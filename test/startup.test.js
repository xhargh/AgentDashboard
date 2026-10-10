import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Exercise the actual npm start command without binding a network socket.
async function startup(t, { file, exported } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-startup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { start: pkg.scripts.start } }));
  await mkdir(join(dir, 'src')); await mkdir(join(dir, 'public'));
  await copyFile(new URL('../src/server.js', import.meta.url), join(dir, 'src/server.js'));
  for (const name of ['index.html', 'app.js', 'session-state.js', 'style.css']) await writeFile(join(dir, 'public', name), '');
  await writeFile(join(dir, 'probe.mjs'), `import { Server } from 'node:http';
import { writeFileSync } from 'node:fs';
Server.prototype.listen = function (port, host) { writeFileSync('started', 'STARTUP_OK ' + host); return this; };`);
  if (file !== undefined) await writeFile(join(dir, '.env'), file);
  const env = { ...process.env, NODE_OPTIONS: `--import=${join(dir, 'probe.mjs')}` };
  delete env.SUPERVISOR_TOKEN;
  delete env.HOST;
  if (exported !== undefined) env.SUPERVISOR_TOKEN = exported;
  await promisify(execFile)('npm', ['start', '--silent'], { cwd: dir, env, timeout: 10000 });
  return { stdout: await readFile(join(dir, 'started'), 'utf8') };
}
test('npm start reads an unexported token from .env', async t => {
  const { stdout } = await startup(t, { file: 'SUPERVISOR_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789\n' });
  assert.match(stdout, /STARTUP_OK/);
});
test('npm start still works with an exported token and no .env', async t => {
  const { stdout } = await startup(t, { exported: 'abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.match(stdout, /STARTUP_OK/);
});
test('exported settings take precedence over .env', async t => {
  const { stdout } = await startup(t, { exported: 'abcdefghijklmnopqrstuvwxyz0123456789', file: 'SUPERVISOR_TOKEN=short\n' });
  assert.match(stdout, /STARTUP_OK/);
});

test('no token forces loopback even with a network HOST in .env', async t => {
  const { stdout } = await startup(t, { file: 'HOST=0.0.0.0\n' });
  assert.equal(stdout, 'STARTUP_OK 127.0.0.1');
});
test('a configured token enables network binding by default', async t => {
  const { stdout } = await startup(t, { exported: 'abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.equal(stdout, 'STARTUP_OK 0.0.0.0');
});
