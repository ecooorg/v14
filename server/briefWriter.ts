/**
 * brief_writer (TZ 11.2 profile / BX-22.a / P20): build a Task Package draft for the code executor.
 * Pure: no database, no network, no model. A model may fill the text fields later; this function
 * shapes a schema-valid package a human can approve and hand to any tool.
 */
import { taskPackageSchema, type TaskPackage, packageSecretFindings, CodeExecutorError } from './codeExecutor.ts';

export interface BriefWriterInput {
  taskId: string;
  projectId: string;
  /** Short goal of the coding task (becomes the core of SPEC.md). */
  goal: string;
  /** Optional extra constraints / boundaries. */
  constraints?: string;
  /** Acceptance criteria text (ACCEPTANCE.md). */
  acceptanceCriteria?: string;
  /** Paths the implementer may change (glob-style as in package schema). */
  allowedPaths?: string[];
  /** Optional acceptance test files under tests/acceptance/. */
  acceptanceTests?: Array<{ path: string; content: string }>;
  /** Optional context file snippets. */
  contextFiles?: Array<{ path: string; content: string }>;
  /** normal | high — high requires explicit human approval before handoff (P20). */
  sensitivity?: 'normal' | 'high';
  agentsMd?: string;
  executorPromptMd?: string;
  limits?: { maxFiles?: number; maxChangedLines?: number };
}

const DEFAULT_AGENTS = [
  '# Task agents',
  '',
  '- Follow SPEC.md and ACCEPTANCE.md exactly.',
  '- Do not modify tests/acceptance/** except files listed in the package.',
  '- Do not touch .github/**, AGENTS.md, or other protected paths.',
  '- Keep the change within allowed_paths and the stated limits.',
].join('\n');

const DEFAULT_EXECUTOR_PROMPT = [
  '# Executor prompt',
  '',
  'Implement the change described in SPEC.md.',
  'Satisfy every criterion in ACCEPTANCE.md.',
  'Stay inside allowed_paths. Return a PR or unified diff against the task branch.',
].join('\n');

/**
 * Build a Task Package from a structured brief. Throws CodeExecutorError if the result fails schema or secret checks.
 */
export function buildTaskPackageFromBrief(input: BriefWriterInput): TaskPackage {
  const goal = (input.goal || '').trim();
  if (goal.length < 1) throw new CodeExecutorError('PACKAGE_INVALID', 'goal is required');
  const constraints = (input.constraints || '').trim();
  const acceptance = (input.acceptanceCriteria || 'The change meets SPEC.md and does not break existing behaviour outside allowed_paths.').trim();
  const allowedPaths = (input.allowedPaths?.length ? input.allowedPaths : ['server/**', 'src/**']).map((s) => s.trim()).filter(Boolean);
  const specMd = [
    `# SPEC — task ${input.taskId}`,
    '',
    '## Goal',
    '',
    goal,
    '',
    ...(constraints ? ['## Constraints', '', constraints, ''] : []),
    '## Project',
    '',
    `- project_id: \`${input.projectId}\``,
    `- task_id: \`${input.taskId}\``,
  ].join('\n');

  const raw = {
    agentsMd: (input.agentsMd || DEFAULT_AGENTS).trim(),
    specMd,
    acceptanceMd: acceptance,
    executorPromptMd: (input.executorPromptMd || DEFAULT_EXECUTOR_PROMPT).trim(),
    allowedPaths,
    acceptanceTests: input.acceptanceTests ?? [],
    contextFiles: input.contextFiles ?? [],
    limits: {
      maxFiles: input.limits?.maxFiles ?? 10,
      maxChangedLines: input.limits?.maxChangedLines ?? 400,
    },
    sensitivity: input.sensitivity ?? 'normal',
  };
  const parsed = taskPackageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CodeExecutorError('PACKAGE_INVALID', 'brief_writer produced an invalid package', {
      issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
  }
  const secrets = packageSecretFindings(parsed.data);
  if (secrets.length) {
    throw new CodeExecutorError('PACKAGE_SECRET', 'The package contains secret-looking text', { findings: secrets.slice(0, 20) });
  }
  return parsed.data;
}

/** Paths under tests/acceptance/** declared by the package (for Test Integrity baseline). */
export function packageAcceptancePaths(pkg: TaskPackage): string[] {
  return pkg.acceptanceTests.map((f) => f.path);
}
