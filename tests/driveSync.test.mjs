// TEST-01 / DRV-01: sync core against a fake Drive. No network.
import assert from 'node:assert/strict';
import { syncOnce } from '../src/utils/driveSync.ts';
import { autosaveDelay, hasUnsavedLocal, shouldNotify } from '../src/utils/autosave.ts';
import { DriveAuthError, DriveNotFoundError } from '../src/utils/driveClient.ts';

const d = (id, updatedAt, t = '') => ({ id, updatedAt, t });
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

function fakeDrive(initial, { onWrite, beforeWrite } = {}) {
  const s = { file: initial ? { id: 'f1', mod: 100, decisions: initial } : null, writes: 0, finds: 0 };
  const info = () => (s.file ? { id: s.file.id, modifiedTime: s.file.mod } : null);
  s.concurrent = (decisions) => { s.file = { id: s.file?.id || 'f1', mod: (s.file?.mod || 100) + 10, decisions }; };
  s.ops = {
    find: async () => { s.finds++; return info(); },
    read: async () => ({ decisions: s.file.decisions }),
    write: async (body, id) => {
      if (beforeWrite) beforeWrite(s);
      if (id && !s.file) throw new DriveNotFoundError();
      s.writes++;
      s.file = { id: id || 'f1', mod: (s.file?.mod || 100) + 1, decisions: JSON.parse(body).decisions };
      return info();
    },
  };
  return s;
}
const base = (o) => ({ mode: 'manual', local: [], lastSync: 0, appVersion: 'x', schemaVersion: 11, backup: () => {}, ...o });
const ids = (arr) => arr.map((x) => x.id).sort();

await t('connect with both sides non-empty: merged, backed up, nothing lost', async () => {
  const dr = fakeDrive([d('b', 1), d('c', 1)]); let backed = 0;
  const r = await syncOnce(base({ mode: 'connect', local: [d('a', 1), d('b', 1)], backup: () => backed++ }), dr.ops);
  assert.deepEqual(ids(r.merged), ['a', 'b', 'c']); assert.deepEqual(ids(dr.file.decisions), ['a', 'b', 'c']);
  assert.equal(backed, 1); assert.ok(r.changedLocal && r.wrote);
});
await t('first save creates the file', async () => {
  const dr = fakeDrive(null);
  const r = await syncOnce(base({ local: [d('a', 1)] }), dr.ops);
  assert.ok(r.wrote && dr.file.decisions.length === 1);
});
await t('empty library never overwrites a non-empty Drive file', async () => {
  const dr = fakeDrive([d('a', 1)]);
  const r = await syncOnce(base({ mode: 'manual', local: [], lastSync: 0 }), dr.ops);
  assert.deepEqual(ids(dr.file.decisions), ['a']);   // Drive content intact
  assert.deepEqual(ids(r.merged), ['a']);            // local gets Drive's dialogs, not wiped
  // Drive unreadable as newer (already synced): empty local, nothing to write
  const r2 = await syncOnce(base({ local: [], lastSync: 999 }), dr.ops);
  assert.ok(!r2.wrote && ids(dr.file.decisions)[0] === 'a');
});
await t('DRV-01: another device writes between read and write -> re-read, merge, nothing lost', async () => {
  const dr = fakeDrive([d('b', 1)]);
  let fired = false;
  const ops = { ...dr.ops, find: async () => { const r = await dr.ops.find(); if (!fired && dr.finds === 1) { fired = true; dr.concurrent([d('b', 1), d('z', 5)]); } return r; } };
  const r = await syncOnce(base({ mode: 'connect', local: [d('a', 1), d('b', 1)] }), ops);
  assert.equal(r.status, 'ok'); assert.equal(r.retries, 1);
  assert.deepEqual(ids(dr.file.decisions), ['a', 'b', 'z']);
});
await t('DRV-01: Drive keeps changing -> stops after max retries, writes nothing, local intact', async () => {
  const dr = fakeDrive([d('b', 1)]); let k = 0;
  const ops = { ...dr.ops, find: async () => { const r = await dr.ops.find(); dr.concurrent([d('b', 1), d('x' + k++, 2)]); return r; } };
  const local = [d('a', 1)];
  const r = await syncOnce(base({ mode: 'connect', local, maxRetries: 3 }), ops);
  assert.equal(r.status, 'conflict'); assert.equal(dr.writes, 0); assert.equal(r.retries, 3);
  assert.deepEqual(r.merged, local);
});
await t('DRV-01: file created by another device while we had none -> merged, not duplicated', async () => {
  const dr = fakeDrive(null); let first = true;
  const ops = { ...dr.ops, find: async () => { const r = await dr.ops.find(); if (first) { first = false; dr.concurrent([d('z', 3)]); } return r; } };
  const r = await syncOnce(base({ local: [d('a', 1)] }), ops);
  assert.deepEqual(ids(dr.file.decisions), ['a', 'z']); assert.equal(r.retries, 1);
});
await t('missing file id (404 on write) falls back to creating the file', async () => {
  const dr = fakeDrive(null); let calls = 0;
  const ops = { ...dr.ops, write: async (b, id) => { calls++; if (calls === 1) throw new DriveNotFoundError(); return dr.ops.write(b); } };
  const r = await syncOnce(base({ local: [d('a', 1)] }), ops);
  assert.ok(r.wrote && calls === 2);
});
await t('expired token (401/403) propagates for the caller to handle; nothing written', async () => {
  const dr = fakeDrive([d('a', 1)]);
  const ops = { ...dr.ops, find: async () => { throw new DriveAuthError(); } };
  await assert.rejects(() => syncOnce(base({ local: [d('a', 2)] }), ops), DriveAuthError);
  assert.equal(dr.writes, 0);
});

await t('DRV-02: autosave with nothing new writes nothing (remote unread)', async () => {
  const dr = fakeDrive([d('a', 1)]);
  const r = await syncOnce(base({ mode: 'auto', local: [d('a', 1)], lastSync: 100, dirty: false }), dr.ops);
  assert.ok(!r.wrote && dr.writes === 0);
});
await t('DRV-02: autosave with new local data writes', async () => {
  const dr = fakeDrive([d('a', 1)]);
  const r = await syncOnce(base({ mode: 'auto', local: [d('a', 5)], lastSync: 100, dirty: true }), dr.ops);
  assert.ok(r.wrote && dr.file.decisions[0].updatedAt === 5);
});
await t('DRV-02: autosave, Drive newer and local not dirty -> merges locally, writes nothing', async () => {
  const dr = fakeDrive([d('a', 1), d('z', 9)]);
  const r = await syncOnce(base({ mode: 'auto', local: [d('a', 1)], lastSync: 0, dirty: false }), dr.ops);
  assert.ok(!r.wrote && r.changedLocal && ids(r.merged).join() === 'a,z');
});
await t('DRV-02: manual save always writes, even with nothing new', async () => {
  const dr = fakeDrive([d('a', 1)]);
  const r = await syncOnce(base({ mode: 'manual', local: [d('a', 1)], lastSync: 100, dirty: false }), dr.ops);
  assert.ok(r.wrote);
});
await t('expired token, then reconnect repeats the failed save (nothing lost)', async () => {
  const dr = fakeDrive([d('b', 1)]);
  const failing = { ...dr.ops, find: async () => { throw new DriveAuthError(); } };
  const local = [d('a', 2), d('b', 1)];
  await assert.rejects(() => syncOnce(base({ mode: 'auto', local, dirty: true }), failing), DriveAuthError);
  const r = await syncOnce(base({ mode: 'connect', local }), dr.ops);   // reconnect = merge + write
  assert.ok(r.wrote); assert.deepEqual(ids(dr.file.decisions), ['a', 'b']);
});
await t('DRV-02: autosave delay keeps the minimum interval between writes', () => {
  const o = { debounceMs: 4000, minIntervalMs: 30000 };
  assert.equal(autosaveDelay({ ...o, now: 1000, lastWriteAt: 0 }), 4000);
  assert.equal(autosaveDelay({ ...o, now: 11000, lastWriteAt: 10000 }), 29000);
  assert.equal(autosaveDelay({ ...o, now: 100000, lastWriteAt: 10000 }), 4000);
});
await t('hasUnsavedLocal', () => {
  assert.ok(hasUnsavedLocal([d('a', 5)], { a: 4 }) && hasUnsavedLocal([d('a', 1)], {}));
  assert.ok(!hasUnsavedLocal([d('a', 5)], { a: 5 }) && !hasUnsavedLocal([], {}));
});
await t('autosave messages are throttled; manual and connect always show', () => {
  assert.ok(shouldNotify('auto', 1000, 0, 30000) && !shouldNotify('auto', 5000, 1000, 30000) && shouldNotify('auto', 31001, 1000, 30000));
  assert.ok(shouldNotify('manual', 5000, 4999, 30000) && shouldNotify('connect', 5000, 4999, 30000));
});
console.log(n + ' tests passed');
