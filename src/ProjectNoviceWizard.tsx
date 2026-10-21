/**
 * P58 — Novice wizard: idea → short questions → confirm → create project + optional code build.
 * Uses existing Project APIs only. Does not change Simple/Expert.
 */
import React, { useMemo, useState } from 'react';
import {
  NOVICE_KIND_OPTIONS,
  STACK_TEMPLATES,
  emptyNoviceAnswers,
  passportFromNoviceAnswers,
  buildGoalFromNoviceAnswers,
  manualDeployInstructions,
  suggestProjectName,
  type NoviceAnswers,
} from './projectAppBuilder.ts';

const S: Record<string, React.CSSProperties> = {
  box: { margin: '12px 0', padding: 16, border: '1px solid #1f4f86', borderRadius: 10, background: '#0b1a2c' },
  label: { display: 'grid', gap: 6, fontSize: 13, marginBottom: 12 },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 44,
    padding: 10,
    border: '1px solid #3d7fc4',
    borderRadius: 8,
    background: '#07111f',
    color: '#e6edf7',
    fontSize: 16,
  },
  button: {
    minHeight: 44,
    padding: '10px 16px',
    border: '1px solid #3d7fc4',
    borderRadius: 8,
    background: '#0b2545',
    color: '#9fd8ff',
    cursor: 'pointer',
  },
  primary: { background: '#12345a', borderColor: '#78baff', color: '#e6edf7' },
  muted: { fontSize: 13, color: '#8fa6c2' },
  row: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  choice: {
    minHeight: 40,
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid #25405e',
    background: '#07111f',
    color: '#c5d4e8',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  choiceOn: { borderColor: '#78baff', background: '#12345a', color: '#e6edf7' },
};

type Step = 0 | 1 | 2 | 3 | 4;

export function ProjectNoviceWizard({
  busy,
  onBack,
  onFinished,
  createProject,
  confirmPassport,
  requestBuild,
  programZipAvailable,
}: {
  busy: boolean;
  onBack: () => void;
  onFinished: (projectId: string) => void;
  createProject: (name: string, goal: string) => Promise<{ id: string; state_version: number; state: Record<string, unknown> }>;
  confirmPassport: (
    projectId: string,
    expectedVersion: number,
    passport: ReturnType<typeof passportFromNoviceAnswers> & { status: 'proposed' | 'confirmed' },
    stateBase: Record<string, unknown>,
  ) => Promise<{ state_version: number }>;
  requestBuild: (projectId: string, goal: string, answers: NoviceAnswers) => Promise<{ downloadUrl?: string; note?: string; status?: string; stack?: string }>;
  programZipAvailable: boolean;
}) {
  const [step, setStep] = useState<Step>(0);
  const [answers, setAnswers] = useState<NoviceAnswers>(emptyNoviceAnswers);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');

  const canNextIdea = answers.idea.trim().length >= 8;
  const passportPreview = useMemo(() => passportFromNoviceAnswers(answers), [answers]);
  const buildGoal = useMemo(() => buildGoalFromNoviceAnswers(answers), [answers]);
  const deployText = useMemo(() => manualDeployInstructions(projectName || suggestProjectName(answers.idea)), [projectName, answers.idea]);

  const set = <K extends keyof NoviceAnswers>(key: K, value: NoviceAnswers[K]) =>
    setAnswers((prev) => ({ ...prev, [key]: value }));

  const runCreateAndBuild = async () => {
    setError('');
    setNotice('');
    setDownloadUrl(null);
    try {
      const name = suggestProjectName(answers.idea);
      setProjectName(name);
      const project = await createProject(name, answers.idea.trim());
      const passport = { ...passportFromNoviceAnswers(answers), status: 'confirmed' as const };
      const nextState = {
        ...project.state,
        passport,
        appBuilder: { path: 'novice', answers, createdAt: new Date().toISOString() },
      };
      await confirmPassport(project.id, project.state_version, passport, nextState);
      setNotice('Project created and description confirmed.');

      setNotice('Project created. Building source ZIP (IR → scaffold)…');
      const built = await requestBuild(project.id, answers.idea.trim(), answers);
      if (built.downloadUrl) {
        setDownloadUrl(built.downloadUrl);
        setNotice(`Source ZIP ready${built.stack ? ` (stack: ${built.stack})` : ''}. Download and follow the steps below.`);
      } else {
        setNotice(
          `Project is ready. Build status: ${built.status || 'unknown'}. ${built.note || 'Open the project for more tools.'}`,
        );
      }
      setStep(4);
      onFinished(project.id);
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  return (
    <div data-testid="project-novice-wizard">
      <button type="button" style={{ ...S.button, marginBottom: 8 }} disabled={busy} onClick={onBack}>
        ← Back to path choice
      </button>
      <h2 style={{ margin: '4px 0 8px' }}>Simple words</h2>
      <p style={S.muted}>Step {Math.min(step + 1, 5)} of 5 · You stay in control; nothing is published automatically.</p>

      {step === 0 && (
        <div style={S.box}>
          <label style={S.label}>
            What do you want to build? (ordinary language)
            <textarea
              value={answers.idea}
              onChange={(e) => set('idea', e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="Example: A simple site where people register and leave short notes. Should work on a phone."
              style={S.input}
            />
          </label>
          <div style={S.row}>
            <button type="button" style={{ ...S.button, ...S.primary }} disabled={busy || !canNextIdea} onClick={() => setStep(1)}>
              Next
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div style={S.box}>
          <p style={{ marginTop: 0 }}>What kind of product is this?</p>
          <div style={{ display: 'grid', gap: 8 }}>
            {NOVICE_KIND_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                style={{ ...S.choice, ...(answers.kind === o.id ? S.choiceOn : {}) }}
                onClick={() => set('kind', o.id)}
              >
                <strong>{o.label}</strong>
                <div style={S.muted}>{o.hint}</div>
              </button>
            ))}
          </div>
          <div style={S.row}>
            <button type="button" style={S.button} onClick={() => setStep(0)}>
              Back
            </button>
            <button type="button" style={{ ...S.button, ...S.primary }} onClick={() => setStep(2)}>
              Next
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={S.box}>
          <p style={{ marginTop: 0 }}>A few choices (tap one in each group)</p>
          <p style={S.muted}>Do people need to sign in?</p>
          <div style={S.row}>
            {(
              [
                ['yes', 'Yes'],
                ['no', 'No'],
                ['unsure', 'Not sure'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                style={{ ...S.choice, ...(answers.needsAuth === id ? S.choiceOn : {}) }}
                onClick={() => set('needsAuth', id)}
              >
                {label}
              </button>
            ))}
          </div>
          <p style={S.muted}>Do you need to store data (database)?</p>
          <div style={S.row}>
            {(
              [
                ['yes', 'Yes'],
                ['no', 'No'],
                ['unsure', 'Not sure'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                style={{ ...S.choice, ...(answers.needsDb === id ? S.choiceOn : {}) }}
                onClick={() => set('needsDb', id)}
              >
                {label}
              </button>
            ))}
          </div>
          <p style={S.muted}>Interface language</p>
          <div style={S.row}>
            {(
              [
                ['en', 'English'],
                ['ru', 'Russian'],
                ['other', 'Other / mixed'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                style={{ ...S.choice, ...(answers.language === id ? S.choiceOn : {}) }}
                onClick={() => set('language', id)}
              >
                {label}
              </button>
            ))}
          </div>
          <label style={{ ...S.label, marginTop: 12 }}>
            Any constraints? (optional)
            <input
              value={answers.constraints}
              onChange={(e) => set('constraints', e.target.value)}
              placeholder="e.g. free to run, no paid APIs"
              style={S.input}
              maxLength={500}
            />
          </label>
          <div style={S.row}>
            <button type="button" style={S.button} onClick={() => setStep(1)}>
              Back
            </button>
            <button type="button" style={{ ...S.button, ...S.primary }} onClick={() => setStep(3)}>
              Next
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div style={S.box}>
          <p style={{ marginTop: 0 }}>Technical shape (optional — you can leave “Choose for me”)</p>
          <div style={{ display: 'grid', gap: 8 }}>
            {STACK_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                style={{ ...S.choice, ...(answers.stack === t.id ? S.choiceOn : {}) }}
                onClick={() => set('stack', t.id)}
              >
                <strong>{t.label}</strong>
                <div style={S.muted}>{t.summary}</div>
              </button>
            ))}
          </div>
          <div style={{ ...S.box, marginTop: 16, borderStyle: 'dashed' }}>
            <strong>Summary</strong>
            <p style={S.muted}>{passportPreview.goal}</p>
            <p style={S.muted}>{passportPreview.inputsOutputs}</p>
            <p style={S.muted}>{passportPreview.constraints}</p>
          </div>
          <div style={S.row}>
            <button type="button" style={S.button} disabled={busy} onClick={() => setStep(2)}>
              Back
            </button>
            <button type="button" style={{ ...S.button, ...S.primary }} disabled={busy} onClick={() => void runCreateAndBuild()}>
              {busy ? 'Working…' : 'Create project & build ZIP'}
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div style={S.box} data-testid="novice-done">
          <h3 style={{ marginTop: 0 }}>Done</h3>
          {notice && <p style={{ color: '#9fd8ff' }}>{notice}</p>}
          {downloadUrl && (
            <p>
              <a href={downloadUrl} style={{ color: '#78baff', fontWeight: 600 }} download>
                Download source ZIP
              </a>
            </p>
          )}
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 13,
              background: '#07111f',
              padding: 12,
              borderRadius: 8,
              border: '1px solid #25405e',
              color: '#c5d4e8',
            }}
          >
            {deployText}
          </pre>
          <p style={S.muted}>
            You can open the project in the list below for more analysis, another build, or Professional tools.
          </p>
        </div>
      )}

      {error && (
        <p role="alert" style={{ color: '#f1b3ac' }}>
          {error}
        </p>
      )}
    </div>
  );
}

export default ProjectNoviceWizard;
