import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const assets = new Map(await Promise.all(['index.html', 'app.js', 'session-state.js', 'style.css'].map(async name =>
  ['/' + (name === 'index.html' ? '' : name), { body: await readFile(new URL('../public/' + name, import.meta.url)),
    type: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }])));
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
const LIMITS = Object.freeze({ instances: 2000, sessionsPerReport: 1000, sessionsTotal: 20000,
  eventsPerReport: 200, eventsTotal: 10000, field: 4096, summary: 200, pruneInterval: 60000 });
function boundedString(value, max = LIMITS.field) { return typeof value === 'string' && value.length <= max; }
function validReport(v) {
  return v && typeof v.instanceId === 'string' && v.instanceId.length <= 100 &&
    (v.machineId === undefined || boundedString(v.machineId, 100)) && boundedString(v.host, 200) &&
    (v.generationStartedAt === undefined || Number.isFinite(v.generationStartedAt)) &&
    (v.pid === undefined || Number.isInteger(v.pid)) &&
    (v.directory === undefined || boundedString(v.directory)) &&
    Array.isArray(v.sessions) && v.sessions.length <= LIMITS.sessionsPerReport && v.sessions.every(s => s && boundedString(s.id, 200) &&
      boundedString(s.status, 40) && (s.title === undefined || boundedString(s.title)) && (s.directory === undefined || boundedString(s.directory)) &&
      (s.activity === undefined || boundedString(s.activity)) && (s.agent === undefined || boundedString(s.agent, 200)) &&
      (s.parentID === undefined || boundedString(s.parentID, 200)) && (s.todos === undefined || Array.isArray(s.todos) && s.todos.length <= 200 &&
        s.todos.every(todo => todo && boundedString(todo.content) && boundedString(todo.status, 40)))) &&
    (v.git === undefined || v.git && typeof v.git === 'object' && !Array.isArray(v.git) &&
      Object.entries(v.git).every(([key, value]) => boundedString(key, 100) && (typeof value !== 'string' || boundedString(value)))) &&
    (v.events === undefined || Array.isArray(v.events) && v.events.length <= LIMITS.eventsPerReport && v.events.every(e => e &&
      boundedString(e.sessionId, 200) && boundedString(e.timestamp, 40) && Number.isFinite(Date.parse(e.timestamp)) &&
      ['created','busy','idle','waiting','error','retry','permissionAnswered','deleted'].includes(e.kind) &&
      boundedString(e.summary, LIMITS.summary)));
}
export function createServer({ token, now = Date.now } = {}) {
  if (token && token.length < 24) throw new Error('SUPERVISOR_TOKEN must contain at least 24 characters');
  const instances = new Map();
  let revision = 0;
  let lastPrune = 0;
  const prune = (force = false) => {
    const time = now();
    if (!force && time - lastPrune < LIMITS.pruneInterval) return;
    lastPrune = time;
    for (const [key, v] of instances) if (time - v.lastSeen > 86400000) { instances.delete(key); revision++; }
  };
  const sessionCount = () => { let count = 0; for (const item of instances.values()) count += item.sessions.length; return count; };
  const evictForCapacity = incomingId => {
    while (instances.size >= LIMITS.instances || sessionCount() > LIMITS.sessionsTotal) {
      const candidates = [...instances.entries()].filter(([id]) => id !== incomingId);
      candidates.sort((a, b) => {
        const score = item => item.online && item.sessions.some(s => ['busy', 'retry', 'waiting'].includes(s.status)) ? 2 : item.online ? 1 : 0;
        return score(a[1]) - score(b[1]) || a[1].lastSeen - b[1].lastSeen;
      });
      if (!candidates.length) return false;
      instances.delete(candidates[0][0]); revision++;
    }
    return true;
  };
  return http.createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; }
    catch { return reply(400, { error: 'Invalid request URL' }); }
    if (!token) {
      // Check both the peer and Host: loopback binding alone does not stop DNS rebinding.
      const peer = req.socket?.remoteAddress;
      const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
      const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(req.headers.host || '');
      if (!localPeer || !localHost) return reply(403, { error: 'Local mode only accepts loopback connections and localhost addresses' });
    }
    if (path.startsWith('/api/')) {
      if (token && !equal(req.headers.authorization, `Bearer ${token}`)) return reply(401, { error: 'Invalid access token' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return reply(403, { error: 'Cross-origin request rejected' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return reply(403, { error: 'Cross-site request rejected' });
      prune();
      if (path === '/api/state' && req.method === 'GET') {
        const time = now();
        for (const instance of instances.values()) {
          const online = time - instance.lastSeen < 20000 && !instance.replaced;
          if (online !== instance.online) { instance.online = online; revision++; }
        }
        const etag = `"${revision}"`;
        res.setHeader('etag', etag);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { 'cache-control': 'no-store' }); return res.end(); }
        return reply(200, { revision, instances: [...instances.values()].map(v => ({ ...v })), serverTime: time, mode: token ? 'network' : 'local' });
      }
      if (path === '/api/report' && req.method === 'POST') {
        try {
          let size = 0, chunks = [];
          for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { reply(413, { error: 'Report exceeds 1 MiB' }); return; } chunks.push(chunk); }
          const v = JSON.parse(Buffer.concat(chunks).toString());
          if (!validReport(v)) return reply(400, { error: 'Invalid report' });
          if (!instances.has(v.instanceId) && !evictForCapacity(v.instanceId)) return reply(503, { error: 'Instance capacity is occupied by retained active sessions' });
          const seenAt = now();
          let supersededBy;
          if (v.machineId && Number.isInteger(v.pid)) {
            for (const [id, previous] of instances) {
              if (id === v.instanceId || previous.machineId !== v.machineId || previous.pid !== v.pid) continue;
              if (Number.isFinite(previous.generationStartedAt) && Number.isFinite(v.generationStartedAt) &&
                  previous.generationStartedAt > v.generationStartedAt) {
                supersededBy = previous.instanceId;
                continue;
              }
              if (!previous.replaced) {
                previous.online = false;
                previous.replaced = true;
                previous.replacedBy = v.instanceId;
                revision++;
              }
            }
          }
          const previous = instances.get(v.instanceId);
          const oldCount = previous ? previous.sessions.length : 0;
          if (sessionCount() - oldCount + v.sessions.length > LIMITS.sessionsTotal) {
            while (sessionCount() - oldCount + v.sessions.length > LIMITS.sessionsTotal) {
              const priority = item => item.online && item.sessions.some(s => ['busy', 'retry', 'waiting'].includes(s.status)) ? 2 : item.online ? 1 : 0;
              const candidates = [...instances.entries()].filter(([id]) => id !== v.instanceId)
                .sort((a, b) => priority(a[1]) - priority(b[1]) || a[1].lastSeen - b[1].lastSeen);
              if (!candidates.length) return reply(503, { error: 'Aggregate session limit reached' });
              instances.delete(candidates[0][0]); revision++;
            }
          }
          const online = previous ? now() - previous.lastSeen < 20000 : false;
          const replaced = Boolean(supersededBy || previous?.replaced);
          const meaningfulChange = !previous || JSON.stringify({ ...previous, lastSeen: undefined, online: undefined, replaced: undefined, replacedBy: undefined }) !== JSON.stringify(v);
          instances.set(v.instanceId, { ...v, ...(replaced ? { replaced: true, replacedBy: supersededBy || previous.replacedBy } : {}),
            lastSeen: replaced && previous ? previous.lastSeen : seenAt, online: !replaced });
          let eventCount = [...instances.values()].reduce((count, instance) => count + (instance.events?.length || 0), 0);
          if (eventCount > LIMITS.eventsTotal) {
            for (const instance of [...instances.values()].sort((a, b) => a.lastSeen - b.lastSeen)) {
              while (eventCount > LIMITS.eventsTotal && instance.events?.length) { instance.events.shift(); eventCount--; }
              if (eventCount <= LIMITS.eventsTotal) break;
            }
          }
          if (meaningfulChange || !replaced && !online) revision++;
          return reply(200, { ok: true });
        } catch { return reply(400, { error: 'Invalid JSON report' }); }
      }
      return reply(404, { error: 'Unknown endpoint' });
    }
    const asset = assets.get(path);
    if (req.method === 'GET' && asset) { res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' }); res.end(asset.body); }
    else reply(404, { error: 'Not found' });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const token = process.env.SUPERVISOR_TOKEN;
    const host = token ? (process.env.HOST || '0.0.0.0') : '127.0.0.1';
    const server = createServer({ token });
    server.requestTimeout = 10000;
    server.on('error', error => { console.error(`Companion failed: ${error.message}`); process.exitCode = 1; });
    server.listen(Number(process.env.PORT || 4317), host, () => console.log(`Supervisor ${token ? 'network (token required)' : 'local (no token)'} mode listening on ${host}:${process.env.PORT || 4317}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
