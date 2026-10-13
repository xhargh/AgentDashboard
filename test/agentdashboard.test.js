import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { createServer } from '../src/server.js';
import { retryDelay, AgentDashboardPlugin } from '../src/plugin.js';
import { normalizeObservabilityEvent } from '../src/activity-events.js';
const token = 'test-token-with-at-least-24-characters';
async function start(t, options = {}) {
  const server = createServer({ token, ...options });
  const url = 'http://localhost:4317';
  const dispatch = async (input, init = {}) => {
    const target = new URL(input, url);
    const req = Readable.from(init.body ? [Buffer.from(init.body)] : []);
    req.socket = { remoteAddress: init.remoteAddress || '127.0.0.1' };
    req.url = target.pathname + target.search; req.method = init.method || 'GET';
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
test('retry delay grows exponentially, is jittered, and remains bounded', () => {
  assert.equal(retryDelay(1, () => 0), 500);
  assert.equal(retryDelay(2, () => 1), 2000);
  assert.equal(retryDelay(100, () => 1), 60000);
});
test('requires a strong shared token', () => assert.throws(() => createServer({ token: 'short' })));
test('authenticated reporting retains offline instances for companion lifetime', async t => {
  let time = 1000; const { request } = await start(t, { now: () => time });
  for (const [id, host] of [['one', 'alpha'], ['two', 'beta']]) assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(report(id, host)) })).status, 200);
  let state = await (await request('/api/state')).json(); assert.equal(state.instances.length, 2); assert.ok(state.instances.every(i => i.online));
  time += 21000; state = await (await request('/api/state')).json(); assert.ok(state.instances.every(i => !i.online));
  time += 86400000; state = await (await request('/api/state')).json();
  assert.equal(state.instances.length, 2);
  assert.ok(state.instances.every(i => !i.online));
});
test('accepts legacy reports without a machine identity', async t => {
  const { request } = await start(t);
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(report()) })).status, 200);
  const state = await (await request('/api/state')).json();
  assert.equal(state.instances[0].machineId, undefined);
});
test('bounds aggregate fleet retention, preserves active instances, and caps report strings', async t => {
  const { request } = await start(t);
  const send = value => request('/api/report', { method: 'POST', body: JSON.stringify(value) });
  for (let n = 0; n < 20; n++) {
    const value = report(`fleet-${n}`);
    value.sessions = Array.from({ length: 1000 }, (_, index) => ({ id: `${n}-${index}`, status: n === 19 ? 'busy' : 'idle', title: 'ok' }));
    assert.equal((await send(value)).status, 200);
  }
  const active = report('new-active'); active.sessions[0].status = 'waiting';
  assert.equal((await send(active)).status, 200);
  const state = await (await request('/api/state')).json();
  assert.ok(state.instances.reduce((count, instance) => count + instance.sessions.length, 0) <= 20000);
  assert.ok(state.instances.some(instance => instance.instanceId === 'fleet-19'));
  assert.ok(state.instances.some(instance => instance.instanceId === 'new-active'));
  const oversized = report('too-long'); oversized.sessions[0].title = 'x'.repeat(4097);
  assert.equal((await send(oversized)).status, 400);
});
test('accepts reports with privacy-filtered optional metadata', async t => {
  const { request } = await start(t);
  const minimal = { instanceId: 'private', machineId: 'machine', host: 'alpha', pid: 1,
    sessions: [{ id: 'session', status: 'busy' }] };
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(minimal) })).status, 200);
  const state = await (await request('/api/state')).json();
  assert.equal(state.instances[0].sessions[0].status, 'busy');
  assert.equal(state.instances[0].sessions[0].title, undefined);
  assert.equal(state.instances[0].git, undefined);
});
test('reports assistant model metadata per session and filters it at the outbound boundary', async t => {
  const originalFetch = globalThis.fetch;
  const keys = ['AGENTDASHBOARD_URL', 'AGENTDASHBOARD_TOKEN', 'AGENTDASHBOARD_TELEMETRY', 'XDG_CONFIG_HOME'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = await mkdtemp(join(tmpdir(), 'supervisor-model-'));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  });
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317';
  process.env.AGENTDASHBOARD_TOKEN = token;
  process.env.XDG_CONFIG_HOME = root;
  const reports = [];
  globalThis.fetch = async (_url, init) => { reports.push(JSON.parse(init.body)); return new Response('', { status: 200 }); };
  const client = { session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) }, config: { providers: async () => ({ data: { providers: [
    { id: 'provider-a', name: 'Provider A', models: { 'model-x': { name: 'Friendly Model', limit: { context: 128000 } } } },
    { id: 'provider-b', name: 'Provider B', models: { 'model-y': { name: 'Friendly B', limit: { context: 64000 } } } },
  ] } }) } };
  const plugin = await AgentDashboardPlugin({ directory: '/tmp', client });
  t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } }));
  const sourceMessageAt = Date.now();
  await plugin.event({ event: { type: 'message.updated', properties: { info: {
    id: 'message-1', sessionID: 'parent', role: 'assistant', time: { created: sourceMessageAt, completed: sourceMessageAt + 1 }, parentID: 'root',
    providerID: 'provider-a', modelID: 'model-x', mode: 'build', path: { cwd: '/tmp', root: '/tmp' }, cost: 0,
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 1, write: 0 } }, finish: 'stop',
  } } } });
  await plugin.event({ event: { type: 'message.updated', properties: { info: {
    id: 'message-2', sessionID: 'child', role: 'assistant', providerID: 'provider-b', modelID: 'model-z',
  } } } });
  for (let n = 0; n < 100 && !reports.some(r => r.sessions.some(s => s.id === 'child')); n++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 20));
  const sessions = reports.at(-1).sessions;
  assert.deepEqual(sessions.find(s => s.id === 'parent').model, {
    providerID: 'provider-a', modelID: 'model-x', providerName: 'Provider A', name: 'Friendly Model', contextLimit: 128000,
  });
  assert.deepEqual(sessions.find(s => s.id === 'child').model, { providerID: 'provider-b', modelID: 'model-z' });
  assert.deepEqual(reports.at(-1).events.filter(event => event.kind === 'modelSnapshot').map(event => [event.sessionId, event.messageId]),
    [['parent', 'message-1'], ['child', 'message-2']]);
  await plugin.event({ event: { type: 'message.updated', properties: { info: {
    id: 'message-3', sessionID: 'parent', role: 'assistant', providerID: 'provider-b', modelID: 'model-y',
  } } } });
  await new Promise(resolve => setTimeout(resolve, 280));
  const switched = reports.at(-1).sessions;
  assert.deepEqual(switched.find(s => s.id === 'parent').model, {
    providerID: 'provider-b', modelID: 'model-y', providerName: 'Provider B', name: 'Friendly B', contextLimit: 64000,
  });
  assert.deepEqual(switched.find(s => s.id === 'child').model, { providerID: 'provider-b', modelID: 'model-z' },
    'one session model switch does not overwrite another session metadata');
  assert.deepEqual(reports.at(-1).events.filter(event => event.kind === 'modelSnapshot' && event.sessionId === 'parent').map(event => event.messageId),
    ['message-1', 'message-3']);

  process.env.AGENTDASHBOARD_TELEMETRY = '{"modelMetrics":false}';
  const filtered = await AgentDashboardPlugin({ directory: '/tmp', client });
  t.after(() => filtered.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } }));
  await filtered.event({ event: { type: 'message.updated', properties: { info: {
    sessionID: 'private', role: 'assistant', providerID: 'private-provider', modelID: 'private-model', variant: 'private-variant',
  } } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!JSON.stringify(reports.at(-1)).includes('private-provider'));
  assert.ok(!reports.at(-1).events?.some(event => event.kind === 'modelSnapshot'));

  process.env.AGENTDASHBOARD_TELEMETRY = '{"profile":"status-only"}';
  const statusOnly = await AgentDashboardPlugin({ directory: '/tmp', client });
  t.after(() => statusOnly.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } }));
  await statusOnly.event({ event: { type: 'message.updated', properties: { info: {
    sessionID: 'minimal', role: 'assistant', providerID: 'private-provider', modelID: 'private-model',
  } } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(!JSON.stringify(reports.at(-1)).includes('private-model'));
});
test('fetches transcript messages only after separate plugin opt-in and strips tool payloads', async t => {
  const originalFetch = globalThis.fetch;
  const keys = ['AGENTDASHBOARD_URL', 'AGENTDASHBOARD_TOKEN', 'AGENTDASHBOARD_TELEMETRY', 'AGENTDASHBOARD_TRANSCRIPT_TOKEN', 'XDG_CONFIG_HOME'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const config = await mkdtemp(join(tmpdir(), 'agentdashboard-transcript-'));
  const reports = [], results = [];
  let messageCalls = 0;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(config, { recursive: true, force: true });
  });
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317';
  delete process.env.AGENTDASHBOARD_TOKEN;
  process.env.AGENTDASHBOARD_TELEMETRY = '{"git":false,"sessionTranscript":true}';
  process.env.AGENTDASHBOARD_TRANSCRIPT_TOKEN = 'separate-transcript-access-key-32-chars';
  process.env.XDG_CONFIG_HOME = config;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/transcript/result')) { results.push(JSON.parse(init.body)); return new Response('{"ok":true}', { status: 200 }); }
    const payload = JSON.parse(init.body); reports.push(payload);
    return new Response(JSON.stringify({ ok: true, transcriptRequests: payload.transcriptEnabled
      ? [{ requestId: 'request-1', instanceId: payload.instanceId, sessionId: 'session', expiresAt: Date.now() + 10000 }] : [] }), { status: 200 });
  };
  const client = { session: {
    list: async () => ({ data: [{ id: 'session', title: 'Transcript test', directory: '/tmp' }] }),
    status: async () => ({ data: {} }),
    messages: async () => {
      messageCalls++;
      return { data: [
        { id: 'user-message', role: 'user', time: { created: Date.now() }, parts: [{ type: 'text', text: '<script>prompt</script>' }] },
        { id: 'assistant-message', role: 'assistant', parts: [
          { type: 'text', text: 'Safe answer' },
          { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'PRIVATE_ARGUMENT' }, output: 'PRIVATE_RESULT' } },
        ] },
      ] };
    },
  } };
  const plugin = await AgentDashboardPlugin({ directory: '/tmp', client });
  t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } }));
  for (let n = 0; n < 100 && !results.length; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reports[0].transcriptEnabled, true);
  assert.equal(messageCalls, 1);
  assert.equal(results[0].messages.length, 2);
  assert.equal(results[0].messages[0].parts[0].text, '<script>prompt</script>');
  assert.deepEqual(results[0].messages[1].parts[1], { type: 'tool', name: 'bash', status: 'completed' });
  assert.doesNotMatch(JSON.stringify(results[0]), /PRIVATE_ARGUMENT|PRIVATE_RESULT/);

  process.env.AGENTDASHBOARD_TELEMETRY = '{"git":false}';
  results.length = 0;
  const disabled = await AgentDashboardPlugin({ directory: '/tmp', client });
  t.after(() => disabled.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(messageCalls, 1, 'transcript SDK calls are disabled unless the separate privacy category is enabled');
  assert.equal(reports.at(-1).transcriptEnabled, false);
  assert.equal(results.length, 0);
});
test('tool detail inspection returns only a safe title and allowlisted structured metadata', async t => {
  const originalFetch = globalThis.fetch;
  const keys = ['AGENTDASHBOARD_URL', 'AGENTDASHBOARD_TOKEN', 'AGENTDASHBOARD_TELEMETRY', 'AGENTDASHBOARD_TRANSCRIPT_TOKEN', 'XDG_CONFIG_HOME'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const config = await mkdtemp(join(tmpdir(), 'agentdashboard-tool-details-'));
  const reports = [], results = [];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(config, { recursive: true, force: true });
  });
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317';
  delete process.env.AGENTDASHBOARD_TOKEN;
  process.env.AGENTDASHBOARD_TELEMETRY = '{"git":false,"toolDetails":true}';
  process.env.AGENTDASHBOARD_TRANSCRIPT_TOKEN = 'separate-transcript-access-key-32-chars';
  process.env.XDG_CONFIG_HOME = config;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/transcript/result')) { results.push(JSON.parse(init.body)); return new Response('{"ok":true}', { status: 200 }); }
    const payload = JSON.parse(init.body); reports.push(payload);
    return new Response(JSON.stringify({ ok: true, transcriptRequests: payload.toolDetailsEnabled
      ? [{ requestId: 'detail-request', sessionId: 'session', mode: 'toolDetails', messageId: 'message', toolCallId: 'call', expiresAt: Date.now() + 10000 }] : [] }), { status: 200 });
  };
  const client = { session: {
    list: async () => ({ data: [{ id: 'session', directory: '/tmp' }] }),
    status: async () => ({ data: {} }),
    messages: async () => ({ data: [{ id: 'message', parts: [{ type: 'tool', callID: 'call', tool: 'read', state: {
      status: 'completed', title: 'Read a document', input: { count: 3, recursive: true, path: '/private/file', command: 'PRIVATE_ARGUMENT' },
      output: 'PRIVATE_RESULT',
    } }] }] }),
  } };
  const plugin = await AgentDashboardPlugin({ directory: '/tmp', client });
  t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } }));
  await plugin.event({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool', sessionID: 'session', messageID: 'message', callID: 'call', tool: 'read', state: { status: 'completed' },
  } } } });
  for (let n = 0; n < 100 && !results.length; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reports.at(-1).toolDetailsEnabled, true);
  assert.deepEqual(results[0].toolDetail, { callId: 'call', name: 'read', status: 'completed', title: 'Read a document', metadata: { count: 3, recursive: true } });
  assert.doesNotMatch(JSON.stringify(results[0]), /PRIVATE_ARGUMENT|PRIVATE_RESULT|\/private\/file|"path"/);
});

test('validates optional model metadata while accepting legacy sessions', async t => {
  const { request } = await start(t);
  const value = report();
  value.sessions[0].model = { providerID: 'provider', modelID: 'model', variant: 'high', contextLimit: 200000 };
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 200);
  value.sessions[0].model.contextLimit = -1;
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 400);
  delete value.sessions[0].model;
  value.sessions[0].usage = { input: 10, output: 3, partial: false, contextEstimate: 12 };
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 200);
  value.sessions[0].usage.input = Number.MAX_SAFE_INTEGER + 1;
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 400);
  delete value.sessions[0].usage;
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 200);
});
test('accepts older reports and validates optional bounded timeline payloads', async t => {
  const { request } = await start(t);
  const value = report();
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 200);
  value.timeline = { partial: true, intervals: [{ sessionId: 'parent', startAt: '2026-10-12T00:00:00Z', endAt: null, status: 'busy' }] };
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 200);
  value.timeline.intervals[0].status = 'private-prompt';
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 400);
  value.timeline.intervals[0].status = 'busy';
  value.timeline.intervals[0].startAt = null;
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 400);
  value.timeline = undefined;
  value.events = [normalizeObservabilityEvent({ instanceId: value.instanceId, sessionId: 'parent', kind: 'busy', timestamp: '2026-10-12T00:00:00Z' })];
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 200);
  value.events.push(value.events[0]);
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 400);
});
test('queues bounded on-demand transcripts and serves each private response once', async t => {
  const transcriptToken = 'separate-transcript-access-key-32-chars';
  let time = Date.now();
  const { request } = await start(t, { transcriptToken, trustProxy: true, now: () => time });
  const send = value => request('/api/report', { method: 'POST', body: JSON.stringify(value) });
  const browserHeaders = { origin: 'https://localhost:4317', 'x-forwarded-proto': 'https', 'x-agentdashboard-transcript-token': transcriptToken };
  const value = report(); value.transcriptEnabled = true;
  assert.equal((await send(value)).status, 200);
  assert.equal((await request('/api/transcript/request', { method: 'POST', headers: { ...browserHeaders, 'x-forwarded-proto': 'http' },
    body: JSON.stringify({ instanceId: 'one', sessionId: 'parent', limit: 50 }) })).status, 403);
  assert.equal((await request('/api/transcript/request', { method: 'POST', headers: { origin: 'https://localhost:4317', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ instanceId: 'one', sessionId: 'parent', limit: 50 }) })).status, 403);
  const queuedResponse = await request('/api/transcript/request', { method: 'POST', headers: browserHeaders,
    body: JSON.stringify({ instanceId: 'one', sessionId: 'parent', limit: 50 }) });
  assert.equal(queuedResponse.status, 202);
  const queued = await queuedResponse.json();
  const heartbeat = await send(value);
  assert.deepEqual((await heartbeat.json()).transcriptRequests.map(({ requestId, sessionId }) => [requestId, sessionId]), [[queued.requestId, 'parent']]);
  const result = { requestId: queued.requestId, instanceId: 'one', sessionId: 'parent', available: true, partial: false, messages: [
    { id: 'message', role: 'assistant', timestamp: null, parts: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }, { type: 'tool', name: 'bash', status: 'completed' }] },
  ] };
  assert.equal((await request('/api/transcript/result', { method: 'POST', headers: browserHeaders, body: JSON.stringify(result) })).status, 200);
  const resultResponse = await request(`/api/transcript/result?requestId=${encodeURIComponent(queued.requestId)}`, { headers: browserHeaders });
  assert.equal(resultResponse.status, 200);
  assert.deepEqual(await resultResponse.json(), result);
  assert.equal((await request(`/api/transcript/result?requestId=${encodeURIComponent(queued.requestId)}`, { headers: browserHeaders })).status, 404,
    'transcript responses can only be fetched once');
  const cancelled = await (await request('/api/transcript/request', { method: 'POST', headers: browserHeaders,
    body: JSON.stringify({ instanceId: 'one', sessionId: 'parent', limit: 50 }) })).json();
  assert.equal((await request('/api/transcript/cancel', { method: 'POST', headers: browserHeaders,
    body: JSON.stringify({ requestId: cancelled.requestId, instanceId: 'one', sessionId: 'parent' }) })).status, 200);
  assert.equal((await request(`/api/transcript/result?requestId=${encodeURIComponent(cancelled.requestId)}`, { headers: browserHeaders })).status, 404);
  const expires = await (await request('/api/transcript/request', { method: 'POST', headers: browserHeaders,
    body: JSON.stringify({ instanceId: 'one', sessionId: 'parent', limit: 50 }) })).json();
  time += 16000;
  assert.equal((await request(`/api/transcript/result?requestId=${encodeURIComponent(expires.requestId)}`, { headers: browserHeaders })).status, 404,
    'an unfulfilled request expires from the in-memory queue');
});
test('authorizes safe tool details only for an observed tool call and validates the bounded response', async t => {
  const transcriptToken = 'separate-transcript-access-key-32-chars';
  const { request } = await start(t, { transcriptToken, trustProxy: true });
  const headers = { origin: 'https://localhost:4317', 'x-forwarded-proto': 'https', 'x-agentdashboard-transcript-token': transcriptToken };
  const value = report();
  value.toolDetailsEnabled = true;
  value.events = [{ sessionId: 'parent', messageId: 'message', toolCallId: 'call', timestamp: new Date().toISOString(), kind: 'toolActivity', summary: 'Tool activity' }];
  assert.equal((await request('/api/report', { method: 'POST', body: JSON.stringify(value) })).status, 200);
  const submit = body => request('/api/transcript/request', { method: 'POST', headers, body: JSON.stringify(body) });
  const common = { instanceId: 'one', sessionId: 'parent', mode: 'toolDetails', messageId: 'message', toolCallId: 'call' };
  assert.equal((await submit({ ...common, toolCallId: 'unobserved' })).status, 404);
  const queuedResponse = await submit(common);
  assert.equal(queuedResponse.status, 202);
  const queued = await queuedResponse.json();
  const heartbeat = await request('/api/report', { method: 'POST', body: JSON.stringify(value) });
  assert.deepEqual((await heartbeat.json()).transcriptRequests.map(({ mode, messageId, toolCallId }) => [mode, messageId, toolCallId]),
    [['toolDetails', 'message', 'call']]);
  const result = { requestId: queued.requestId, instanceId: 'one', sessionId: 'parent', mode: 'toolDetails', toolCallId: 'call', available: true, partial: false,
    messages: [], toolDetail: { callId: 'call', name: 'read', status: 'completed', title: 'Read document', metadata: { count: 2 } } };
  const invalid = structuredClone(result);
  invalid.toolDetail.metadata.path = '/private/path';
  assert.equal((await request('/api/transcript/result', { method: 'POST', headers, body: JSON.stringify(invalid) })).status, 400);
  assert.equal((await request('/api/transcript/result', { method: 'POST', headers, body: JSON.stringify(result) })).status, 200);
  assert.equal((await request('/api/transcript/result', { method: 'POST', headers, body: JSON.stringify(result) })).status, 404,
    'a response cannot be reused after delivery');
});
test('accumulates timeline intervals beyond report-buffer limits and retains ended descendants', async t => {
  const { request } = await start(t);
  const send = value => request('/api/report', { method: 'POST', body: JSON.stringify(value) });
  const stamp = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const interval = n => ({ sessionId: n % 2 ? 'child' : 'parent', startAt: stamp(n),
    endAt: stamp(n + 1), status: n % 2 ? 'idle' : 'busy' });
  const first = report();
  first.sessions.push({ id: 'child', parentID: 'parent', title: 'Worker', status: 'idle' });
  first.timeline = { partial: false, intervals: Array.from({ length: 800 }, (_, n) => interval(n)) };
  assert.equal((await send(first)).status, 200);
  const next = report();
  next.sessions.push({ id: 'child', parentID: 'parent', title: 'Worker', status: 'idle' });
  next.timeline = { partial: true, intervals: Array.from({ length: 800 }, (_, n) => interval(n + 600)) };
  assert.equal((await send(next)).status, 200);
  const state = await (await request('/api/state')).json();
  assert.equal(state.instances[0].timeline.intervals.length, 1400);
  assert.equal(state.instances[0].timeline.intervals[0].startAt, stamp(0));
  assert.equal(state.instances[0].timeline.partial, true);

  const completed = report();
  completed.timeline = { partial: false, intervals: [
    ...next.timeline.intervals,
    { sessionId: 'child', startAt: stamp(1400), endAt: null, status: 'busy' },
  ] };
  completed.events = [{ sessionId: 'child', timestamp: stamp(1401), kind: 'deleted', summary: 'Session ended' }];
  assert.equal((await send(completed)).status, 200);
  const afterDelete = await (await request('/api/state')).json();
  const child = afterDelete.instances[0].sessions.find(session => session.id === 'child');
  assert.equal(child.parentID, 'parent');
  assert.equal(child.archived, true);
  assert.equal(child.ended, true);
  assert.equal(afterDelete.instances[0].timeline.intervals.length, 1401);
  assert.equal(afterDelete.instances[0].timeline.intervals.at(-1).endAt, stamp(1401));
});
test('bounds companion-lifetime timeline memory and marks discarded chronology partial', async t => {
  const { request } = await start(t);
  const send = value => request('/api/report', { method: 'POST', body: JSON.stringify(value) });
  const stamp = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const interval = n => ({ sessionId: 'parent', startAt: stamp(n), endAt: stamp(n + 1), status: n % 2 ? 'idle' : 'busy' });
  const first = report();
  first.timeline = { partial: false, intervals: Array.from({ length: 5000 }, (_, n) => interval(n)) };
  assert.equal((await send(first)).status, 200);
  const next = report();
  next.timeline = { partial: false, intervals: [interval(4999), interval(5000)] };
  assert.equal((await send(next)).status, 200);
  const state = await (await request('/api/state')).json();
  assert.equal(state.instances[0].timeline.intervals.length, 5000);
  assert.equal(state.instances[0].timeline.intervals[0].startAt, stamp(1));
  assert.equal(state.instances[0].timeline.partial, true);
});
test('merges normalized event snapshots across the plugin rolling-window boundary', async t => {
  const { request } = await start(t);
  const send = value => request('/api/report', { method: 'POST', body: JSON.stringify(value) });
  const event = n => normalizeObservabilityEvent({ instanceId: 'one', sessionId: 'parent',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), kind: 'toolActivity', phase: 'tool',
    outcome: n % 2 ? 'started' : 'completed', messageId: 'message', toolCallId: `call-${n}`, eventId: `event-${n}` });
  const first = report(); first.events = Array.from({ length: 200 }, (_, n) => event(n));
  assert.equal((await send(first)).status, 200);
  const next = report(); next.events = Array.from({ length: 200 }, (_, n) => event(n + 50));
  assert.equal((await send(next)).status, 200);
  const instance = (await (await request('/api/state')).json()).instances[0];
  assert.equal(instance.events.length, 250);
  assert.equal(instance.events[0].toolCallId, 'call-0');
  assert.equal(instance.events.at(-1).toolCallId, 'call-249');
  assert.equal(instance.eventsPartial, undefined);
});
test('tracks bounded idempotent usage per session and keeps latest context separate', async t => {
  const originalFetch = globalThis.fetch;
  const keys = ['AGENTDASHBOARD_URL', 'AGENTDASHBOARD_TOKEN', 'AGENTDASHBOARD_TELEMETRY', 'XDG_CONFIG_HOME'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = await mkdtemp(join(tmpdir(), 'supervisor-usage-'));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  });
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317'; process.env.AGENTDASHBOARD_TOKEN = token;
  process.env.XDG_CONFIG_HOME = root; delete process.env.AGENTDASHBOARD_TELEMETRY;
  const reports = [];
  globalThis.fetch = async (_url, init) => { reports.push(JSON.parse(init.body)); return new Response('', { status: 200 }); };
  const client = { session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) }, config: { providers: async () => ({ data: { providers: [
    { id: 'p', models: { m: { name: 'Model', limit: { context: 1000 } } } },
  ] } }) } };
  const plugin = await AgentDashboardPlugin({ directory: '/tmp', client });
  t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } }));
  const emit = (sessionID, info) => plugin.event({ event: { type: 'message.updated', properties: { info: {
    sessionID, role: 'assistant', providerID: 'p', modelID: 'm', ...info,
  } } } });
  await emit('parent', { id: 'msg-1', time: { created: 1 }, tokens: { input: 80, output: 10, reasoning: 4, cache: { read: 20, write: 2 } } });
  await emit('child', { id: 'child-msg', time: { created: 1 }, tokens: { input: 7, output: 3 } });
  await emit('parent', { id: 'msg-1', time: { created: 1 }, tokens: { input: 90 } });
  await emit('parent', { id: 'msg-2', time: { created: 2 }, tokens: { input: 30, cache: { read: 5 } } });
  await emit('parent', { id: 'old-msg', time: { created: 0 }, tokens: { input: 999 } });
  for (let n = 0; n < 100 && !reports.some(r => r.sessions.some(s => s.id === 'parent' && s.usage)); n++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 280));
  let parent = reports.at(-1).sessions.find(s => s.id === 'parent');
  assert.deepEqual(parent.usage, { input: 1119, output: 10, reasoning: 4, cacheRead: 25, cacheWrite: 2, partial: false, contextEstimate: 35 });
  assert.deepEqual(reports.at(-1).sessions.find(s => s.id === 'child').usage,
    { input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0, partial: false, contextEstimate: 7 });

  for (let n = 0; n < 105; n++) await emit('parent', { id: `bounded-${n}`, time: { created: 10 + n }, tokens: { input: 1 } });
  await new Promise(resolve => setTimeout(resolve, 300));
  parent = reports.at(-1).sessions.find(s => s.id === 'parent');
  assert.equal(parent.usage.partial, true);
  assert.equal(parent.usage.contextEstimate, 1, 'latest context can fall independently of lifetime totals');
});
test('reconciles same-process generations without merging concurrent instances', async t => {
  let time = 1000;
  const { request } = await start(t, { now: () => time });
  const send = value => request('/api/report', { method: 'POST', body: JSON.stringify(value) });
  const generation = (instanceId, pid, status = 'busy', generationStartedAt = time) => ({
    instanceId, machineId: 'machine-a', host: 'same-host', pid, generationStartedAt,
    directory: '/work/project', sessions: [{ id: `session-${instanceId}`, title: instanceId, directory: '/work/project', status }], git: {},
  });

  await send(generation('old-generation', 41, 'busy', 900));
  time += 5000;
  await send(generation('concurrent-process', 42));
  time += 5000;
  await send(generation('replacement', 41, 'idle', 10900));

  let instances = (await (await request('/api/state')).json()).instances;
  const old = instances.find(instance => instance.instanceId === 'old-generation');
  assert.equal(old.online, false);
  assert.equal(old.replaced, true);
  assert.equal(old.replacedBy, 'replacement');
  assert.equal(instances.find(instance => instance.instanceId === 'replacement').online, true);
  assert.equal(instances.find(instance => instance.instanceId === 'concurrent-process').online, true);
  assert.equal(instances.length, 3);
  const revision = (await (await request('/api/state')).json()).revision;

  await send(generation('old-generation', 41, 'busy', 900));
  const state = await (await request('/api/state')).json();
  instances = state.instances;
  assert.equal(instances.find(instance => instance.instanceId === 'old-generation').online, false);
  assert.equal(instances.find(instance => instance.instanceId === 'replacement').online, true,
    'a delayed heartbeat from an older generation cannot replace its successor');
  assert.equal(state.revision, revision, 'stale generation heartbeats do not churn state revisions');

  time += 86400001;
  instances = (await (await request('/api/state')).json()).instances;
  assert.equal(instances.length, 2, 'only the replaced generation expires; current offline sessions remain for the companion lifetime');
  assert.ok(!instances.some(instance => instance.instanceId === 'old-generation'));
});
test('offline instances recover under the same generation and remain distinct from replaced ones', async t => {
  let time = 1000;
  const { request } = await start(t, { now: () => time });
  const send = (instanceId, generationStartedAt) => request('/api/report', { method: 'POST', body: JSON.stringify({
    instanceId, machineId: 'machine-a', host: 'alpha', pid: 41, generationStartedAt,
    sessions: [{ id: 'session', status: 'busy' }],
  }) });

  await send('generation-one', 900);
  time += 20000;
  let instances = (await (await request('/api/state')).json()).instances;
  assert.equal(instances[0].online, false);
  assert.equal(instances[0].replaced, undefined);

  await send('generation-one', 900);
  instances = (await (await request('/api/state')).json()).instances;
  assert.equal(instances.find(instance => instance.instanceId === 'generation-one').online, true);

  await send('generation-two', 21000);
  instances = (await (await request('/api/state')).json()).instances;
  assert.equal(instances.find(instance => instance.instanceId === 'generation-one').online, false);
  assert.equal(instances.find(instance => instance.instanceId === 'generation-one').replaced, true);
  assert.equal(instances.find(instance => instance.instanceId === 'generation-two').online, true);
});
test('state revision changes only for meaningful reports and derived transitions', async t => {
  let time = 1000;
  const { request } = await start(t, { now: () => time });
  const send = value => request('/api/report', { method: 'POST', body: JSON.stringify(value) });
  await send(report());
  let response = await request('/api/state');
  let state = await response.json();
  assert.equal(state.revision, 1);
  assert.equal(response.headers.get('etag'), '"1"');

  time += 5000;
  await send(report());
  response = await request('/api/state', { headers: { 'if-none-match': '"1"' } });
  assert.equal(response.status, 304);

  const changed = report(); changed.sessions[0].status = 'waiting';
  await send(changed);
  response = await request('/api/state', { headers: { 'if-none-match': '"1"' } });
  state = await response.json();
  assert.equal(state.revision, 2);
  assert.equal(state.instances[0].sessions[0].status, 'waiting');

  time += 20000;
  response = await request('/api/state', { headers: { 'if-none-match': '"2"' } });
  state = await response.json();
  assert.equal(state.revision, 3);
  assert.equal(state.instances[0].online, false);

  // A client without a validator (including one reconnecting after losing its cache) gets a full snapshot.
  response = await request('/api/state');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).instances.length, 1);
});
test('machine identity persists across plugin generations and distinguishes machines and concurrent processes', async t => {
  const originalFetch = globalThis.fetch;
  const old = Object.fromEntries(['AGENTDASHBOARD_URL', 'AGENTDASHBOARD_TOKEN', 'AGENTDASHBOARD_HOST', 'XDG_CONFIG_HOME'].map(k => [k, process.env[k]]));
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
  process.env.AGENTDASHBOARD_URL = 'http://localhost:4317';
  process.env.AGENTDASHBOARD_TOKEN = token;
  process.env.AGENTDASHBOARD_HOST = 'same-hostname';
  const client = { session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) } };
  const runAt = async config => {
    process.env.XDG_CONFIG_HOME = config;
    const plugin = await AgentDashboardPlugin({ directory: '/tmp', client });
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
test('migrates the legacy machine ID into the AgentDashboard config without changing identity', async t => {
  const originalFetch = globalThis.fetch;
  const keys = ['AGENTDASHBOARD_URL', 'OPENCODE_SUPERVISOR_URL', 'AGENTDASHBOARD_TOKEN', 'OPENCODE_SUPERVISOR_TOKEN', 'XDG_CONFIG_HOME'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = await mkdtemp(join(tmpdir(), 'agentdashboard-identity-migration-'));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  });
  const legacyDirectory = join(root, 'opencode-supervisor');
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(join(legacyDirectory, 'machine-id'), 'stable-legacy-machine-id');
  process.env.XDG_CONFIG_HOME = root;
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317';
  process.env.AGENTDASHBOARD_TOKEN = token;
  delete process.env.OPENCODE_SUPERVISOR_URL;
  delete process.env.OPENCODE_SUPERVISOR_TOKEN;
  let report;
  globalThis.fetch = async (_url, init) => { report = JSON.parse(init.body); return new Response('', { status: 200 }); };
  const plugin = await AgentDashboardPlugin({ directory: '/tmp', client: { session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) } } });
  t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } }));
  for (let n = 0; n < 100 && !report; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(report.machineId, 'stable-legacy-machine-id');
  assert.equal(await readFile(join(root, 'agentdashboard', 'machine-id'), 'utf8'), 'stable-legacy-machine-id');
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
test('serves every web icon referenced by the dashboard with its correct media type', async t => {
  const { dispatch } = await start(t);
  const html = await (await dispatch('/')).text();
  const iconPaths = [...html.matchAll(/(?:href|src)="(\/icons\/[^\"]+)"/g)].map(([, path]) => path);
  assert.ok(iconPaths.length > 0);
  for (const path of iconPaths) {
    const response = await dispatch(path);
    assert.equal(response.status, 200, `${path} is served`);
    assert.notEqual(response.headers.get('content-type'), 'text/html', `${path} is not an HTML fallback`);
    assert.ok((await response.arrayBuffer()).byteLength > 0, `${path} is non-empty`);
  }
  assert.equal((await dispatch('/icons/icon.svg')).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await dispatch('/icons/favicon.ico')).headers.get('content-type'), 'image/vnd.microsoft.icon');
  assert.equal((await dispatch('/icons/site.webmanifest')).headers.get('content-type'), 'application/manifest+json');
});
for (const local of [false, true]) test(`plugin reports Git and session events in ${local ? 'local' : 'network'} mode`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => promisify(execFile)('git', ['-C', dir, ...args]);
  await git('init'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(join(dir, 'file.txt'), 'initial'); await git('add', '.'); await git('commit', '-m', 'Initial commit'); await writeFile(join(dir, 'file.txt'), 'changed');
  await git('worktree', 'add', '-b', 'feature', join(dir, 'linked'));
  const { url, request, dispatch } = await start(t, local ? { token: undefined } : {});
  const originalFetch = globalThis.fetch; globalThis.fetch = dispatch; t.after(() => { globalThis.fetch = originalFetch; });
  process.env.AGENTDASHBOARD_URL = url; process.env.AGENTDASHBOARD_TOKEN = local ? '' : token;
  t.after(() => { delete process.env.AGENTDASHBOARD_URL; delete process.env.AGENTDASHBOARD_TOKEN; });
  const plugin = await AgentDashboardPlugin({ directory: dir, worktree: dir, client: { session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) } } });
  t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: dir } } }));
  async function emit(type, properties) { await plugin.event({ event: { type, properties } }); }
  async function waitFor(predicate) { for (let n = 0; n < 100; n++) { const state = await (await request('/api/state')).json(); if (predicate(state.instances[0])) return state.instances[0]; await new Promise(r => setTimeout(r, 60)); } throw new Error('Report not received'); }
  const first = await waitFor(i => i?.git.status); assert.match(first.git.status, /file.txt/); assert.match(first.git.log, /Initial commit/); assert.ok(first.git.worktrees.includes('refs/heads/feature'));
  await emit('session.created', { info: { id: 'root', title: 'Parent', directory: dir } });
  await emit('session.created', { info: { id: 'child', parentID: 'root', title: 'Investigate', directory: dir, delegationID: 'task-call-1' } });
  await emit('session.status', { sessionID: 'child', status: { type: 'busy' } });
  const toolStartedAt = new Date(Date.now() - 5000).toISOString();
  const toolFinishedAt = new Date(Date.now()).toISOString();
  const toolPart = { sessionID: 'child', messageID: 'message-1', id: 'part-1', callID: 'call-1', type: 'tool', tool: 'bash', state: { status: 'running', time: { start: toolStartedAt }, input: { command: 'secret-value' } } };
  await emit('message.part.updated', { part: toolPart });
  await emit('message.part.updated', { part: toolPart });
  const compactedAt = new Date(Date.now() - 1000).toISOString();
  await emit('session.compacted', { sessionID: 'child', time: { created: compactedAt }, content: 'PRIVATE_COMPACTION_TEXT' });
  await emit('session.compacted', { sessionID: 'child', time: { created: compactedAt }, content: 'PRIVATE_COMPACTION_TEXT' });
  const diff = [{ path: `${dir}/file.txt`, additions: 3, deletions: 1, patch: 'PRIVATE_SOURCE_HUNK' }];
  await emit('session.diff', { sessionID: 'child', diff });
  await emit('session.diff', { sessionID: 'child', diff });
  const running = await waitFor(i => i?.sessions.some(s => s.id === 'child' && s.activity === 'bash: running'));
  assert.equal(running.sessions.find(s => s.id === 'child').parentID, 'root'); assert.ok(!JSON.stringify(running).includes('secret-value'));
  await emit('permission.asked', { sessionID: 'child', id: 'permission-1', type: 'bash', title: 'PRIVATE_COMMAND_TITLE', pattern: '/private/path', metadata: { prompt: 'secret prompt' } });
  await emit('permission.updated', { sessionID: 'child', id: 'permission-1', type: 'bash', title: 'PRIVATE_COMMAND_TITLE', pattern: '/private/path', metadata: { prompt: 'secret prompt' } });
  await emit('permission.asked', { sessionID: 'child', id: 'permission-2', type: 'read', pattern: '/another/private/path' });
  const waiting = await waitFor(i => i?.sessions.find(s => s.id === 'child')?.status === 'waiting' && i.sessions.find(s => s.id === 'child').permissions?.length === 2);
  assert.ok(waiting.events.some(event => event.sessionId === 'child' && event.kind === 'waiting'));
  assert.ok(waiting.events.some(event => event.sessionId === 'root' && event.kind === 'created'));
  assert.equal(waiting.events.find(event => event.sessionId === 'child' && event.kind === 'created').attributes.delegationId, 'task-call-1');
  const permission = waiting.sessions.find(s => s.id === 'child').permissions[0];
  assert.equal(permission.id, 'permission-1');
  assert.equal(permission.type, 'bash');
  assert.equal(permission.title, 'Run command');
  assert.equal(permission.status, 'pending');
  assert.equal(waiting.events.filter(event => event.attributes?.permissionId === 'permission-1').length, 1, 'permission snapshot replay is idempotent');
  assert.equal(waiting.sessions.find(s => s.id === 'child').permissions[1].type, 'read');
  assert.equal(waiting.sessions.find(s => s.id === 'child').permissions[1].title, 'Read files');
  const toolEvents = waiting.events.filter(event => event.kind === 'toolActivity');
  assert.equal(toolEvents.length, 1, 'repeated running snapshots produce one event');
  assert.equal(toolEvents[0].schemaVersion, 1);
  assert.equal(toolEvents[0].parentSessionId, 'root');
  assert.equal(toolEvents[0].phase, 'tool');
  assert.equal(toolEvents[0].outcome, 'started');
  assert.equal(toolEvents[0].timestamp, toolStartedAt);
  assert.equal(toolEvents[0].timestampSource, 'source');
  assert.equal(toolEvents[0].attributes.toolName, 'bash');
  assert.equal(toolEvents[0].attributes.toolStatus, 'running');
  assert.equal(waiting.sessions.find(s => s.id === 'child').compactionCount, 1);
  assert.equal(waiting.sessions.find(s => s.id === 'child').lastCompactedAt, compactedAt);
  assert.equal(waiting.events.filter(event => event.sessionId === 'child' && event.kind === 'compaction').length, 1);
  const fileEvents = waiting.events.filter(event => event.kind === 'fileChange' && event.attributes.fileKey !== '__snapshot__');
  assert.equal(fileEvents.length, 1, 'repeated full diff snapshots do not double-count a file');
  assert.equal(fileEvents[0].attributes.additions, 3);
  assert.equal(fileEvents[0].attributes.deletions, 1);
  assert.equal(fileEvents[0].attributes.path, `${dir}/file.txt`);
  assert.doesNotMatch(JSON.stringify(waiting), /PRIVATE_COMMAND_TITLE|\/private\/path|secret prompt|secret-value|PRIVATE_SOURCE_HUNK|PRIVATE_COMPACTION_TEXT/);
  await emit('permission.replied', { sessionID: 'child', id: 'permission-1', reply: 'reject', title: 'SECRET_REPLY_TITLE' });
  const permissionPartiallyAnswered = await waitFor(i => i?.sessions.find(s => s.id === 'child')?.permissions?.[0]?.status === 'responded');
  assert.equal(permissionPartiallyAnswered.sessions.find(s => s.id === 'child').status, 'waiting', 'one reply does not clear another outstanding permission');
  assert.equal(permissionPartiallyAnswered.sessions.find(s => s.id === 'child').permissions[0].resolution, 'rejected');
  await emit('permission.replied', { sessionID: 'child', id: 'permission-2', reply: 'once' });
  const permissionAnswered = await waitFor(i => i?.sessions.find(s => s.id === 'child')?.permissions?.[1]?.status === 'responded');
  assert.equal(permissionAnswered.sessions.find(s => s.id === 'child').permissions[1].resolution, 'approved');
  assert.equal(permissionAnswered.sessions.find(s => s.id === 'child').status, 'busy');
  assert.doesNotMatch(JSON.stringify(permissionAnswered), /SECRET_REPLY_TITLE/);
  await emit('message.part.updated', { part: { ...toolPart, state: { status: 'completed', time: { start: toolStartedAt, end: toolFinishedAt } } } });
  const completed = await waitFor(i => i?.events?.some(event => event.kind === 'toolActivity' && event.outcome === 'completed'));
  const finishedCall = completed.events.find(event => event.kind === 'toolActivity' && event.outcome === 'completed');
  assert.equal(finishedCall.timestamp, toolFinishedAt);
  assert.equal(finishedCall.toolCallId, 'call-1');
  const retryDeadline = new Date(Date.now() + 30000).toISOString();
  const retryStatus = { type: 'retry', attempt: 1, nextRetryAt: retryDeadline, message: 'PRIVATE_RETRY_MESSAGE' };
  await emit('session.status', { sessionID: 'child', status: retryStatus });
  await emit('session.status', { sessionID: 'child', status: retryStatus });
  let retrying = await waitFor(i => i?.sessions.find(s => s.id === 'child')?.status === 'retry');
  let retryEvents = retrying.events.filter(event => event.sessionId === 'child' && event.kind === 'retry');
  assert.equal(retryEvents.length, 1, 'replayed retry status does not create duplicate events');
  assert.equal(retrying.sessions.find(s => s.id === 'child').retry.attempt, 1);
  assert.equal(retryEvents[0].attributes.nextRetryAt, retryDeadline);
  assert.doesNotMatch(JSON.stringify(retrying), /PRIVATE_RETRY_MESSAGE/);
  await emit('session.status', { sessionID: 'child', status: { ...retryStatus, attempt: 2, message: 'PRIVATE_RETRY_MESSAGE_2' } });
  await emit('session.status', { sessionID: 'child', status: retryStatus });
  retrying = await waitFor(i => i?.sessions.find(s => s.id === 'child')?.retry?.attempt === 2);
  retryEvents = retrying.events.filter(event => event.sessionId === 'child' && event.kind === 'retry');
  assert.equal(retryEvents.length, 2);
  assert.equal(retrying.sessions.find(s => s.id === 'child').retry.attempt, 2, 'an older retry attempt cannot regress the current state');
  await emit('session.status', { sessionID: 'child', status: { type: 'busy' } });
  const resumed = await waitFor(i => i?.sessions.find(s => s.id === 'child')?.status === 'busy');
  assert.equal(resumed.sessions.find(s => s.id === 'child').retry, undefined);
  await emit('session.error', { sessionID: 'child', error: { name: 'ETIMEDOUT', message: 'PRIVATE_ERROR_DETAIL' } });
  const errored = await waitFor(i => i?.sessions.find(s => s.id === 'child')?.errorCategory === 'timeout');
  const errorEvent = errored.events.find(event => event.sessionId === 'child' && event.kind === 'error');
  assert.equal(errorEvent.attributes.errorCategory, 'timeout');
  assert.doesNotMatch(JSON.stringify(errored), /PRIVATE_ERROR_DETAIL/);
  await emit('session.idle', { sessionID: 'child' });
  await waitFor(i => i?.sessions.find(s => s.id === 'child')?.status === 'idle');
  globalThis.fetch = async () => { throw new Error('Network offline'); };
  await emit('session.status', { sessionID: 'child', status: { type: 'busy' } });
  await new Promise(r => setTimeout(r, 350));
  globalThis.fetch = dispatch;
  await emit('session.status', { sessionID: 'child', status: { type: 'retry' } });
  await waitFor(i => i?.sessions.find(s => s.id === 'child')?.status === 'retry');
  await emit('session.deleted', { info: { id: 'child' } });
  await waitFor(i => i && i.sessions.some(s => s.id === 'child' && s.archived));
});
test('replacing a base session removes the previous root but retains the new root and its children', async t => {
  const originalFetch = globalThis.fetch;
  const keys = ['AGENTDASHBOARD_URL', 'AGENTDASHBOARD_TOKEN', 'XDG_CONFIG_HOME'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const config = await mkdtemp(join(tmpdir(), 'agentdashboard-replaced-session-'));
  const reports = [];
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317';
  process.env.AGENTDASHBOARD_TOKEN = token;
  process.env.XDG_CONFIG_HOME = config;
  globalThis.fetch = async (_url, init) => { reports.push(JSON.parse(init.body)); return new Response('', { status: 200 }); };
  const directory = '/tmp/replaced-session';
  const plugin = await AgentDashboardPlugin({ directory, client: {
    session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) },
  } });
  t.after(async () => {
    await plugin.event({ event: { type: 'server.instance.disposed', properties: { directory } } });
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(config, { recursive: true, force: true });
  });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'old-root', title: 'Old', directory } } } });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'other-root', title: 'Other directory', directory: '/tmp/other' } } } });
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'old-root' } } });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'new-root', title: 'New', directory } } } });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'new-child', parentID: 'new-root', title: 'Child', directory } } } });
  for (let n = 0; n < 100 && !reports.some(report => report.sessions.some(session => session.id === 'new-child')); n++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const sessions = reports.at(-1).sessions.map(session => session.id);
  assert.deepEqual(sessions, ['other-root', 'new-root', 'new-child']);
});
test('plugin refuses remote telemetry without a token', async t => {
  const old = process.env.AGENTDASHBOARD_URL;
  t.after(() => { if (old === undefined) delete process.env.AGENTDASHBOARD_URL; else process.env.AGENTDASHBOARD_URL = old; });
  process.env.AGENTDASHBOARD_URL = 'http://192.168.1.10:4317';
  assert.deepEqual(await AgentDashboardPlugin({ directory: '/tmp' }), {});
});
test('legacy plugin environment names do not enable remote reports', async t => {
  const keys = ['AGENTDASHBOARD_URL', 'OPENCODE_SUPERVISOR_URL', 'AGENTDASHBOARD_TOKEN', 'OPENCODE_SUPERVISOR_TOKEN', 'XDG_CONFIG_HOME'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const config = await mkdtemp(join(tmpdir(), 'agentdashboard-legacy-env-'));
  let requested;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(config, { recursive: true, force: true });
  });
  delete process.env.AGENTDASHBOARD_URL;
  process.env.OPENCODE_SUPERVISOR_URL = 'http://192.168.1.10:4317';
  delete process.env.AGENTDASHBOARD_TOKEN;
  process.env.OPENCODE_SUPERVISOR_TOKEN = token;
  process.env.XDG_CONFIG_HOME = config;
  globalThis.fetch = async (url, init) => { requested = { url: String(url), headers: init.headers }; return new Response('', { status: 200 }); };
  const plugin = await AgentDashboardPlugin({ directory: '/tmp' });
  for (let n = 0; n < 100 && !requested; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(requested.url, 'http://127.0.0.1:4317/api/report', 'the unsupported remote legacy URL is ignored');
  assert.equal(requested.headers.authorization, undefined, 'the unsupported legacy token is not sent');
  await plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } });
});
test('status-only telemetry strips metadata before transmission and validates settings', async t => {
  const originalFetch = globalThis.fetch;
  const old = Object.fromEntries(['AGENTDASHBOARD_URL', 'AGENTDASHBOARD_TOKEN', 'AGENTDASHBOARD_TELEMETRY', 'XDG_CONFIG_HOME'].map(k => [k, process.env[k]]));
  const root = await mkdtemp(join(tmpdir(), 'supervisor-privacy-'));
  let sent;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  });
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317';
  process.env.AGENTDASHBOARD_TOKEN = token;
  process.env.AGENTDASHBOARD_TELEMETRY = '{"profile":"status-only"}';
  process.env.XDG_CONFIG_HOME = root;
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return new Response('', { status: 200 }); };
  const plugin = await AgentDashboardPlugin({ directory: '/private/project', worktree: '/private/worktree', client: { session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) } } });
  t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/private/project' } } }));
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'session', title: 'Secret title', directory: '/private/project' } } } });
  await plugin.event({ event: { type: 'permission.asked', properties: {
    sessionID: 'session', id: 'status-only-permission', type: 'bash', title: 'PRIVATE_TITLE', pattern: 'PRIVATE_COMMAND',
  } } });
  await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'session', status: { type: 'busy' } } } });
  await plugin.event({ event: { type: 'session.compacted', properties: { sessionID: 'session', content: 'PRIVATE_COMPACTION_TEXT' } } });
  await plugin.event({ event: { type: 'message.updated', properties: { info: { sessionID: 'session', role: 'assistant', id: 'message',
    providerID: 'private-provider', modelID: 'private-model', variant: 'private-variant', tokens: { input: 12, output: 3 } } } } });
  for (let n = 0; n < 100 && (!sent?.sessions?.length || sent.sessions[0].status !== 'busy' || sent.timeline?.intervals.length < 2); n++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(sent.sessions[0].id, 'session');
  assert.equal(sent.sessions[0].status, 'busy');
  assert.equal(sent.sessions[0].title, undefined);
  assert.equal(sent.sessions[0].directory, undefined);
  assert.equal(sent.sessions[0].model, undefined);
  assert.equal(sent.sessions[0].usage, undefined);
  assert.equal(sent.sessions[0].permissions, undefined);
  assert.equal(sent.sessions[0].lastCompactedAt, undefined);
  assert.ok(!sent.events?.some(event => event.kind === 'compaction'));
  assert.ok(!sent.events?.some(event => event.attributes?.permissionId));
  assert.deepEqual(sent.events?.map(event => event.kind), ['created', 'waiting', 'busy']);
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_TITLE|PRIVATE_COMMAND|PRIVATE_COMPACTION_TEXT/);
  const observedStatuses = sent.timeline.intervals.map(({ sessionId, status }) => [sessionId, status]);
  assert.equal(observedStatuses[0][1], 'waiting');
  assert.ok(observedStatuses.every(([sessionId, status]) => sessionId === 'session' && ['waiting', 'busy'].includes(status)));
  if (!observedStatuses.some(([, status]) => status === 'busy')) {
    assert.equal(sent.timeline.partial, true, 'same-millisecond transitions remain explicitly partial instead of receiving fabricated timestamps');
  }
  assert.doesNotMatch(JSON.stringify(sent.timeline), /Secret title|private\/project|private-provider|private-model/);
  assert.equal(sent.directory, undefined);
  assert.equal(sent.git, undefined);
  assert.equal(sent.machineId.length > 0, true);
  assert.deepEqual(await (async () => {
    process.env.AGENTDASHBOARD_TELEMETRY = '{"unknown":false}';
    return AgentDashboardPlugin({ directory: '/tmp' });
  })(), {});
});
test('each telemetry privacy category is filtered from the outgoing report payload', async t => {
  const originalFetch = globalThis.fetch;
  const keys = ['AGENTDASHBOARD_URL', 'AGENTDASHBOARD_TOKEN', 'AGENTDASHBOARD_TELEMETRY', 'XDG_CONFIG_HOME'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = await mkdtemp(join(tmpdir(), 'supervisor-privacy-categories-'));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  });
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317';
  process.env.AGENTDASHBOARD_TOKEN = token;
  process.env.XDG_CONFIG_HOME = root;
  const git = (...args) => promisify(execFile)('git', ['-C', root, ...args]);
  await git('init');
  await git('config', 'user.name', 'Privacy test');
  await git('config', 'user.email', 'privacy@example.test');
  await writeFile(join(root, 'private-file'), 'fixture');
  await git('add', '.');
  await git('commit', '-m', 'PRIVATE_COMMIT');

  for (const [category, forbidden] of [
    ['titles', 'PRIVATE_TITLE'], ['tasks', 'PRIVATE_TASK'], ['toolActivity', 'PRIVATE_ACTIVITY'], ['toolDetails', 'PRIVATE_TOOL_TITLE'], ['modelMetrics', 'PRIVATE_MODEL'],
    ['paths', root], ['git', 'PRIVATE_COMMIT'], ['permissionDetails', 'PRIVATE_PERMISSION_ID'],
  ]) {
    process.env.AGENTDASHBOARD_TELEMETRY = JSON.stringify({ [category]: false });
    const reports = [];
    globalThis.fetch = async (_url, init) => { reports.push(JSON.parse(init.body)); return new Response('', { status: 200 }); };
    const directory = root;
    const plugin = await AgentDashboardPlugin({ directory, worktree: '/private/worktree', client: {
      session: {
        list: async () => ({ data: [{ id: 'session', title: 'PRIVATE_TITLE', directory, parentID: 'parent' }] }),
        status: async () => ({ data: { session: { type: 'busy' } } }),
      },
    } });
    t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory } } }));
    await plugin.event({ event: { type: 'session.updated', properties: { info: {
      id: 'session', title: 'PRIVATE_TITLE', directory,
      todos: [{ content: 'PRIVATE_TASK', status: 'pending' }],
    } } } });
    await plugin.event({ event: { type: 'message.part.updated', properties: {
      part: { sessionID: 'session', messageID: 'private-message', id: 'private-part', callID: 'private-call', type: 'tool', tool: 'PRIVATE_ACTIVITY', state: { status: 'running', title: 'PRIVATE_TOOL_TITLE', input: { command: 'RAW_TOOL_ARGUMENT' }, output: 'RAW_TOOL_OUTPUT' } },
    } } });
    await plugin.event({ event: { type: 'todo.updated', properties: { sessionID: 'session', todos: [{ content: 'PRIVATE_TASK', status: 'pending' }] } } });
    await plugin.event({ event: { type: 'permission.asked', properties: {
      sessionID: 'session', id: 'PRIVATE_PERMISSION_ID', type: 'bash', title: 'PRIVATE_PERMISSION_TITLE',
      pattern: '/private/command', metadata: { prompt: 'PRIVATE_PERMISSION_PROMPT' },
    } } });
    await plugin.event({ event: { type: 'session.diff', properties: { sessionID: 'session', diff: [
      { path: join(root, 'private-file'), additions: 4, deletions: 2, patch: 'PRIVATE_SOURCE_CONTENT' },
    ] } } });
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'session', status: { type: 'busy' } } } });
    await plugin.event({ event: { type: 'message.updated', properties: { info: { sessionID: 'session', role: 'assistant', id: 'message',
      providerID: 'PRIVATE_MODEL', modelID: 'model', variant: 'variant', tokens: { input: 10, reasoning: 2 },
      content: 'RAW_PROMPT and PRIVATE_REASONING' } } } });
    await new Promise(resolve => setTimeout(resolve, 350));
    const sent = reports.at(-1);
    assert.ok(sent, `${category}: report was transmitted`);
    const payload = JSON.stringify(sent);
    assert.ok(!payload.includes(forbidden), `${category}: ${forbidden} absent from transmitted report`);
    assert.ok(!payload.includes('RAW_TOOL_ARGUMENT'));
    assert.ok(!payload.includes('RAW_TOOL_OUTPUT'));
    assert.ok(!payload.includes('RAW_PROMPT'));
    assert.ok(!payload.includes('PRIVATE_REASONING'));
    assert.ok(!payload.includes('PRIVATE_PERMISSION_TITLE'));
    assert.ok(!payload.includes('PRIVATE_PERMISSION_PROMPT'));
    assert.ok(!payload.includes('/private/command'));
    assert.ok(!payload.includes('PRIVATE_SOURCE_CONTENT'));
    if (category === 'toolActivity') assert.ok(!sent.events?.some(event => event.kind === 'toolActivity'));
    if (category === 'toolDetails') assert.equal(sent.toolDetailsEnabled, false);
    if (category === 'permissionDetails') {
      assert.equal(sent.sessions[0].permissions, undefined);
      assert.ok(!sent.events?.some(event => event.attributes?.permissionId));
    } else assert.equal(sent.sessions[0].permissions?.[0]?.title, 'Run command');
    assert.equal(sent.sessions[0].id, 'session');
    assert.equal(sent.sessions[0].status, 'busy');
    if (category === 'paths') {
      assert.equal(sent.directory, undefined);
      assert.equal(sent.worktree, undefined);
      assert.equal(sent.git, undefined);
      assert.equal(sent.sessions[0].directory, undefined);
    }
    if (category === 'git') assert.equal(sent.git, undefined);
    if (category === 'modelMetrics') { assert.equal(sent.sessions[0].model, undefined); assert.equal(sent.sessions[0].usage, undefined); }
    await plugin.event({ event: { type: 'server.instance.disposed', properties: { directory } } });
  }
});
test('polls MCP health safely, falls back for older SDKs, and respects its privacy category', async t => {
  const originalFetch = globalThis.fetch;
  const keys = ['AGENTDASHBOARD_URL', 'AGENTDASHBOARD_TOKEN', 'AGENTDASHBOARD_TELEMETRY', 'XDG_CONFIG_HOME'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const config = await mkdtemp(join(tmpdir(), 'agentdashboard-mcp-health-'));
  const reports = [];
  let statusCalls = 0;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(config, { recursive: true, force: true });
  });
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317';
  process.env.AGENTDASHBOARD_TOKEN = token;
  process.env.AGENTDASHBOARD_TELEMETRY = '{"paths":false}';
  process.env.XDG_CONFIG_HOME = config;
  globalThis.fetch = async (_url, init) => { reports.push(JSON.parse(init.body)); return new Response('', { status: 200 }); };
  const client = {
    session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) },
    mcp: { status: async () => {
      statusCalls++;
      return { data: {
        'local-build': { status: 'connected', updatedAt: '2026-10-12T10:00:00Z' },
        'private-auth': { status: 'auth-required', endpoint: 'https://user:secret@private.example', token: 'PRIVATE_TOKEN' },
        'failing-server': { status: 'failed', error: 'PRIVATE_ERROR_BODY' },
        'offline-server': { status: 'disconnected' },
        'new-sdk-state': { status: 'unexpected-future-status' },
      } };
    } },
  };
  const plugin = await AgentDashboardPlugin({ directory: '/tmp/mcp-health', client });
  t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp/mcp-health' } } }));
  for (let n = 0; n < 100 && !reports.find(report => report.mcpHealth?.available); n++) await new Promise(resolve => setTimeout(resolve, 20));
  const health = reports.find(report => report.mcpHealth?.available)?.mcpHealth;
  assert.equal(health.servers.length, 5);
  assert.deepEqual(health.servers.map(server => [server.name, server.state]), [
    ['local-build', 'connected'], ['private-auth', 'auth-required'], ['failing-server', 'failed'],
    ['offline-server', 'disconnected'], ['new-sdk-state', 'unknown'],
  ]);
  assert.doesNotMatch(JSON.stringify(reports), /private\.example|PRIVATE_TOKEN|PRIVATE_ERROR_BODY/);
  assert.equal(statusCalls, 1, 'ordinary heartbeats do not poll MCP status continuously');

  const unsupported = await AgentDashboardPlugin({ directory: '/tmp/mcp-unsupported', client: { session: client.session } });
  t.after(() => unsupported.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp/mcp-unsupported' } } }));
  for (let n = 0; n < 100 && !reports.find(report => report.mcpHealth?.status === 'unsupported'); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(reports.some(report => report.mcpHealth?.status === 'unsupported'));

  const failingMcp = await AgentDashboardPlugin({ directory: '/tmp/mcp-failed', client: {
    session: client.session, mcp: { status: async () => { throw new Error('PRIVATE_MCP_FAILURE_DETAIL'); } },
  } });
  t.after(() => failingMcp.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp/mcp-failed' } } }));
  for (let n = 0; n < 100 && !reports.find(report => report.mcpHealth?.status === 'unavailable'); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(reports.some(report => report.mcpHealth?.status === 'unavailable'));
  assert.doesNotMatch(JSON.stringify(reports), /PRIVATE_MCP_FAILURE_DETAIL/);

  process.env.AGENTDASHBOARD_TELEMETRY = '{"mcpHealth":false,"paths":false}';
  const reportsBeforeDisabled = reports.length;
  const privatePlugin = await AgentDashboardPlugin({ directory: '/tmp/mcp-private', client });
  t.after(() => privatePlugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp/mcp-private' } } }));
  for (let n = 0; n < 100 && reports.length === reportsBeforeDisabled; n++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(statusCalls, 1, 'disabled MCP telemetry does not call the SDK');
  assert.equal(reports.at(-1).mcpHealth, undefined);
});
test('polls LSP and formatter status while retaining only diagnostic counts', async t => {
  const originalFetch = globalThis.fetch;
  const keys = ['AGENTDASHBOARD_URL', 'AGENTDASHBOARD_TOKEN', 'AGENTDASHBOARD_TELEMETRY', 'XDG_CONFIG_HOME'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const config = await mkdtemp(join(tmpdir(), 'agentdashboard-lsp-health-'));
  const reports = [];
  let lspCalls = 0, formatterCalls = 0;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(config, { recursive: true, force: true });
  });
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317';
  process.env.AGENTDASHBOARD_TOKEN = token;
  process.env.AGENTDASHBOARD_TELEMETRY = '{"paths":false}';
  process.env.XDG_CONFIG_HOME = config;
  globalThis.fetch = async (_url, init) => { reports.push(JSON.parse(init.body)); return new Response('', { status: 200 }); };
  const client = {
    session: { list: async () => ({ data: [] }), status: async () => ({ data: {} }) },
    lsp: { status: async () => { lspCalls++; return { data: {
      tsserver: { status: 'connected', updatedAt: '2026-10-12T10:00:00Z' },
      pyright: { status: 'failed', error: 'PRIVATE_LSP_ERROR' },
    } }; } },
    formatter: { status: async () => { formatterCalls++; return { data: { prettier: true, rustfmt: true } }; } },
  };
  const plugin = await AgentDashboardPlugin({ directory: '/tmp/lsp-health', client });
  t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp/lsp-health' } } }));
  for (let n = 0; n < 100 && !reports.find(report => report.lspHealth?.lsp.status === 'available'); n++) await new Promise(resolve => setTimeout(resolve, 20));
  await plugin.event({ event: { type: 'lsp.client.diagnostics', properties: { uri: '/private/project/file.ts', diagnostics: [
    { severity: 1, message: 'PRIVATE_DIAGNOSTIC_MESSAGE' }, { severity: 2, message: 'PRIVATE_DIAGNOSTIC_WARNING' },
  ] } } });
  for (let n = 0; n < 100 && !reports.at(-1)?.lspHealth?.diagnostics?.available; n++) await new Promise(resolve => setTimeout(resolve, 20));
  const report = reports.at(-1), health = report.lspHealth;
  assert.deepEqual(health.lsp.servers.map(server => [server.name, server.state]), [['tsserver', 'connected'], ['pyright', 'failed']]);
  assert.deepEqual(health.formatter.formatters.map(formatter => [formatter.name, formatter.state]), [['prettier', 'available'], ['rustfmt', 'available']]);
  assert.deepEqual([health.diagnostics.errors, health.diagnostics.warnings, health.diagnostics.information, health.diagnostics.hints], [1, 1, 0, 0]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_LSP_ERROR|PRIVATE_DIAGNOSTIC|\/private\/project\/file/);
  assert.equal(lspCalls, 1);
  assert.equal(formatterCalls, 1);

  const unsupported = await AgentDashboardPlugin({ directory: '/tmp/lsp-unsupported', client: { session: client.session } });
  t.after(() => unsupported.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp/lsp-unsupported' } } }));
  for (let n = 0; n < 100 && !reports.find(item => item.lspHealth?.lsp.status === 'unsupported'); n++) await new Promise(resolve => setTimeout(resolve, 20));
  const noSdk = reports.find(item => item.lspHealth?.lsp.status === 'unsupported').lspHealth;
  assert.equal(noSdk.formatter.status, 'unsupported');
  assert.equal(noSdk.diagnostics.available, false);
});
test('plugin keeps HTTP, network, and timeout failures out of client output', async t => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const oldUrl = process.env.AGENTDASHBOARD_URL;
  const oldToken = process.env.AGENTDASHBOARD_TOKEN;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (oldUrl === undefined) delete process.env.AGENTDASHBOARD_URL;
    else process.env.AGENTDASHBOARD_URL = oldUrl;
    if (oldToken === undefined) delete process.env.AGENTDASHBOARD_TOKEN;
    else process.env.AGENTDASHBOARD_TOKEN = oldToken;
  });
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317';
  process.env.AGENTDASHBOARD_TOKEN = 'secret-token-that-must-not-be-logged';

  const cases = [401, 403, 400, 413, 500, 503, 'network', 'timeout'];
  for (const failure of cases) {
    const warnings = [];
    console.warn = message => warnings.push(message);
    globalThis.fetch = async () => {
      if (failure === 'network') throw new TypeError('private network details');
      if (failure === 'timeout') {
        const error = new Error('private timeout details'); error.name = 'TimeoutError'; throw error;
      }
      return new Response('private response body', { status: failure });
    };
    const plugin = await AgentDashboardPlugin({ directory: '/tmp' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(warnings, [], `${failure} should not print plugin diagnostics`);
    await plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } });
  }
});
test('plugin backs off repeated failures and recovers on retry without client output', async t => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const old = Object.fromEntries(['AGENTDASHBOARD_URL', 'AGENTDASHBOARD_TOKEN', 'XDG_CONFIG_HOME'].map(k => [k, process.env[k]]));
  const root = await mkdtemp(join(tmpdir(), 'supervisor-retry-'));
  t.after(async () => {
    globalThis.fetch = originalFetch; console.warn = originalWarn;
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  });
  process.env.AGENTDASHBOARD_URL = 'http://127.0.0.1:4317';
  process.env.AGENTDASHBOARD_TOKEN = 'test-token';
  process.env.XDG_CONFIG_HOME = root;
  let requests = 0, recovered = false;
  const warnings = [];
  console.warn = message => warnings.push(message);
  globalThis.fetch = async () => {
    requests++;
    return recovered ? new Response('', { status: 200 }) : new Response('', { status: 503 });
  };
  const plugin = await AgentDashboardPlugin({ directory: '/tmp' });
  t.after(() => plugin.event({ event: { type: 'server.instance.disposed', properties: { directory: '/tmp' } } }));
  for (let n = 0; n < 100 && requests < 2; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(requests >= 2 && requests <= 5, `unexpected retry count ${requests}`);
  assert.deepEqual(warnings, []);
  recovered = true;
  for (let n = 0; n < 100 && requests < 3; n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(requests >= 3, 'retry should recover after the endpoint becomes available');
  assert.deepEqual(warnings, []);
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
