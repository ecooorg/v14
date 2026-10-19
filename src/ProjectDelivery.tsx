/**
 * P54: Project «Delivery» tab. Manual Code Delivery and checks, all with GitHub read-only (ADR-06 Amendment 1).
 * BiForge prepares the package and reads the result; the person works elsewhere, reviews and decides. Nothing is merged here,
 * nothing is decided automatically, nothing polls. The server stays the authority for every rule.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Capabilities } from './projectCapabilities.ts';
import {
  CODE_STATE_LABELS, NO_COMMIT_NOTE, STEP_LABELS, STEP_ORDER, deliveryErrorMessage, gateRows, handoffText, latestPerTask, nextDeliveryAction, shortSha, stopReasonLabel,
  type CodeTaskView, type GatesData,
} from './projectDeliveryModel.ts';

type Payload<T> = { success?: boolean; data?: T; error?: string; code?: string; changed?: boolean; findings?: unknown };
class DeliveryCallError extends Error { code?: string; }

/** One request. Keeps the whole payload (refresh answers `changed` beside `data`) and the error code (plain sentence for the person). */
async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<Payload<T>> {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const p = await r.json().catch(() => ({})) as Payload<T>;
  if (!r.ok || p.success === false) {
    const e = new DeliveryCallError(deliveryErrorMessage(p.code, p.error || `Request failed (${r.status})`));
    e.code = p.code; throw e;
  }
  return p;
}

const S: Record<string, React.CSSProperties> = {
  box: { margin: '12px 0', padding: 12, border: '1px solid #1f4f86', borderRadius: 8 },
  button: { minHeight: 44, padding: '10px 16px', border: '1px solid #3d7fc4', borderRadius: 8, background: '#0b2545', color: '#9fd8ff', cursor: 'pointer' },
  danger: { minHeight: 44, padding: '10px 16px', border: '1px solid #a6584f', borderRadius: 8, background: '#2a1414', color: '#f1b3ac', cursor: 'pointer' },
  input: { width: '100%', boxSizing: 'border-box', minHeight: 44, padding: 10, border: '1px solid #3d7fc4', borderRadius: 8, background: '#07111f', color: '#e6edf7', fontSize: 16 },
  muted: { fontSize: 13, color: '#8fa6c2' },
  row: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
};
const dim = (on: boolean): React.CSSProperties => ({ opacity: on ? 1 : 0.45 });

function Confirm({ title, text, needReason, reasonLabel, confirmLabel, danger, busy, onConfirm, onCancel }: {
  title: string; text: string; needReason: boolean; reasonLabel?: string; confirmLabel: string; danger?: boolean; busy: boolean; onConfirm: (reason: string) => void; onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const blocked = busy || (needReason && !reason.trim());
  return <div role="alertdialog" aria-label={title} style={{ ...S.box, borderColor: danger ? '#a6584f' : '#e6c07a' }}>
    <strong>{title}</strong>
    <p style={S.muted}>{text}</p>
    <textarea aria-label={reasonLabel || 'Reason'} placeholder={reasonLabel || 'Reason'} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} style={{ ...S.input, minHeight: 0 }} />
    <div style={{ ...S.row, marginTop: 8 }}>
      <button type="button" style={{ ...(danger ? S.danger : S.button), ...dim(!blocked) }} disabled={blocked} onClick={() => onConfirm(reason.trim())}>{confirmLabel}</button>
      <button type="button" style={S.button} disabled={busy} onClick={onCancel}>Back</button>
    </div>
  </div>;
}

export default function ProjectDelivery({ projectId, capabilities, passportConfirmed, executor, focusTaskId, onFocusHandled }: {
  projectId: string; capabilities: Capabilities | null; passportConfirmed: boolean; executor: string; focusTaskId?: string | null; onFocusHandled?: () => void;
}) {
  const [all, setAll] = useState<CodeTaskView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [gates, setGates] = useState<GatesData | null>(null);
  const [gatesError, setGatesError] = useState('');
  const [pending, setPending] = useState<null | { kind: 'cancel' } | { kind: 'decide'; decision: 'accept' | 'repair' | 'reject' } | { kind: 'waive'; gate: string } | { kind: 'gate-fail'; gate: string }>(null);
  const idemKey = useRef<string>('');
  const newKey = () => { idemKey.current = (globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`); };
  const [form, setForm] = useState({ goal: '', constraints: '', acceptance: '' });
  const [resultKind, setResultKind] = useState<'pr' | 'branch' | 'diff'>('pr');
  const [resultValue, setResultValue] = useState('');
  const [diffText, setDiffText] = useState('');
  const [reviewNotes, setReviewNotes] = useState('');
  const [repair, setRepair] = useState({ trigger: 'human' as 'ci' | 'reviewer' | 'human', flaky: false, log: '' });
  const [repairOutcome, setRepairOutcome] = useState('');

  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const selected = all.find((c) => c.id === selectedId) ?? null;
  const tasks = latestPerTask(all);
  const root = (c: CodeTaskView) => `${base}/tasks/${encodeURIComponent(c.taskId)}/code/${encodeURIComponent(c.id)}`;

  const reload = useCallback(async () => {
    try { const p = await call<CodeTaskView[]>('GET', `${base}/code`); setAll(p.data ?? []); setError(''); }
    catch (e) { setError((e as Error).message); }
    finally { setLoaded(true); }
  }, [base]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!focusTaskId || !loaded) return;
    const hit = latestPerTask(all).find((c) => c.taskId === focusTaskId);
    if (hit) setSelectedId(hit.id);
    onFocusHandled?.();   // consume the link once, so going back to the list does not reselect
  }, [focusTaskId, loaded, all, onFocusHandled]);

  const loadGates = useCallback(async (c: CodeTaskView | null) => {
    if (!c) { setGates(null); return; }
    try { const p = await call<GatesData>('GET', `${base}/tasks/${encodeURIComponent(c.taskId)}/gates`); setGates(p.data ?? null); setGatesError(''); }
    catch (e) { setGates(null); setGatesError((e as Error).message); }
  }, [base]);
  const gateKey = selected ? `${selected.id}:${selected.status}:${selected.headSha ?? ''}` : '';
  useEffect(() => { void loadGates(selected); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [gateKey, loadGates]);
  useEffect(() => { setPending(null); setRepairOutcome(''); setResultValue(''); setDiffText(''); }, [selectedId]);

  /** Runs one action: busy flag, plain error, plain notice, then a reload. Never retries and never decides for the person. */
  const act = async (fn: () => Promise<string | void>) => {
    setBusy(true); setError(''); setNotice('');
    try { const msg = await fn(); if (msg) setNotice(msg); await reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setPending(null); }
  };

  const createTask = () => act(async () => {
    if (!idemKey.current) newKey();
    const body: Record<string, unknown> = { goal: form.goal.trim(), idempotency_key: idemKey.current };
    if (form.constraints.trim()) body.constraints = form.constraints.trim();
    if (form.acceptance.trim()) body.acceptance_criteria = form.acceptance.trim();
    const p = await call<{ taskId: string; codeTask: CodeTaskView }>('POST', `${base}/code/manual`, body);
    setForm({ goal: '', constraints: '', acceptance: '' }); newKey(); setCreating(false);
    if (p.data?.codeTask) setSelectedId(p.data.codeTask.id);
    return 'Hand-off task created. Download the package and approve it when you are ready.';
  });
  const downloadPackage = (c: CodeTaskView) => act(async () => {
    const p = await call<{ filename: string; text: string }>('GET', `${root(c)}/package`);
    const blob = new Blob([p.data?.text ?? ''], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = p.data?.filename || 'PACKAGE.md'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return 'PACKAGE.md saved.';
  });
  const approvePackage = (c: CodeTaskView) => act(async () => { await call('POST', `${root(c)}/approve`, {}); return 'Package approved.'; });
  const commitPackage = (c: CodeTaskView) => act(async () => { await call('POST', `${root(c)}/commit-package`, {}); return 'Package committed to the task branch.'; });
  const submitResult = (c: CodeTaskView) => act(async () => {
    const v = resultValue.trim();
    const body = resultKind === 'pr' ? { kind: 'pr', pr_number: Number.parseInt(v, 10) }
      : resultKind === 'branch' ? { kind: 'branch', branch: v }
      : { kind: 'diff', diff: diffText };
    if (resultKind === 'pr' && !(Number.parseInt(v, 10) >= 1)) throw new Error('Enter the pull request number.');
    await call('POST', `${root(c)}/result`, body); setResultValue(''); setDiffText('');
    return 'Result received. Refresh from GitHub to see the checks.';
  });
  const refreshFromGithub = (c: CodeTaskView) => act(async () => {
    const p = await call<CodeTaskView>('POST', `${root(c)}/refresh`, {});
    await loadGates(c);
    return p.changed ? 'Updated from GitHub.' : 'No change on GitHub.';
  });
  const runReview = (c: CodeTaskView) => act(async () => {
    await call('POST', `${root(c)}/review`, reviewNotes.trim() ? { notes: reviewNotes.trim() } : {}); setReviewNotes('');
    return 'Review finished.';
  });
  const decide = (c: CodeTaskView, decision: 'accept' | 'repair' | 'reject', reason: string) => act(async () => {
    await call('POST', `${root(c)}/decide`, { decision, ...(reason ? { reason } : {}) });
    return decision === 'accept' ? 'Accepted. Merge it in GitHub yourself; BiForge never merges.' : decision === 'repair' ? 'Marked for repair.' : 'Rejected.';
  });
  const requestRepair = (c: CodeTaskView) => act(async () => {
    const p = await call<{ action: string; reasons?: string[]; diagnostic?: string }>('POST', `${root(c)}/repair`, { trigger: repair.trigger, ...(repair.flaky ? { flaky: true } : {}), ...(repair.log.trim() ? { log_excerpt: repair.log.trim().slice(0, 2000) } : {}) });
    const d = p.data;
    const msg = d?.action === 'stopped' ? `Repair stopped: ${(d.reasons ?? []).map(stopReasonLabel).join('; ') || 'see the report'}.`
      : d?.action === 'ci_restart' ? 'Checks will be restarted. Refresh from GitHub in a moment.' : 'A new package for the next attempt is ready.';
    setRepairOutcome(msg); setRepair({ ...repair, log: '' });
    return msg;
  });
  const cancel = (c: CodeTaskView, reason: string) => act(async () => { await call('POST', `${root(c)}/cancel`, { reason }); return 'Task closed.'; });
  const approveGate = (c: CodeTaskView, gate: string, status: 'PASS' | 'FAIL') => act(async () => {
    await call('POST', `${base}/tasks/${encodeURIComponent(c.taskId)}/gates/${gate}/approve`, { status }); await loadGates(c);
    return status === 'PASS' ? 'Approved.' : 'Marked as not approved.';
  });
  const waiveGate = (c: CodeTaskView, gate: string, reason: string) => act(async () => {
    if (!gates?.commit) throw new Error(NO_COMMIT_NOTE(c.expectedBranch));
    await call('POST', `${base}/tasks/${encodeURIComponent(c.taskId)}/gates/${gate}/waive`, { commit_sha: gates.commit, reason }); await loadGates(c);
    return 'Waived. Your reason is recorded.';
  });
  const copy = async (text: string) => { try { await navigator.clipboard?.writeText(text); setNotice('Copied.'); } catch { setNotice('Could not copy. Select the text and copy it by hand.'); } };

  const newDisabledReason = !passportConfirmed ? 'Confirm the project description first.' : executor !== 'manual' ? 'Set «How code is written» to Manual in the project settings.' : '';
  const action = selected ? nextDeliveryAction(selected, capabilities) : null;
  const rows = gateRows(gates);

  return <section aria-label="Delivery" style={{ margin: '16px 0' }}>
    <h3 style={{ marginBottom: 4 }}>Delivery</h3>
    <p style={S.muted}>Hand a coding task to any tool you like, then bring the result back here: BiForge reads the pull request and its checks, and you review and decide. BiForge never merges and never writes to GitHub.</p>
    <div style={{ ...S.box, background: '#0b2545' }}>
      <strong style={{ fontSize: 13 }}>How Delivery works (4 steps)</strong>
      <ol style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 13, color: '#c5d4e8', lineHeight: 1.55 }}>
        <li><strong>Create</strong> a hand-off task and download PACKAGE.md (the brief for your external tool).</li>
        <li><strong>Work outside</strong> BiForge (your editor, agent, or CI). The server does not write your code for you here.</li>
        <li><strong>Refresh from GitHub</strong> (read-only) so BiForge can see the pull request and checks.</li>
        <li><strong>You decide</strong>: accept, request repair, or reject. Merge only in GitHub by you — never by BiForge.</li>
      </ol>
      <p style={{ ...S.muted, marginBottom: 0, marginTop: 8 }}>Gates, fingerprints, and waive live under <em>Advanced details</em> on a task.</p>
    </div>
    <div role="status" aria-live="polite" style={{ minHeight: 20, fontSize: 13, color: '#9fd8ff' }}>{notice}</div>
    {error && <div role="alert" style={{ ...S.box, borderColor: '#a6584f', color: '#f1b3ac' }}>{error}</div>}

    {!selected && <>
      <div style={S.row}>
        <button type="button" style={{ ...S.button, ...dim(!newDisabledReason) }} disabled={Boolean(newDisabledReason) || busy} onClick={() => { newKey(); setCreating((v) => !v); }}>New hand-off task</button>
        {newDisabledReason && <span style={{ ...S.muted, color: '#e6c07a' }}>{newDisabledReason}</span>}
      </div>
      {creating && <div style={S.box}>
        <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>What should be done
          <textarea aria-label="Goal of the hand-off task" value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} rows={3} maxLength={4000} style={{ ...S.input, minHeight: 0 }} /></label>
        <label style={{ display: 'grid', gap: 4, fontSize: 13, marginTop: 8 }}>Limits and constraints (optional)
          <textarea aria-label="Constraints" value={form.constraints} onChange={(e) => setForm({ ...form, constraints: e.target.value })} rows={2} maxLength={4000} style={{ ...S.input, minHeight: 0 }} /></label>
        <label style={{ display: 'grid', gap: 4, fontSize: 13, marginTop: 8 }}>How you will know it is done (optional)
          <textarea aria-label="Acceptance criteria" value={form.acceptance} onChange={(e) => setForm({ ...form, acceptance: e.target.value })} rows={2} maxLength={4000} style={{ ...S.input, minHeight: 0 }} /></label>
        <div style={{ ...S.row, marginTop: 8 }}>
          <button type="button" style={{ ...S.button, ...dim(Boolean(form.goal.trim()) && !busy) }} disabled={!form.goal.trim() || busy} onClick={() => void createTask()}>Create task</button>
          <button type="button" style={S.button} disabled={busy} onClick={() => setCreating(false)}>Back</button>
        </div>
      </div>}
      {loaded && tasks.length === 0 && !creating && <p style={S.muted}>No hand-off tasks yet.</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0' }}>
        {tasks.map((c) => <li key={c.id} style={{ ...S.box, margin: '8px 0' }}>
          <strong>{c.taskTitle || c.taskId}</strong><br />
          <small style={S.muted}>{CODE_STATE_LABELS[c.status] ?? c.status}{c.decision ? ` · ${c.decision === 'accept' ? 'accepted' : c.decision === 'repair' ? 'repair requested' : 'rejected'}` : ''}{c.attempt > 1 ? ` · attempt ${c.attempt}` : ''}</small>
          <div style={{ marginTop: 8 }}><button type="button" style={S.button} onClick={() => setSelectedId(c.id)}>Open</button></div>
        </li>)}
      </ul>
    </>}

    {selected && action && <div>
      <button type="button" style={S.button} onClick={() => setSelectedId(null)}>← All tasks</button>
      <h4 style={{ marginBottom: 2 }}>{selected.taskTitle || selected.taskId}</h4>
      <p style={{ ...S.muted, marginTop: 0 }}>{CODE_STATE_LABELS[selected.status] ?? selected.status}{selected.attempt > 1 ? ` · attempt ${selected.attempt}` : ''}{selected.statusReason ? ` · ${selected.statusReason}` : ''}</p>
      <ol aria-label="Steps" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, listStyle: 'none', padding: 0 }}>
        {STEP_ORDER.map((s) => <li key={s} aria-current={s === action.step ? 'step' : undefined} style={{ padding: '4px 10px', borderRadius: 999, border: `1px solid ${s === action.step ? '#78baff' : '#25405e'}`, color: s === action.step ? '#e6edf7' : '#8fa6c2', background: s === action.step ? '#12345a' : 'transparent', fontSize: 13 }}>{STEP_LABELS[s]}</li>)}
        {action.step === 'closed' && <li aria-current="step" style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid #78baff', fontSize: 13 }}>{STEP_LABELS.closed}</li>}
      </ol>

      <div style={S.box}>
        <strong>1 · Package</strong>
        <p style={S.muted}>Fingerprint {selected.packageHash.slice(0, 12)} · {selected.packageApprovedAt ? 'approved' : 'not approved yet'}</p>
        <div style={S.row}>
          <button type="button" style={S.button} disabled={busy} onClick={() => void downloadPackage(selected)}>Download PACKAGE.md</button>
          {action.canApprovePackage && <button type="button" style={S.button} disabled={busy} onClick={() => void approvePackage(selected)}>Approve package</button>}
        </div>
      </div>

      {(action.step === 'handoff' || action.step === 'result') && <div style={S.box}>
        <strong>2 · Hand-off</strong>
        <ol style={{ fontSize: 14, paddingLeft: 20 }}>{handoffText(selected.expectedBranch).map((t) => <li key={t}>{t}</li>)}</ol>
        {selected.expectedBranch && <div style={S.row}><code style={{ wordBreak: 'break-all' }}>{selected.expectedBranch}</code><button type="button" style={S.button} onClick={() => void copy(selected.expectedBranch!)}>Copy branch name</button></div>}
      </div>}

      {(action.canSubmitResult || action.needsGithubForResult) && <div style={S.box}>
        <strong>3 · Result</strong>
        {action.needsGithubForResult && <p style={{ ...S.muted, color: '#e6c07a' }}>GitHub is not connected to BiForge, so a returned result cannot be read yet. The package is still yours to use.</p>}
        {action.canSubmitResult && <>
          <div role="radiogroup" aria-label="Kind of result" style={{ ...S.row, margin: '8px 0' }}>
            {action.resultKinds.map((k) => <label key={k} style={{ ...S.row, gap: 6 }}><input type="radio" name="result-kind" checked={resultKind === k} onChange={() => setResultKind(k)} />{k === 'pr' ? 'Pull request number' : k === 'branch' ? 'Branch' : 'Diff'}</label>)}
          </div>
          {resultKind === 'diff' && action.resultKinds.includes('diff')
            ? <textarea aria-label="Diff" value={diffText} onChange={(e) => setDiffText(e.target.value)} rows={6} style={{ ...S.input, minHeight: 0, fontFamily: 'monospace', fontSize: 13 }} />
            : <input aria-label={resultKind === 'pr' ? 'Pull request number' : 'Branch name'} inputMode={resultKind === 'pr' ? 'numeric' : 'text'} value={resultValue} onChange={(e) => setResultValue(e.target.value)} placeholder={resultKind === 'pr' ? 'e.g. 12' : selected.expectedBranch ?? 'biforge/…'} style={S.input} />}
          <div style={{ ...S.row, marginTop: 8 }}>
            <button type="button" style={S.button} disabled={busy} onClick={() => void submitResult(selected)}>Send result</button>
            {action.showCommitPackage && <button type="button" style={S.button} disabled={busy} onClick={() => void commitPackage(selected)}>Commit package to the branch</button>}
          </div>
        </>}
      </div>}

      {(selected.status === 'DELIVERED' || selected.headSha) && <div style={S.box}>
        <strong>4 · Checks</strong>
        {selected.prUrl && <p style={S.muted}>Pull request: <a href={selected.prUrl} target="_blank" rel="noreferrer" style={{ color: '#78baff' }}>#{selected.prNumber}</a></p>}
        <div style={S.row}>
          {gates?.commit && <span style={S.muted}>Commit <code>{shortSha(gates.commit)}</code> <button type="button" style={{ ...S.button, minHeight: 32, padding: '2px 10px' }} onClick={() => void copy(gates.commit!)}>Copy</button></span>}
          {action.canRefresh && <button type="button" style={S.button} disabled={busy} onClick={() => void refreshFromGithub(selected)}>Refresh from GitHub</button>}
        </div>
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: '#9fd8ff', minHeight: 36 }}>Advanced details — gates, fingerprints, waive</summary>
          <div style={{ marginTop: 8 }}>
        {gatesError && <p role="alert" style={{ color: '#f1b3ac', fontSize: 13 }}>{gatesError}</p>}
        {!gatesError && rows.length === 0 && <p style={S.muted}>{NO_COMMIT_NOTE(selected.expectedBranch)}</p>}
        {rows.length > 0 && <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0' }}>
          {rows.map((r) => <li key={r.gate} style={{ padding: '8px 0', borderTop: '1px solid #25405e' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><strong>{r.label}</strong><span aria-label={`Status: ${r.statusLabel}`} style={{ color: r.status === 'PASS' || r.status === 'WAIVED' ? '#7ddc9a' : r.status === 'FAIL' ? '#f1b3ac' : '#e6c07a' }}>{r.statusLabel}</span></div>
            {r.reasons.length > 0 && <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13, color: '#8fa6c2' }}>{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
            {r.ciOnlyNote && <small style={S.muted}>{r.ciOnlyNote}</small>}
            <div style={{ ...S.row, marginTop: 4 }}>
              {r.canApprove && <button type="button" style={S.button} disabled={busy} onClick={() => void approveGate(selected, r.gate, 'PASS')}>Approve</button>}
              {r.canApprove && <button type="button" style={S.button} disabled={busy} onClick={() => void approveGate(selected, r.gate, 'FAIL')}>Not approved</button>}
              {r.canWaive && <button type="button" style={S.button} disabled={busy} onClick={() => setPending({ kind: 'waive', gate: r.gate })}>Waive…</button>}
            </div>
            {pending?.kind === 'waive' && pending.gate === r.gate && <Confirm title={`Waive «${r.label}»`} text="You accept this check without it passing, at this commit only. Your reason is recorded." needReason reasonLabel="Why do you waive this check?" confirmLabel="Waive" danger busy={busy} onConfirm={(reason) => void waiveGate(selected, r.gate, reason)} onCancel={() => setPending(null)} />}
          </li>)}
        </ul>}
        {gates?.manifest && <p style={S.muted}>Release summary: {gates.manifest.complete ? 'all checks settled at this commit' : 'not complete yet'}{gates.manifest.tools?.length ? ` · tools: ${gates.manifest.tools.join(', ')}` : ''}</p>}

          </div>
        </details>
      </div>}

      {selected.status === 'DELIVERED' && <div style={S.box}>
        <strong>5 · Review</strong>
        {selected.reviewFindings ? <>
          <p style={S.muted}>{selected.reviewFindings.summary}</p>
          <ul style={{ paddingLeft: 18, fontSize: 14 }}>{selected.reviewFindings.findings.map((f) => <li key={f.id}><strong>{f.severity}</strong> — {f.summary}{f.path ? ` (${f.path})` : ''}{f.detail ? <><br /><small style={S.muted}>{f.detail}</small></> : null}</li>)}</ul>
          {selected.reviewFindings.findings.length === 0 && <p style={S.muted}>No findings.</p>}
        </> : <p style={S.muted}>Run the review after the checks finish. It reads the checks and the delivery; it changes nothing.</p>}
        {action.canReview && <>
          <textarea aria-label="Notes for the review (optional)" placeholder="Notes for the review (optional)" value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} rows={2} maxLength={2000} style={{ ...S.input, minHeight: 0 }} />
          <div style={{ marginTop: 8 }}><button type="button" style={S.button} disabled={busy} onClick={() => void runReview(selected)}>Run review</button></div>
        </>}
      </div>}

      {selected.status === 'DELIVERED' && <div style={S.box}>
        <strong>6 · Your decision</strong>
        {selected.decision ? <p>{selected.decision === 'accept' ? 'Accepted' : selected.decision === 'repair' ? 'Repair requested' : 'Rejected'}{selected.decisionReason ? ` — ${selected.decisionReason}` : ''}</p> : <p style={S.muted}>Nothing is decided for you. Accepting does not merge: you merge in GitHub yourself.</p>}
        {action.canDecide && <div style={S.row}>
          <button type="button" style={S.button} disabled={busy} onClick={() => setPending({ kind: 'decide', decision: 'accept' })}>Accept</button>
          <button type="button" style={S.button} disabled={busy} onClick={() => setPending({ kind: 'decide', decision: 'repair' })}>Ask for repair</button>
          <button type="button" style={S.danger} disabled={busy} onClick={() => setPending({ kind: 'decide', decision: 'reject' })}>Reject</button>
        </div>}
        {pending?.kind === 'decide' && <Confirm
          title={pending.decision === 'accept' ? 'Accept this result' : pending.decision === 'repair' ? 'Ask for a repair' : 'Reject this result'}
          text={pending.decision === 'accept' ? 'You merge in GitHub yourself. BiForge never merges. A reason is required if the review found serious problems.' : pending.decision === 'repair' ? 'The result will be sent back for another attempt. Say what is wrong.' : 'The result is closed as not accepted. Say why.'}
          needReason={pending.decision !== 'accept' || Boolean(selected.reviewFindings?.hasUnresolvedHigh)} reasonLabel="Your reason" confirmLabel={pending.decision === 'accept' ? 'Accept' : pending.decision === 'repair' ? 'Ask for repair' : 'Reject'} danger={pending.decision === 'reject'} busy={busy}
          onConfirm={(reason) => void decide(selected, pending.decision, reason)} onCancel={() => setPending(null)} />}
      </div>}

      {action.canRepair && (selected.decision === 'repair' || selected.reviewFindings?.hasUnresolvedHigh || gates?.gates && Object.values(gates.gates).some((g) => g.status === 'FAIL')) && <div style={S.box}>
        <strong>7 · Repair</strong>
        <p style={S.muted}>Repair needs a failed check, a serious review finding, or your decision to repair. BiForge stops after repeated identical results.</p>
        <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>What triggered it
          <select value={repair.trigger} onChange={(e) => setRepair({ ...repair, trigger: e.target.value as typeof repair.trigger })} style={S.input}>
            <option value="human">My decision</option><option value="ci">A failed check</option><option value="reviewer">A review finding</option></select></label>
        <label style={{ ...S.row, margin: '8px 0', fontSize: 14 }}><input type="checkbox" checked={repair.flaky} onChange={(e) => setRepair({ ...repair, flaky: e.target.checked })} />The failure looks random (restart the checks)</label>
        <textarea aria-label="Relevant lines from the failing log (optional)" placeholder="Relevant lines from the failing log (optional)" value={repair.log} onChange={(e) => setRepair({ ...repair, log: e.target.value })} rows={3} maxLength={2000} style={{ ...S.input, minHeight: 0, fontFamily: 'monospace', fontSize: 13 }} />
        <div style={{ marginTop: 8 }}><button type="button" style={S.button} disabled={busy} onClick={() => void requestRepair(selected)}>Request repair</button></div>
        {repairOutcome && <p style={{ fontSize: 14 }}>{repairOutcome}</p>}
        {selected.repairStopReasons && selected.repairStopReasons.length > 0 && <p style={{ ...S.muted, color: '#e6c07a' }}>Stopped because {selected.repairStopReasons.map(stopReasonLabel).join('; ')}.</p>}
      </div>}

      {action.canCancel && <div style={S.box}>
        <button type="button" style={S.danger} disabled={busy} onClick={() => setPending({ kind: 'cancel' })}>Close this task…</button>
        {pending?.kind === 'cancel' && <Confirm title="Close this task" text="The task is closed and no result will be accepted for it. Say why." needReason reasonLabel="Why do you close it?" confirmLabel="Close task" danger busy={busy} onConfirm={(reason) => void cancel(selected, reason)} onCancel={() => setPending(null)} />}
      </div>}

      {action.step === 'closed' && <p style={S.muted}>This task is closed{selected.decision ? ` (${selected.decision === 'accept' ? 'accepted' : selected.decision === 'reject' ? 'rejected' : 'repair requested'})` : ''}.</p>}
    </div>}
  </section>;
}
