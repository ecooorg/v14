// Drive mirror: manifest + status (no network). Run via node --experimental-strip-types or project test runner.
import assert from 'node:assert/strict';

const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => ls.get(k) ?? null,
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};

const mod = await import('../src/driveMirror.ts');

assert.equal(mod.isMirrorConnected(), false);
assert.equal(mod.mirrorStatus('x'), 'not_configured'); // no VITE client id in node

const man = mod.loadMirrorManifest();
assert.equal(man.version, 1);
assert.deepEqual(man.files, []);

console.log('ok - driveMirror basics');
