import assert from 'node:assert/strict';
import { mergeLibraries, isSafeToWrite, remoteIsNewer, parseLibrary, buildLibraryPayload,
  createBackup, listBackups, DRIVE_FILE_NAME } from '../src/utils/driveMerge.ts';

const d = (id, updatedAt, t = '') => ({ id, updatedAt, t });
const mem = () => { const m = new Map(); return { m,
  getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('merge: union by id', () => {
  const r = mergeLibraries([d('a', 1), d('b', 1)], [d('c', 1)]);
  assert.deepEqual(r.merged.map((x) => x.id).sort(), ['a', 'b', 'c']);
  assert.ok(r.changedLocal && r.changedRemote);
});
t('merge: newer wins (remote newer)', () => {
  const r = mergeLibraries([d('a', 1, 'old')], [d('a', 5, 'new')]);
  assert.equal(r.merged[0].t, 'new'); assert.ok(r.changedLocal); assert.ok(!r.changedRemote);
});
t('merge: newer wins (local newer)', () => {
  const r = mergeLibraries([d('a', 9, 'new')], [d('a', 5, 'old')]);
  assert.equal(r.merged[0].t, 'new'); assert.ok(!r.changedLocal); assert.ok(r.changedRemote);
});
t('merge: tie keeps local, nothing changed', () => {
  const r = mergeLibraries([d('a', 5, 'L')], [d('a', 5, 'R')]);
  assert.equal(r.merged[0].t, 'L'); assert.ok(!r.changedLocal && !r.changedRemote);
});
t('merge: empty local keeps remote, empty remote keeps local', () => {
  assert.equal(mergeLibraries([], [d('a', 1)]).merged.length, 1);
  assert.equal(mergeLibraries([d('a', 1)], []).merged.length, 1);
});
t('merge: does not mutate inputs; ignores rows without id', () => {
  const L = [d('a', 1)], R = [d('b', 1), { updatedAt: 3 }];
  mergeLibraries(L, R); assert.equal(L.length, 1); assert.equal(R.length, 2);
  assert.equal(mergeLibraries(L, R).merged.length, 2);
});
t('empty library never overwrites non-empty remote', () => {
  assert.equal(isSafeToWrite([], [d('a', 1)]), false);
  assert.equal(isSafeToWrite([], []), true);
  assert.equal(isSafeToWrite([], null), true);
  assert.equal(isSafeToWrite([d('a', 1)], [d('b', 1)]), true);
});
t('remoteIsNewer', () => {
  assert.equal(remoteIsNewer(200, 100), true);
  assert.equal(remoteIsNewer(100, 100), false);
  assert.equal(remoteIsNewer(100, null), true);
  assert.equal(remoteIsNewer(null, 100), false);
});
t('parse: old format, new format, bare array, garbage', () => {
  assert.equal(parseLibrary('{"version":13,"updatedAt":7,"decisions":[{"id":"a","updatedAt":1}]}').decisions.length, 1);
  const nw = parseLibrary(buildLibraryPayload([d('a', 1)], '16.5.0', 11, 42));
  assert.equal(nw.appVersion, '16.5.0'); assert.equal(nw.schemaVersion, 11); assert.equal(nw.updatedAt, 42);
  assert.equal(parseLibrary([d('a', 1)]).decisions.length, 1);
  assert.deepEqual(parseLibrary('not json').decisions, []);
  assert.deepEqual(parseLibrary(null).decisions, []);
});
t('payload keeps legacy version field and file name is unchanged', () => {
  assert.equal(JSON.parse(buildLibraryPayload([], '16.5.0', 11)).version, 13);
  assert.equal(DRIVE_FILE_NAME, 'bifurcation-v13-library.json');
});
t('backup: created, dated, keeps last three', () => {
  const s = mem();
  for (let i = 1; i <= 5; i++) assert.ok(createBackup(s, [d('a', i)], 1000 + i));
  const keys = listBackups(s);
  assert.equal(keys.length, 3);
  assert.deepEqual(keys, ['bifurcation_library_backup_1003', 'bifurcation_library_backup_1004', 'bifurcation_library_backup_1005']);
  assert.equal(JSON.parse(s.getItem(keys[2])).createdAt, 1005);
  assert.equal(s.m.has('bifurcation_library_backup_1001'), false);
});
t('backup: same millisecond does not overwrite; empty library skipped', () => {
  const s = mem();
  const a = createBackup(s, [d('a', 1)], 5), b = createBackup(s, [d('a', 1)], 5);
  assert.notEqual(a, b); assert.equal(listBackups(s).length, 2);
  assert.equal(createBackup(mem(), [], 5), null);
});
t('backup: quota error does not throw', () => {
  const s = mem(); s.setItem = () => { throw new Error('quota'); };
  assert.equal(createBackup(s, [d('a', 1)], 5), null);
});
console.log(`${n} tests passed`);
