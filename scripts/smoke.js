import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from '../src/server.js';
const dir = await mkdtemp(join(tmpdir(), 'supervisor-smoke-'));
const token = randomBytes(32).toString('hex');
const companion = createServer({ token });
let child;
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
async function eventually(fn) { let last; for (let n = 0; n < 120; n++) { try { const result = await fn(); if (result) return result; } catch (e) { last = e; } await new Promise(r => setTimeout(r, 500)); } throw new Error(`Timed out: ${last?.message || 'expected data not received'}`); }
try {
  await listen(companion);
  const url = `http://127.0.0.1:${companion.address().port}`;
  await mkdir(join(dir, '.opencode', 'plugins'), { recursive: true });
  await copyFile(new URL('../src/plugin.js', import.meta.url), join(dir, '.opencode/plugins/supervisor.js'));
  let output = '';
  child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: dir, env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), XDG_CACHE_HOME: join(dir, 'cache'),
      OPENCODE_SUPERVISOR_URL: url, OPENCODE_SUPERVISOR_TOKEN: token, OPENCODE_SERVER_PASSWORD: '', OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '{}' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', error => { output += error.message; });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const endpoint = await eventually(() => { if (child.exitCode !== null) throw new Error(output); return output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; });
  async function create(body) { const response = await fetch(endpoint + '/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); if (!response.ok) throw new Error(await response.text()); return response.json(); }
  const parent = await create({ title: 'Supervisor smoke parent' });
  const sub = await create({ title: 'Supervisor smoke child', parentID: parent.id });
  await eventually(async () => { const state = await (await fetch(url + '/api/state', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) })).json(); return state.instances.some(i => i.sessions.some(s => s.id === sub.id && s.parentID === parent.id)); });
  console.log('PASS: real OpenCode plugin → companion → authenticated dashboard API, including parent/subagent relationship');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 2000))]); if (child.exitCode === null) child.kill('SIGKILL'); }
  companion.closeAllConnections(); await new Promise(r => companion.close(r));
  await rm(dir, { recursive: true, force: true });
}
