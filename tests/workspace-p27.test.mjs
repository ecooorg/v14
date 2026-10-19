/**
 * P27 — persistIngest glue + privacy guard (no browser / IndexedDB required).
 */
import assert from "node:assert/strict";
import { MemoryWorkspaceStore } from "../src/workspace/memoryStore.ts";
import {
  canBuildWorkspaceContext,
  isArchiveFileName,
  languageSummaryLine,
  persistIngestResult,
  summarizeLanguages,
} from "../src/workspace/persistIngest.ts";
import { sha256Bytes } from "../src/workspace/hash.ts";

assert.equal(isArchiveFileName("app.zip"), true);
assert.equal(isArchiveFileName("x.tar.gz"), true);
assert.equal(isArchiveFileName("readme.md"), false);

assert.equal(canBuildWorkspaceContext(false), false);
assert.equal(canBuildWorkspaceContext(true), true);

const enc = new TextEncoder();
const textBytes = enc.encode("hello workspace\n");
const sha = await sha256Bytes(textBytes);
const entry = {
  path: "hello.txt",
  sha256: sha,
  size: textBytes.byteLength,
  mode: 0o644,
  class: "source",
  lang: "txt",
  flags: [],
};
const result = {
  entries: [entry],
  blobs: new Map([[sha, textBytes]]),
  report: { accepted: 1, skipped: [], marked: [], rootPrefix: "", limitsHit: [] },
  manifestHash: "test",
};

const langs = summarizeLanguages(result.entries);
assert.equal(langs.txt, 1);
assert.ok(languageSummaryLine(result.entries).includes("txt"));

const store = new MemoryWorkspaceStore();
const ok = await persistIngestResult(store, result, "demo");
assert.equal(ok.ok, true, JSON.stringify(ok));
if (!ok.ok) throw new Error("unreachable");
assert.ok(ok.workspaceId);
assert.equal(ok.version.no, 1);
assert.equal(ok.stats.files, 1);
const manifest = await store.getManifest(ok.workspaceId, 1);
assert.equal(manifest.length, 1);
assert.equal(manifest[0].path, "hello.txt");

const rejected = await persistIngestResult(store, {
  entries: [],
  blobs: new Map(),
  report: { accepted: 0, skipped: [], marked: [], rootPrefix: "", limitsHit: [], rejected: "empty_archive" },
  manifestHash: "",
}, "x");
assert.equal(rejected.ok, false);
assert.equal(rejected.ok === false && rejected.code, "empty_archive");

const empty = await persistIngestResult(store, {
  entries: [],
  blobs: new Map(),
  report: { accepted: 0, skipped: [], marked: [], rootPrefix: "", limitsHit: [] },
  manifestHash: "",
}, "x");
assert.equal(empty.ok, false);
assert.equal(empty.ok === false && empty.code, "empty_ingest");

console.log("workspace-p27: ok");
