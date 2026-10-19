import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

 test('Project Mode refuses to start without an application password', async () => {
  const child = spawn('tsx', ['server.ts'], { env: { ...process.env, NODE_ENV: 'production', ENABLE_PROJECT_MODE: 'true', ENABLE_APP_AUTH: 'true', APP_PASSWORD: '', SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not refuse insecure Project Mode startup')); }, 10000);
    child.once('error', reject);
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 1);
  assert.match(output, /requires APP_PASSWORD and ENABLE_APP_AUTH=true/);
});
