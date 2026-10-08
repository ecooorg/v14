import React, { useRef, useState, useCallback } from 'react';
import { CloudUpload, Copy, Download, FileText, Paperclip, X } from 'lucide-react';
import {
  ACCEPT_FILES, Attachment, DocumentSpec, MAX_FILES_PER_MESSAGE, conversationToDocument,
  downloadDocument, formatSize, messageToDocument, uploadAttachment,
} from '../utils/attachments';
import { detectUiLanguage } from '../i18n/ui';
import { isDriveConfigured } from '../utils/driveClient';
import { saveDocumentToGoogleDocs, type SavedDoc } from '../utils/driveExport';
import {
  listProgramFiles, deleteProgramFile, programFileToAttachment, archiveAttachment,
  getProgramFilesQuota, type ProgramFile,
} from '../utils/programFiles';

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

/** A document the agent prepared: title + one Save menu (same targets as the Files panel). */
export function DocumentCard({ doc }: { doc: DocumentSpec }) {
  const { busy, error, run } = useDownload();
  const [open, setOpen] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [statusLink, setStatusLink] = useState('');
  const saveFormat = async (format: 'docx' | 'pdf' | 'gdocs') => {
    setOpen(false);
    setStatus('');
    setStatusLink('');
    try {
      if (format === 'gdocs') {
        if (!isDriveConfigured()) { setStatus('Google sign-in is not configured.'); return; }
        setDriveBusy(true);
        const saved = await saveDocumentToGoogleDocs(doc);
        setStatus('Saved to Google Drive.');
        setStatusLink(saved?.link || '');
      } else {
        await run(doc, format);
        setStatus(format === 'docx' ? 'Saved as Word.' : 'Saved as PDF.');
      }
    } catch (e: any) {
      setStatus(e?.message || 'The download failed.');
    } finally {
      setDriveBusy(false);
    }
  };
  return (
    <div className="doc-card">
      <div className="doc-card-title"><FileText size={18} /><span translate="no" dir="auto">{doc.title}</span></div>
      <div className="doc-card-actions">
        <div className="files-menu-wrap">
          <button type="button" className="ghost" disabled={!!busy || driveBusy} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            <Download size={14} />{busy || driveBusy ? 'Preparing…' : 'Save…'}
          </button>
          {open && (
            <div className="files-menu" role="menu">
              <button type="button" role="menuitem" className="files-menu-item" onClick={() => void saveFormat('docx')}>Word (.docx)</button>
              <button type="button" role="menuitem" className="files-menu-item" onClick={() => void saveFormat('pdf')}>PDF</button>
              {isDriveConfigured() && <button type="button" role="menuitem" className="files-menu-item" onClick={() => void saveFormat('gdocs')}>Google Docs</button>}
            </div>
          )}
        </div>
      </div>
      {(error || status) && (
        <div className="attach-error" role="status">
          {error || status}
          {!error && statusLink && status === 'Saved to Google Drive.' && <> <a href={statusLink} target="_blank" rel="noopener noreferrer">Open in Google Docs</a></>}
        </div>
      )}
    </div>
  );
}

/** Copy under an assistant reply. Full save lives in the Files panel. */
export function CopyButton({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
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
    </div>
  );
}

/** @deprecated Stage 2: use FilesPanel Save menu instead. Kept for rare call sites. */
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

/* ---------- Stage 2: permanent Files panel under the dialogue ---------- */

export type SaveWhat = 'dialogue' | 'agent-summary' | 'full-review' | 'calendar';
export type SaveWhere = 'docx' | 'pdf' | 'gdocs';

export function FilesPanel({
  files,
  onFilesChange,
  disabled,
  expertMode,
  title,
  history,
  canCalendar,
  onAgentSummary,
  onCalendar,
  buildFullReview,
  hideAdd,
}: {
  files: Attachment[];
  onFilesChange: (next: Attachment[]) => void;
  disabled?: boolean;
  expertMode?: boolean;
  title: string;
  history: any[];
  canCalendar?: boolean;
  /** Ask the agent for «Итог от агента» (document intent). */
  onAgentSummary?: () => void;
  /** Download .ics when review dates exist. */
  onCalendar?: () => void;
  /** Expert: build a DocumentSpec for the whole decision review. */
  buildFullReview?: () => DocumentSpec;
  /** Expert stages: hide «Add file» until attachments reach the expert requests. */
  hideAdd?: boolean;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveStep, setSaveStep] = useState<'what' | 'where'>('what');
  const [what, setWhat] = useState<SaveWhat>(expertMode ? 'full-review' : 'dialogue');
  const [status, setStatus] = useState('');
  const [statusLink, setStatusLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerList, setPickerList] = useState<ProgramFile[]>([]);
  const [pickerSelected, setPickerSelected] = useState<Record<string, boolean>>({});
  const [quotaMsg, setQuotaMsg] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click / Esc
  React.useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setAddOpen(false);
        setSaveOpen(false);
        setSaveStep('what');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAddOpen(false);
        setSaveOpen(false);
        setSaveStep('what');
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const dialogueDoc = (): DocumentSpec => {
    const sample = history.map((m) => String(m.content || '')).join(' ').slice(0, 2000);
    const ru = detectUiLanguage(sample) === 'ru';
    return conversationToDocument(title, history, ru
      ? { user: 'Вы', assistant: 'Агент', attached: 'Вложения' }
      : { user: 'You', assistant: 'Agent', attached: 'Attached' });
  };

  const pickDevice = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setStatus('');
    setAddOpen(false);
    const room = MAX_FILES_PER_MESSAGE - files.length;
    const chosen = Array.from(fileList).slice(0, Math.max(0, room));
    if (fileList.length > chosen.length) setStatus(`You can attach up to ${MAX_FILES_PER_MESSAGE} files to one message.`);
    let next = files;
    for (const f of chosen) {
      try {
        const a = await uploadAttachment(f);
        next = [...next, a];
        onFilesChange(next);
        setStatus(`Added ${a.name}`);
        void archiveAttachment(a); // Stage 3: text-only archive in IndexedDB
      } catch (e: any) {
        setStatus(e?.message || 'The file could not be attached.');
      }
    }
    if (input.current) input.current.value = '';
  };

  const doSave = async (where: SaveWhere) => {
    setSaveOpen(false);
    setSaveStep('what');
    setBusy(true);
    setStatus('');
    try {
      if (what === 'agent-summary') {
        onAgentSummary?.();
        setStatus('Requesting summary from the agent…');
        return;
      }
      if (what === 'calendar') {
        onCalendar?.();
        setStatus('Calendar downloaded.');
        return;
      }
      const doc = what === 'full-review' && buildFullReview ? buildFullReview() : dialogueDoc();
      if (where === 'gdocs') {
        if (!isDriveConfigured()) { setStatus('Google sign-in is not configured.'); return; }
        const saved = await saveDocumentToGoogleDocs(doc);
        setStatus('Saved to Google Drive.');
        setStatusLink(saved?.link || '');
      } else {
        await downloadDocument(doc, where);
        setStatus(where === 'docx' ? 'Saved as Word.' : 'Saved as PDF.');
      }
    } catch (e: any) {
      setStatus(e?.message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  };


  const loadPicker = async () => {
    try {
      const rows = await listProgramFiles();
      setPickerList(rows);
      setPickerSelected({});
      const q = await getProgramFilesQuota();
      setQuotaMsg(q.message || '');
    } catch {
      setPickerList([]);
      setQuotaMsg('Could not open program files.');
    }
  };

  const applyPicker = () => {
    const chosen = pickerList.filter((r) => pickerSelected[r.id]);
    if (!chosen.length) { setPickerOpen(false); return; }
    const room = MAX_FILES_PER_MESSAGE - files.length;
    const take = chosen.slice(0, Math.max(0, room));
    const next = [...files, ...take.map(programFileToAttachment)];
    onFilesChange(next);
    setStatus(take.length === 1 ? `Added ${take[0].name}` : `Added ${take.length} files`);
    setPickerOpen(false);
  };

  const openSave = () => {
    setAddOpen(false);
    setWhat(expertMode ? 'full-review' : 'dialogue');
    setSaveStep('what');
    setSaveOpen((v) => !v);
  };

  return (
    <div className="files-panel" ref={panelRef}>
      <div className="files-panel-buttons">
        <div className="files-menu-wrap" style={hideAdd ? { display: 'none' } : undefined}>
          <button
            type="button"
            className="ghost files-panel-btn"
            disabled={disabled || files.length >= MAX_FILES_PER_MESSAGE}
            aria-expanded={addOpen}
            onClick={() => { setSaveOpen(false); setAddOpen((v) => !v); }}
          >
            <Paperclip size={15} /> Add file
          </button>
          {addOpen && (
            <div className="files-menu" role="menu">
              <button type="button" role="menuitem" className="files-menu-item" onClick={() => input.current?.click()}>
                From device
              </button>
              <button type="button" role="menuitem" className="files-menu-item" onClick={() => { setAddOpen(false); setPickerOpen(true); void loadPicker(); }}>
                From program files
              </button>
            </div>
          )}
          <input ref={input} type="file" hidden multiple accept={ACCEPT_FILES} onChange={(e) => void pickDevice(e.target.files)} />
        </div>
        <div className="files-menu-wrap">
          <button
            type="button"
            className="ghost files-panel-btn"
            disabled={disabled || busy}
            aria-expanded={saveOpen}
            onClick={openSave}
          >
            <Download size={15} />{busy ? 'Saving…' : 'Save to file'}
          </button>
          {saveOpen && (
            <div className="files-menu" role="menu">
              {saveStep === 'what' && (
                <>
                  <div className="files-menu-label">What to save</div>
                  {history.length > 0 && <button type="button" role="menuitem" className={`files-menu-item${what === 'dialogue' ? ' active' : ''}`} onClick={() => { setWhat('dialogue'); setSaveStep('where'); }}>Whole dialogue</button>}
                  {onAgentSummary && <button type="button" role="menuitem" className={`files-menu-item${what === 'agent-summary' ? ' active' : ''}`} onClick={() => { setWhat('agent-summary'); void doSave('docx'); }}>Agent summary</button>}
                  {expertMode && (
                    <button type="button" role="menuitem" className={`files-menu-item${what === 'full-review' ? ' active' : ''}`} onClick={() => { setWhat('full-review'); setSaveStep('where'); }}>Full decision review</button>
                  )}
                  {canCalendar && (
                    <button type="button" role="menuitem" className="files-menu-item" onClick={() => { setWhat('calendar'); void doSave('docx'); }}>Reminder calendar (.ics)</button>
                  )}
                </>
              )}
              {saveStep === 'where' && (
                <>
                  <button type="button" className="files-menu-item files-menu-back" onClick={() => setSaveStep('what')}>← Back</button>
                  <div className="files-menu-label">Format</div>
                  <button type="button" role="menuitem" className="files-menu-item" onClick={() => void doSave('docx')}>Word (.docx)</button>
                  <button type="button" role="menuitem" className="files-menu-item" onClick={() => void doSave('pdf')}>PDF</button>
                  {isDriveConfigured() && (
                    <button type="button" role="menuitem" className="files-menu-item" onClick={() => void doSave('gdocs')}>Google Docs</button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {!hideAdd && (
        <span className="attach-privacy-note" title="Files are sent to Google Gemini together with your message. The server does not keep them.">
          File will be sent to Gemini
        </span>
      )}
      <AttachmentChips items={files} onRemove={(i) => onFilesChange(files.filter((_, k) => k !== i))} />
      {status && (
        <div className="files-panel-status" role="status">
          {status}
          {statusLink && status === 'Saved to Google Drive.' && <> <a href={statusLink} target="_blank" rel="noopener noreferrer">Open in Google Docs</a></>}
        </div>
      )}
      {quotaMsg && <div className="files-panel-status files-panel-warn" role="status">{quotaMsg}</div>}

      {pickerOpen && (
        <div className="pf-modal" role="dialog" aria-label="Program files">
          <div className="pf-modal-card">
            <div className="pf-modal-head">
              <strong>Program files</strong>
              <button type="button" className="ghost" onClick={() => setPickerOpen(false)} aria-label="Close">Close</button>
            </div>
            {quotaMsg && <div className="files-panel-warn">{quotaMsg}</div>}
            {!pickerList.length && <p className="pf-empty">No files in the archive yet. Attach a file from the device — its text is kept here for reuse.</p>}
            <ul className="pf-list">
              {pickerList.map((row) => (
                <li key={row.id} className="pf-row">
                  <label className="pf-row-main">
                    <input
                      type="checkbox"
                      checked={!!pickerSelected[row.id]}
                      onChange={(e) => setPickerSelected((s) => ({ ...s, [row.id]: e.target.checked }))}
                    />
                    <span className="pf-name" translate="no">{row.name}</span>
                    <small>{row.kind} · {new Date(row.addedAt).toLocaleDateString()}</small>
                  </label>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => void (async () => {
                      await deleteProgramFile(row.id);
                      void loadPicker();
                    })()}
                  >Delete</button>
                </li>
              ))}
            </ul>
            <div className="pf-modal-actions">
              <button type="button" className="ghost" onClick={() => setPickerOpen(false)}>Cancel</button>
              <button type="button" className="primary" onClick={applyPicker} disabled={!Object.values(pickerSelected).some(Boolean)}>
                Add to dialogue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Standalone manager opened from More → Program files */
export function ProgramFilesManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [list, setList] = useState<ProgramFile[]>([]);
  const [quotaMsg, setQuotaMsg] = useState('');
  React.useEffect(() => {
    if (!open) return;
    void (async () => {
      setList(await listProgramFiles());
      const q = await getProgramFilesQuota();
      setQuotaMsg(q.message || '');
    })();
  }, [open]);
  if (!open) return null;
  return (
    <div className="pf-modal" role="dialog" aria-label="Program files">
      <div className="pf-modal-card">
        <div className="pf-modal-head">
          <strong>Program files</strong>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <p className="pf-hint">Only text and descriptions are stored in this browser. Originals are not kept. Included in Export all (JSON backup).</p>
        {quotaMsg && <div className="files-panel-warn">{quotaMsg}</div>}
        {!list.length && <p className="pf-empty">Archive is empty.</p>}
        <ul className="pf-list">
          {list.map((row) => (
            <li key={row.id} className="pf-row">
              <div className="pf-row-main">
                <span className="pf-name" translate="no">{row.name}</span>
                <small>{row.kind} · {new Date(row.addedAt).toLocaleDateString()}{row.usedIn?.length ? ` · used in ${row.usedIn.length}` : ''}</small>
              </div>
              <button
                type="button"
                className="link-button"
                onClick={() => void (async () => {
                  await deleteProgramFile(row.id);
                  setList(await listProgramFiles());
                })()}
              >Delete</button>
            </li>
          ))}
        </ul>
        <div className="pf-modal-actions">
          <button type="button" className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
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
