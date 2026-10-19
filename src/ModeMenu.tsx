import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Layers, RotateCcw } from 'lucide-react';

/**
 * P51 — one "Mode" control for every screen (Simple, Expert, Project).
 * Shows the current mode and opens a list of the three modes plus a way back to the start screen.
 * The caller decides what each choice does (the chat shell switches in place, Project navigates).
 */
export type AppMode = 'Simple' | 'Expert' | 'Project';

/** Same key the chat shell uses to remember the chosen mode for this browser session. */
export const START_MODE_KEY = 'biforge-start-mode';

const ITEMS: { mode: AppMode; label: string; hint: string }[] = [
  { mode: 'Simple', label: 'Simple chat', hint: 'Open conversation — no required steps' },
  { mode: 'Expert', label: 'Expert method', hint: 'Step-by-step decision method with stages' },
  { mode: 'Project', label: 'Project workspace', hint: 'Separate page: plans, tasks, confirmations' },
];

export function ModeMenu(props: {
  current: AppMode;
  /** When false the Project entry is shown but disabled (deployment without Project mode). */
  projectEnabled: boolean;
  onSelect: (mode: AppMode) => void;
  /** Return to the start screen with the three mode cards. */
  onOverview: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="mode-menu-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="ghost mode-btn"
        data-testid="mode-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Mode: switch between Simple, Expert and Project"
        onClick={() => setOpen((v) => !v)}
      >
        <Layers size={14} className="mode-btn-icon" />
        <span className="lbl">{props.current}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="mode-menu-list" role="menu" aria-label="Mode">
          {ITEMS.map((it) => {
            const disabled = it.mode === 'Project' && !props.projectEnabled;
            const selected = it.mode === props.current;
            return (
              <button
                key={it.mode}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                disabled={disabled}
                className={`ghost mode-item${selected ? ' selected' : ''}`}
                data-testid={`mode-item-${it.mode.toLowerCase()}`}
                onClick={() => { setOpen(false); if (!selected) props.onSelect(it.mode); }}
              >
                <span className="mode-item-check">{selected ? <Check size={14} /> : null}</span>
                <span className="mode-item-text">
                  <strong>{it.label}</strong>
                  <small>{disabled ? 'Unavailable: Project mode is disabled for this deployment' : it.hint}</small>
                </span>
              </button>
            );
          })}
          <div className="mode-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="ghost mode-item"
            data-testid="change-mode"
            title="Return to the screen where you choose Simple, Expert or Project"
            onClick={() => { setOpen(false); props.onOverview(); }}
          >
            <span className="mode-item-check"><RotateCcw size={14} /></span>
            <span className="mode-item-text"><strong>Back to mode selection</strong></span>
          </button>
        </div>
      )}
    </div>
  );
}
