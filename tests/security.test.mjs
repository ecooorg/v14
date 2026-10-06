import assert from 'node:assert/strict';
import { createSessionSigner, sessionCookie, clearedCookie, LoginLimiter, stripMarkdown } from '../server/security.ts';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('session: valid, expired, tampered, wrong secret, garbage', () => {
  const s = createSessionSigner('secret-secret-secret');
  const tok = s.sign(Date.now() + 1000);
  assert.ok(s.verify(tok));
  assert.ok(!s.verify(s.sign(Date.now() - 1)));
  assert.ok(!s.verify(tok.replace(/^\d+/, (x) => String(Number(x) + 99999))));
  assert.ok(!createSessionSigner('other-secret-other').verify(tok));
  for (const g of ['', null, undefined, 'abc', '1.2.3', '123.']) assert.ok(!s.verify(g));
});
t('session survives "restart": a new signer with the same secret accepts the token', () => {
  const tok = createSessionSigner('same-secret-value-1').sign(Date.now() + 5000);
  assert.ok(createSessionSigner('same-secret-value-1').verify(tok));
});
t('cookie flags', () => {
  const c = sessionCookie('x', 60, true);
  for (const f of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Max-Age=60']) assert.ok(c.includes(f), f);
  assert.ok(!sessionCookie('x', 60, false).includes('Secure'));
  assert.ok(clearedCookie(true).includes('Max-Age=0'));
});
t('limiter: blocks after max failures, window resets, success does not reset', () => {
  const L = new LoginLimiter(3, 1000);
  for (let i = 0; i < 2; i++) L.recordFailure('ip', 0);
  assert.equal(L.retryAfterSec('ip', 10), 0);
  L.recordFailure('ip', 20);
  assert.ok(L.retryAfterSec('ip', 30) > 0);            // blocked (a correct password is not consulted here)
  assert.equal(L.retryAfterSec('other', 30), 0);       // other addresses unaffected
  assert.equal(L.retryAfterSec('ip', 1200), 0);        // window passed: allowed again
});
t('markdown: bold, italic, headings, list markers, code, links', () => {
  assert.equal(stripMarkdown('**Bold** and *italic* and __b__ and _i_'), 'Bold and italic and b and i');
  assert.equal(stripMarkdown('## Title\ntext'), 'Title\ntext');
  assert.equal(stripMarkdown('* one\n+ two\n  * nested\n- keep'), '- one\n- two\n  - nested\n- keep');
  assert.equal(stripMarkdown('use `x` and [site](https://a.b/c)'), 'use x and site (https://a.b/c)');
  assert.equal(stripMarkdown('a\n---\nb'), 'a\n\nb');
  assert.equal(stripMarkdown('```js\ncode\n```'), 'code');
});
t('markdown: ordinary text is untouched', () => {
  for (const x of ['2 * 3 = 6', 'snake_case_name', '5 > 3 and 3 < 5', 'Cost: 10-20%', 'a * b * c', 'Привет, мир! Что делать?'])
    assert.equal(stripMarkdown(x), x);
});
console.log(`${n} tests passed`);
