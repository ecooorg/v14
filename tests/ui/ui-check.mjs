// QA-02: browser check of the interface at 360, 414, 768 and 1024 px (portrait). NOT part of `npm run check`.
// Run locally:  npx playwright install chromium   (once)   then   npm run test:ui
// Builds the app if dist/ is missing, starts the real server with a fake AI key, logs in through the API.
import { chromium } from 'playwright';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const PASS = 'ui-pass-123', WIDTHS = [360, 414, 768, 1024], HEIGHT = 900, MIN_TAP = 44;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
if (!existsSync('dist/index.html')) {
  const b = spawnSync('npx', ['vite', 'build'], { stdio: 'inherit' });
  if (b.status !== 0) { console.error('build failed'); process.exit(1); }
}
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const server = spawn('tsx', ['server.ts'], { stdio: 'ignore', env: { ...process.env, NODE_ENV: 'production', PORT: String(port),
  APP_PASSWORD: PASS, SESSION_SECRET: 'x'.repeat(40), GEMINI_API_KEY: 'k' } });
const problems = [];
const bad = (w, msg) => { problems.push(`${w}px: ${msg}`); console.log(`FAIL ${w}px - ${msg}`); };
const good = (w, msg) => console.log(`ok   ${w}px - ${msg}`);
let browser;
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(250); }
  browser = await chromium.launch();
  for (const w of WIDTHS) {
    let ctx;
    try {
    ctx = await browser.newContext({ viewport: { width: w, height: HEIGHT }, hasTouch: true, isMobile: w < 768 });
    const login = await ctx.request.post(base + '/api/login', { data: { password: PASS } });
    if (!login.ok()) { bad(w, 'login failed'); await ctx.close(); continue; }
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (e) => bad(w, `page error: ${String(e.message).slice(0, 120)}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)\.com/.test(m.location().url || '')) bad(w, `console error: ${m.text().slice(0, 120)}`); });
    await page.goto(base + '/');
    // Welcome / privacy screen: the header exists only after the Start button is pressed.
    const startBtn = page.locator('.empty button.primary', { hasText: /^Start$/ });
    try { await startBtn.waitFor({ timeout: 8000 }); } catch {}
    if (await startBtn.count()) {
      const sb = await startBtn.first().boundingBox();
      sb && sb.height < MIN_TAP - 0.5 ? bad(w, `Start button height ${Math.round(sb.height)}px < ${MIN_TAP}px`) : good(w, 'Start button >= 44px');
      await page.screenshot({ path: `ui-welcome-${w}.png` });
      await startBtn.first().click();
    }
    await page.waitForSelector('.header-actions', { timeout: 15000 });
    // A fresh profile shows "Nothing here yet": open a conversation so the chat, composer and Method button exist.
    const newDecision = page.getByRole('button', { name: /New decision/ });
    if (await newDecision.count()) { await newDecision.first().click(); await page.waitForSelector('textarea', { timeout: 8000 }); }
    const noHScroll = async (label) => {
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      over > 1 ? bad(w, `horizontal scroll (${over}px) ${label}`) : good(w, `no horizontal scroll ${label}`);
    };
    const taps = async (label) => {
      const boxes = await page.$$eval('.header-actions .ghost', (els) => els.filter((e) => e.offsetParent !== null)
        .map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent || e.getAttribute('aria-label') || '').trim(), w: r.width, h: r.height, x: r.x, r: r.right }; }));
      if (!boxes.length) return bad(w, `no visible header buttons ${label}`);
      const small = boxes.filter((b) => b.h < MIN_TAP - 0.5 || b.w < MIN_TAP - 0.5);
      small.length ? bad(w, `tap area < ${MIN_TAP}px ${label}: ${small.map((b) => `${b.t} ${Math.round(b.w)}x${Math.round(b.h)}`).join('; ')}`) : good(w, `tap areas >= ${MIN_TAP}px ${label}`);
      const off = boxes.filter((b) => b.x < -1 || b.r > w + 1);
      off.length ? bad(w, `button outside screen ${label}: ${off.map((b) => b.t).join(', ')}`) : good(w, `buttons inside screen ${label}`);
    };
    await noHScroll('(start)'); await taps('(start)');
    // UI-09: text in every visible input, textarea and select is at least 16 px (no iOS zoom on focus)
    const inputSizes = async (label) => {
      const small = await page.$$eval('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), textarea, select',
        (els) => els.filter((e) => e.offsetParent !== null).map((e) => ({ n: e.getAttribute('aria-label') || e.tagName, s: parseFloat(getComputedStyle(e).fontSize) })).filter((x) => x.s < 16));
      small.length ? bad(w, `input font < 16px ${label}: ${small.map((x) => `${x.n} ${x.s}px`).join('; ')}`) : good(w, `input fonts >= 16px ${label}`);
    };
    // UI-08: any visible button on the current screen, other than those inside the header, has a 44 px tap area
    const screenTaps = async (label, sel) => {
      const small = await page.$$eval(sel, (els) => els.filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect();
        return { t: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 20), w: r.width, h: r.height }; }).filter((b) => b.h < 43.5 || b.w < 43.5));
      small.length ? bad(w, `tap area < ${MIN_TAP}px ${label}: ${small.map((b) => `${b.t} ${Math.round(b.w)}x${Math.round(b.h)}`).join('; ')}`) : good(w, `tap areas >= ${MIN_TAP}px ${label}`);
    };
    await inputSizes('(chat)'); await screenTaps('(chat)', 'main button.primary, main button.chip, .conversation-composer button');
    // History panel
    const hist = page.getByRole('button', { name: /^History$/ });
    if (await hist.count()) {
      await hist.first().click();
      const close = page.getByRole('button', { name: /Close history/ });
      if (await close.count()) { await noHScroll('(History open)'); await screenTaps('(History open)', '[role=dialog][aria-label="History"] button'); await close.first().click(); }
      else bad(w, 'History panel did not open');
    }
    // "Google AI" screen: it is a menuitem inside More on narrow screens and
    // an inline menuitem on wide screens. Use its actual ARIA role.
    const moreBtn = page.locator('.hdr-more-btn');
    if (await moreBtn.isVisible()) {
      await moreBtn.click();
      const open = await page.locator('.hdr-secondary.open').count();
      open ? good(w, 'More menu opens for Google AI') : bad(w, 'More menu did not open for Google AI');
    }
    const gai = page.getByRole('menuitem', { name: /^Google AI$/ });
    if (await gai.count()) {
      await gai.first().click();
      await page.waitForSelector('input[aria-label="Gemini API key"]', { timeout: 8000 });
      await inputSizes('(Google AI)'); await screenTaps('(Google AI)', '.empty button');
      await noHScroll('(Google AI)');
      await page.getByRole('button', { name: /^Cancel$/ }).first().click();
      await page.waitForSelector('.header-actions', { timeout: 8000 });
    } else bad(w, 'no visible "Google AI" menuitem');

    // The "More" menu is only a button on narrow screens. The previous test
    // clicked it once before Google AI and then clicked it again here, which
    // closed an already-open menu and falsely reported a failure. Check state
    // explicitly before toggling it.
    const more = page.locator('.hdr-more-btn');
    if (await more.isVisible()) {
      const expanded = await more.getAttribute('aria-expanded');
      if (expanded !== 'true') await more.click();
      (await page.locator('.hdr-secondary.open').count()) ? good(w, 'More menu opens') : bad(w, 'More menu did not open');
      await noHScroll('(More open)'); await taps('(More open)');
      if ((await more.getAttribute('aria-expanded')) === 'true') await more.click();
    } else good(w, 'More button not needed (wide screen)');

    // Current UI calls the toggle "Expert mode" / "Simple mode". Verify the
    // real mode switch instead of the obsolete "Method" / "Normal mode" labels.
    const mode = page.getByRole('button', { name: /^(Expert mode|Simple mode)$/ });
    if (await mode.count()) {
      const before = (await mode.first().innerText()).trim();
      await mode.first().click();
      const expected = before === 'Expert mode' ? 'Simple mode' : 'Expert mode';
      const back = page.getByRole('button', { name: new RegExp(`^${expected}$`) });
      if (await back.count()) {
        await noHScroll('(mode switched)'); await taps('(mode switched)');
        const box = await back.first().boundingBox();
        box && box.x >= -1 && box.x + box.width <= w + 1 ? good(w, `${expected} button reachable`) : bad(w, `${expected} button off screen`);
        await back.first().click();
        (await page.getByRole('button', { name: new RegExp(`^${before}$`) }).count())
          ? good(w, 'mode restored')
          : bad(w, 'could not restore previous mode');
      } else bad(w, `no "${expected}" button after mode switch`);
    } else bad(w, 'no Expert/Simple mode button');
    } catch (e) { bad(w, `test error: ${String(e.message).slice(0, 150)}`); } finally { await ctx?.close().catch(() => {}); }
  }
} finally { await browser?.close(); server.kill(); }
if (problems.length) { console.error(`\n${problems.length} problem(s):\n- ` + problems.join('\n- ')); process.exit(1); }
console.log('\nUI check passed');
