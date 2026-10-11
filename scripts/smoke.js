import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from '../src/server.js';
import { installPlugin } from './install-plugin.js';

const dir = await mkdtemp(join(tmpdir(), 'supervisor-smoke-'));
const token = randomBytes(32).toString('hex');
const companion = createServer({ token });
const env = {
  ...process.env,
  HOME: join(dir, 'home'),
  XDG_CONFIG_HOME: join(dir, 'config'),
  XDG_DATA_HOME: join(dir, 'data'),
  XDG_CACHE_HOME: join(dir, 'cache'),
  XDG_STATE_HOME: join(dir, 'state'),
  OPENCODE_SUPERVISOR_TOKEN: token,
  OPENCODE_SERVER_PASSWORD: '',
  OPENCODE_CONFIG: '',
  OPENCODE_CONFIG_CONTENT: '{}',
};
let child;
let endpoint;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}
async function eventually(scenario, fn) {
  let last;
  for (let n = 0; n < 120; n++) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Scenario "${scenario}" timed out${last ? `: ${last.message}` : ''}`);
}
async function state() {
  const response = await fetch(`${url}/api/state`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Dashboard returned HTTP ${response.status}`);
  return response.json();
}
function instanceFor(instances, instanceId) {
  return instances.find(instance => instance.instanceId === instanceId);
}
async function startOpenCode() {
  let output = '';
  child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: dir, env: { ...env, OPENCODE_SUPERVISOR_URL: url }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', error => { output += error.message; });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  endpoint = await eventually('OpenCode server startup', () => {
    if (child.exitCode !== null) throw new Error(output);
    return output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  });
  return output;
}
async function stopOpenCode() {
  const process = child;
  if (!process || process.exitCode !== null) return;
  const exited = new Promise(resolve => process.once('exit', resolve));
  process.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (process.exitCode === null) {
    process.kill('SIGKILL');
    await exited;
  }
  child = undefined;
}
async function session(body) {
  let response;
  try {
    response = await fetch(`${endpoint}/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) { throw new Error(`OpenCode session creation failed: ${error.message}`); }
  if (!response.ok) throw new Error(`OpenCode session creation returned HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

let url;
try {
  await mkdir(env.HOME, { recursive: true });
  await installPlugin(dir);
  await listen(companion);
  url = `http://127.0.0.1:${companion.address().port}`;

  await startOpenCode();
  const parent = await session({ title: 'Supervisor smoke parent' });
  const childSession = await session({ title: 'Supervisor smoke child', parentID: parent.id });
  const first = await eventually('parent/child lifecycle telemetry', async () => {
    const current = await state();
    const instance = current.instances.find(candidate => candidate.sessions.some(s => s.id === childSession.id));
    const parentTelemetry = instance?.sessions.find(s => s.id === parent.id);
    const childTelemetry = instance?.sessions.find(s => s.id === childSession.id);
    if (!instance || !parentTelemetry || !childTelemetry) return undefined;
    if (childTelemetry.parentID !== parent.id) throw new Error('Child telemetry has an incorrect parentID');
    if (parentTelemetry.status !== 'idle' || childTelemetry.status !== 'idle') {
      throw new Error(`New sessions should be idle; got parent=${parentTelemetry.status}, child=${childTelemetry.status}`);
    }
    if (!parentTelemetry.stateChangedAt || !childTelemetry.stateChangedAt) {
      throw new Error('Session telemetry is missing stateChangedAt lifecycle timestamps');
    }
    return instance;
  });
  const originalMachineId = first.machineId;
  const originalInstanceId = first.instanceId;
  if (!originalMachineId || !originalInstanceId) throw new Error('Initial report is missing process or machine identity');
  console.log('PASS: parent and child creation, parentID, idle status, and lifecycle timestamps');

  await stopOpenCode();
  await eventually('shutdown/disconnection', async () => {
    const current = await state();
    const instance = instanceFor(current.instances, originalInstanceId);
    return instance && !instance.online;
  });
  console.log('PASS: OpenCode shutdown is reflected as disconnected');

  await startOpenCode();
  await session({ title: 'Supervisor smoke restart probe' });
  const recovered = await eventually('process restart identity and recovery', async () => {
    const current = await state();
    const online = current.instances.find(instance => instance.online && instance.machineId === originalMachineId);
    return online && online.instanceId !== originalInstanceId ? online : undefined;
  });
  if (recovered.machineId !== originalMachineId || recovered.instanceId === originalInstanceId) {
    throw new Error('Restart did not preserve machine identity and issue a fresh instance identity');
  }
  console.log('PASS: restart recovers reporting with stable machine identity and a new instance identity');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stopOpenCode().catch(error => { console.error(`Cleanup: ${error.message}`); process.exitCode = 1; });
  companion.closeAllConnections();
  await new Promise(resolve => companion.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
