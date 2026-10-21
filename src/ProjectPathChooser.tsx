/**
 * P58 — First screen of Project Mode: choose Novice vs Professional path.
 * Isolated UI; does not affect Simple/Expert routes.
 */
import React from 'react';
import type { BuilderPath } from './projectAppBuilder.ts';

const S: Record<string, React.CSSProperties> = {
  grid: { display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginTop: 16 },
  card: {
    textAlign: 'left',
    padding: 20,
    borderRadius: 12,
    border: '1px solid #1f4f86',
    background: '#0b2545',
    color: '#e6edf7',
    cursor: 'pointer',
    minHeight: 160,
  },
  title: { margin: '0 0 8px', fontSize: 18, color: '#9fd8ff' },
  body: { margin: 0, fontSize: 14, color: '#c5d4e8', lineHeight: 1.45 },
  tag: { display: 'inline-block', marginTop: 12, fontSize: 12, color: '#8fa6c2' },
};

export function ProjectPathChooser({
  onChoose,
  disabled,
}: {
  onChoose: (path: BuilderPath) => void;
  disabled?: boolean;
}) {
  return (
    <div data-testid="project-path-chooser">
      <h2 style={{ margin: '8px 0 4px', fontSize: 20 }}>How do you want to work?</h2>
      <p style={{ color: '#8fa6c2', marginTop: 0, fontSize: 14 }}>
        Both paths end with a <strong>source ZIP</strong> and a short manual guide (GitHub + host by hand). Nothing is pushed
        automatically.
      </p>
      <div style={S.grid}>
        <button
          type="button"
          data-testid="path-novice"
          disabled={disabled}
          style={{ ...S.card, opacity: disabled ? 0.6 : 1 }}
          onClick={() => onChoose('novice')}
        >
          <h3 style={S.title}>Simple words</h3>
          <p style={S.body}>
            Describe the idea in ordinary language. Answer a few questions with buttons. Confirm once. Get a project ZIP and
            deploy steps — no technical jargon required.
          </p>
          <span style={S.tag}>Best for beginners and clear goals</span>
        </button>
        <button
          type="button"
          data-testid="path-professional"
          disabled={disabled}
          style={{ ...S.card, opacity: disabled ? 0.6 : 1 }}
          onClick={() => onChoose('professional')}
        >
          <h3 style={S.title}>Professional</h3>
          <p style={S.body}>
            More control: project description, analysis, plans, tasks, and delivery tools. Still ends with a ZIP you upload
            yourself. Use when you already know the domain and constraints.
          </p>
          <span style={S.tag}>Best for specialists who want settings</span>
        </button>
      </div>
    </div>
  );
}

export default ProjectPathChooser;
