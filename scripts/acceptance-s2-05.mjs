// S2-05 acceptance helper: runs 10 situations on two servers (v16.5 and v17) and writes a BLIND sheet.
// Usage (two servers started from two archives, e.g. ports 3001 = v16.5, 3002 = v17):
//   A_URL=http://localhost:3001 B_URL=http://localhost:3002 APP_PASSWORD=... BYOK_KEY=<your free Gemini key> node scripts/acceptance-s2-05.mjs
// Your own key (x-byok-key) is not counted in the server's daily cap. ~10-12 calls per server.
// Output: acceptance-blind.md (read and rate it) and acceptance-key.json (open ONLY after rating).
import fs from 'node:fs';
const { A_URL, B_URL, APP_PASSWORD = '', BYOK_KEY = '' } = process.env;
if (!A_URL || !B_URL) { console.error('Set A_URL (v16.5) and B_URL (v17).'); process.exit(1); }

const CASES = [
  ['climate move', 'Я думаю переехать в другую страну из-за климата. Здесь зимой мне очень тяжело. Стоит ли?'],
  ['repair vs car', 'У меня есть деньги либо на ремонт дома, либо на машину. Не могу выбрать, что важнее.'],
  ['unclear wording', 'Короче, всё сложно, надо что-то менять, но непонятно что.'],
  ['tense message', 'Я больше не выдерживаю этого начальника, он меня унижает при всех. Хочу уволиться завтра же.'],
  ['not understood', 'Выбираю между двумя предложениями о работе.', 'Ты меня не понял. Дело не в деньгах.'],
  ['already thought through', 'Я уже понял, что главный риск при открытии своей кофейни — аренда. Я сравнил три помещения, у двух арендодатели не дают договор больше года. Что делать дальше?'],
  ['hypothesis trap', 'Думаю, не пора ли мне менять профессию. Мне 38, работаю бухгалтером, скучно.', 'Да, мне кажется, дело в выгорании.'],
  ['just data missing', 'Хочу взять ипотеку. Платёж будет 40% дохода. Нормально ли это?'],
  ['asks to choose', 'Скажи прямо: мне оставаться в городе с родителями или ехать учиться в другой?'],
  ['other person', 'Хочу поговорить с мужем о том, чтобы переехать ближе к моей маме, но боюсь, что он обидится.'],
];

async function login(base) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: APP_PASSWORD }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function ask(base, cookie, brief, history, state) {
  const r = await fetch(base + '/api/conversation', { method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, ...(BYOK_KEY ? { 'x-byok-key': BYOK_KEY } : {}) },
    body: JSON.stringify({ brief: { decision: brief }, history, state }) });
  const j = await r.json();
  if (!j.success) return { reply: '[ERROR] ' + j.error, state };
  return { reply: j.data.reply, state: j.data.state };
}
async function run(base, cookie, [, first, second]) {
  let h = [{ role: 'user', content: first }];
  let o = await ask(base, cookie, first, h);
  if (second) { h = [...h, { role: 'assistant', content: o.reply }, { role: 'user', content: second }]; o = await ask(base, cookie, first, h, o.state); }
  return o.reply;
}
const flags = (t) => ({ words: t.split(/\s+/).length, questions: (t.match(/[?？]/g) || []).length,
  markdown: /(\*\*|^#{1,6}\s|`|^\s*\*\s)/m.test(t), labels: /(USER FACT|HYPOTHESIS|problemClear|driftDetected|\b(?:UNDERSTAND|EXPAND|ATTACK)\b)/.test(t) });

const [ca, cb] = [await login(A_URL), await login(B_URL)];
let md = '# Blind comparison (S2-05)\nFor each case rate X and Y: shorter and more precise? no retelling of the question? no invented numbers/facts? max one question related to the problem? no markup or service labels? Then: does one of them feel different from an ordinary chat assistant?\n\n';
const key = [];
let i = 0;
for (const c of CASES) {
  i++;
  const [ra, rb] = [await run(A_URL, ca, c), await run(B_URL, cb, c)];
  const swap = Math.random() < 0.5;            // hide which is which
  const [x, y] = swap ? [rb, ra] : [ra, rb];
  md += `## ${i}. ${c[1]}${c[2] ? '\n(then the person writes: ' + c[2] + ')' : ''}\n\n### X\n${x}\n\n### Y\n${y}\n\nRating: \n\n`;
  key.push({ case: i, name: c[0], X: swap ? 'v17' : 'v16.5', Y: swap ? 'v16.5' : 'v17', auto: { 'v16.5': flags(ra), v17: flags(rb) } });
  console.log('done', i);
}
fs.writeFileSync('acceptance-blind.md', md);
fs.writeFileSync('acceptance-key.json', JSON.stringify(key, null, 1));
const sum = (v, f) => key.reduce((n, k) => n + f(k.auto[v]), 0);
for (const v of ['v16.5', 'v17']) console.log(v, 'avg words', Math.round(sum(v, (a) => a.words) / key.length), 'questions>1:', key.filter((k) => k.auto[v].questions > 1).length, 'markdown:', key.filter((k) => k.auto[v].markdown).length, 'labels:', key.filter((k) => k.auto[v].labels).length);
