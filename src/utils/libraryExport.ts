/** B2–B4: whole-library export as one document (md / Word / PDF / Google Docs) and import merge with a report. Pure functions. */
import type { Decision } from '../types/decision';
import { conversationToDocument, type DocBlock, type DocumentSpec } from './attachments';
import { decisionToDocument } from './decisionDocument';
import { mergeLibraries } from './driveMerge';
import { detectUiLanguage } from '../i18n/ui';

const cell = (s: string) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');

export function documentToMarkdown(doc: DocumentSpec): string {
  const out: string[] = [`# ${doc.title}`];
  for (const b of doc.blocks) {
    if (b.type === 'heading') out.push(`## ${b.text}`);
    else if (b.type === 'paragraph') out.push(b.text);
    else if (b.type === 'bullets') out.push(b.items.map((i) => `- ${i}`).join('\n'));
    else if (b.type === 'numbered') out.push(b.items.map((i, n) => `${n + 1}. ${i}`).join('\n'));
    else if (b.type === 'table') {
      out.push([`| ${b.headers.map(cell).join(' | ')} |`, `| ${b.headers.map(() => '---').join(' | ')} |`, ...b.rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n'));
    }
  }
  return out.join('\n\n') + '\n';
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dateOf = (ms: number) => { const d = new Date(ms); return Number.isFinite(ms) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : ''; };

/** One document: every dialogue is a chapter (title and date, then the conversation and/or the decision review). */
export function libraryToDocument(decisions: Decision[], now = Date.now()): DocumentSpec {
  const sample = decisions.map((d) => d.title).join(' ').slice(0, 1500);
  const ru = detectUiLanguage(sample) === 'ru';
  const labels = ru ? { user: 'Вы', assistant: 'Агент', attached: 'Вложения' } : { user: 'You', assistant: 'Agent', attached: 'Attached' };
  const blocks: DocBlock[] = [];
  decisions.forEach((d, i) => {
    const date = dateOf(d.createdAt);
    blocks.push({ type: 'heading', text: `${i + 1}. ${(d.title || (ru ? 'Без названия' : 'Untitled')).trim()}${date ? ` — ${date}` : ''}` });
    const conv: any[] = Array.isArray(d.modelSuggestions?.conversation) ? (d.modelSuggestions as any).conversation : [];
    const expert = d.step !== 'TRIAGE' && d.step !== 'BRIEF';
    let any = false;
    if (conv.length) { blocks.push(...conversationToDocument(d.title, conv, labels).blocks); any = true; }
    if (!conv.length || expert) {
      const review = decisionToDocument(d).blocks;
      if (review.length) { blocks.push(...review); any = true; }
    }
    if (!any) blocks.push({ type: 'paragraph', text: ru ? '(пусто)' : '(empty)' });
  });
  return { title: ru ? 'Все диалоги' : 'All dialogues', fileName: 'all-dialogues', blocks: blocks.length ? blocks : [{ type: 'paragraph', text: ' ' }] };
}

export interface ImportPlan {
  merged: Decision[];
  added: number;
  updated: number;
  skipped: number;
  /** incoming dialogues that are older than the local version: the local one is kept */
  conflicts: string[];
}

/** B4: merge by id with the same rule as the Drive sync (later updatedAt wins, local wins a tie); nothing is removed. */
export function planImport(local: Decision[], incoming: Decision[]): ImportPlan {
  const byId = new Map(local.map((d) => [d.id, d]));
  let added = 0, updated = 0, skipped = 0;
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const inc of incoming) {
    if (seen.has(inc.id)) { skipped++; continue; }   // duplicate inside the file
    seen.add(inc.id);
    const l = byId.get(inc.id);
    if (!l) added++;
    else if (inc.updatedAt > l.updatedAt) updated++;
    else { skipped++; if (l.updatedAt > inc.updatedAt) conflicts.push(l.title || l.id); }
  }
  const merged = mergeLibraries(local, incoming).merged;
  const fresh = new Set(local.map((d) => d.id));
  // new dialogues first (as before), the rest keep their order
  const ordered = [...merged.filter((d) => !fresh.has(d.id)), ...merged.filter((d) => fresh.has(d.id))];
  return { merged: ordered, added, updated, skipped, conflicts };
}

export function importReport(p: Pick<ImportPlan, 'added' | 'updated' | 'skipped'>, ru: boolean): string {
  return ru ? `Добавлено ${p.added}, обновлено ${p.updated}, пропущено ${p.skipped}.` : `Added ${p.added}, updated ${p.updated}, skipped ${p.skipped}.`;
}
