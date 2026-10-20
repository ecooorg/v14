/**
 * Keep-alive для Render (free tier засыпает после ~15 мин без входящего трафика).
 *
 * Вместо ровного setInterval имитирует «визиты» живого человека:
 *  - случайный интервал 11–14 мин (колоколообразный, а не равномерный);
 *  - разные сценарии визита: открыл страницу + подтянул ассеты / дёрнул API / health;
 *  - реалистичные заголовки, «липкий» User-Agent, паузы между запросами;
 *  - при ошибке быстрые повторы, чтобы не пропустить окно в 15 минут.
 *
 * Пингует только публичные маршруты (без авторизации и без БД).
 */

const MIN_GAP_MS = 11 * 60_000;
const MAX_GAP_MS = 14 * 60_000; // строго < 15 мин, иначе сервис уснёт
const RETRY_MIN_MS = 40_000;
const RETRY_MAX_MS = 90_000;
const REQUEST_TIMEOUT_MS = 45_000; // запас на холодный старт

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
];
const LANGUAGES = ['ru-RU,ru;q=0.9,en;q=0.8', 'en-US,en;q=0.9', 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7'];

type Identity = { ua: string; lang: string };
type Scenario = 'page' | 'api' | 'health';

const rnd = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** Среднее двух равномерных величин: чаще середина диапазона, редко края. */
function humanGap(): number {
  return (rnd(MIN_GAP_MS, MAX_GAP_MS) + rnd(MIN_GAP_MS, MAX_GAP_MS)) / 2;
}

function pickScenario(): Scenario {
  const r = Math.random();
  if (r < 0.6) return 'page';
  if (r < 0.85) return 'api';
  return 'health';
}

export function startKeepAlive(): () => void {
  const baseUrl = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (!baseUrl || process.env.KEEP_ALIVE === 'false') return () => undefined;

  const ac = new AbortController();
  let identity: Identity = { ua: pick(USER_AGENTS), lang: pick(LANGUAGES) };
  let consecutiveFails = 0;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (ac.signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      t.unref(); // таймер не мешает корректному завершению процесса
      ac.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });

  async function request(path: string, kind: 'html' | 'asset' | 'api', referer?: string): Promise<{ status: number; body: string }> {
    const accept = kind === 'html'
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      : kind === 'api' ? 'application/json, text/plain, */*' : '*/*';
    const res = await fetch(`${baseUrl}${path}`, {
      headers: {
        'User-Agent': identity.ua,
        'Accept': accept,
        'Accept-Language': identity.lang,
        'Cache-Control': kind === 'html' && Math.random() < 0.3 ? 'max-age=0' : 'no-cache',
        ...(referer ? { Referer: referer } : {}),
      },
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    // читаем тело целиком, чтобы соединение корректно освободилось
    const text = kind === 'asset' ? (await res.arrayBuffer(), '') : await res.text();
    return { status: res.status, body: text };
  }

  /** Один «визит». true — сервер ответил нормально (не 5xx). */
  async function visit(): Promise<boolean> {
    if (Math.random() < 0.1) identity = { ua: pick(USER_AGENTS), lang: pick(LANGUAGES) };
    const scenario = pickScenario();
    const home = `${baseUrl}/`;

    try {
      if (scenario === 'page') {
        const main = await request('/', 'html');
        if (main.status >= 500) return false;
        const assets = [...main.body.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
        for (const a of assets.slice(0, Math.floor(rnd(0, 3)))) {
          await sleep(rnd(150, 900));
          await request(a, 'asset', home).catch(() => undefined);
        }
        if (Math.random() < 0.7) {
          await sleep(rnd(400, 2500));
          await request('/api/session', 'api', home).catch(() => undefined);
        }
        return true;
      }
      const path = scenario === 'api' ? '/api/session' : '/api/health';
      const r = await request(path, 'api', Math.random() < 0.5 ? home : undefined);
      return r.status < 500;
    } catch {
      return false;
    }
  }

  async function loop() {
    console.log(`[KeepAlive] запущен, цель: ${baseUrl}`);
    await sleep(rnd(60_000, 180_000)); // первый визит не сразу после старта
    while (!ac.signal.aborted) {
      const ok = await visit();
      if (ok) {
        if (consecutiveFails > 0) console.log(`[KeepAlive] восстановлено после ${consecutiveFails} неудач`);
        consecutiveFails = 0;
        await sleep(humanGap());
      } else {
        consecutiveFails++;
        console.warn(`[KeepAlive] неудачный визит (#${consecutiveFails}), повтор через ~1 мин`);
        await sleep(rnd(RETRY_MIN_MS, RETRY_MAX_MS));
      }
    }
  }

  void loop();
  return () => ac.abort();
}
