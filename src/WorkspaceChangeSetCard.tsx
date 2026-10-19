/**
 * P36 — human confirmation card for workspace ChangeSet (diff → Apply / Reject / Rollback).
 * Version never advances until Apply succeeds.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  applyWorkspaceChangeSet,
  rollbackWorkspace,
  validateWorkspaceChangeSet,
  type FilePreview,
  type ValidateResult,
  type WorkspaceChangeSet,
} from './workspace/changeset.ts';
import type { Entry, WorkspaceStore } from './workspace/types.ts';

type Props = {
  store: WorkspaceStore;
  workspaceId: string;
  /** Current head version shown in the panel. */
  headVersion: number;
  changeSet: WorkspaceChangeSet;
  disabled?: boolean;
  onApplied: (next: { version: number; entries: Entry[] }) => void;
  onRejected: () => void;
  onRolledBack?: (next: { version: number; entries: Entry[] }) => void;
};

export function WorkspaceChangeSetCard({
  store,
  workspaceId,
  headVersion,
  changeSet,
  disabled,
  onApplied,
  onRejected,
  onRolledBack,
}: Props) {
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCiLock, setConfirmCiLock] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setValidation(null);
    void (async () => {
      try {
        const cs = confirmCiLock ? { ...changeSet, confirmCiLock: true } : changeSet;
        const v = await validateWorkspaceChangeSet(store, workspaceId, cs);
        if (!cancelled) setValidation(v);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Validation failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, workspaceId, changeSet, confirmCiLock]);

  const apply = useCallback(async () => {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const cs = confirmCiLock ? { ...changeSet, confirmCiLock: true } : changeSet;
      const result = await applyWorkspaceChangeSet(store, workspaceId, cs);
      if (result.ok === false) {
        const violations = result.violations;
        setError(violations.map((v) => `${v.code}${v.path ? ` (${v.path})` : ''}`).join('; '));
        setValidation({
          ok: false,
          violations,
          previews: [],
          totals: { files: 0, added: 0, removed: 0 },
          needsCiLockConfirm: false,
        });
        return;
      }
      const entries = await store.getManifest(workspaceId, result.version.no);
      onApplied({ version: result.version.no, entries });
    } catch (e: any) {
      setError(e?.message || 'Apply failed');
    } finally {
      setBusy(false);
    }
  }, [busy, disabled, confirmCiLock, changeSet, store, workspaceId, onApplied]);

  const rollback = useCallback(async () => {
    if (busy || disabled || headVersion < 2) return;
    setBusy(true);
    setError(null);
    try {
      const target = headVersion - 1;
      const version = await rollbackWorkspace(store, workspaceId, target);
      const entries = await store.getManifest(workspaceId, version.no);
      onRolledBack?.({ version: version.no, entries });
      onRejected();
    } catch (e: any) {
      setError(e?.message || 'Rollback failed');
    } finally {
      setBusy(false);
    }
  }, [busy, disabled, headVersion, store, workspaceId, onRolledBack, onRejected]);

  const previews: FilePreview[] = validation?.previews || [];
  const canApply = Boolean(validation?.ok) && !busy && !disabled;

  return (
    <div className="workspace-changeset-card" data-testid="workspace-changeset-card">
      <div className="workspace-card-head">
        <strong>Proposed changes</strong>
        <span className="workspace-card-meta">
          base v{changeSet.baseVersion}
          {changeSet.message ? ` · ${changeSet.message}` : ''}
          {validation
            ? ` · ${validation.totals.files} file(s), +${validation.totals.added}/−${validation.totals.removed}`
            : ''}
        </span>
      </div>

      {error && (
        <div className="files-panel-warn" role="alert">
          {error}
        </div>
      )}

      {validation && !validation.ok && (
        <div className="files-panel-warn" data-testid="workspace-changeset-violations">
          Cannot apply until fixed:
          <ul>
            {validation.violations.map((v, i) => (
              <li key={i}>
                <code>{v.code}</code>
                {v.path ? ` — ${v.path}` : ''}
                {v.detail ? ` (${v.detail})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {validation?.needsCiLockConfirm && (
        <label className="workspace-privacy" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={confirmCiLock}
            onChange={(e) => setConfirmCiLock(e.target.checked)}
            disabled={disabled || busy}
          />
          <span>I confirm changes to CI / lockfile paths</span>
        </label>
      )}

      <div className="workspace-changeset-diffs" data-testid="workspace-changeset-diffs">
        {previews.map((p) => (
          <details key={p.path + (p.newPath || '')} open={previews.length <= 3}>
            <summary>
              <code>{p.action}</code> {p.path}
              {p.newPath ? ` → ${p.newPath}` : ''} (+{p.added}/−{p.removed})
            </summary>
            <pre className="workspace-file-view">{p.diff || '(no text diff)'}</pre>
          </details>
        ))}
      </div>

      <div className="workspace-panel-buttons" style={{ marginTop: 8 }}>
        <button type="button" className="primary" disabled={!canApply} onClick={() => void apply()} data-testid="workspace-changeset-apply">
          {busy ? 'Applying…' : 'Apply'}
        </button>
        <button type="button" className="ghost files-panel-btn" disabled={busy || disabled} onClick={onRejected} data-testid="workspace-changeset-reject">
          Reject
        </button>
        {headVersion >= 2 && onRolledBack && (
          <button
            type="button"
            className="ghost files-panel-btn"
            disabled={busy || disabled}
            onClick={() => void rollback()}
            title={`Create a new version restoring content of v${headVersion - 1}`}
            data-testid="workspace-changeset-rollback"
          >
            Rollback to v{headVersion - 1}
          </button>
        )}
      </div>
      <p className="files-panel-status">Draft only until Apply. Reject keeps files unchanged. Rollback restores a previous snapshot as a new version.</p>
    </div>
  );
}
