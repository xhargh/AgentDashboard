import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from '../src/server.js';

const token = 'final-hardening-test-token-at-least-24';

function endpoint() {
  const server = createServer({ token });
  return async (path, init = {}) => {
    const request = Readable.from(init.body ? [Buffer.from(init.body)] : []);
    request.socket = { remoteAddress: '127.0.0.1' };
    request.url = new URL(path, 'http://localhost').pathname;
    request.method = init.method || 'GET';
    request.headers = { host: 'localhost', authorization: `Bearer ${token}`, ...init.headers };
    return new Promise(resolve => {
      let status = 200;
      const headers = {};
      const response = {
        setHeader: (key, value) => { headers[key.toLowerCase()] = value; },
        writeHead: (code, values = {}) => { status = code; Object.assign(headers, values); },
        end: body => resolve(new Response(body, { status, headers })),
      };
      server.emit('request', request, response);
    });
  };
}

function machineReport(machine) {
  return {
    instanceId: `instance-${machine}`,
    machineId: `machine-${machine}`,
    host: `workstation-${machine % 4}`,
    pid: machine + 1000,
    sessions: Array.from({ length: 64 }, (_, index) => ({
      id: `machine-${machine}-session-${index}`,
      ...(index ? { parentID: `machine-${machine}-session-${Math.floor((index - 1) / 4)}` } : {}),
      status: index % 9 === 0 ? 'waiting' : 'busy',
      title: 'private-title', directory: 'private-path', activity: 'private-tool',
      todos: [{ status: 'in_progress', content: 'private-task' }],
    })),
  };
}

function statusOnly(report) {
  return {
    instanceId: report.instanceId, machineId: report.machineId, host: report.host, pid: report.pid,
    sessions: report.sessions.map(({ id, parentID, status }) => ({ id, ...(parentID ? { parentID } : {}), status })),
  };
}

test('sustained multi-machine nested workload recovers across outage/restart within resource and privacy bounds', async () => {
  const machines = Array.from({ length: 8 }, (_, index) => statusOnly(machineReport(index)));
  const serialized = machines.map(report => JSON.stringify(report));
  const reportBytes = serialized.reduce((total, value) => total + Buffer.byteLength(value), 0);
  assert.ok(reportBytes < 200_000, `per-round network budget exceeded: ${reportBytes} bytes`);

  let send = endpoint();
  const baseline = process.memoryUsage().heapUsed;
  let totalBytesSent = 0, totalStateBytes = 0;
  let lastState;
  for (let round = 0; round < 10; round++) {
    for (let machine = 0; machine < machines.length; machine++) {
      const body = serialized[machine];
      totalBytesSent += Buffer.byteLength(body);
      const response = await send('/api/report', { method: 'POST', body });
      assert.equal(response.status, 200);
    }
    const response = await send('/api/state');
    assert.equal(response.status, 200);
    const body = await response.text();
    totalStateBytes += Buffer.byteLength(body);
    lastState = JSON.parse(body);
    assert.equal(lastState.instances.length, 8);
    assert.equal(lastState.instances.reduce((sum, item) => sum + item.sessions.length, 0), 512);
    assert.equal(lastState.instances.filter(item => item.online).length, 8);
  }

  const revision = lastState.revision;
  const unchanged = await send('/api/report', { method: 'POST', body: serialized[0] });
  assert.equal(unchanged.status, 200);
  const unchangedState = await send('/api/state', { headers: { 'if-none-match': `"${revision}"` } });
  assert.equal(unchangedState.status, 304);
  const changedReport = structuredClone(machines[0]);
  changedReport.sessions[0].status = 'error';
  assert.equal((await send('/api/report', { method: 'POST', body: JSON.stringify(changedReport) })).status, 200);
  const changedState = await (await send('/api/state')).json();
  assert.equal(changedState.revision, revision + 1);
  assert.equal(changedState.instances[0].sessions.length, 64);

  // An outage loses queued requests; an agent heartbeat repopulates the restarted in-memory companion.
  send = async () => { throw new Error('simulated network outage'); };
  await assert.rejects(send('/api/report', { method: 'POST', body: serialized[0] }), /simulated network outage/);
  send = endpoint();
  for (let machine = 0; machine < machines.length; machine++) {
    const body = serialized[machine];
    totalBytesSent += Buffer.byteLength(body);
    assert.equal((await send('/api/report', { method: 'POST', body })).status, 200);
  }
  const recovered = await (await send('/api/state')).json();
  assert.equal(recovered.instances.length, 8);
  assert.equal(recovered.instances.reduce((sum, item) => sum + item.sessions.length, 0), 512);
  assert.ok(recovered.revision > 0);

  // Status-only reports contain no optional user or filesystem metadata, including under sustained traffic.
  const stateText = JSON.stringify(recovered);
  assert.doesNotMatch(stateText, /private-title|private-path|private-task|private-tool/);
  assert.ok(totalBytesSent < 3_000_000, `total request network budget exceeded: ${totalBytesSent} bytes`);
  const stateBytes = Buffer.byteLength(stateText);
  assert.ok(stateBytes < 1_000_000, `retained state response exceeded 1 MB: ${stateBytes} bytes`);
  assert.ok(totalStateBytes < 5_000_000, `state polling network budget exceeded: ${totalStateBytes} bytes`);
  const heapGrowth = process.memoryUsage().heapUsed - baseline;
  assert.ok(heapGrowth < 64 * 1024 * 1024, `heap grew by ${heapGrowth} bytes during bounded workload`);
});

test('retains a maximum-size metrics report within the body budget without ETag churn', async () => {
  const send = endpoint();
  const value = {
    instanceId: 'metrics-fleet', host: 'metrics-host', sessions: Array.from({ length: 1000 }, (_, index) => ({
      id: `session-${index}`, status: 'busy', parentID: index ? 'session-0' : undefined,
      model: { providerID: 'provider-id', providerName: 'Friendly Provider', modelID: 'model-id', name: 'Friendly Model', variant: 'reasoning-high', contextLimit: 200000 },
      usage: { input: 90000, output: 10000, reasoning: 1000, cacheRead: 3000, cacheWrite: 250, contextEstimate: 93000, partial: false },
    })),
  };
  const body = JSON.stringify(value);
  assert.ok(Buffer.byteLength(body) < 1024 * 1024);
  assert.equal((await send('/api/report', { method: 'POST', body })).status, 200);
  const snapshot = await send('/api/state');
  assert.equal(snapshot.status, 200);
  const state = await snapshot.json();
  assert.equal(state.instances[0].sessions.length, 1000);
  assert.equal(state.instances[0].sessions[999].usage.contextEstimate, 93000);
  assert.equal((await send('/api/report', { method: 'POST', body })).status, 200);
  assert.equal((await send('/api/state', { headers: { 'if-none-match': snapshot.headers.get('etag') } })).status, 304);
});
