import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Exercise the actual npm start command without binding a network socket.
async function startup(t, { file, exported } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-startup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { start: pkg.scripts.start } }));
  await mkdir(join(dir, 'src')); await mkdir(join(dir, 'public')); await mkdir(join(dir, 'public/icons'));
  await copyFile(new URL('../src/server.js', import.meta.url), join(dir, 'src/server.js'));
  for (const name of ['index.html', 'app.js', 'session-state.js', 'style.css']) await writeFile(join(dir, 'public', name), '');
  for (const name of ['icon.svg', 'favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png', 'apple-touch-icon.png',
    'site.webmanifest', 'android-chrome-192x192.png', 'android-chrome-512x512.png']) {
    await writeFile(join(dir, 'public/icons', name), '');
  }
  await writeFile(join(dir, 'probe.mjs'), `import { Server } from 'node:http';
import { writeFileSync } from 'node:fs';
Server.prototype.listen = function (port, host) { writeFileSync('started', 'STARTUP_OK ' + host); return this; };`);
  if (file !== undefined) await writeFile(join(dir, '.env'), file);
  const env = { ...process.env, NODE_OPTIONS: `--import=${join(dir, 'probe.mjs')}` };
  for (const key of ['SUPERVISOR_TOKEN', 'AGENTDASHBOARD_TOKEN', 'HOST', 'PORT', 'AGENTDASHBOARD_HOST', 'AGENTDASHBOARD_PORT']) delete env[key];
  if (exported !== undefined) env.AGENTDASHBOARD_TOKEN = exported;
  await promisify(execFile)('npm', ['start', '--silent'], { cwd: dir, env, timeout: 10000 });
  return { stdout: await readFile(join(dir, 'started'), 'utf8') };
}
test('npm start reads the AgentDashboard token from .env', async t => {
  const { stdout } = await startup(t, { file: 'AGENTDASHBOARD_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789\n' });
  assert.match(stdout, /STARTUP_OK/);
});
test('npm start still works with an exported token and no .env', async t => {
  const { stdout } = await startup(t, { exported: 'abcdefghijklmnopqrstuvwxyz0123456789' });
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

test('legacy companion environment names do not enable network mode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-startup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { start: pkg.scripts.start } }));
  await mkdir(join(dir, 'src')); await mkdir(join(dir, 'public')); await mkdir(join(dir, 'public/icons'));
  await copyFile(new URL('../src/server.js', import.meta.url), join(dir, 'src/server.js'));
  for (const name of ['index.html', 'app.js', 'session-state.js', 'style.css']) await writeFile(join(dir, 'public', name), '');
  for (const name of ['icon.svg', 'favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png', 'apple-touch-icon.png',
    'site.webmanifest', 'android-chrome-192x192.png', 'android-chrome-512x512.png']) {
    await writeFile(join(dir, 'public/icons', name), '');
  }
  await writeFile(join(dir, 'probe.mjs'), `import { Server } from 'node:http'; import { writeFileSync } from 'node:fs'; Server.prototype.listen = function (port, host) { writeFileSync('started', 'STARTUP_OK ' + host); return this; };`);
  await writeFile(join(dir, '.env'), 'SUPERVISOR_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789\nHOST=0.0.0.0\n');
  const env = { ...process.env, NODE_OPTIONS: `--import=${join(dir, 'probe.mjs')}` }; delete env.AGENTDASHBOARD_TOKEN;
  await promisify(execFile)('npm', ['start', '--silent'], { cwd: dir, env, timeout: 10000 });
  assert.equal(await readFile(join(dir, 'started'), 'utf8'), 'STARTUP_OK 127.0.0.1');
});

test('installer creates one loadable AgentDashboard plugin file and removes legacy files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-plugin-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plugins = join(dir, 'opencode/plugins');
  await mkdir(plugins, { recursive: true });
  await writeFile(join(plugins, 'supervisor.js'), 'export {};');
  await writeFile(join(plugins, 'session-lifecycle.js'), 'export {};');
  await writeFile(join(plugins, 'activity-events.js'), 'export {};');
  await writeFile(join(plugins, 'session-lifecycle.mjs'), 'export {};');
  await writeFile(join(plugins, 'activity-events.mjs'), 'export {};');
  await promisify(execFile)('npm', ['run', 'install-plugin'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, XDG_CONFIG_HOME: dir }, timeout: 10000,
  });
  const installed = pathToFileURL(join(plugins, 'AgentDashboardPlugin.js')).href;
  const plugin = await import(installed);
  assert.equal(typeof plugin.AgentDashboardPlugin, 'function');
  assert.deepEqual(await readdir(plugins), ['AgentDashboardPlugin.js']);
});
