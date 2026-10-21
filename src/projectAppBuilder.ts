/**
 * P58 — App Builder helpers for Project Mode.
 * Pure client helpers: question sets, passport mapping, deploy instructions.
 * Does not touch Simple/Expert. No network. No secrets.
 */

export type BuilderPath = 'novice' | 'professional';

export type StackId = 'node_express_react' | 'node_express_api' | 'static_site' | 'auto';

export interface NoviceAnswers {
  idea: string;
  kind: 'website' | 'app' | 'bot' | 'utility' | 'other';
  needsAuth: 'yes' | 'no' | 'unsure';
  needsDb: 'yes' | 'no' | 'unsure';
  language: 'en' | 'ru' | 'other';
  constraints: string;
  stack: StackId;
}

export interface StackTemplate {
  id: StackId;
  label: string;
  summary: string;
  /** Hints embedded into the code-build goal so the model fills a coherent scaffold. */
  buildHints: string;
}

export const STACK_TEMPLATES: StackTemplate[] = [
  {
    id: 'node_express_react',
    label: 'Web app (Node + Express + React)',
    summary: 'Frontend + API server + optional database. Good default for interactive sites.',
    buildHints:
      'Scaffold a small full-stack app: Node.js + Express API, React frontend (Vite), package.json, .env.example, README with local run and manual deploy steps. Include a health endpoint GET /api/health. Do not execute code on any server; deliver source only.',
  },
  {
    id: 'node_express_api',
    label: 'API only (Node + Express)',
    summary: 'Backend API without a complex UI. Suitable for services and bots.',
    buildHints:
      'Scaffold a small Node.js + Express API: package.json, src/server entry, .env.example, README with local run and manual deploy steps. Include GET /health. Source only; never run on the host.',
  },
  {
    id: 'static_site',
    label: 'Static site (HTML/CSS/JS)',
    summary: 'Simple pages without a heavy backend.',
    buildHints:
      'Scaffold a static site: index.html, styles, minimal JS, README with how to open locally and how to host as static files. Source only.',
  },
  {
    id: 'auto',
    label: 'Choose for me',
    summary: 'Pick the simplest stack that fits the idea.',
    buildHints:
      'Choose the simplest appropriate stack for the idea (prefer Node+Express+React for interactive sites, static for pure pages, Express-only for APIs). Include package or equivalent, .env.example when server-side, README with local run and manual deploy. Source only.',
  },
];

export const NOVICE_KIND_OPTIONS: { id: NoviceAnswers['kind']; label: string; hint: string }[] = [
  { id: 'website', label: 'Website / web app', hint: 'People open it in a browser' },
  { id: 'app', label: 'Personal cabinet / app', hint: 'Users sign in and work with their data' },
  { id: 'bot', label: 'Bot or automation', hint: 'Reacts to messages or schedules' },
  { id: 'utility', label: 'Small utility', hint: 'Script or tool, not a full product' },
  { id: 'other', label: 'Something else', hint: 'Describe in the idea text' },
];

export function emptyNoviceAnswers(): NoviceAnswers {
  return {
    idea: '',
    kind: 'website',
    needsAuth: 'unsure',
    needsDb: 'unsure',
    language: 'en',
    constraints: '',
    stack: 'auto',
  };
}

/** Map wizard answers into a Project Passport shape (existing schema). */
/** Passport fields without status — caller sets proposed | confirmed. */
export type NovicePassportFields = {
  projectType: string;
  goal: string;
  users: string;
  inputsOutputs: string;
  constraints: string;
  securityData: string;
  successCriteria: string;
  budget: { calls: number; tokens: number; executorRuns: number };
  executor: 'model_patch' | 'manual';
  humanLevel: 'supervised';
};

export function passportFromNoviceAnswers(a: NoviceAnswers): NovicePassportFields {
  const stack = STACK_TEMPLATES.find((s) => s.id === a.stack) ?? STACK_TEMPLATES[3];
  const authLine =
    a.needsAuth === 'yes' ? 'Users must sign in.' : a.needsAuth === 'no' ? 'No user accounts required.' : 'Auth: decide during design.';
  const dbLine =
    a.needsDb === 'yes' ? 'Needs persistent storage (database).' : a.needsDb === 'no' ? 'No database required.' : 'Storage: decide during design.';
  const lang =
    a.language === 'ru' ? 'Russian UI preferred.' : a.language === 'en' ? 'English UI.' : 'UI language as stated in the idea.';

  return {
    projectType: `${a.kind} · stack hint: ${stack.label}`,
    goal: a.idea.trim(),
    users: a.kind === 'utility' || a.kind === 'bot' ? 'Operator / developer' : 'End users in a browser',
    inputsOutputs: `Kind: ${a.kind}. ${authLine} ${dbLine} ${lang}`,
    constraints: [a.constraints.trim(), 'No automatic GitHub or Render integration — deliver a source ZIP and clear manual deploy steps only.', stack.summary]
      .filter(Boolean)
      .join(' '),
    securityData: 'Do not embed secrets. Use .env.example. No production credentials in source.',
    successCriteria:
      'A downloadable source ZIP that runs locally with documented commands, includes README with manual deploy steps (e.g. GitHub + Render/Railway by hand), and matches the stated goal.',
    budget: { calls: 40, tokens: 200000, executorRuns: 8 },
    executor: 'model_patch',
    humanLevel: 'supervised',
  };
}

/** Goal string passed to existing /code/build so the model produces a more complete scaffold. */
export function buildGoalFromNoviceAnswers(a: NoviceAnswers): string {
  const stack = STACK_TEMPLATES.find((s) => s.id === a.stack) ?? STACK_TEMPLATES[3];
  const parts = [
    `Build a complete small project as source files only (ZIP). Goal: ${a.idea.trim()}`,
    `Product kind: ${a.kind}.`,
    `Auth: ${a.needsAuth}. Database: ${a.needsDb}. UI language: ${a.language}.`,
    a.constraints.trim() ? `Constraints: ${a.constraints.trim()}` : '',
    stack.buildHints,
    'Always include: README.md with (1) what this is, (2) how to run locally, (3) how to put the code on GitHub and connect a host such as Render or Railway manually.',
    'Always include .env.example when there is a server. Never put real secrets in the ZIP.',
    'Keep the project small and runnable. Prefer clarity over features.',
  ];
  return parts.filter(Boolean).join('\n');
}

/** Short deploy instruction shown in the UI and suitable for README paste. */
export function manualDeployInstructions(projectName: string): string {
  const name = projectName.trim() || 'your-project';
  return [
    `## How to use this ZIP (${name})`,
    '',
    '1. Unpack the archive on your computer.',
    '2. Read README.md inside — it lists local run commands.',
    '3. Copy `.env.example` to `.env` and fill in values if needed (never commit real secrets).',
    '4. Create a new empty repository on GitHub and upload the unpacked files.',
    '5. On Render (or Railway): create a new Web Service, connect that GitHub repo, set build/start commands from the README, add environment variables from `.env.example`.',
    '6. Deploy. Open the health URL if the README mentions one.',
    '',
    'BiForge does not push to GitHub or Render for you. You stay in control of the account and the merge.',
  ].join('\n');
}

/** Suggested project name from the idea (safe, short). */
export function suggestProjectName(idea: string): string {
  const base = idea
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s-]/gi, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join('-')
    .slice(0, 40);
  return base || 'my-app';
}

export const BUILDER_STATE_KEY = 'appBuilder';

export type AppBuilderState = {
  path: BuilderPath;
  answers?: NoviceAnswers;
  phase?: 'choose' | 'wizard' | 'workspace';
};
