import React, { useRef, useState, useCallback } from 'react';
import { CloudUpload, Copy, Download, FileText, Paperclip, X } from 'lucide-react';
import {
  ACCEPT_FILES, Attachment, DocumentSpec, MAX_FILES_PER_MESSAGE, conversationToDocument,
  downloadDocument, formatSize, messageToDocument, uploadAttachment,
} from '../utils/attachments';
import { detectUiLanguage } from '../i18n/ui';
import { isDriveConfigured } from '../utils/driveClient';
import { saveDocumentToGoogleDocs, type SavedDoc } from '../utils/driveExport';

/* ---------- Attach button + chips of files waiting to be sent ---------- */

export function AttachControl({
  value, onChange, disabled, showPrivacyNote = true,
}: {
  value: Attachment[];
  onChange: (next: Attachment[]) => void;
  disabled?: boolean;
  /** When true (default), show a one-line privacy note next to the button. */
  showPrivacyNote?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState('');

  const pick = useCallback(async (fileList: FileList | File[] | null) => {
    if (!fileList || (fileList as FileList).length === 0 && !(fileList as File[]).length) return;
    setError('');
    const list = Array.isArray(fileList) ? fileList : Array.from(fileList as FileList);
    const room = MAX_FILES_PER_MESSAGE - value.length;
    const chosen = list.slice(0, Math.max(0, room));
    if (list.length > chosen.length) setError(`You can attach up to ${MAX_FILES_PER_MESSAGE} files to one message.`);
    let next = value;
    setUploading((n) => n + chosen.length);
    for (const f of chosen) {
      try {
        const a = await uploadAttachment(f);
        next = [...next, a];
        onChange(next);
      } catch (e: any) {
        setError(e?.message || 'The file could not be attached.');
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (input.current) input.current.value = '';
  }, [value, onChange]);

  // Expose pick for drag-and-drop / paste from parent via ref-like callback or window event.
  // Parents call the same upload path through a custom event so we keep one implementation.
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { files?: File[] } | undefined;
      if (detail?.files?.length) void pick(detail.files);
    };
    window.addEventListener('be:attach-files', handler);
    return () => window.removeEventListener('be:attach-files', handler);
  }, [pick]);

  return (
    <div className="attach-control">
      <input ref={input} type="file" hidden multiple accept={ACCEPT_FILES} onChange={(e) => void pick(e.target.files)} />
      <button
        type="button" className="ghost attach-button" disabled={disabled || uploading > 0 || value.length >= MAX_FILES_PER_MESSAGE}
        onClick={() => input.current?.click()} aria-label="Attach file"
      >
        <Paperclip size={15} />{uploading > 0 ? 'Reading…' : 'Attach file'}
      </button>
      {showPrivacyNote && (
        <span className="attach-privacy-note" title="Files are sent to Google Gemini together with your message. The server does not keep them.">
          File will be sent to Gemini
        </span>
      )}
      <AttachmentChips items={value} onRemove={(i) => onChange(value.filter((_, k) => k !== i))} />
      {error && <div className="attach-error" role="alert">{error}</div>}
    </div>
  );
}

export function AttachmentChips({ items, onRemove }: { items: Attachment[]; onRemove?: (index: number) => void }) {
  if (!items.length) return null;
  return (
    <div className="attach-chips">
      {items.map((a, i) => (
        <span key={`${a.name}-${i}`} className="attach-chip" title={a.truncated ? 'Only the first part of this file is used' : a.name}>
          <FileText size={13} />
          <span className="attach-chip-name" translate="no">{a.name}</span>
          <small>{formatSize(a.size)}{a.truncated ? ' · partly' : ''}</small>
          {onRemove && <button type="button" className="attach-chip-x" aria-label={`Remove ${a.name}`} onClick={() => onRemove(i)}><X size={13} /></button>}
        </span>
      ))}
    </div>
  );
}

/* ---------- Downloading ---------- */

function useDownload() {
  const [busy, setBusy] = useState<'docx' | 'pdf' | ''>('');
  const [error, setError] = useState('');
  const run = async (doc: DocumentSpec, format: 'docx' | 'pdf') => {
    if (busy) return;
    setBusy(format); setError('');
    try { await downloadDocument(doc, format); }
    catch (e: any) { setError(e?.message || 'The download failed.'); }
    finally { setBusy(''); }
  };
  return { busy, error, run };
}

/** "Save to Google Docs": uploads the Word version and lets Drive convert it. Shown only when Google sign-in is configured. */
export function DriveSaveButton({ getDoc }: { getDoc: () => DocumentSpec }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<SavedDoc | null>(null);
  if (!isDriveConfigured()) return null;
  const run = async () => {
    if (busy) return;
    setBusy(true); setError(''); setSaved(null);
    try { setSaved(await saveDocumentToGoogleDocs(getDoc())); }
    catch (e: any) { setError(e?.message || 'Could not save to Google Drive.'); }
    finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" className="ghost" disabled={busy} onClick={() => void run()}><CloudUpload size={14} />{busy ? 'Saving…' : 'Save to Google Docs'}</button>
      {saved && <span className="drive-saved" role="status"><span>Saved to Google Drive.</span> <a href={saved.link} target="_blank" rel="noopener noreferrer">Open in Google Docs</a></span>}
      {error && <span className="attach-error" role="alert">{error}</span>}
    </>
  );
}

/** A document the agent prepared: a card with Word and PDF downloads. */
export function DocumentCard({ doc }: { doc: DocumentSpec }) {
  const { busy, error, run } = useDownload();
  return (
    <div className="doc-card">
      <div className="doc-card-title"><FileText size={18} /><span translate="no" dir="auto">{doc.title}</span></div>
      <div className="doc-card-actions">
        <button type="button" className="ghost" disabled={!!busy} onClick={() => void run(doc, 'docx')}><Download size={14} />{busy === 'docx' ? 'Preparing…' : 'Word (.docx)'}</button>
        <button type="button" className="ghost" disabled={!!busy} onClick={() => void run(doc, 'pdf')}><Download size={14} />{busy === 'pdf' ? 'Preparing…' : 'PDF'}</button>
        <DriveSaveButton getDoc={() => doc} />
      </div>
      {error && <div className="attach-error" role="alert">{error}</div>}
    </div>
  );
}

/** Small "download this reply" links under an assistant message. */
export function MessageDownload({ title, text }: { title: string; text: string }) {
  const { busy, error, run } = useDownload();
  const [copied, setCopied] = useState(false);
  const doc = () => messageToDocument(title, text);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers / denied permission
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch { /* ignore */ }
    }
  };
  return (
    <div className="message-download">
      <button type="button" className="link-button" onClick={() => void copy()} aria-label="Copy reply">
        <Copy size={13} style={{ marginRight: 4 }} />{copied ? 'Copied' : 'Copy'}
      </button>
      <button type="button" className="link-button" disabled={!!busy} onClick={() => void run(doc(), 'docx')}>{busy === 'docx' ? 'Preparing…' : 'Save as Word'}</button>
      <button type="button" className="link-button" disabled={!!busy} onClick={() => void run(doc(), 'pdf')}>{busy === 'pdf' ? 'Preparing…' : 'Save as PDF'}</button>
      <DriveSaveButton getDoc={doc} />
      {error && <span className="attach-error" role="alert">{error}</span>}
    </div>
  );
}

/** Whole conversation as one file. */
export function ConversationExport({ title, history }: { title: string; history: any[] }) {
  const { busy, error, run } = useDownload();
  const doc = (): DocumentSpec => {
    const sample = history.map((m) => String(m.content || '')).join(' ').slice(0, 2000);
    const ru = detectUiLanguage(sample) === 'ru';
    return conversationToDocument(title, history, ru
      ? { user: 'Вы', assistant: 'Агент', attached: 'Вложения' }
      : { user: 'You', assistant: 'Agent', attached: 'Attached' });
  };
  return (
    <>
      <button type="button" className="ghost" disabled={!!busy} onClick={() => void run(doc(), 'docx')}><Download size={14} />{busy === 'docx' ? 'Preparing…' : 'Conversation as Word'}</button>
      <button type="button" className="ghost" disabled={!!busy} onClick={() => void run(doc(), 'pdf')}><Download size={14} />{busy === 'pdf' ? 'Preparing…' : 'Conversation as PDF'}</button>
      <DriveSaveButton getDoc={doc} />
      {error && <span className="attach-error" role="alert">{error}</span>}
    </>
  );
}

/** Everything a message carries besides its text: files the person attached, a document the agent prepared. */
export function MessageExtras({ message }: { message: any }) {
  const attachments: Attachment[] = Array.isArray(message?.attachments) ? message.attachments : [];
  const doc: DocumentSpec | undefined = message?.document && Array.isArray(message.document.blocks) ? message.document : undefined;
  if (!attachments.length && !doc) return null;
  return (
    <>
      <AttachmentChips items={attachments} />
      {doc && <DocumentCard doc={doc} />}
    </>
  );
}
