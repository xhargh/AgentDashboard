import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { createServer } from '../src/server.js';
import { SupervisorPlugin } from '../src/plugin.js';
const token = 'test-token-with-at-least-24-characters';
async function start(t, options = {}) {
  const server = createServer({ token, ...options });
  const url = 'http://localhost:4317';
  const dispatch = async (input, init = {}) => {
    const target = new URL(input, url);
    const req = Readable.from(init.body ? [Buffer.from(init.body)] : []);
    req.socket = { remoteAddress: init.remoteAddress || '127.0.0.1' };
    req.url = target.pathname; req.method = init.method || 'GET';
    req.headers = { host: 'localhost:4317', ...init.headers };
    return new Promise(resolve => {
      let status = 200; const headers = {};
      const res = { setHeader: (key, value) => { headers[key.toLowerCase()] = value; },
        writeHead: (code, values) => { status = code; Object.assign(headers, values); },
        end: body => resolve(new Response(body, { status, headers })) };
      server.emit('request', req, res);
    });
  };
  return { url, dispatch, request: (path, init = {}) => dispatch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } }) };
}
const report = (id = 'one', host = 'alpha') => ({ instanceId: id, host, directory: '/work/project', sessions: [{ id: 'parent', title: 'Build', directory: '/work/project', status: 'busy' }], git: {} });
test('requires a strong shared token', () => assert.throws(() => createServer({ token: 'short' })));
test('authenticated reporting, multiple hosts, stale and expired instances', async t => {
  let time = 1000; const { request } = await start(t, { now: () => time });
  for (const [id, host] of [['one', 'alpha'], ['two', 'beta']]) assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(report(id, host)) })).status, 200);
  let state = await (await request('/api/state')).json(); assert.equal(state.instances.length, 2); assert.ok(state.instances.every(i => i.online));
  time += 21000; state = await (await request('/api/state')).json(); assert.ok(state.instances.every(i => !i.online));
  time += 86400000; assert.equal((await (await request('/api/state')).json()).instances.length, 0);
});
test('accepts legacy reports without a machine identity', async t => {
  const { request } = await start(t);
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(report()) })).status, 200);
  const state = await (await request('/api/state')).json();
  assert.equal(state.instances[0].machineId, undefined);
});
test('machine identity persists across plugin generations and distinguishes machines and concurrent processes', async t => {
  const originalFetch = globalThis.fetch;
  const old = Object.fromEntries(['OPENCODE_SUPERVISOR_URL', 'OPENCODE_SUPERVISOR_TOKEN', 'OPENCODE_SUPERVISOR_HOST', 'XDG_CONFIG_HOME'].map(k => [k, process.env[k]]));
  const root = await mkdtemp(join(tmpdir(), 'supervisor-identity-'));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  });
  let time = Date.now();
  const { request, dispatch } = await start(t, { now: () => time });
  const plugins = [];
  t.after(async () => {
    for (const plugin of plugins) await plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } });
  });
  globalThis.fetch = dispatch;
  process.env.OPENCODE_SUPERVISOR_URL = 'http://localhost:4317';
  process.env.OPENCODE_SUPERVISOR_TOKEN = token;
  process.env.OPENCODE_SUPERVISOR_HOST = 'same-hostname';
  const client = { session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) } };
  const runAt = async config => {
    process.env.XDG_CONFIG_HOME = config;
    const plugin = await SupervisorPlugin({ directory: '/tmp', client });
    plugins.push(plugin);
    return plugin;
  };
  const [first, concurrent] = await Promise.all([runAt(join(root, 'machine-a')), runAt(join(root, 'machine-a'))]);
  await new Promise(resolve => setTimeout(resolve, 30));
  let state = await (await request('/api/state')).json();
  assert.equal(state.instances.length, 2);
  assert.equal(new Set(state.instances.map(i => i.machineId)).size, 1);
  assert.equal(new Set(state.instances.map(i => i.instanceId)).size, 2);
  const oldGeneration = state.instances[0].instanceId;
  await first.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } });
  await concurrent.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } });
  time += 21000;
  await runAt(join(root, 'machine-a'));
  await runAt(join(root, 'machine-b'));
  await new Promise(resolve => setTimeout(resolve, 30));
  state = await (await request('/api/state')).json();
  const current = state.instances.filter(i => i.online);
  assert.equal(current.length, 2);
  assert.equal(new Set(current.map(i => i.machineId)).size, 2);
  const restarted = current.find(i => i.machineId === state.instances.find(old => old.instanceId === oldGeneration).machineId);
  assert.ok(restarted);
  assert.notEqual(restarted.instanceId, oldGeneration);
  assert.equal(new Set(current.map(i => i.host)).size, 1);
});
test('rejects unauthenticated, malformed, oversized and cross-origin requests', async t => {
  const { url, request, dispatch } = await start(t);
  assert.equal((await dispatch(url + '/api/state')).status, 401);
  assert.equal((await request('/api/report', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await request('/api/report', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await request('/api/report', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
  assert.equal((await request('/api/state', { headers: { origin: 'http://evil.example' } })).status, 403);
  const page = await dispatch(url); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await dispatch(url + '/src/plugin.js')).status, 404);
});
for (const local of [false, true]) test(`plugin reports Git and session events in ${local ? 'local' : 'network'} mode`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => promisify(execFile)('git', ['-C', dir, ...args]);
  await git('init'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(join(dir, 'file.txt'), 'initial'); await git('add', '.'); await git('commit', '-m', 'Initial commit'); await writeFile(join(dir, 'file.txt'), 'changed');
  await git('worktree', 'add', '-b', 'feature', join(dir, 'linked'));
  const { url, request, dispatch } = await start(t, local ? { token: undefined } : {});
  const originalFetch = globalThis.fetch; globalThis.fetch = dispatch; t.after(() => { globalThis.fetch = originalFetch; });
  process.env.OPENCODE_SUPERVISOR_URL = url; process.env.OPENCODE_SUPERVISOR_TOKEN = local ? '' : token;
  t.after(() => { delete process.env.OPENCODE_SUPERVISOR_URL; delete process.env.OPENCODE_SUPERVISOR_TOKEN; });
  const plugin = await SupervisorPlugin({ directory: dir, worktree: dir, client: { session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) } } });
  t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: dir } } }));
  async function emit(type, properties) { await plugin.event({ event: { type, properties } }); }
  async function waitFor(predicate) { for (let n = 0; n < 100; n++) { const state = await (await request('/api/state')).json(); if (predicate(state.instances[0])) return state.instances[0]; await new Promise(r => setTimeout(r, 60)); } throw new Error('Report not received'); }
  const first = await waitFor(i => i?.git.status); assert.match(first.git.status, /file.txt/); assert.match(first.git.log, /Initial commit/); assert.ok(first.git.worktrees.includes('refs/heads/feature'));
  await emit('session.created', { info: { id: 'root', title: 'Parent', directory: dir } });
  await emit('session.created', { info: { id: 'child', parentID: 'root', title: 'Investigate', directory: dir } });
  await emit('session.status', { sessionID: 'child', status: { type: 'busy' } });
  await emit('message.part.updated', { part: { sessionID: 'child', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'secret-value' } } } });
  const running = await waitFor(i => i?.sessions.some(s => s.id === 'child' && s.activity === 'bash: running'));
  assert.equal(running.sessions.find(s => s.id === 'child').parentID, 'root'); assert.ok(!JSON.stringify(running).includes('secret-value'));
  await emit('permission.asked', { sessionID: 'child' });
  await waitFor(i => i?.sessions.find(s => s.id === 'child')?.status === 'waiting');
  await emit('session.idle', { sessionID: 'child' });
  await waitFor(i => i?.sessions.find(s => s.id === 'child')?.status === 'idle');
  globalThis.fetch = async () => { throw new Error('Network offline'); };
  await emit('session.status', { sessionID: 'child', status: { type: 'busy' } });
  await new Promise(r => setTimeout(r, 350));
  globalThis.fetch = dispatch;
  await emit('session.status', { sessionID: 'child', status: { type: 'retry' } });
  await waitFor(i => i?.sessions.find(s => s.id === 'child')?.status === 'retry');
  await emit('session.deleted', { info: { id: 'child' } });
  await waitFor(i => i && !i.sessions.some(s => s.id === 'child'));
});
test('plugin refuses remote telemetry without a token', async t => {
  const old = process.env.OPENCODE_SUPERVISOR_URL;
  t.after(() => { if (old === undefined) delete process.env.OPENCODE_SUPERVISOR_URL; else process.env.OPENCODE_SUPERVISOR_URL = old; });
  process.env.OPENCODE_SUPERVISOR_URL = 'http://192.168.1.10:4317';
  assert.deepEqual(await SupervisorPlugin({ directory: '/tmp' }), {});
});
test('plugin classifies HTTP, network, and timeout report failures without leaking details', async t => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const oldUrl = process.env.OPENCODE_SUPERVISOR_URL;
  const oldToken = process.env.OPENCODE_SUPERVISOR_TOKEN;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (oldUrl === undefined) delete process.env.OPENCODE_SUPERVISOR_URL;
    else process.env.OPENCODE_SUPERVISOR_URL = oldUrl;
    if (oldToken === undefined) delete process.env.OPENCODE_SUPERVISOR_TOKEN;
    else process.env.OPENCODE_SUPERVISOR_TOKEN = oldToken;
  });
  process.env.OPENCODE_SUPERVISOR_URL = 'http://127.0.0.1:4317';
  process.env.OPENCODE_SUPERVISOR_TOKEN = 'secret-token-that-must-not-be-logged';

  const cases = [
    [401, 'authentication (HTTP 401)'], [403, 'authentication (HTTP 403)'],
    [400, 'rejected report (HTTP 400)'], [413, 'rejected report (HTTP 413)'],
    [500, 'server failure (HTTP 500)'], [503, 'server failure (HTTP 503)'],
    ['network', 'network failure'], ['timeout', 'timeout'],
  ];
  for (const [failure, expected] of cases) {
    const warnings = [];
    console.warn = message => warnings.push(message);
    globalThis.fetch = async () => {
      if (failure === 'network') throw new TypeError('private network details');
      if (failure === 'timeout') {
        const error = new Error('private timeout details'); error.name = 'TimeoutError'; throw error;
      }
      return new Response('private response body', { status: failure });
    };
    const plugin = await SupervisorPlugin({ directory: '/tmp' });
    for (let n = 0; n < 100 && warnings.length === 0; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(warnings.length, 1, `${failure} should produce one diagnostic`);
    assert.match(warnings[0], new RegExp(expected.replace(/[()]/g, '\\$&')));
    assert.doesNotMatch(warnings[0], /secret-token|private/);
    await plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } });
  }
});
test('local mode allows token-free reports and rejects remote peers, rebinding and foreign origins', async t => {
  const { dispatch } = await start(t, { token: undefined });
  assert.equal((await dispatch('/api/report', { method: 'POST', body: JSON.stringify(report()) })).status, 200);
  const state = await (await dispatch('/api/state')).json();
  assert.equal(state.mode, 'local'); assert.equal(state.instances.length, 1);
  assert.equal((await dispatch('/api/state', { remoteAddress: '192.168.1.2' })).status, 403);
  assert.equal((await dispatch('/api/state', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await dispatch('/api/report', { method: 'POST', headers: { origin: 'http://evil.example' }, body: JSON.stringify(report()) })).status, 403);
  assert.equal((await dispatch('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await dispatch('/api/state', { headers: { origin: 'http://localhost:4317' } })).status, 200);
});
