import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

test('live OpenCode lifecycle smoke', { skip: !process.env.OPENCODE_LIVE_SMOKE && 'Run with npm run smoke' }, async () => {
  const smoke = spawn(process.execPath, ['scripts/smoke.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  smoke.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  smoke.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    smoke.once('error', reject);
    smoke.once('close', resolve);
  });
  assert.equal(exitCode, 0, `Live smoke failed:\n${output}`);
  for (const scenario of [
    'parent and child creation, parentID, idle status, and lifecycle timestamps',
    'OpenCode shutdown is reflected as disconnected',
    'restart recovers reporting with stable machine identity and a new instance identity',
  ]) {
    assert.ok(output.includes(`PASS: ${scenario}`), `Missing smoke result for: ${scenario}`);
  }
});
