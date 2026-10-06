/** JSON export/import — TZ A-06, I-11 (no zip/docx endpoints) */

import { Decision } from '../types/decision';

export function exportDecisionJson(d: Decision): Blob {
  const payload = {
    schemaVersion: d.schemaVersion,
    exportedAt: new Date().toISOString(),
    decision: d,
  };
  return new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
}

export function exportAllJson(decisions: Decision[]): Blob {
  return new Blob(
    [
      JSON.stringify(
        {
          schemaVersion: 8,
          exportedAt: new Date().toISOString(),
          decisions,
        },
        null,
        2
      ),
    ],
    { type: 'application/json' }
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(u);
}

const VALID_STEPS = new Set([
  'TRIAGE', 'BRIEF', 'UNDERSTAND', 'EXPAND', 'ATTACK', 'TEST', 'DECIDE', 'SYNTHESIS', 'LEARN',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDecisionLike(value: unknown): value is Decision {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || !value.id) return false;
  if (typeof value.title !== 'string') return false;
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) return false;
  if (!Number.isFinite(value.schemaVersion)) return false;
  if (typeof value.step !== 'string' || !VALID_STEPS.has(value.step)) return false;
  if (!isRecord(value.brief) || typeof value.brief.decision !== 'string') return false;
  const arrayFields = ['options', 'redTeam', 'hypotheses', 'experiments', 'evidence', 'journal'];
  if (arrayFields.some((key) => !Array.isArray(value[key]))) return false;
  if (!isRecord(value.modelSuggestions) || !isRecord(value.stepHistory)) return false;
  return true;
}

function validateImportedDecisions(value: unknown): Decision[] {
  if (!Array.isArray(value)) throw new Error('Import contains no decisions');
  if (!value.length) throw new Error('Import contains no decisions');
  const bad = value.findIndex((item) => !isDecisionLike(item));
  if (bad !== -1) throw new Error(`Invalid decision at position ${bad + 1}`);
  return value as Decision[];
}

export function parseImportedJson(text: string): Decision[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON file');
  }

  if (isRecord(data) && Array.isArray(data.decisions)) {
    return validateImportedDecisions(data.decisions);
  }
  if (isRecord(data) && data.decision !== undefined) {
    return validateImportedDecisions([data.decision]);
  }
  if (Array.isArray(data)) return validateImportedDecisions(data);
  throw new Error('Unknown import format');
}
