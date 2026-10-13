import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const publicAssets = ['index.html', 'app.js', 'session-state.js', 'style.css',
  'icons/icon.svg', 'icons/favicon.ico', 'icons/favicon-16x16.png', 'icons/favicon-32x32.png',
  'icons/apple-touch-icon.png', 'icons/site.webmanifest', 'icons/android-chrome-192x192.png',
  'icons/android-chrome-512x512.png'];
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.ico': 'image/vnd.microsoft.icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const assets = new Map(await Promise.all(publicAssets.map(async name =>
  ['/' + (name === 'index.html' ? '' : name), { body: await readFile(new URL('../public/' + name, import.meta.url)),
    type: mimeTypes[name.slice(name.lastIndexOf('.'))] }])));
function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
const LIMITS = Object.freeze({ instances: 2000, sessionsPerReport: 1000, sessionsTotal: 20000,
  eventsPerReport: 200, eventsPerInstance: 5000, eventsTotal: 10000, timelineIntervals: 5000, timelineIntervalsTotal: 5000,
  field: 4096, summary: 200, pruneInterval: 60000 });
function boundedString(value, max = LIMITS.field) { return typeof value === 'string' && value.length <= max; }
function validModel(model) {
  return model && typeof model === 'object' && !Array.isArray(model) &&
    boundedString(model.providerID, 200) && boundedString(model.modelID, 200) &&
    (model.variant === undefined || boundedString(model.variant, 200)) &&
    (model.providerName === undefined || boundedString(model.providerName, 200)) &&
    (model.name === undefined || boundedString(model.name, 200)) &&
    (model.contextLimit === undefined || Number.isSafeInteger(model.contextLimit) && model.contextLimit >= 0);
}
function validUsage(usage) {
  return usage && typeof usage === 'object' && !Array.isArray(usage) &&
    ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'contextEstimate'].every(key =>
      usage[key] === undefined || Number.isSafeInteger(usage[key]) && usage[key] >= 0) &&
    (usage.partial === undefined || typeof usage.partial === 'boolean');
}
function validTimestamp(value) { return value === null || boundedString(value, 40) && Number.isFinite(Date.parse(value)); }
function validObservabilityEvent(event, reportInstanceId) {
  if (!event || !boundedString(event.sessionId, 200) || !boundedString(event.timestamp, 40) || !Number.isFinite(Date.parse(event.timestamp)) ||
      !['created','busy','idle','waiting','error','retry','permissionAnswered','deleted','toolActivity','fileChange','modelSnapshot','compaction'].includes(event.kind) || !boundedString(event.summary, LIMITS.summary)) return false;
  if (event.schemaVersion === undefined) return true;
  const attributes = event.attributes;
  return event.schemaVersion === 1 && boundedString(event.id, 200) && boundedString(event.instanceId, 100) &&
    event.instanceId === reportInstanceId &&
    (event.timestampSource === undefined || ['source', 'observed'].includes(event.timestampSource)) &&
    (event.parentSessionId === undefined || boundedString(event.parentSessionId, 200)) &&
    (event.messageId === undefined || boundedString(event.messageId, 200)) &&
    (event.toolCallId === undefined || boundedString(event.toolCallId, 200)) &&
    ['lifecycle', 'working', 'idle', 'permission', 'error', 'retry', 'tool', 'files', 'model'].includes(event.phase) &&
    ['observed', 'inferred'].includes(event.source) &&
    (event.outcome === undefined || ['started', 'completed', 'failure', 'cancelled'].includes(event.outcome)) &&
    (attributes === undefined || attributes && typeof attributes === 'object' && !Array.isArray(attributes) &&
      Object.entries(attributes).every(([key, value]) => ['attempt', 'durationMs', 'toolName', 'toolStatus', 'providerId', 'modelId', 'variant', 'permissionType', 'permissionTitle', 'permissionId', 'nextRetryAt', 'errorCategory', 'fileKey', 'path', 'additions', 'deletions', 'changeType', 'snapshotId', 'delegationId'].includes(key) &&
        (boundedString(value, key === 'path' ? 4096 : ['providerId', 'modelId', 'variant', 'delegationId'].includes(key) ? 200 : 100) || Number.isSafeInteger(value) && value >= 0) &&
        (key !== 'toolStatus' || ['pending', 'running', 'completed', 'error'].includes(value)) &&
        (key !== 'errorCategory' || ['timeout', 'permission', 'cancelled', 'rate-limit', 'provider', 'tool', 'unknown'].includes(value)) &&
        (key !== 'permissionType' || ['read', 'write', 'edit', 'bash', 'webfetch', 'external_directory', 'doom_loop', 'task', 'unknown'].includes(value)) &&
        (key !== 'permissionTitle' || ['Read files', 'Write files', 'Edit files', 'Run command', 'Access web', 'Access external directory', 'Continue loop', 'Launch subtask', 'Permission details unavailable'].includes(value)) &&
        (key !== 'changeType' || ['snapshot', 'incremental', 'unassigned'].includes(value))));
}
function validTimeline(timeline) {
  return timeline && typeof timeline === 'object' && !Array.isArray(timeline) && typeof timeline.partial === 'boolean' &&
    Array.isArray(timeline.intervals) && timeline.intervals.length <= LIMITS.timelineIntervals && timeline.intervals.every(interval =>
      interval && boundedString(interval.sessionId, 200) && boundedString(interval.startAt, 40) && Number.isFinite(Date.parse(interval.startAt)) &&
      (interval.endAt === null || validTimestamp(interval.endAt)) &&
      ['busy', 'idle', 'waiting', 'error', 'retry'].includes(interval.status) &&
      (interval.endAt === null || Date.parse(interval.endAt) >= Date.parse(interval.startAt)));
}
function validWorkspaceService(service, states) {
  return service && typeof service === 'object' && !Array.isArray(service) && ['available', 'unsupported', 'unavailable'].includes(service.status) &&
    (service.observedAt === undefined || validTimestamp(service.observedAt)) &&
    (service.partial === undefined || typeof service.partial === 'boolean') &&
    Array.isArray(service.servers || service.formatters) && (service.servers || service.formatters).length <= 100 &&
    (service.servers || service.formatters).every(item => item && boundedString(item.name, 80) && states.includes(item.state) &&
      (item.lastTransitionAt === undefined || validTimestamp(item.lastTransitionAt)));
}
function validLspHealth(health) {
  if (!health || typeof health !== 'object' || Array.isArray(health) || !validTimestamp(health.observedAt) ||
      !validWorkspaceService(health.lsp, ['connected', 'disconnected', 'auth-required', 'failed', 'unknown']) ||
      !validWorkspaceService(health.formatter, ['available', 'unavailable', 'unknown'])) return false;
  const diagnostics = health.diagnostics;
  return diagnostics === undefined || diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics) &&
    typeof diagnostics.available === 'boolean' && ['errors', 'warnings', 'information', 'hints'].every(key =>
      diagnostics[key] === undefined || Number.isSafeInteger(diagnostics[key]) && diagnostics[key] >= 0) &&
    (diagnostics.observedAt === undefined || validTimestamp(diagnostics.observedAt)) &&
    (diagnostics.partial === undefined || typeof diagnostics.partial === 'boolean');
}
function validReport(v) {
  const eventsValid = !v || v.events === undefined || Array.isArray(v.events) && v.events.length <= LIMITS.eventsPerReport &&
    v.events.every(event => validObservabilityEvent(event, v.instanceId)) &&
    new Set(v.events.filter(event => event.schemaVersion !== undefined).map(event => event.id)).size === v.events.filter(event => event.schemaVersion !== undefined).length;
  return v && typeof v.instanceId === 'string' && v.instanceId.length <= 100 &&
    (v.eventsPartial === undefined || typeof v.eventsPartial === 'boolean') &&
    (v.unassignedFileChangesPartial === undefined || typeof v.unassignedFileChangesPartial === 'boolean') &&
    (v.machineId === undefined || boundedString(v.machineId, 100)) && boundedString(v.host, 200) &&
    (v.generationStartedAt === undefined || Number.isFinite(v.generationStartedAt)) &&
    (v.pid === undefined || Number.isInteger(v.pid)) &&
     (v.directory === undefined || boundedString(v.directory)) &&
     (v.unassignedFileCount === undefined || Number.isSafeInteger(v.unassignedFileCount) && v.unassignedFileCount >= 0 && v.unassignedFileCount <= 50000) &&
    Array.isArray(v.sessions) && v.sessions.length <= LIMITS.sessionsPerReport && v.sessions.every(s => s && boundedString(s.id, 200) &&
      boundedString(s.status, 40) && (s.title === undefined || boundedString(s.title)) && (s.directory === undefined || boundedString(s.directory)) &&
       (s.activity === undefined || boundedString(s.activity)) && (s.agent === undefined || boundedString(s.agent, 200)) &&
       (s.model === undefined || validModel(s.model)) && (s.usage === undefined || validUsage(s.usage)) &&
       (s.retry === undefined || s.retry && typeof s.retry === 'object' && !Array.isArray(s.retry) &&
         (s.retry.attempt === undefined || Number.isSafeInteger(s.retry.attempt) && s.retry.attempt >= 0) &&
         (s.retry.nextRetryAt === undefined || validTimestamp(s.retry.nextRetryAt))) &&
        (s.errorCategory === undefined || ['timeout', 'permission', 'cancelled', 'rate-limit', 'provider', 'tool', 'unknown'].includes(s.errorCategory)) &&
       ['lastCompactedAt', 'contextEstimateAt'].every(key => s[key] === undefined || validTimestamp(s[key])) &&
       (s.compactionCount === undefined || Number.isSafeInteger(s.compactionCount) && s.compactionCount >= 0) &&
       (s.permissions === undefined || Array.isArray(s.permissions) && s.permissions.length <= 50 && s.permissions.every(permission => permission &&
         (permission.id === undefined || boundedString(permission.id, 200)) &&
         (permission.type === undefined || ['read', 'write', 'edit', 'bash', 'webfetch', 'external_directory', 'doom_loop', 'task', 'unknown'].includes(permission.type)) &&
         (permission.title === undefined || ['Read files', 'Write files', 'Edit files', 'Run command', 'Access web', 'Access external directory', 'Continue loop', 'Launch subtask', 'Permission details unavailable'].includes(permission.title)) &&
         validTimestamp(permission.requestedAt) && ['pending', 'responded', 'ended', 'unknown'].includes(permission.status) &&
         (permission.timestampSource === undefined || ['source', 'observed'].includes(permission.timestampSource)) &&
         (permission.resolution === undefined || ['approved', 'rejected', 'unknown'].includes(permission.resolution)))) &&
       ['firstObservedAt', 'lastActivityAt', 'stateChangedAt'].every(key => s[key] === undefined || validTimestamp(s[key])) &&
       (s.restored === undefined || typeof s.restored === 'boolean') &&
      (s.parentID === undefined || boundedString(s.parentID, 200)) && (s.todos === undefined || Array.isArray(s.todos) && s.todos.length <= 200 &&
        s.todos.every(todo => todo && boundedString(todo.content) && boundedString(todo.status, 40)))) &&
     (v.git === undefined || v.git && typeof v.git === 'object' && !Array.isArray(v.git) &&
       Object.entries(v.git).every(([key, value]) => boundedString(key, 100) && (typeof value !== 'string' || boundedString(value)))) &&
     (v.mcpHealth === undefined || v.mcpHealth && typeof v.mcpHealth === 'object' && !Array.isArray(v.mcpHealth) &&
       typeof v.mcpHealth.available === 'boolean' && ['available', 'unsupported', 'unavailable'].includes(v.mcpHealth.status) &&
       validTimestamp(v.mcpHealth.observedAt) && (v.mcpHealth.partial === undefined || typeof v.mcpHealth.partial === 'boolean') &&
       Array.isArray(v.mcpHealth.servers) && v.mcpHealth.servers.length <= 100 && v.mcpHealth.servers.every(server => server &&
         boundedString(server.name, 80) && ['connected', 'disconnected', 'auth-required', 'failed', 'unknown'].includes(server.state) &&
         (server.lastTransitionAt === undefined || validTimestamp(server.lastTransitionAt)))) &&
     (v.lspHealth === undefined || validLspHealth(v.lspHealth)) &&
     eventsValid && (v.timeline === undefined || validTimeline(v.timeline));
}
export function createServer({ token, now = Date.now } = {}) {
  if (token && token.length < 24) throw new Error('AGENTDASHBOARD_TOKEN must contain at least 24 characters');
  const instances = new Map();
  let revision = 0;
  let lastPrune = 0;
  const prune = (force = false) => {
    const time = now();
    if (!force && time - lastPrune < LIMITS.pruneInterval) return;
    lastPrune = time;
    for (const [key, instance] of instances) {
      if (instance.replaced && time - instance.lastSeen > 86400000) { instances.delete(key); revision++; }
    }
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
  const mergeTimeline = (previous, incoming) => {
    if (!incoming) return previous && { ...previous, intervals: previous.intervals.map(interval => ({ ...interval })) };
    const byStart = new Map();
    for (const interval of previous?.intervals || []) byStart.set(`${interval.sessionId}\0${interval.startAt}\0${interval.status}`, { ...interval });
    for (const interval of incoming.intervals) {
      const key = `${interval.sessionId}\0${interval.startAt}\0${interval.status}`;
      const prior = byStart.get(key);
      byStart.set(key, { ...prior, ...interval, endAt: interval.endAt ?? prior?.endAt ?? null });
    }
    const incomingBySession = new Map();
    for (const interval of incoming.intervals) {
      if (!incomingBySession.has(interval.sessionId)) incomingBySession.set(interval.sessionId, []);
      incomingBySession.get(interval.sessionId).push(interval);
    }
    for (const intervals of incomingBySession.values()) intervals.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    for (const interval of byStart.values()) {
      if (interval.endAt !== null) continue;
      const next = (incomingBySession.get(interval.sessionId) || []).find(candidate =>
        Date.parse(candidate.startAt) > Date.parse(interval.startAt));
      if (next) interval.endAt = next.startAt;
    }
    const intervals = [...byStart.values()].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.sessionId.localeCompare(b.sessionId));
    let partial = Boolean(previous?.partial || incoming.partial);
    if (intervals.length > LIMITS.timelineIntervals) {
      intervals.splice(0, intervals.length - LIMITS.timelineIntervals);
      partial = true;
    }
    return { partial, intervals };
  };
  const mergeEvents = (previous, incoming, incomingPartial = false) => {
    const eventsById = new Map();
    for (const event of previous?.events || []) eventsById.set(event.id || JSON.stringify([event.sessionId, event.timestamp, event.kind]), event);
    for (const event of incoming || []) eventsById.set(event.id || JSON.stringify([event.sessionId, event.timestamp, event.kind]), event);
    const events = [...eventsById.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const partial = events.length > LIMITS.eventsPerInstance;
    if (partial) events.splice(0, events.length - LIMITS.eventsPerInstance);
    return { events, partial: Boolean(previous?.eventsPartial || incomingPartial || partial) };
  };
  const trimTimelineCapacity = () => {
    let count = [...instances.values()].reduce((sum, instance) => sum + (instance.timeline?.intervals.length || 0), 0);
    if (count <= LIMITS.timelineIntervalsTotal) return;
    const oldest = [...instances.values()].flatMap(instance => (instance.timeline?.intervals || [])
      .map(interval => ({ instance, interval })))
      .sort((a, b) => Date.parse(a.interval.startAt) - Date.parse(b.interval.startAt));
    for (const { instance, interval } of oldest) {
      if (count <= LIMITS.timelineIntervalsTotal) break;
      instance.timeline.intervals.splice(instance.timeline.intervals.indexOf(interval), 1);
      instance.timeline.partial = true;
      count--;
    }
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
          const timeline = mergeTimeline(previous?.timeline, v.timeline);
          const eventHistory = mergeEvents(previous, v.events, v.eventsPartial);
          const sessionsById = new Map(v.sessions.map(session => [session.id, session]));
          const timelineSessionIds = new Set((timeline?.intervals || []).map(interval => interval.sessionId));
          const deletedAt = new Map((v.events || []).filter(event => event.kind === 'deleted').map(event => [event.sessionId, event.timestamp]));
          let addedArchive = true;
          while (addedArchive) {
            addedArchive = false;
            for (const session of previous?.sessions || []) {
              if (!session.parentID || sessionsById.has(session.id) || !timelineSessionIds.has(session.id) || !sessionsById.has(session.parentID)) continue;
              sessionsById.set(session.id, { ...session, status: 'idle', activity: undefined,
                archived: true, ended: deletedAt.has(session.id) || Boolean(session.ended),
                archivedAt: session.archivedAt ?? previous.lastSeen,
                ...(session.permissions ? { permissions: session.permissions.map(permission => permission.status === 'pending'
                  ? { ...permission, status: 'ended' } : permission) } : {}) });
              const endedAt = Date.parse(deletedAt.get(session.id));
              if (Number.isFinite(endedAt)) for (const interval of timeline?.intervals || []) {
                if (interval.sessionId === session.id && interval.endAt === null && endedAt >= Date.parse(interval.startAt)) {
                  interval.endAt = deletedAt.get(session.id);
                }
              }
              else if (timeline) timeline.partial = true;
              addedArchive = true;
            }
          }
          const sessions = [...sessionsById.values()];
          const oldCount = previous ? previous.sessions.length : 0;
          if (sessionCount() - oldCount + sessions.length > LIMITS.sessionsTotal) {
            while (sessionCount() - oldCount + sessions.length > LIMITS.sessionsTotal) {
              const priority = item => item.online && item.sessions.some(s => ['busy', 'retry', 'waiting'].includes(s.status)) ? 2 : item.online ? 1 : 0;
              const candidates = [...instances.entries()].filter(([id]) => id !== v.instanceId)
                .sort((a, b) => priority(a[1]) - priority(b[1]) || a[1].lastSeen - b[1].lastSeen);
              if (!candidates.length) return reply(503, { error: 'Aggregate session limit reached' });
              instances.delete(candidates[0][0]); revision++;
            }
          }
          const online = previous ? now() - previous.lastSeen < 20000 : false;
          const replaced = Boolean(supersededBy || previous?.replaced);
          const report = { ...v, sessions, ...(timeline ? { timeline } : {}),
            ...(eventHistory.events.length ? { events: eventHistory.events } : {}), ...(eventHistory.partial ? { eventsPartial: true } : {}) };
          const meaningfulChange = !previous || JSON.stringify({ ...previous, lastSeen: undefined, online: undefined, replaced: undefined, replacedBy: undefined }) !== JSON.stringify(report);
          instances.set(v.instanceId, { ...report, ...(replaced ? { replaced: true, replacedBy: supersededBy || previous.replacedBy } : {}),
            lastSeen: replaced && previous ? previous.lastSeen : seenAt, online: !replaced });
          trimTimelineCapacity();
          let eventCount = [...instances.values()].reduce((count, instance) => count + (instance.events?.length || 0), 0);
          if (eventCount > LIMITS.eventsTotal) {
            for (const instance of [...instances.values()].sort((a, b) => a.lastSeen - b.lastSeen)) {
              while (eventCount > LIMITS.eventsTotal && instance.events?.length) { instance.events.shift(); instance.eventsPartial = true; eventCount--; }
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
    const token = process.env.AGENTDASHBOARD_TOKEN;
    const configuredHost = process.env.AGENTDASHBOARD_HOST;
    const configuredPort = process.env.AGENTDASHBOARD_PORT;
    const host = token ? (configuredHost || '0.0.0.0') : '127.0.0.1';
    const server = createServer({ token });
    server.requestTimeout = 10000;
    server.on('error', error => { console.error(`Companion failed: ${error.message}`); process.exitCode = 1; });
    server.listen(Number(configuredPort || 4317), host, () => console.log(`AgentDashboard ${token ? 'network (token required)' : 'local (no token)'} mode listening on ${host}:${configuredPort || 4317}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
