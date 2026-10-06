// UI-06 and CODE-01
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportFileName } from '../src/utils/exportName.ts';
import { APP_VERSION, SCHEMA_VERSION } from '../src/config.ts';
assert.equal(exportFileName(123), `bifurcation_${APP_VERSION}_123.json`);
assert.ok(!/_v1[0-5]_/.test(exportFileName()));
const defs = ['src/config.ts', 'src/types/decision.ts', 'src/utils/storage.ts', 'src/hooks/useDrive.ts', 'src/App.tsx']
  .filter((f) => /export\s+const\s+SCHEMA_VERSION\s*=/.test(readFileSync(f, 'utf8')));
assert.deepEqual(defs, ['src/config.ts']);
assert.equal(SCHEMA_VERSION, 11);
console.log('2 tests passed');
