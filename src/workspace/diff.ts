/**
 * Line-level diff helpers for workspace ChangeSet (P26b FW-40).
 * Independent of server/codeExecutor so browser and Node share one path.
 */

export interface LineChange {
  op: ' ' | '+' | '-';
  text: string;
}

/** Count added/removed lines between two LF-normalised texts. */
export function lineDiffStats(before: string, after: string): { added: number; removed: number; hunks: LineChange[] } {
  const a = splitLines(before);
  const b = splitLines(after);
  // Myers-lite: LCS DP for small files; for large files fall back to whole-file replace stats.
  if (a.length > 2000 || b.length > 2000) {
    const removed = a.length;
    const added = b.length;
    const hunks: LineChange[] = [
      ...a.map((t) => ({ op: '-' as const, text: t })),
      ...b.map((t) => ({ op: '+' as const, text: t })),
    ];
    return { added, removed, hunks };
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const hunks: LineChange[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      hunks.push({ op: ' ', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      hunks.push({ op: '-', text: a[i]! });
      removed++;
      i++;
    } else {
      hunks.push({ op: '+', text: b[j]! });
      added++;
      j++;
    }
  }
  while (i < n) {
    hunks.push({ op: '-', text: a[i++]! });
    removed++;
  }
  while (j < m) {
    hunks.push({ op: '+', text: b[j++]! });
    added++;
  }
  return { added, removed, hunks };
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Detect dominant EOL of original bytes-as-text (before LF normalisation). */
export function detectEol(raw: string): 'LF' | 'CRLF' | 'mixed' {
  const crlf = (raw.match(/\r\n/g) || []).length;
  const lfOnly = (raw.match(/(?<!\r)\n/g) || []).length;
  const crOnly = (raw.match(/\r(?!\n)/g) || []).length;
  if (crlf && (lfOnly || crOnly)) return 'mixed';
  if (crlf) return 'CRLF';
  return 'LF';
}

/** Apply LF-normalised content back to original EOL convention. */
export function restoreEol(lfText: string, eol: 'LF' | 'CRLF' | 'mixed'): string {
  if (eol === 'CRLF') return lfText.replace(/\n/g, '\r\n');
  return lfText;
}

/** Build a unified diff for one file (git-style paths). */
export function unifiedDiffForFile(path: string, before: string | null, after: string | null): string {
  const oldLabel = before === null ? '/dev/null' : `a/${path}`;
  const newLabel = after === null ? '/dev/null' : `b/${path}`;
  const a = before === null ? [] : splitLines(before);
  const b = after === null ? [] : splitLines(after);
  const { hunks } = lineDiffStats(before ?? '', after ?? '');
  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    `--- ${oldLabel}`,
    `+++ ${newLabel}`,
  ];
  if (!hunks.length && before === after) return lines.join('\n') + '\n';
  // Single hunk covering the whole file (simple, git-apply friendly for small edits).
  const oldCount = a.length || (before === null ? 0 : 0);
  const newCount = b.length || (after === null ? 0 : 0);
  const oldStart = before === null ? 0 : 1;
  const newStart = after === null ? 0 : 1;
  lines.push(`@@ -${oldStart},${a.length} +${newStart},${b.length} @@`);
  for (const h of hunks) {
    lines.push(`${h.op}${h.text}`);
  }
  if (!hunks.length && before !== after) {
    for (const t of a) lines.push(`-${t}`);
    for (const t of b) lines.push(`+${t}`);
  }
  return lines.join('\n') + '\n';
}
