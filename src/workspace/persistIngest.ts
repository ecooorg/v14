/**
 * Persist an IngestResult into a WorkspaceStore (P27 glue).
 * Pure control flow — no React. Used by WorkspacePanel and tests.
 */
import type { Entry, IngestResult, VersionInfo, WorkspaceStore } from './types.ts';

export type PersistIngestOk = {
  ok: true;
  workspaceId: string;
  version: VersionInfo;
  stats: { files: number; bytes: number; languages: Record<string, number> };
};

export type PersistIngestFail = {
  ok: false;
  code: string;
  detail?: string;
};

export function summarizeLanguages(entries: Entry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    const lang = e.lang || e.class || 'unknown';
    out[lang] = (out[lang] || 0) + 1;
  }
  return out;
}

export function languageSummaryLine(entries: Entry[], max = 6): string {
  const counts = summarizeLanguages(entries);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k, n]) => `${k}:${n}`)
    .join(', ');
}

/** Create workspace, store blobs, commit version 1 from an ingest result. */
export async function persistIngestResult(
  store: WorkspaceStore,
  result: IngestResult,
  name: string,
): Promise<PersistIngestOk | PersistIngestFail> {
  if (result.report.rejected) {
    return { ok: false, code: result.report.rejected, detail: result.report.rejectDetail };
  }
  if (!result.entries.length) {
    return { ok: false, code: 'empty_ingest', detail: 'no accepted entries' };
  }
  try {
    const workspaceId = await store.createWorkspace(name, result.report.rootPrefix || '', false);
    for (const e of result.entries) {
      const bytes = result.blobs.get(e.path) || result.blobs.get(e.sha256);
      if (!bytes) return { ok: false, code: 'missing_blob', detail: e.path };
      await store.putBlob(workspaceId, e.sha256, bytes);
    }
    const version = await store.commitVersion(workspaceId, null, result.entries, {
      createdBy: 'import',
      message: 'P27 ingest',
    });
    const bytes = result.entries.reduce((s, e) => s + (e.size || 0), 0);
    return {
      ok: true,
      workspaceId,
      version,
      stats: {
        files: result.entries.length,
        bytes,
        languages: summarizeLanguages(result.entries),
      },
    };
  } catch (e: any) {
    return { ok: false, code: 'persist_failed', detail: e?.message || String(e) };
  }
}

/** Guard used before any model-facing workspace block (P27-2). */
export function canBuildWorkspaceContext(privacyAck: boolean): boolean {
  return privacyAck === true;
}

export function isArchiveFileName(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.zip') || n.endsWith('.tar') || n.endsWith('.tar.gz') || n.endsWith('.tgz');
}
