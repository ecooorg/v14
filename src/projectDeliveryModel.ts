/**
 * P54: pure model behind the Project «Delivery» tab: plain labels, error sentences and the rules for what the person
 * can do next. No React, no network. The server stays the authority: every rule here only decides which control is
 * shown; the server still refuses anything not allowed.
 */
import type { Capabilities } from './projectCapabilities.ts';

export const GATE_ORDER = ['requirements', 'spec', 'build', 'test', 'test_integrity', 'security', 'review', 'release_candidate'] as const;
export type GateName = (typeof GATE_ORDER)[number];
export const GATE_STATUS_ORDER = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'REAL_ONLY', 'WAIVED'] as const;
export type GateStatus = (typeof GATE_STATUS_ORDER)[number];

export const GATE_LABELS: Record<GateName, string> = {
  requirements: 'Requirements approved',
  spec: 'Specification approved',
  build: 'Build',
  test: 'Tests',
  test_integrity: 'Tests untouched',
  security: 'Security checks',
  review: 'Review approved',
  release_candidate: 'Ready for your release decision',
};
export const GATE_STATUS_LABELS: Record<GateStatus, string> = {
  PASS: 'Passed',
  FAIL: 'Failed',
  BLOCKED: 'Blocked',
  NOT_RUN: 'Not run',
  REAL_ONLY: 'Needs a check in a real environment',
  WAIVED: 'Waived by you',
};

/** Gates a person may approve or reject. Everything else is set by CI or derived by the server (TZ 12.2). */
export const HUMAN_APPROVAL_GATES: readonly GateName[] = ['requirements', 'spec', 'review'];
export const CI_ONLY_NOTE = 'Only CI can set this.';

export interface GateResult { gate: GateName; status: GateStatus; reasons: string[] }
export interface GatesData { commit: string | null; gates: Record<string, GateResult> | null; manifest?: { complete?: boolean; tools?: string[]; decisions?: Array<{ gate: string; reason: string }>; risks?: string[] } | null }

export interface GateRowView { gate: GateName; label: string; status: GateStatus; statusLabel: string; reasons: string[]; canApprove: boolean; canWaive: boolean; ciOnlyNote: string | null }

/** Rows for the checks panel. With no commit yet (gates === null) there are no rows: the panel shows an explanation instead. */
export function gateRows(data: GatesData | null | undefined): GateRowView[] {
  if (!data?.commit || !data.gates) return [];
  return GATE_ORDER.map((gate) => {
    const r = data.gates![gate];
    const status: GateStatus = (r && (GATE_STATUS_ORDER as readonly string[]).includes(r.status)) ? r.status : 'NOT_RUN';
    const settled = status === 'PASS' || status === 'WAIVED';
    const human = HUMAN_APPROVAL_GATES.includes(gate);
    return {
      gate, label: GATE_LABELS[gate], status, statusLabel: GATE_STATUS_LABELS[status], reasons: (r?.reasons ?? []).map(String).slice(0, 6),
      canApprove: human && status !== 'PASS',
      canWaive: !settled,
      ciOnlyNote: human ? null : CI_ONLY_NOTE,
    };
  });
}
export const shortSha = (sha: string | null | undefined): string => (sha ? String(sha).slice(0, 7) : '');
export const NO_COMMIT_NOTE = (branch: string | null | undefined) => `Checks appear after a pull request from ${branch || 'the task branch'} is linked.`;

// ---- code task ----
export type CodeTaskState = 'WAITING_HUMAN' | 'RUNNING' | 'DELIVERED' | 'FAILED' | 'BLOCKED';
export const CODE_STATE_LABELS: Record<CodeTaskState, string> = {
  WAITING_HUMAN: 'Waiting for you',
  RUNNING: 'Working',
  DELIVERED: 'Delivered',
  FAILED: 'Closed',
  BLOCKED: 'Needs attention',
};
export interface CodeTaskView {
  id: string; taskId: string; status: CodeTaskState; delivery: 'pr' | 'branch' | 'diff' | null; branch: string | null; expectedBranch?: string | null;
  headSha: string | null; prNumber: number | null; prUrl: string | null; statusReason: string | null; packageApprovedAt: string | null; packageHash: string;
  decision: 'accept' | 'repair' | 'reject' | null; decisionReason: string | null; reviewFindings: { findings: Array<{ id: string; severity: string; summary: string; detail?: string; path?: string }>; summary: string; highCount: number; hasUnresolvedHigh: boolean } | null;
  repairStopReasons: string[] | null; attempt: number; repairOf: string | null; taskTitle?: string; updatedAt?: string;
}

export type DeliveryStep = 'package' | 'handoff' | 'result' | 'checks' | 'review' | 'decision' | 'repair' | 'closed';
export const STEP_ORDER: readonly DeliveryStep[] = ['package', 'handoff', 'result', 'checks', 'review', 'decision', 'repair'];
export const STEP_LABELS: Record<DeliveryStep, string> = {
  package: 'Package', handoff: 'Hand-off', result: 'Result', checks: 'Checks', review: 'Review', decision: 'Decision', repair: 'Repair', closed: 'Closed',
};

export interface DeliveryAction {
  step: DeliveryStep;
  canApprovePackage: boolean;
  canDownloadPackage: boolean;
  canSubmitResult: boolean;
  resultKinds: Array<'pr' | 'branch' | 'diff'>;
  needsGithubForResult: boolean;
  showCommitPackage: boolean;
  canRefresh: boolean;
  canReview: boolean;
  canDecide: boolean;
  canRepair: boolean;
  canCancel: boolean;
}

/**
 * What to show next. Write controls (diff upload, commit package) appear only when the server reports GitHub write on (ADR-06 Amendment 1).
 * Without GitHub read there is no way to return a result, so result kinds are empty and the page explains it.
 */
export function nextDeliveryAction(ct: CodeTaskView, caps: Capabilities | null | undefined): DeliveryAction {
  const read = Boolean(caps?.manualDelivery?.githubRead);
  const write = Boolean(caps?.githubWrite) && read;
  const approved = Boolean(ct.packageApprovedAt);
  const open = ct.status === 'WAITING_HUMAN' || ct.status === 'RUNNING' || ct.status === 'BLOCKED';
  const awaitingResult = ct.status === 'WAITING_HUMAN' || ct.status === 'BLOCKED';
  const delivered = ct.status === 'DELIVERED';
  const decided = ct.decision !== null;

  let step: DeliveryStep;
  if (ct.status === 'FAILED') step = 'closed';
  else if (delivered && decided) step = ct.decision === 'repair' ? 'repair' : 'closed';
  else if (delivered) step = ct.reviewFindings ? 'decision' : (ct.headSha ? 'review' : 'checks');
  else if (awaitingResult) step = approved ? (ct.status === 'BLOCKED' ? 'result' : 'handoff') : 'package';
  else step = 'handoff';

  const resultKinds: Array<'pr' | 'branch' | 'diff'> = read ? (write ? ['pr', 'branch', 'diff'] : ['pr', 'branch']) : [];
  return {
    step,
    canApprovePackage: awaitingResult && !approved,
    canDownloadPackage: true,
    canSubmitResult: awaitingResult && approved && read,
    resultKinds,
    needsGithubForResult: awaitingResult && approved && !read,
    showCommitPackage: write && awaitingResult && approved,
    canRefresh: delivered && !decided && read,
    canReview: delivered && !decided && !ct.reviewFindings,
    canDecide: delivered && !decided,
    canRepair: delivered && (ct.decision === 'repair' || ct.decision === null),
    canCancel: open,
  };
}

/** Latest attempt per task, newest task first (the list in the Delivery tab). Repair children are attempts of the same task. */
export function latestPerTask(all: CodeTaskView[]): CodeTaskView[] {
  const best = new Map<string, CodeTaskView>();
  for (const c of all) { const cur = best.get(c.taskId); if (!cur || c.attempt > cur.attempt) best.set(c.taskId, c); }
  const firstSeen = new Map<string, number>();
  all.forEach((c, i) => { if (!firstSeen.has(c.taskId)) firstSeen.set(c.taskId, i); });
  return [...best.values()].sort((a, b) => (firstSeen.get(a.taskId)! - firstSeen.get(b.taskId)!));
}

// ---- errors ----
export const CODE_ERROR_MESSAGES: Record<string, string> = {
  APPROVAL_REQUIRED: 'Approve the package first.',
  ARTIFACT_ERROR: 'The stored package could not be read. Nothing was changed.',
  BRANCH_MISMATCH: 'The branch must be the one shown on this page.',
  BRANCH_NOT_FOUND: 'That branch does not exist in the repository yet. Push it, then try again.',
  BUDGET_EXCEEDED: 'The code task budget of this project is used up. Only you can raise it.',
  CODE_TASK_ACTIVE: 'This task already has a code run in progress.',
  CODE_TASK_CLOSED: 'This task is closed for that action.',
  DECISION_EXISTS: 'A decision is already recorded for this task.',
  DIFF_UPLOAD_DISABLED: 'Uploading a diff is switched off. Return a pull request or a branch instead.',
  EXECUTOR_MISMATCH: 'Set «How code is written» to Manual in the project settings, then try again.',
  EXECUTOR_UNAVAILABLE: 'This way of writing code is not available on this server.',
  GITHUB_ERROR: 'GitHub did not answer as expected. Try again in a moment.',
  GITHUB_NOT_CONFIGURED: 'GitHub is not connected, so BiForge cannot read the result.',
  HIGH_FINDINGS: 'The review found serious problems. To accept anyway, write down your reason.',
  HUMAN_REQUIRED: 'Only you can do this.',
  MODEL_CALLER_MISSING: 'Automatic coding is not available here.',
  DECISION_REQUIRED: 'Record your decision first.',
  MODEL_PATCH_INVALID: 'The generated result did not pass the safety checks.',
  PACKAGE_SECRET: 'The task description looks like it contains a secret (a key or a password). Remove it and try again.',
  PACKAGE_TOO_LARGE: 'The task description is too large. Shorten it and try again.',
  NOT_DELIVERED: 'The result has not been delivered yet.',
  NOT_FOUND: 'Not found. It may have been removed.',
  NOT_LATEST: 'A newer attempt exists. Open the latest one.',
  PACKAGE_INVALID: 'The task description could not be turned into a valid package.',
  PASSPORT_NOT_CONFIRMED: 'Confirm the project description first.',
  PR_MISMATCH: 'The pull request must come from the branch shown on this page.',
  PR_NOT_OPEN: 'That pull request is not open.',
  REPAIR_NOT_TRIGGERED: 'Repair needs a failed check, a serious review finding, or your decision to repair.',
  TASK_NOT_ACTIVE: 'This task is cancelled.',
  VALIDATION: 'Some of the entered values are not valid.',
  NO_HEAD: 'Checks appear after a pull request from the task branch is linked.',
  INVALID_GATE: 'That check cannot be set by hand.',
  UNAUTHORIZED: 'Please sign in again.',
};
/** Plain sentence for an error; unknown codes fall back to the server message. */
export function deliveryErrorMessage(code: string | undefined, fallback: string): string {
  return (code && CODE_ERROR_MESSAGES[code]) || fallback || 'Something went wrong. Nothing was changed.';
}

export const stopReasonLabel = (r: string): string => ({
  max_attempts: 'the maximum number of repair attempts was reached',
  identical_diff: 'the new result is identical to the previous one',
  identical_error: 'the same error repeated',
  no_progress: 'there was no progress between attempts',
  budget: 'the code budget is used up',
} as Record<string, string>)[r] || r;

/** Plain instructions for the hand-off step. */
export function handoffText(branch: string | null | undefined): string[] {
  const b = branch || 'the task branch';
  return [
    'Download PACKAGE.md and take it to any tool you like.',
    `Make the change on the branch ${b} and open a pull request from it.`,
    'Come back here and enter the pull request number (or the branch name).',
  ];
}
