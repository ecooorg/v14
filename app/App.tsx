/**
 * Bifurcation Engine v14 — main shell
 * Flow: privacy → storage → (connect Drive if B) → login → library / chat
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { en } from './i18n-en';
import {
  DialogRecord,
  Library,
  StorageMode,
  exportLibraryJson,
  getStorageMode,
  importLibraryJson,
  isDriveConfigured,
  isGoogleConnected,
  isGoogleDriveActive,
  loadLibrary,
  newId,
  privacyAccepted,
  requestGoogleDriveToken,
  restoreGoogleTokenFromSession,
  saveLibrary,
  setPrivacyAccepted,
  setStorageMode,
  setGoogleAccessToken,
} from './storage';
import { PHASE_PROGRESS, Phase, createInitialState, transition } from './machine';
import { OfflineIndicator } from './OfflineIndicator';
import { usePWAInstall } from './usePWAInstall';

type Screen =
  | 'boot'
  | 'privacy'
  | 'storage'
  | 'connect_drive'
  | 'login'
  | 'library'
  | 'chat'
  | 'settings'
  | 'about';

type Msg = { id: string; role: 'user' | 'agent'; text: string; at: number };

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: T }> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  const json = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, json };
}

function Modal({
  title,
  body,
  onConfirm,
  onCancel,
  confirmLabel,
}: {
  title: string;
  body: string;
  onConfirm: () => void;
  onCancel?: () => void;
  confirmLabel?: string;
}) {
  return (
    <div className="overlay" role="dialog">
      <div className="modal stack">
        <div className="title">{title}</div>
        <p className="muted">{body}</p>
        <div className="row">
          {onCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              {en.cancel}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {confirmLabel || en.ok}
          </button>
        </div>
      </div>
    </div>
  );
}

function StorageBadge() {
  if (isGoogleDriveActive()) {
    return <span className="badge-ok">{en.storageBadgeB}</span>;
  }
  if (getStorageMode() === 'google_drive') {
    return <span className="badge-warn">{en.storagePendingB}</span>;
  }
  return <span className="badge-warn">{en.storageWarningA}</span>;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('boot');
  const [lib, setLib] = useState<Library | null>(null);
  const [testerId, setTesterId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [loginError, setLoginError] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveError, setDriveError] = useState('');
  const [modal, setModal] = useState<null | { title: string; body: string; onConfirm: () => void }>(null);
  const [toast, setToast] = useState('');
  const { isInstallable: canInstall, install } = usePWAInstall();

  const active = useMemo(() => lib?.dialogs.find((d) => d.id === activeId) || null, [lib, activeId]);

  const persist = useCallback(async (next: Library) => {
    setLib(next);
    await saveLibrary(next);
  }, []);

  useEffect(() => {
    restoreGoogleTokenFromSession();
    (async () => {
      if (!privacyAccepted()) {
        setScreen('privacy');
        return;
      }
      const mode = getStorageMode();
      if (!mode) {
        setScreen('storage');
        return;
      }
      // Mode B without token → must connect Drive first
      if (mode === 'google_drive' && !isGoogleConnected()) {
        setScreen('connect_drive');
        return;
      }
      const session = await api<{ success?: boolean; data?: { testerId: string } }>('/api/session');
      if (session.ok && session.json.data?.testerId) {
        setTesterId(session.json.data.testerId);
        const library = await loadLibrary();
        setLib(library);
        setScreen('library');
      } else {
        setScreen('login');
      }
    })();
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError('');
    const res = await api<{ success?: boolean; data?: { testerId: string }; error?: string }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      setLoginError(en.invalidCode);
      return;
    }
    setTesterId(res.json.data!.testerId);
    const library = await loadLibrary();
    setLib(library);
    setScreen('library');
  }

  async function handleLogout() {
    await api('/api/logout', { method: 'POST' });
    setTesterId(null);
    setScreen('login');
  }

  function chooseStorage(mode: StorageMode) {
    if (mode === 'google_drive') {
      if (!isDriveConfigured()) {
        setToast(en.storageBUnavailable);
        return;
      }
      setStorageMode('google_drive');
      setDriveError('');
      setScreen('connect_drive');
      return;
    }
    setStorageMode('session');
    setGoogleAccessToken(null);
    setScreen('login');
  }

  async function connectDrive() {
    setDriveBusy(true);
    setDriveError('');
    try {
      await requestGoogleDriveToken();
      setToast(en.connectDriveOk);
      setScreen('login');
    } catch {
      setDriveError(en.connectDriveError);
    } finally {
      setDriveBusy(false);
    }
  }

  function createDialog() {
    if (!lib) return;
    const id = newId();
    const now = Date.now();
    const d: DialogRecord = {
      id,
      title: 'New dialog',
      createdAt: now,
      updatedAt: now,
      phase: 'INTAKE',
      messages: [],
      state: createInitialState(),
      cycleCount: 1,
    };
    const next = { ...lib, dialogs: [d, ...lib.dialogs] };
    void persist(next);
    setActiveId(id);
    setScreen('chat');
  }

  function openDialog(id: string) {
    setActiveId(id);
    setScreen('chat');
  }

  async function sendMessage() {
    if (!lib || !active || !input.trim() || busy) return;
    const text = input.trim();
    setInput('');
    const userMsg: Msg = { id: newId(), role: 'user', text, at: Date.now() };
    let messages = [...active.messages, userMsg];
    let updated: DialogRecord = {
      ...active,
      messages,
      updatedAt: Date.now(),
      lastSnippet: text.slice(0, 80),
    };
    let nextLib: Library = {
      ...lib,
      dialogs: lib.dialogs.map((d) => (d.id === active.id ? updated : d)),
    };
    setLib(nextLib);
    setBusy(true);
    try {
      const byok = lib.settings.userGeminiKey;
      const res = await api<{
        success?: boolean;
        data?: { reply: string; nextStep?: string; event?: string };
        code?: string;
        error?: string;
      }>('/api/conversation', {
        method: 'POST',
        headers: byok ? { 'x-byok-key': byok } : undefined,
        body: JSON.stringify({
          mode: lib.settings.mode,
          compactState: updated.state,
          recentMessages: messages.slice(-12).map((m) => ({ role: m.role, text: m.text })),
        }),
      });
      if (!res.ok) {
        const code = res.json.code;
        const errText =
          code === 'PROVIDER_QUOTA'
            ? en.providerQuota
            : code === 'AI_DISABLED'
              ? en.aiDisabled
              : res.json.error || en.errorGeneric;
        messages = [...messages, { id: newId(), role: 'agent', text: errText, at: Date.now() }];
      } else {
        const reply = res.json.data?.reply || '';
        messages = [...messages, { id: newId(), role: 'agent', text: reply, at: Date.now() }];
        try {
          const st = transition(
            (updated.state as ReturnType<typeof createInitialState>) || createInitialState(),
            'CONTINUE',
          );
          updated = { ...updated, state: st, phase: st.phase };
        } catch {
          /* keep */
        }
        if (res.json.data?.nextStep) {
          messages = [
            ...messages,
            {
              id: newId(),
              role: 'agent',
              text: `${en.nextStep}\n${res.json.data.nextStep}`,
              at: Date.now(),
            },
          ];
        }
      }
      updated = { ...updated, messages, updatedAt: Date.now() };
      if (updated.title === 'New dialog' && text) {
        updated.title = text.slice(0, 48) + (text.length > 48 ? '…' : '');
      }
      nextLib = { ...lib, dialogs: lib.dialogs.map((d) => (d.id === active.id ? updated : d)) };
      await persist(nextLib);
    } finally {
      setBusy(false);
    }
  }

  function deleteDialog(id: string) {
    setModal({
      title: en.delete,
      body: en.confirmDelete,
      onConfirm: () => {
        if (!lib) return;
        void persist({ ...lib, dialogs: lib.dialogs.filter((d) => d.id !== id) });
        if (activeId === id) {
          setActiveId(null);
          setScreen('library');
        }
        setModal(null);
      },
    });
  }

  function downloadBackup() {
    if (!lib) return;
    const blob = new Blob([exportLibraryJson(lib)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bifurcation-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }

  function importBackup(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (!lib) return;
        const merged = importLibraryJson(String(reader.result), lib);
        void persist(merged);
        setToast('Imported');
      } catch {
        setToast('Import failed');
      }
    };
    reader.readAsText(file);
  }

  if (screen === 'boot') {
    return (
      <div className="app-shell">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (screen === 'privacy') {
    return (
      <div className="app-shell stack">
        <h1 className="title">{en.privacyTitle}</h1>
        <div className="card">
          <p>{en.privacyBody}</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setPrivacyAccepted();
            setScreen(getStorageMode() ? (getStorageMode() === 'google_drive' && !isGoogleConnected() ? 'connect_drive' : 'login') : 'storage');
          }}
        >
          {en.privacyAccept}
        </button>
      </div>
    );
  }

  if (screen === 'storage') {
    return (
      <div className="app-shell stack">
        <h1 className="title">{en.storageTitle}</h1>
        <div className="card stack">
          <strong>{en.storageATitle}</strong>
          <p className="muted">{en.storageABody}</p>
          <button type="button" className="btn" onClick={() => chooseStorage('session')}>
            {en.storageChoose}
          </button>
        </div>
        <div className="card stack">
          <strong>{en.storageBTitle}</strong>
          <p className="muted">{en.storageBBody}</p>
          {isDriveConfigured() ? (
            <button type="button" className="btn btn-primary" onClick={() => chooseStorage('google_drive')}>
              {en.storageChoose}
            </button>
          ) : (
            <p className="badge-warn">{en.storageBUnavailable}</p>
          )}
        </div>
        {toast && <p className="hint">{toast}</p>}
      </div>
    );
  }

  if (screen === 'connect_drive') {
    return (
      <div className="app-shell stack">
        <h1 className="title">{en.connectDriveTitle}</h1>
        <div className="card stack">
          <p>{en.connectDriveBody}</p>
          {driveError && <p className="badge-warn">{driveError}</p>}
          <button type="button" className="btn btn-primary" disabled={driveBusy} onClick={() => void connectDrive()}>
            {driveBusy ? '…' : en.connectDriveBtn}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setStorageMode(null);
              setGoogleAccessToken(null);
              setScreen('storage');
            }}
          >
            {en.connectDriveSkip}
          </button>
        </div>
      </div>
    );
  }

  if (screen === 'login') {
    return (
      <div className="app-shell stack">
        <h1 className="title">{en.app}</h1>
        <p className="muted">{en.promise}</p>
        <form className="card stack" onSubmit={handleLogin}>
          <label htmlFor="code">{en.accessCode}</label>
          <p className="hint">{en.accessCodeHint}</p>
          <input
            id="code"
            type="password"
            autoComplete="one-time-code"
            placeholder={en.accessCodePlaceholder}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          {loginError && <p className="badge-warn">{loginError}</p>}
          <button type="submit" className="btn btn-primary">
            {en.signIn}
          </button>
        </form>
        <p className="hint">
          Storage: <StorageBadge />
        </p>
      </div>
    );
  }

  if (!lib) {
    return (
      <div className="app-shell">
        <p className="muted">Loading library…</p>
      </div>
    );
  }

  if (screen === 'settings') {
    return (
      <div className="app-shell stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1 className="title">{en.settings}</h1>
          <button type="button" className="btn btn-ghost" onClick={() => setScreen('library')}>
            Back
          </button>
        </div>
        <div className="card stack">
          <label>
            <input
              type="radio"
              checked={lib.settings.mode === 'normal'}
              onChange={() => void persist({ ...lib, settings: { ...lib.settings, mode: 'normal' } })}
            />{' '}
            {en.modeNormal}
          </label>
          <label>
            <input
              type="radio"
              checked={lib.settings.mode === 'expert'}
              onChange={() => void persist({ ...lib, settings: { ...lib.settings, mode: 'expert' } })}
            />{' '}
            {en.modeExpert}
          </label>
        </div>
        <div className="card stack">
          <label>{en.byok}</label>
          <input
            type="password"
            placeholder={en.byokPlaceholder}
            value={lib.settings.userGeminiKey || ''}
            onChange={(e) =>
              void persist({
                ...lib,
                settings: { ...lib.settings, userGeminiKey: e.target.value || undefined },
              })
            }
          />
        </div>
        <div className="card stack">
          <p className="muted">
            Storage: <StorageBadge />
          </p>
          {getStorageMode() === 'google_drive' && !isGoogleConnected() && (
            <button type="button" className="btn btn-primary" onClick={() => setScreen('connect_drive')}>
              {en.connectDriveBtn}
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setStorageMode(null);
              setGoogleAccessToken(null);
              setScreen('storage');
            }}
          >
            Change storage mode
          </button>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={downloadBackup}>
            {en.exportAll}
          </button>
          <label className="btn">
            {en.importAll}
            <input
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => e.target.files?.[0] && importBackup(e.target.files[0])}
            />
          </label>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => setScreen('about')}>
          {en.aboutMethod}
        </button>
        <p className="hint">{en.howToTranslate}</p>
        {canInstall && (
          <button type="button" className="btn" onClick={() => void install()}>
            Install on home screen
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => void handleLogout()}>
          {en.signOut}
        </button>
        <OfflineIndicator />
      </div>
    );
  }

  if (screen === 'about') {
    return (
      <div className="app-shell stack">
        <h1 className="title">{en.aboutMethod}</h1>
        <div className="card">
          <p>{en.aboutBody}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setScreen('settings')}>
          Back
        </button>
      </div>
    );
  }

  if (screen === 'library') {
    const list = lib.dialogs
      .filter((d) => !d.archived)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    return (
      <div className="app-shell stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1 className="title">{en.library}</h1>
          <button type="button" className="btn btn-ghost" onClick={() => setScreen('settings')}>
            {en.settings}
          </button>
        </div>
        <p>
          <StorageBadge />
        </p>
        <button type="button" className="btn btn-primary" onClick={createDialog}>
          {en.newDialog}
        </button>
        <div className="card" style={{ padding: 0 }}>
          {list.length === 0 && (
            <p className="muted" style={{ padding: 16 }}>
              {en.emptyLibrary}
            </p>
          )}
          {list.map((d) => (
            <div key={d.id} className="dialog-item" onClick={() => openDialog(d.id)}>
              <div>
                <div>
                  {d.pinned ? '📌 ' : ''}
                  {d.title}
                </div>
                <div className="hint">
                  {d.phase} · {d.lastSnippet || '—'} · {new Date(d.updatedAt).toLocaleString()}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteDialog(d.id);
                }}
              >
                {en.delete}
              </button>
            </div>
          ))}
        </div>
        {modal && (
          <Modal
            title={modal.title}
            body={modal.body}
            onConfirm={modal.onConfirm}
            onCancel={() => setModal(null)}
            confirmLabel={en.delete}
          />
        )}
      </div>
    );
  }

  const phase = (active?.phase as Phase) || 'INTAKE';
  return (
    <div className="app-shell" style={{ height: '100%' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <button type="button" className="btn btn-ghost" onClick={() => setScreen('library')}>
          ← {en.library}
        </button>
        <span className="hint">{active?.title}</span>
      </div>
      <div className="progress">
        {PHASE_PROGRESS.map((p) => (
          <span key={p.id} className={p.phases.includes(phase) ? 'current' : ''}>
            {en.progress[p.id as keyof typeof en.progress] || p.id}
          </span>
        ))}
      </div>
      <div className="chat-scroll">
        <p className="muted" style={{ marginBottom: 12 }}>
          {en.promise}
        </p>
        {(active?.messages || []).map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'msg-user' : 'msg-agent'} translate="no" dir="auto">
            {m.text}
          </div>
        ))}
        {busy && <p className="hint">{en.thinking}</p>}
      </div>
      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe your situation…"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void sendMessage();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !input.trim()}
          onClick={() => void sendMessage()}
        >
          {en.send}
        </button>
      </div>
      {modal && (
        <Modal title={modal.title} body={modal.body} onConfirm={modal.onConfirm} onCancel={() => setModal(null)} />
      )}
    </div>
  );
}
