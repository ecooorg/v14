/**
 * Full-screen User Guide for Simple, Expert and Project.
 * - Covers the whole viewport (not a small card over the chat)
 * - Body scrolls end-to-end (flex minHeight: 0 — required on mobile Chrome)
 * - Optional “Open in new tab” for a real separate browser window
 */
import React, { useEffect, useCallback } from 'react';
import { CircleHelp, ExternalLink, X } from 'lucide-react';

export function UserGuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    const prevPos = document.body.style.position;
    document.body.style.overflow = 'hidden';
    // Reduce background scroll on iOS/Android while guide is open
    document.body.style.position = 'relative';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      document.body.style.position = prevPos;
    };
  }, [open, onClose]);

  const openInNewTab = useCallback(() => {
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>BiForge User Guide</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;max-width:720px;margin:24px auto;padding:0 16px 48px;background:#0d1b2a;color:#e6edf7}
h1{font-size:1.5rem}h2{font-size:1.2rem;margin-top:1.6em;border-bottom:1px solid #1f4f86;padding-bottom:6px}
h3{font-size:1.05rem;margin-top:1.2em;color:#9fd8ff}table{border-collapse:collapse;width:100%;font-size:0.9rem}
th,td{border:1px solid #25405e;padding:6px 8px;text-align:left}th{background:#10243a}
code{background:#07111f;padding:1px 4px;border-radius:4px}a{color:#78baff}ul,ol{padding-left:1.3em}
</style></head><body>${guideHtmlForPrint()}</body></html>`;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);

  if (!open) return null;

  return (
    <div
      className="user-guide-root"
      role="dialog"
      aria-modal="true"
      aria-label="BiForge user guide"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 3000,
        display: 'flex',
        flexDirection: 'column',
        background: '#07111f',
        color: '#e6edf7',
        width: '100%',
        height: '100%',
        maxHeight: '100dvh',
      }}
    >
      <div
        className="user-guide-toolbar"
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '12px 14px',
          paddingTop: 'max(12px, env(safe-area-inset-top))',
          borderBottom: '1px solid #1f4f86',
          background: '#0d1b2a',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 17, display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          <CircleHelp size={18} aria-hidden /> BiForge user guide
        </h1>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button type="button" className="ghost" onClick={openInNewTab} title="Open the full guide in a new browser tab">
            <ExternalLink size={14} /> <span className="lbl">New tab</span>
          </button>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close user guide">
            <X size={16} /> <span className="lbl">Close</span>
          </button>
        </div>
      </div>

      {/* minHeight: 0 is required so this flex child can scroll on mobile Chrome */}
      <div
        className="user-guide-scroll"
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'contain',
          padding: '16px 16px max(32px, env(safe-area-inset-bottom))',
          maxWidth: 720,
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
          fontSize: 15,
          lineHeight: 1.65,
        }}
      >
        <GuideBody />
        <p style={{ color: '#8fa6c2', fontSize: 13, marginTop: 32, paddingBottom: 24 }}>
          End of guide. Use <strong>New tab</strong> above if you prefer a separate browser window.
        </p>
      </div>
    </div>
  );
}

function guideHtmlForPrint(): string {
  // Plain HTML string for the new-tab view (no React).
  return `
<h1>BiForge User Guide</h1>
<p><strong>Product version 55.</strong> The AI proposes; <strong>only you decide</strong>. Not legal, medical, or financial advice.</p>
<h2>1. Getting started</h2>
<ol>
<li>Open the BiForge URL from your administrator.</li>
<li>Do not enter passwords, card numbers, or ID documents.</li>
<li>Choose <strong>Simple</strong>, <strong>Expert</strong>, or <strong>Project</strong> (Project may need sign-in).</li>
</ol>
<p>Switch modes anytime with the <strong>Mode</strong> button.</p>
<h2>2. Top menu</h2>
<ul>
<li><strong>Mode</strong> — Simple / Expert / Project, or back to mode selection.</li>
<li><strong>New</strong> — new dialogue (Simple/Expert).</li>
<li><strong>Drive</strong> — Google Drive mirror <em>while this tab is open</em>.</li>
<li><strong>History</strong> — past dialogues on this device.</li>
<li><strong>More</strong> — Export, Import, saved texts, Gemini key, Decision brief / Delete (Expert), User guide.</li>
</ul>
<h2>3. Simple mode</h2>
<p>Open conversation without required steps. Describe the situation, chat, optionally add detail fields, attach files, export under More.</p>
<h2>4. Expert mode</h2>
<p>Guided method: Understand → Explore → Challenge → Check → Learn. Confirm suggestions yourself. Open chat stays for clarifications. Decision brief shows structured fields once they exist — not a second copy of the chat.</p>
<table><thead><tr><th>Stage</th><th>You</th><th>Model</th></tr></thead><tbody>
<tr><td>Start</td><td>Safety / fit check</td><td>—</td></tr>
<tr><td>Your story</td><td>Describe the situation</td><td>Helps organize</td></tr>
<tr><td>Clarify</td><td>Confirm facts / unknowns</td><td>Knowledge map</td></tr>
<tr><td>Options</td><td>Mark realistic options</td><td>Suggests more</td></tr>
<tr><td>Challenge</td><td>Stress-test</td><td>Challenges assumptions</td></tr>
<tr><td>Check</td><td>Small tests</td><td>Helps design tests</td></tr>
<tr><td>Decide</td><td>Your decision</td><td>Does not choose</td></tr>
<tr><td>Learn</td><td>Lessons / next cycle</td><td>Supports reflection</td></tr>
</tbody></table>
<h2>5. Project mode</h2>
<p>Separate from Simple/Expert. Two paths: <strong>Simple words</strong> (idea → questions → ZIP + manual deploy steps) or <strong>Professional</strong> (analysis, plan, delivery). GitHub is read-only; BiForge never merges or deploys for you.</p>
<ol>
<li>Sign in if required; choose a path; check <em>What is available here</em>.</li>
<li>Simple words: describe the idea, answer button questions, confirm once, download ZIP.</li>
<li>Professional: create a project; confirm the <strong>project description</strong>.</li>
<li>Run analysis; on Results, <strong>Confirm</strong> or <strong>Reject</strong> each item (nothing is accepted automatically).</li>
<li>Add human decisions; create a plan; approve budgets/gates; start tasks.</li>
<li>Download source ZIP and follow on-screen manual deploy steps (GitHub + host by hand).</li>
<li>Files / optional developer JSON.</li>
</ol>
<p>Paths: Simple words → ZIP · or Description → Analysis → Confirm → Plan → ZIP / Delivery.</p>
<h2>6. Google Drive</h2>
<p>Mirroring works only while the tab is open. Optional.</p>
<h2>7. Export</h2>
<p>JSON backup, Markdown, Word, PDF, Google Docs, project artifacts / ZIP.</p>
<h2>8. Safety</h2>
<ul>
<li>No secrets in chat.</li>
<li>Urgent personal help → real person or local help service.</li>
<li>Verify important facts yourself.</li>
</ul>
<h2>9. Troubleshooting</h2>
<ul>
<li>Project unavailable — disabled by admin.</li>
<li>Analysis blocked — confirm project description.</li>
<li>Save rejected — project changed in another window; reload.</li>
<li>Drive not syncing — reconnect; keep tab open.</li>
<li>Folder import — desktop browser only.</li>
</ul>
<p style="color:#8fa6c2">Repository copy: docs/USER_GUIDE.md</p>
`;
}

function GuideBody() {
  const h2: React.CSSProperties = {
    fontSize: 18,
    margin: '28px 0 10px',
    paddingBottom: 6,
    borderBottom: '1px solid #1f4f86',
    color: '#e6edf7',
  };
  const h3: React.CSSProperties = {
    fontSize: 15,
    margin: '18px 0 8px',
    color: '#9fd8ff',
  };
  const muted: React.CSSProperties = { color: '#8fa6c2' };

  return (
    <article className="user-guide-article">
      <p style={{ marginTop: 0 }}>
        <strong>BiForge</strong> is a calm decision and project workspace. The AI proposes structure and questions;{' '}
        <strong>only you make decisions</strong>. It does not replace professional advice and does not pick a winner for you.
      </p>

      <h2 style={h2}>1. Getting started</h2>
      <ol>
        <li>Open the BiForge URL provided by your administrator.</li>
        <li>Do <strong>not</strong> enter passwords, card numbers, or identity documents.</li>
        <li>
          Choose a mode:
          <ul>
            <li>
              <strong>Simple</strong> — open conversation, no required steps.
            </li>
            <li>
              <strong>Expert</strong> — guided method: Understand → Explore → Challenge → Check → Learn.
            </li>
            <li>
              <strong>Project</strong> — separate workspace for multi-step work (may require sign-in).
            </li>
          </ul>
        </li>
      </ol>
      <p style={muted}>Use the <strong>Mode</strong> button anytime to switch or return to mode selection.</p>

      <h2 style={h2}>2. Top menu (all modes)</h2>
      <ul>
        <li>
          <strong>Mode</strong> — Simple / Expert / Project, or back to mode selection.
        </li>
        <li>
          <strong>New</strong> (Simple/Expert) — start a new dialogue.
        </li>
        <li>
          <strong>Drive</strong> — connect Google Drive. Mirroring runs <em>only while this tab is open</em>.
        </li>
        <li>
          <strong>History</strong> — past dialogues on this device (unavailable in some private browser modes).
        </li>
        <li>
          <strong>More</strong> — Export (JSON, Markdown, Word, PDF, Google Docs), Import (backup, folder on desktop, Drive,
          file as new dialogue), saved texts, optional Gemini API key, Decision brief / Delete (Expert), and this guide.
        </li>
      </ul>

      <h2 style={h2}>3. Simple mode</h2>
      <ol>
        <li>Describe the situation in your own words.</li>
        <li>Chat with the assistant; ask for options, risks, or clearer framing.</li>
        <li>Optional: add detail fields (facts, unknowns, values, constraints).</li>
        <li>Attach files the assistant may read (confirm privacy when asked).</li>
        <li>Export backups under More; connect Drive if you want live mirror while the tab is open.</li>
      </ol>

      <h2 style={h2}>4. Expert mode</h2>
      <p>
        Stages appear in the sidebar. You confirm suggestions. Open chat under the stages is for clarifications only — it does
        not auto-advance stages.
      </p>
      <div style={{ overflowX: 'auto', margin: '12px 0' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #1f4f86' }}>
              <th style={{ padding: '6px 4px' }}>Stage</th>
              <th style={{ padding: '6px 4px' }}>You</th>
              <th style={{ padding: '6px 4px' }}>Model</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ padding: '6px 4px' }}>Start</td>
              <td style={{ padding: '6px 4px' }}>Safety / fit</td>
              <td style={{ padding: '6px 4px' }}>—</td>
            </tr>
            <tr>
              <td style={{ padding: '6px 4px' }}>Your story</td>
              <td style={{ padding: '6px 4px' }}>Describe the situation</td>
              <td style={{ padding: '6px 4px' }}>Helps organize</td>
            </tr>
            <tr>
              <td style={{ padding: '6px 4px' }}>Clarify</td>
              <td style={{ padding: '6px 4px' }}>Confirm facts / unknowns</td>
              <td style={{ padding: '6px 4px' }}>Knowledge map</td>
            </tr>
            <tr>
              <td style={{ padding: '6px 4px' }}>Options</td>
              <td style={{ padding: '6px 4px' }}>Mark realistic options</td>
              <td style={{ padding: '6px 4px' }}>Suggests more</td>
            </tr>
            <tr>
              <td style={{ padding: '6px 4px' }}>Challenge</td>
              <td style={{ padding: '6px 4px' }}>Stress-test</td>
              <td style={{ padding: '6px 4px' }}>Challenges assumptions</td>
            </tr>
            <tr>
              <td style={{ padding: '6px 4px' }}>Check</td>
              <td style={{ padding: '6px 4px' }}>Small tests</td>
              <td style={{ padding: '6px 4px' }}>Helps design tests</td>
            </tr>
            <tr>
              <td style={{ padding: '6px 4px' }}>Decide</td>
              <td style={{ padding: '6px 4px' }}>Your decision</td>
              <td style={{ padding: '6px 4px' }}>Does not choose</td>
            </tr>
            <tr>
              <td style={{ padding: '6px 4px' }}>Learn</td>
              <td style={{ padding: '6px 4px' }}>Lessons / next cycle</td>
              <td style={{ padding: '6px 4px' }}>Supports reflection</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p style={muted}>
        <strong>Decision brief</strong> opens only when structured fields exist. The analysis already in the chat is not covered
        by an empty frame.
      </p>

      <h2 style={h2}>5. Project mode</h2>
      <p>
        Separate workspace (does not change Simple or Expert). Two paths on the start screen:
      </p>
      <ul>
        <li>
          <strong>Simple words</strong> — describe the idea in ordinary language, answer a few button questions, confirm once.
          When program ZIP is enabled on the server, you get a source archive plus manual deploy steps (GitHub + host by hand).
        </li>
        <li>
          <strong>Professional</strong> — more control: project description, analysis, plans, tasks, delivery tools. Same final
          idea: a ZIP you publish yourself. <strong>GitHub is read-only</strong>; BiForge never merges or deploys for you.
        </li>
      </ul>
      <h3 style={h3}>Suggested path (Professional)</h3>
      <ol>
        <li>Sign in if required; open <em>What is available here</em>; choose Professional if you want full tools.</li>
        <li>
          Create a project; confirm the <strong>project description</strong> to unlock analysis.
        </li>
        <li>
          Run <strong>analysis</strong>. On Results, nothing is accepted until you press <strong>Confirm</strong>. Use{' '}
          <strong>Reject</strong> for wrong suggestions.
        </li>
        <li>Add human decisions in your own words.</li>
        <li>
          Create a <strong>plan</strong>, approve budgets and gates, start tasks.
        </li>
        <li>
          <strong>Delivery</strong> or <strong>Create program</strong>: download the source ZIP, follow the on-screen manual
          deploy steps, work outside BiForge. You upload to GitHub and connect Render/Railway yourself.
        </li>
        <li>Files: artifacts, Drive save, model request history. Developer JSON is optional and hidden until you enable it.</li>
      </ol>

      <h2 style={h2}>6. Google Drive</h2>
      <p>
        Connect via <strong>Drive</strong> in the top bar. While the tab is open and connected, decisions and selected files can be
        mirrored. Closing the tab stops live mirroring for that session.
      </p>
      <p>
        Files go to <strong>My Drive → BiForge → Simple / Expert / Project</strong>. A file attached before you connect Drive is saved right
        after you connect, and every save or refusal is shown as a message. In Project use <strong>Connect Google Drive</strong> and the
        <strong>Save to Google Drive</strong> buttons.
      </p>

      <h2 style={h2}>7. Export and backup</h2>
      <ul>
        <li>
          <strong>JSON</strong> — full restore of a dialogue
        </li>
        <li>
          <strong>Markdown / Word / PDF</strong> — sharing or printing
        </li>
        <li>
          <strong>Google Docs</strong> — when Drive is connected
        </li>
        <li>Project artifacts and program ZIP — from Project files / build</li>
      </ul>

      <h2 style={h2}>8. Safety</h2>
      <ul>
        <li>Do not enter passwords, card numbers, or ID documents.</li>
        <li>If you need urgent personal help, pause and contact a real person or local help service.</li>
        <li>Model output can be wrong; verify important facts yourself.</li>
        <li>Optional web search (if enabled on the server) still needs your judgment.</li>
      </ul>

      <h2 style={h2}>9. Troubleshooting</h2>
      <ul>
        <li>
          <strong>Project unavailable</strong> — disabled for this deployment; ask the administrator.
        </li>
        <li>
          <strong>Analysis blocked</strong> — confirm the project description first.
        </li>
        <li>
          <strong>Save rejected</strong> — the project changed in another window; reload and retry.
        </li>
        <li>
          <strong>Drive not syncing</strong> — reconnect; keep the tab open; check browser permissions.
        </li>
        <li>
          <strong>Folder import missing</strong> — use a desktop browser with folder picker support.
        </li>
        <li>
          <strong>Gemini errors</strong> — try the server key, or set your own key under More.
        </li>
      </ul>

      <h2 style={h2}>10. Principles</h2>
      <ol>
        <li>
          <strong>Human decides</strong> — confirm, reject, approve, or write decisions yourself.
        </li>
        <li>
          <strong>State over chat</strong> — especially in Project, durable state matters more than transcript length.
        </li>
        <li>
          <strong>No silent automation</strong> — plans, budgets, gates, and merges require explicit human action.
        </li>
        <li>
          <strong>Calm process</strong> — Simple for free thought, Expert for a careful method, Project for managed delivery.
        </li>
      </ol>

      <p style={{ ...muted, marginBottom: 0 }}>
        Repository copy: <code>docs/USER_GUIDE.md</code>. Operators: <code>docs/OWNER_OPS.md</code>.
      </p>
    </article>
  );
}

export default UserGuideModal;
