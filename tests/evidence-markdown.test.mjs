import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEvidenceMarkdown } from '../scripts/evidence-to-markdown.mjs';

test('evidence renderer creates a compact Markdown table without dumping raw fields', () => {
  const md = renderEvidenceMarkdown({
    generated_at: '2026-10-13T12:00:00Z', commit: 'abc123', run: 'https://github.com/org/repo/actions/runs/123',
    checks: [{ id: 'health', status: 'PASS', detail: 'service ready' }, { id: 'auth', status: 'NOT_RUN', detail: 'missing app_password=verysecret' }],
    arbitrary_secret_blob: 'do-not-render-this',
  });
  assert.match(md, /\| health \| PASS \| service ready \|/);
  assert.match(md, /app_password=\[REDACTED\]/i);
  assert.ok(!md.includes('do-not-render-this'));
  assert.ok(!md.includes('verysecret'));
});

test('evidence renderer refuses non-object roots and tolerates missing checks', () => {
  assert.throws(() => renderEvidenceMarkdown('[]'), /evidence_root_must_be_object/);
  assert.match(renderEvidenceMarkdown({}), /\| Check \| Status \| Detail \|/);
});
