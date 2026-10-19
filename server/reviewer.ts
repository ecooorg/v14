/**
 * reviewer (TZ 11.5 step 7 / BX-22.b / P21): structured findings from gate evidence and delivery summary.
 * Pure: no database, no network, no model. A model may later fill prose; this function is the pilot contract.
 */
import type { GateName, GateStatus } from './gateEngine.ts';

export const FINDING_SEVERITIES = ['high', 'medium', 'low', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_CATEGORIES = ['ci', 'diff', 'security', 'acceptance', 'other'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  category: FindingCategory;
  summary: string;
  detail?: string;
  path?: string;
  gate?: GateName;
}

export interface GateSnapshot {
  gate: GateName;
  status: GateStatus;
  reasons?: string[];
}

export interface ReviewerInput {
  commitSha?: string | null;
  delivery?: 'pr' | 'branch' | 'diff' | null;
  filesChanged?: number | null;
  linesChanged?: number | null;
  violations?: Array<{ code?: string; path?: string }>;
  gates?: GateSnapshot[] | null;
  /** Optional free-text notes from the human or a future model pass (treated as data only). */
  notes?: string | null;
}

export interface ReviewFindings {
  findings: ReviewFinding[];
  summary: string;
  highCount: number;
  hasUnresolvedHigh: boolean;
  gatesSnapshot: Record<string, string>;
  commitSha: string | null;
  delivery: string | null;
  reviewedAt: string;
}

const HIGH_GATES: GateName[] = ['build', 'test', 'test_integrity', 'security'];

function categoryForGate(gate: GateName): FindingCategory {
  if (gate === 'test_integrity') return 'diff';
  if (gate === 'security') return 'security';
  if (gate === 'test' || gate === 'build') return 'ci';
  if (gate === 'requirements' || gate === 'spec' || gate === 'review') return 'acceptance';
  return 'other';
}

/**
 * Build structured review findings from current gate statuses and delivery metadata.
 * FAIL on critical gates → high; BLOCKED / NOT_RUN on critical → medium.
 */
export function buildReviewFindings(input: ReviewerInput): ReviewFindings {
  const findings: ReviewFinding[] = [];
  const gatesSnapshot: Record<string, string> = {};
  let n = 0;
  const id = () => `f${++n}`;

  for (const g of input.gates ?? []) {
    gatesSnapshot[g.gate] = g.status;
    if (g.status === 'PASS' || g.status === 'WAIVED') continue;
    if (g.status === 'FAIL') {
      const sev: FindingSeverity = HIGH_GATES.includes(g.gate) || g.gate === 'review' ? 'high' : 'medium';
      findings.push({
        id: id(),
        severity: sev,
        category: categoryForGate(g.gate),
        summary: `Gate ${g.gate} is FAIL`,
        detail: (g.reasons ?? []).slice(0, 5).join('; ') || undefined,
        gate: g.gate,
      });
      continue;
    }
    if (g.status === 'BLOCKED' || g.status === 'NOT_RUN') {
      if (!HIGH_GATES.includes(g.gate) && g.gate !== 'release_candidate') continue;
      findings.push({
        id: id(),
        severity: 'medium',
        category: categoryForGate(g.gate),
        summary: `Gate ${g.gate} is ${g.status}`,
        detail: (g.reasons ?? []).slice(0, 5).join('; ') || undefined,
        gate: g.gate,
      });
    }
  }

  for (const v of input.violations ?? []) {
    const code = typeof v.code === 'string' ? v.code : 'violation';
    findings.push({
      id: id(),
      severity: 'high',
      category: 'diff',
      summary: `Delivery violation: ${code}`,
      path: typeof v.path === 'string' ? v.path.slice(0, 200) : undefined,
    });
  }

  if (input.delivery == null && (input.filesChanged == null || input.filesChanged === 0)) {
    findings.push({
      id: id(),
      severity: 'info',
      category: 'other',
      summary: 'No delivery metadata yet',
    });
  }

  const notes = (input.notes || '').trim().slice(0, 2000);
  if (notes) {
    findings.push({
      id: id(),
      severity: 'info',
      category: 'other',
      summary: 'Human or model notes attached',
      detail: notes,
    });
  }

  const highCount = findings.filter((f) => f.severity === 'high').length;
  const hasUnresolvedHigh = highCount > 0;
  const summary = hasUnresolvedHigh
    ? `Review has ${highCount} high finding(s); human decision required before accept without override reason.`
    : findings.length
      ? `Review has ${findings.length} finding(s), none high.`
      : 'No blocking findings from gates or delivery.';

  return {
    findings,
    summary,
    highCount,
    hasUnresolvedHigh,
    gatesSnapshot,
    commitSha: input.commitSha ?? null,
    delivery: input.delivery ?? null,
    reviewedAt: new Date().toISOString(),
  };
}
