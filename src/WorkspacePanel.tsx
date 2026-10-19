/**
 * Workspace attach UI (archive/folder/files → card → privacy → tree).
 * P36: ChangeSet. P37.1: attach. P38: export full / changed / diff.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronRight, Loader2, Download } from 'lucide-react';
import { ingestArchive, ingestFiles } from './workspace/ingest.ts';
import { mirrorBlob, mirrorUserFile } from './driveMirror.ts';
import { IndexedDbWorkspaceStore } from './workspace/idbStore.ts';
import { readWorkspaceFile } from './workspace/context.ts';
import {
  canBuildWorkspaceContext,
  isArchiveFileName,
  languageSummaryLine,
  persistIngestResult,
} from './workspace/persistIngest.ts';
import type { WorkspaceChangeSet } from './workspace/changeset.ts';
import { parseChangeSetFromText } from './workspace/changeSetParse.ts';
import { WorkspaceChangeSetCard } from './WorkspaceChangeSetCard.tsx';
import type { Entry, IngestReport, WorkspaceStore } from './workspace/types.ts';
import { exportWorkspace, type ExportMode } from './workspace/exportZip.ts';

export type WorkspaceUiState = {
  workspaceId: string;
  name: string;
  version: number;
  privacyAck: boolean;
  entries: Entry[];
  report?: IngestReport;
  languagesLine: string;
};

type Props = {
  disabled?: boolean;
  /** Injected store for tests; default IndexedDB in browser. */
  storeFactory?: () => WorkspaceStore;
  onStateChange?: (state: WorkspaceUiState | null) => void;
  /** Text and safe metadata to attach to the next agent request after explicit privacy acknowledgement. */
  onAttachmentsChange?: (attachments: { name: string; kind: string; text: string }[]) => void;
  /** Agent-proposed ChangeSet (or raw JSON/text containing one). Version changes only after Apply. */
  proposedChangeSet?: WorkspaceChangeSet | string | null;
  onChangeSetSettled?: () => void;
};

/**
 * Folder import works only on desktop browsers. Mobile Chrome exposes `webkitdirectory`
 * on the input but its picker cannot select folders, so also exclude touch/mobile UAs.
 */
export function isFolderPickerSupported(): boolean {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  const input = document.createElement('input');
  if (!('webkitdirectory' in input || 'directory' in input)) return false;
  if (/Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || '')) return false;
  try {
    if (window.matchMedia?.('(pointer: coarse)').matches) return false;
  } catch { /* ignore */ }
  return true;
}

export const PICK_FOLDER_EVENT = 'be:pick-folder';

export function WorkspacePanel({ disabled, storeFactory, onStateChange, onAttachmentsChange, proposedChangeSet, onChangeSetSettled }: Props) {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const privacyRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [state, setState] = useState<WorkspaceUiState | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [openText, setOpenText] = useState<string | null>(null);
  const [pendingCs, setPendingCs] = useState<WorkspaceChangeSet | null>(null);
  const [openMeta, setOpenMeta] = useState<string | null>(null);
  const storeRef = useRef<WorkspaceStore | null>(null);
  const getStore = useCallback(() => {
    if (storeFactory) return storeFactory();
    if (!storeRef.current) {
      try {
        storeRef.current = IndexedDbWorkspaceStore.open();
      } catch (e: any) {
        throw new Error(e?.message || 'workspace_indexeddb_unavailable');
      }
    }
    return storeRef.current;
  }, [storeFactory]);

  const publish = useCallback(
    (next: WorkspaceUiState | null) => {
      setState(next);
      onStateChange?.(next);
    },
    [onStateChange],
  );

  // P36: accept proposed ChangeSet from parent (structured or text).
  useEffect(() => {
    if (proposedChangeSet == null || proposedChangeSet === '') {
      return;
    }
    if (typeof proposedChangeSet === 'string') {
      const parsed = parseChangeSetFromText(proposedChangeSet);
      setPendingCs(parsed);
      if (!parsed) setError('Could not parse a workspace ChangeSet from the agent reply.');
    } else {
      setPendingCs(proposedChangeSet);
    }
  }, [proposedChangeSet]);

  // Keep a bounded, privacy-gated attachment payload ready for every mode's agent requests.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!state?.privacyAck || !onAttachmentsChange) {
        onAttachmentsChange?.([]);
        return;
      }
      try {
        const store = getStore();
        const attachments: { name: string; kind: string; text: string }[] = [];
        let budget = 60_000;
        for (const entry of state.entries) {
          if (budget <= 0 || attachments.length >= 40) break;
          if (entry.flags.includes('secret')) continue;
          // P35: readWorkspaceFile runs FileContentExtractor (PDF/Office/CSV/…).
          const read = await readWorkspaceFile(store, state.workspaceId, state.version, entry.path);
          let text = read.formatted || read.text;
          if (!text) {
            // Keep arbitrary binary formats uploadable and visible to the agent as metadata,
            // without pretending their binary contents were decoded.
            text = `Binary or specialized file; content was not decoded.
Path: ${entry.path}
Class: ${entry.class}
Size: ${entry.size} bytes
SHA-256: ${entry.sha256}`;
          }
          const max = Math.min(8_000, budget);
          const content = text.slice(0, max);
          attachments.push({
            name: entry.path,
            kind: read.extract?.metadataOnly ? 'metadata' : 'text',
            text: content + (content.length < text.length ? '\n[truncated]' : ''),
          });
          budget -= content.length;
        }
        if (!cancelled) onAttachmentsChange(attachments);
      } catch {
        if (!cancelled) onAttachmentsChange([]);
      }
    })();
    return () => { cancelled = true; };
  }, [state, getStore, onAttachmentsChange]);

  const runIngest = async (resultPromise: Promise<Awaited<ReturnType<typeof ingestArchive>>>, name: string) => {
    onAttachmentsChange?.([]);
    setBusy(true);
    setError(null);
    setStatus('Reading archive…');
    setOpenPath(null);
    setOpenText(null);
    setOpenMeta(null);
    try {
      const result = await resultPromise;
      if (result.report.rejected) {
        setError(`Rejected: ${result.report.rejected}${result.report.rejectDetail ? ` (${result.report.rejectDetail})` : ''}`);
        publish(null);
        return;
      }
      setStatus('Saving to this device…');
      const store = getStore();
      const persisted = await persistIngestResult(store, result, name);
      if (persisted.ok === false) {
        setError(`Could not save workspace: ${persisted.code}${persisted.detail ? ` — ${persisted.detail}` : ''}`);
        publish(null);
        return;
      }
      const next: WorkspaceUiState = {
        workspaceId: persisted.workspaceId,
        name,
        version: persisted.version.no,
        privacyAck: false,
        entries: result.entries.slice().sort((a, b) => a.path.localeCompare(b.path)),
        report: result.report,
        languagesLine: languageSummaryLine(result.entries),
      };
      publish(next);
      setStatus(
        `Ready: ${next.entries.length} file(s) in workspace. Confirm privacy so the agent can read them, then say what to do.`,
      );
      // Bring the privacy control into view (user is often at the bottom composer after Attach).
      requestAnimationFrame(() => {
        privacyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    } catch (e: any) {
      setError(e?.message || 'Ingest failed');
      publish(null);
    } finally {
      setBusy(false);
    }
  };

  /** P37: one attach path — archives unpack, other files become workspace entries. */
  const onAttach = async (list: FileList | null) => {
    if (!list?.length || disabled || busy) return;
    const files = Array.from(list);
    // P55: the originals the person attached also go to Drive → BiForge → <mode>, in every mode.
    // A whole folder from this computer (hundreds of files) is not copied one by one; it is already on the person's disk.
    for (const f of files.filter((x) => !(x as File & { webkitRelativePath?: string }).webkitRelativePath).slice(0, 10)) void mirrorUserFile(f);
    const archives = files.filter((f) => isArchiveFileName(f.name));
    const normals = files.filter((f) => !isArchiveFileName(f.name));

    // Single archive (typical "project zip") → unpack into tree.
    if (archives.length === 1 && normals.length === 0) {
      const file = archives[0]!;
      const buf = new Uint8Array(await file.arrayBuffer());
      await runIngest(
        ingestArchive(buf),
        file.name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '') || 'workspace',
      );
    } else if (archives.length === 0) {
      // Plain files or a folder selection (webkitRelativePath).
      const label =
        files[0]?.webkitRelativePath?.split('/')[0] ||
        (files.length === 1 ? files[0]!.name.replace(/\.[^.]+$/, '') : `files-${files.length}`) ||
        'workspace';
      await runIngest(ingestFiles(files), label);
    } else if (archives.length === 1 && normals.length > 0) {
      // One zip plus loose files: unpack zip only (clearer than mixing opaque zip blob).
      setError('Choose either one project archive or individual files in one step (not both).');
    } else {
      setError('Attach one project archive at a time, or attach individual files without a zip.');
    }
    if (filesRef.current) filesRef.current.value = '';
    if (folderRef.current) folderRef.current.value = '';
  };

  const onAttachRef = useRef(onAttach);
  onAttachRef.current = onAttach;

  // Drag/drop and composer "Add file" → same workspace path (one place for the agent).
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      const incoming = detail?.files as File[] | undefined;
      if (!incoming?.length) return;
      const dt = new DataTransfer();
      for (const f of incoming) dt.items.add(f);
      void onAttachRef.current(dt.files);
    };
    window.addEventListener('be:attach-files', handler as EventListener);
    return () => window.removeEventListener('be:attach-files', handler as EventListener);
  }, []);

  // Folder import is offered only from the «More» menu (desktop); it fires this event.
  useEffect(() => {
    const handler = () => {
      if (disabled || busy) return;
      folderRef.current?.click();
    };
    window.addEventListener(PICK_FOLDER_EVENT, handler);
    return () => window.removeEventListener(PICK_FOLDER_EVENT, handler);
  }, [disabled, busy]);

  const ackPrivacy = async () => {
    if (!state || state.privacyAck) return;
    try {
      const store = getStore();
      if (store.setPrivacyAck) await store.setPrivacyAck(state.workspaceId, true);
      const next = { ...state, privacyAck: true };
      publish(next);
    } catch (e: any) {
      setError(e?.message || 'Could not save privacy acknowledgement');
    }
  };

  const runExport = async (mode: ExportMode) => {
    if (!state || disabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      const store = getStore();
      const result = await exportWorkspace(store, state.workspaceId, {
        mode,
        version: state.version,
        baseVersion: mode === 'full' ? undefined : Math.max(1, state.version - 1),
        name: state.name,
        skipRulesNote: state.report?.skipped?.slice(0, 5).map((s) => s.reason),
      });
      // Copy into a fresh ArrayBuffer-backed view (TS BlobPart + some runtimes reject SharedArrayBuffer views).
      const payload = Uint8Array.from(result.bytes);
      const blob = new Blob([payload], {
        type: mode === 'diff' ? 'text/plain;charset=utf-8' : 'application/zip',
      });
      // P55: what the agent produced (the changed package or the full archive) is kept on Drive too.
      void mirrorBlob({ name: result.filename, data: blob, mimeType: blob.type, localKey: `workspace_${state.workspaceId}_${state.version}_${mode}` });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(
        mode === 'full'
          ? `Downloaded ${result.files} file(s) as ${result.filename}`
          : mode === 'diff'
            ? `Downloaded diff ${result.filename}`
            : `Downloaded changed package ${result.filename}`,
      );
    } catch (e: any) {
      setError(e?.message || 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    onAttachmentsChange?.([]);
    if (state) {
      try {
        const store = getStore();
        await store.deleteWorkspace(state.workspaceId);
      } catch {
        /* best effort */
      }
    }
    publish(null);
    setError(null);
    setStatus(null);
    setOpenPath(null);
    setOpenText(null);
    setOpenMeta(null);
  };

  const openEntry = async (entry: Entry) => {
    if (!state) return;
    setOpenPath(entry.path);
    setOpenText(null);
    setOpenMeta(null);
    try {
      const store = getStore();
      const read = await readWorkspaceFile(store, state.workspaceId, state.version, entry.path);
      // P35: prefer extracted text; show honest metadata when not decoded.
      if (read.extract && !read.extract.metadataOnly && read.text) {
        setOpenText(read.text);
        setOpenMeta(null);
      } else if (read.text && !read.reason) {
        setOpenText(read.text);
        setOpenMeta(null);
      } else {
        setOpenText(null);
        setOpenMeta(
          [
            `Path: ${entry.path}`,
            `Class: ${entry.class}`,
            entry.lang ? `Language: ${entry.lang}` : null,
            `Size: ${entry.size} bytes`,
            `SHA-256: ${entry.sha256.slice(0, 12)}…`,
            read.extract?.meta?.note || read.reason || 'Binary or non-text — content not shown.',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
    } catch (e: any) {
      setOpenMeta(e?.message || 'Could not open file');
    }
  };

  const skippedPreview = useMemo(() => {
    const sk = state?.report?.skipped || [];
    return sk.slice(0, 8);
  }, [state]);

  return (
    <div className="workspace-panel" data-testid="workspace-panel">
      <div className="workspace-panel-buttons">
        {/* Attach: composer «Attach files» → be:attach-files. Folder import lives in More → Import (desktop only). */}
        <input
          ref={filesRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => void onAttach(e.target.files)}
        />
        <input
          ref={folderRef}
          type="file"
          // @ts-expect-error webkitdirectory is non-standard but widely supported on desktop
          webkitdirectory=""
          directory=""
          multiple
          style={{ display: 'none' }}
          onChange={(e) => void onAttach(e.target.files)}
        />
      </div>

      {status && <div className="files-panel-status">{status}</div>}
      {error && <div className="files-panel-warn" role="alert">{error}</div>}
      {!state && (
        <div className="files-panel-status">
          Attach files with <strong>Attach files</strong> under the message box (a zip is unpacked automatically).
        </div>
      )}

      {state && (
        <div className="workspace-card" data-testid="workspace-card">
          <div className="workspace-card-head">
            <strong>{state.name}</strong>
            <button type="button" className="ghost" onClick={() => void clear()} title="Remove local workspace" aria-label="Clear workspace">
              <X size={14} />
            </button>
          </div>
          <div className="workspace-card-meta">
            {state.entries.length} files · v{state.version}
            {state.languagesLine ? ` · ${state.languagesLine}` : ''}
            {state.report?.skipped?.length ? ` · skipped ${state.report.skipped.length}` : ''}
          </div>

          <div className="workspace-panel-buttons" data-testid="workspace-export" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <button
              type="button"
              className="ghost files-panel-btn"
              disabled={disabled || busy || state.entries.length === 0}
              onClick={() => void runExport('full')}
              title="Download every file in this workspace as a zip (original bytes)"
            >
              <Download size={16} />
              <span>Download all (.zip)</span>
            </button>
            <button
              type="button"
              className="ghost files-panel-btn"
              disabled={disabled || busy || state.version < 2}
              onClick={() => void runExport('changed')}
              title="Zip of files that differ from the previous version, plus a change list"
            >
              <Download size={16} />
              <span>Changes only</span>
            </button>
            <button
              type="button"
              className="ghost files-panel-btn"
              disabled={disabled || busy || state.version < 2}
              onClick={() => void runExport('diff')}
              title="Unified text diff versus the previous version"
            >
              <Download size={16} />
              <span>Text diff</span>
            </button>
          </div>

          {!state.privacyAck ? (
            <div className="workspace-privacy" data-testid="workspace-privacy" ref={privacyRef}>
              <p>
                Files stay on this device until you allow access. After you confirm, the assistant can read them with your messages (not only on this screen).
                Do not add passwords, keys, or private data you are not willing to share with the model.
              </p>
              <button type="button" className="primary" disabled={disabled} onClick={() => void ackPrivacy()}>
                I understand — let the assistant read these files
              </button>
              {!canBuildWorkspaceContext(state.privacyAck) && (
                <span className="files-panel-warn"> Workspace is not sent to the model until you confirm.</span>
              )}
            </div>
          ) : (
            <div className="files-panel-status" data-testid="workspace-context-status">
              Assistant can use {state.entries.length} file(s) from this workspace on your next messages. Say in the chat what to do with them.</div>
          )}

          {skippedPreview.length > 0 && (
            <details className="workspace-skipped">
              <summary>Skipped ({state.report?.skipped.length})</summary>
              <ul>
                {skippedPreview.map((s) => (
                  <li key={s.path + s.reason}>
                    <code>{s.path}</code> — {s.reason}
                    {s.detail ? ` (${s.detail})` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="workspace-tree" data-testid="workspace-tree">
            {state.entries.map((e) => (
              <button
                type="button"
                key={e.path}
                className={`workspace-tree-item${openPath === e.path ? ' active' : ''}`}
                onClick={() => void openEntry(e)}
              >
                <ChevronRight size={12} />
                <span className="workspace-tree-path">{e.path}</span>
                <span className="workspace-tree-lang">{e.lang || e.class}</span>
              </button>
            ))}
          </div>

          {pendingCs && state.privacyAck && (
            <WorkspaceChangeSetCard
              store={getStore()}
              workspaceId={state.workspaceId}
              headVersion={state.version}
              changeSet={pendingCs}
              disabled={disabled || busy}
              onApplied={({ version, entries }) => {
                const next = {
                  ...state,
                  version,
                  entries: entries.slice().sort((a, b) => a.path.localeCompare(b.path)),
                  languagesLine: languageSummaryLine(entries),
                };
                publish(next);
                setPendingCs(null);
                onChangeSetSettled?.();
                setStatus(`Applied changes → workspace v${version}`);
              }}
              onRejected={() => {
                setPendingCs(null);
                onChangeSetSettled?.();
                setStatus('ChangeSet rejected — workspace unchanged');
              }}
              onRolledBack={({ version, entries }) => {
                const next = {
                  ...state,
                  version,
                  entries: entries.slice().sort((a, b) => a.path.localeCompare(b.path)),
                  languagesLine: languageSummaryLine(entries),
                };
                publish(next);
                setStatus(`Rolled back → workspace v${version}`);
              }}
            />
          )}

          {(openText != null || openMeta != null) && (
            <pre className="workspace-file-view" data-testid="workspace-file-view">
              {openText != null ? openText : openMeta}
            </pre>
          )}
        </div>
      )}
      {state && !state.privacyAck && state.entries.length > 0 && (
        <div className="workspace-privacy-sticky" data-testid="workspace-privacy-sticky" role="status">
          <div className="workspace-privacy-sticky-inner">
            <span>
              <strong>{state.entries.length} file(s)</strong> waiting: allow the assistant to read them, or they stay on this device only.
            </span>
            <button type="button" className="primary" disabled={disabled} onClick={() => void ackPrivacy()}>
              I understand — allow read
            </button>
            <button type="button" className="ghost" onClick={() => privacyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
              Show details
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

