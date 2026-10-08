/** Attachments (files the person adds to the chat) and documents (files the agent hands back). */
export type AttachmentKind = 'pdf' | 'image' | 'docx' | 'xlsx' | 'pptx' | 'text';

export interface Attachment {
  name: string;
  kind: AttachmentKind;
  size: number;
  /** Text the model reads. Empty for an image or scan until the model has looked at it and returned a summary. */
  text: string;
  truncated?: boolean;
  pages?: number;
  /** Set while the file waits on the server for the model to look at it; removed when the summary arrives. */
  nativeId?: string;
}

export type DocBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'numbered'; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] };
export interface DocumentSpec { title: string; fileName?: string; blocks: DocBlock[] }

export const MAX_FILES_PER_MESSAGE = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ACCEPT_FILES = '.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.json,.log,.png,.jpg,.jpeg,.webp,.gif';
// The server accepts about this much JSON per request. Attachment text is trimmed to fit with the dialogue.
const REQUEST_BUDGET_BYTES = 235 * 1024;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Upload one file. The server reads it in memory and returns text (or a handle for images and scans). */
export async function uploadAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`“${file.name}” is larger than ${Math.round(MAX_FILE_BYTES / 1048576)} MB.`);
  if (file.size === 0) throw new Error(`“${file.name}” is empty.`);
  let r: Response;
  try {
    r = await fetch('/api/attach', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
    });
  } catch {
    throw new Error('The upload failed. Check the connection and try again.');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(j.error || `The upload failed (${r.status}).`);
  const d = j.data;
  return {
    name: String(d.name || file.name), kind: d.kind, size: Number(d.size) || file.size,
    text: String(d.text || ''), truncated: Boolean(d.truncated), pages: d.pages, nativeId: d.nativeId,
  };
}

/** What the model receives about files: every attachment in the dialogue, trimmed to fit the request. */
export function collectAttachments(history: any[]): { name: string; kind: string; text: string; truncated?: boolean; nativeId?: string }[] {
  const all: any[] = [];
  for (const m of history) if (Array.isArray(m?.attachments)) for (const a of m.attachments) all.push(a);
  return all.map((a) => ({ name: a.name, kind: a.kind, text: String(a.text || ''), truncated: a.truncated, nativeId: a.nativeId }));
}

/**
 * One collector for both sources: files of the decision (expert stages) and files on chat messages (simple mode).
 * Duplicates (same name and size) are sent once. For expert requests (forExpert) images and scans go as their saved description only.
 */
export function collectDecisionAttachments(d: any, history?: any[], forExpert = false): { name: string; kind: string; text: string; truncated?: boolean; nativeId?: string }[] {
  const msgs = history ?? (Array.isArray(d?.modelSuggestions?.conversation) ? d.modelSuggestions.conversation : []);
  const seen = new Set<string>();
  const out: { name: string; kind: string; text: string; truncated?: boolean; nativeId?: string }[] = [];
  for (const a of [...(Array.isArray(d?.files) ? d.files : []), ...collectAttachments(msgs)]) {
    const key = `${a.name}|${(a as any).size ?? ''}|${String(a.text || '').length}`;
    if (!a?.name || seen.has(key)) continue;
    seen.add(key);
    out.push(forExpert ? { name: a.name, kind: a.kind, text: String(a.text || ''), truncated: a.truncated } : { name: a.name, kind: a.kind, text: String(a.text || ''), truncated: a.truncated, nativeId: a.nativeId });
  }
  return out;
}

/** History as the server needs it: roles and text only. A document handed over earlier is described so the agent can revise it. */
export function historyForRequest(history: any[]): { role: string; content: string }[] {
  return history.map((m) => {
    let content = String(m?.content || '');
    if (m?.document) content += `\n\n[Document handed over to the person as a file: ${documentToPlainText(m.document).slice(0, 3500)}]`;
    return { role: m.role === 'user' ? 'user' : 'assistant', content };
  });
}

/** Keeps the JSON request under the server's size limit by shortening attachment text if needed. */
export function fitRequest<T extends { attachments?: { text: string }[] }>(body: T): T {
  const size = (b: unknown) => new TextEncoder().encode(JSON.stringify(b)).length;
  let cur = body;
  for (let i = 0; i < 6 && size(cur) > REQUEST_BUDGET_BYTES && cur.attachments?.some((a) => a.text.length > 500); i++) {
    cur = { ...cur, attachments: cur.attachments!.map((a) => ({ ...a, text: a.text.length > 500 ? a.text.slice(0, Math.floor(a.text.length * 0.6)) : a.text })) };
  }
  return cur;
}

/** Puts the summaries of images and scans (returned by the model) into the messages that carried them. */
export function applyAttachmentNotes(history: any[], notes: { name: string; summary: string }[] | undefined): any[] {
  if (!notes?.length) return history;
  return history.map((m) => {
    if (!Array.isArray(m?.attachments)) return m;
    return {
      ...m,
      attachments: m.attachments.map((a: Attachment) => {
        const n = a.nativeId ? notes.find((x) => x.name.toLowerCase() === String(a.name).toLowerCase()) : undefined;
        return n ? { ...a, text: n.summary, nativeId: undefined } : a;
      }),
    };
  });
}

export function attachmentOnlyText(items: Attachment[]): string {
  return `Attached: ${items.map((a) => a.name).join(', ')}`;
}

/* ---------- Documents ---------- */

export function documentToPlainText(doc: DocumentSpec): string {
  const out: string[] = [doc.title];
  for (const b of doc.blocks) {
    if (b.type === 'heading' || b.type === 'paragraph') out.push(b.text);
    else if (b.type === 'bullets') out.push(b.items.map((i) => `- ${i}`).join('\n'));
    else if (b.type === 'numbered') out.push(b.items.map((i, n) => `${n + 1}. ${i}`).join('\n'));
    else if (b.type === 'table') out.push([b.headers.join(' | '), ...b.rows.map((r) => r.join(' | '))].join('\n'));
  }
  return out.join('\n\n');
}

/** Plain chat text (paragraphs, "- " lines, "1." lines) into document blocks. */
export function textToBlocks(text: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const chunk of String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = chunk.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) continue;
    let i = 0;
    while (i < lines.length) {
      const bullet = /^\s*[-•–]\s+/;
      const num = /^\s*\d+[.)]\s+/;
      if (bullet.test(lines[i])) {
        const items: string[] = [];
        while (i < lines.length && bullet.test(lines[i])) items.push(lines[i++].replace(bullet, ''));
        blocks.push({ type: 'bullets', items });
      } else if (num.test(lines[i])) {
        const items: string[] = [];
        while (i < lines.length && num.test(lines[i])) items.push(lines[i++].replace(num, ''));
        blocks.push({ type: 'numbered', items });
      } else {
        const para: string[] = [];
        while (i < lines.length && !bullet.test(lines[i]) && !num.test(lines[i])) para.push(lines[i++]);
        blocks.push({ type: 'paragraph', text: para.join('\n') });
      }
    }
  }
  return blocks;
}

export function messageToDocument(title: string, text: string): DocumentSpec {
  const clean = String(text || '').split('\n---\n')[0];   // the safety-contacts block is not part of the note
  const firstLine = clean.split('\n').find((l) => l.trim()) || '';
  return { title: (title || firstLine || 'Note').slice(0, 120), fileName: 'note', blocks: textToBlocks(clean) };
}

export function conversationToDocument(title: string, history: any[], labels: { user: string; assistant: string; attached: string }): DocumentSpec {
  const blocks: DocBlock[] = [];
  for (const m of history) {
    blocks.push({ type: 'heading', text: m.role === 'user' ? labels.user : labels.assistant });
    if (Array.isArray(m.attachments) && m.attachments.length) {
      blocks.push({ type: 'paragraph', text: `${labels.attached}: ${m.attachments.map((a: Attachment) => a.name).join(', ')}` });
    }
    blocks.push(...textToBlocks(String(m.content || '').split('\n---\n')[0]));
    if (m.document) blocks.push({ type: 'paragraph', text: `[${m.document.title}]` });
  }
  return { title: (title || 'Conversation').slice(0, 120), fileName: 'conversation', blocks: blocks.length ? blocks : [{ type: 'paragraph', text: ' ' }] };
}

/** Asks the server to build the file. Returns the bytes and the English file name. Throws an Error with a readable message. */
export async function buildDocumentFile(doc: DocumentSpec, format: 'docx' | 'pdf'): Promise<{ blob: Blob; name: string }> {
  let r: Response;
  try {
    r = await fetch('/api/export-document', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, document: doc }),
    });
  } catch {
    throw new Error('The download failed. Check the connection and try again.');
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `The download failed (${r.status}).`);
  }
  const blob = await r.blob();
  const cd = r.headers.get('content-disposition') || '';
  const plain = cd.match(/filename="([^"]+)"/i);
  const name = plain ? plain[1] : `document.${format}`;
  return { blob, name };
}

/** Builds the file on the server and saves it to the device. */
export async function downloadDocument(doc: DocumentSpec, format: 'docx' | 'pdf'): Promise<void> {
  const { blob, name } = await buildDocumentFile(doc, format);
  saveBlob(blob, name);
}

/** Saves a file. The link is attached to the page and released later: browsers need that to keep the file name. */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 10000);
}
