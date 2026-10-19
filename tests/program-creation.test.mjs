import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPackageFromBrief } from '../server/briefWriter.ts';
import { validateGeneratedSource, validateModelPatch } from '../server/codeExecutor.ts';
import { generatedSourceArtifactId } from '../server/codeTaskService.ts';

test('program creation package confines output to the generated task directory', () => {
  const taskId = 'task_tetris_123';
  const allowedPaths = [`generated-projects/${taskId}/**`];
  const pkg = buildTaskPackageFromBrief({
    taskId,
    projectId: 'project_123',
    goal: 'Create a playable browser Tetris game with keyboard controls, score and restart.',
    allowedPaths,
    limits: { maxFiles: 10, maxChangedLines: 400 },
    acceptanceCriteria: 'Create a directly usable browser game and do not claim runtime tests.',
  });
  assert.deepEqual(pkg.allowedPaths, allowedPaths);
  assert.equal(validateModelPatch({ files: [{ path: `generated-projects/${taskId}/index.html`, action: 'create', content: '<!doctype html>\n' }] }, { allowedPaths, limits: pkg.limits }).ok, true);
  assert.equal(validateModelPatch({ files: [{ path: 'generated-projects/another-task/index.html', action: 'create', content: '<!doctype html>\n' }] }, { allowedPaths, limits: pkg.limits }).ok, false);
  assert.deepEqual(validateGeneratedSource({ files: [{ path: `generated-projects/${taskId}/index.html`, action: 'create', content: '<html><body><script>const x = 1;</script></body></html>' }] }, 'Create Tetris'), []);
  assert.ok(validateGeneratedSource({ files: [{ path: `generated-projects/${taskId}/index.html`, action: 'create', content: '<html><body><script>const = ;</script></body></html>' }] }, 'Create Tetris').some((v) => v.code === 'javascript_syntax_invalid'));
  assert.ok(validateGeneratedSource({ files: [{ path: `generated-projects/${taskId}/app.js`, action: 'create', content: 'console.log("x");' }] }, 'Create Tetris').some((v) => v.code === 'browser_entrypoint_missing'));
});

test('generated source artifact id is deterministic and safe for repository storage', () => {
  const a = generatedSourceArtifactId('code_task_123');
  assert.equal(a, generatedSourceArtifactId('code_task_123'));
  assert.match(a, /^source_[a-f0-9]{40}$/);
  assert.notEqual(a, generatedSourceArtifactId('code_task_456'));
});

test('program creation is wired end-to-end and remains gated', async () => {
  const { readFile } = await import('node:fs/promises');
  const [server, service, ui] = await Promise.all([
    readFile(new URL('../server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../server/codeTaskService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/ProjectMode.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(server, /\/api\/projects\/:projectId\/code\/build/);
  assert.match(server, /passport\?\.executor !== 'model_patch' \|\| process\.env\.CODE_EXECUTOR !== 'model_patch'/);
  assert.match(server, /\/download/);
  assert.match(service, /driveModelPatch\(\{ projectId, taskId, codeTaskId: started\.codeTask\.id \}, deps\)/);
  assert.match(service, /generated_secret:/);
  assert.match(ui, /Create a small program/);
  assert.match(ui, /Download generated program/);
});
