import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSession, markActivity, markState } from './session-lifecycle.js';
import { createActivityBuffer } from './activity-events.js';
import { buildExecutionTimeline } from './execution-timeline.js';
const exec = promisify(execFile);

const TELEMETRY_CATEGORIES = ['titles', 'tasks', 'toolActivity', 'paths', 'git', 'modelMetrics', 'permissionDetails', 'mcpHealth'];
const MAX_USAGE_MESSAGES = 100;
const USAGE_KEYS = [['input', 'input'], ['output', 'output'], ['reasoning', 'reasoning'], ['cacheRead', 'cache', 'read'], ['cacheWrite', 'cache', 'write']];
const permissionTitles = {
  read: 'Read files', write: 'Write files', edit: 'Edit files', bash: 'Run command', webfetch: 'Access web',
  external_directory: 'Access external directory', doom_loop: 'Continue loop', task: 'Launch subtask',
};
function permissionType(value) {
  if (typeof value !== 'string') return 'unknown';
  const type = value.trim().toLowerCase().replace(/[ -]/g, '_');
  return Object.hasOwn(permissionTitles, type) ? type : 'unknown';
}
function suppliedTimestamp(value) {
  const date = Number.isFinite(value) ? new Date(value) : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? { timestamp: date.toISOString(), timestampSource: 'source' } : undefined;
}
function permissionResolution(value) {
  const reply = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (['once', 'always', 'allow', 'approved', 'granted'].includes(reply)) return 'approved';
  if (['reject', 'deny', 'denied'].includes(reply)) return 'rejected';
  return 'unknown';
}
function messageUsage(info) {
  const tokens = info.tokens;
  if (!tokens || typeof tokens !== 'object') return undefined;
  const usage = {};
  for (const [name, key, nested] of USAGE_KEYS) {
    const value = nested ? tokens[key]?.[nested] : tokens[key];
    if (Number.isSafeInteger(value) && value >= 0) usage[name] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}
function updateUsage(session, info) {
  const messageId = info.id;
  const snapshot = messageUsage(info);
  if (!messageId || !snapshot) return;
  session.usageMessages ||= new Map();
  const previous = session.usageMessages.get(messageId) || {};
  session.usageMessages.delete(messageId);
  session.usageMessages.set(messageId, { ...previous, ...snapshot });
  while (session.usageMessages.size > MAX_USAGE_MESSAGES) {
    session.usageMessages.delete(session.usageMessages.keys().next().value);
    session.usageTruncated = true;
  }
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  for (const message of session.usageMessages.values()) for (const key of Object.keys(totals)) {
    totals[key] = Math.min(Number.MAX_SAFE_INTEGER, totals[key] + (message[key] || 0));
  }
  session.usage = { ...totals, partial: Boolean(session.usageTruncated) };
  const timestamp = Number(info.time?.created) || Number(info.time?.completed) || 0;
  if (!session.latestUsage || timestamp >= session.latestUsage.timestamp) {
    const latest = session.usageMessages.get(messageId);
    session.latestUsage = { timestamp, input: latest.input, cacheRead: latest.cacheRead };
    if (timestamp > 0 && Number.isFinite(timestamp)) session.contextEstimateAt = new Date(timestamp).toISOString();
    if (Number.isSafeInteger(session.model?.contextLimit)) {
      const occupied = [session.latestUsage.input, session.latestUsage.cacheRead].filter(Number.isSafeInteger);
      if (occupied.length) session.usage.contextEstimate = occupied.reduce((sum, value) => sum + value, 0);
    }
  }
}
function safeRetrySnapshot(status) {
  const retry = {};
  if (Number.isSafeInteger(status?.attempt) && status.attempt >= 0 && status.attempt <= 1_000_000) retry.attempt = status.attempt;
  const deadline = status?.nextRetryAt;
  const timestamp = Number.isFinite(deadline) ? new Date(deadline).toISOString()
    : typeof deadline === 'string' && Number.isFinite(Date.parse(deadline)) ? new Date(deadline).toISOString() : undefined;
  if (timestamp) retry.nextRetryAt = timestamp;
  return Object.keys(retry).length ? retry : undefined;
}
function safeErrorCategory(error) {
  const source = typeof error === 'string' ? error : [error?.name, error?.type, error?.code].filter(value => typeof value === 'string').join(' ');
  const normalized = source.toLowerCase();
  if (/timeout|timed.?out|etimedout/.test(normalized)) return 'timeout';
  if (/permission|denied|unauthor/.test(normalized)) return 'permission';
  if (/abort|cancel/.test(normalized)) return 'cancelled';
  if (/rate.?limit|quota|429/.test(normalized)) return 'rate-limit';
  if (/provider|model|api/.test(normalized)) return 'provider';
  if (/tool/.test(normalized)) return 'tool';
  return 'unknown';
}
function safeFilePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value) ? value : undefined;
}
function lineCount(change, names) {
  for (const name of names) if (Number.isSafeInteger(change?.[name]) && change[name] >= 0) return change[name];
  return undefined;
}
function safeMcpName(value) {
  if (typeof value !== 'string' || value.length > 80 || /[\/:@\\]|\b(token|secret|password|credential|authorization|api[_-]?key)\b/i.test(value)) return 'MCP server';
  return /^[A-Za-z0-9_. -]{1,80}$/.test(value) ? value : 'MCP server';
}
function mcpState(value) {
  const raw = typeof value === 'string' ? value : value?.status ?? value?.state ?? value?.connectionState;
  if (raw === true) return 'connected';
  if (raw === false) return 'disconnected';
  if (typeof raw !== 'string') return 'unknown';
  const state = raw.trim().toLowerCase();
  if (/auth|unauthor|credential/.test(state)) return 'auth-required';
  if (/disconnect|offline/.test(state)) return 'disconnected';
  if (/connect|ready|online/.test(state)) return 'connected';
  if (/fail|error/.test(state)) return 'failed';
  return 'unknown';
}
function safeMcpTransitionTime(value) {
  const result = suppliedTimestamp(value);
  return result?.timestamp;
}
function normalizeMcpHealth(response, now = new Date().toISOString()) {
  const raw = response?.data ?? response;
  const values = Array.isArray(raw) ? raw.map(item => [item?.name, item])
    : Array.isArray(raw?.servers) ? raw.servers.map(item => [item?.name, item])
      : raw?.servers && typeof raw.servers === 'object' ? Object.entries(raw.servers)
        : raw && typeof raw === 'object' ? Object.entries(raw) : [];
  const servers = values.slice(0, 100).map(([name, value]) => {
    const lastTransitionAt = safeMcpTransitionTime(value?.lastTransitionAt ?? value?.updatedAt);
    return { name: safeMcpName(name), state: mcpState(value), ...(lastTransitionAt ? { lastTransitionAt } : {}) };
  });
  return { available: true, status: 'available', observedAt: now, servers, partial: values.length > servers.length };
}
function telemetryConfig(value = process.env.AGENTDASHBOARD_TELEMETRY) {
  if (value === undefined || value === '') return Object.fromEntries(TELEMETRY_CATEGORIES.map(category => [category, true]));
  let config;
  try { config = JSON.parse(value); } catch { throw new Error('AGENTDASHBOARD_TELEMETRY must be valid JSON'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('AGENTDASHBOARD_TELEMETRY must be an object');
  if (config.profile !== undefined && config.profile !== 'status-only') throw new Error('Unknown telemetry profile');
  for (const key of Object.keys(config)) {
  if (key !== 'profile' && !TELEMETRY_CATEGORIES.includes(key)) throw new Error(`Unknown telemetry category: ${key}`);
    if (key !== 'profile' && typeof config[key] !== 'boolean') throw new Error(`Telemetry category ${key} must be boolean`);
  }
  const categories = config.profile === 'status-only'
    ? Object.fromEntries(TELEMETRY_CATEGORIES.map(category => [category, false]))
    : Object.fromEntries(TELEMETRY_CATEGORIES.map(category => [category, config[category] ?? true]));
  // Git snapshots contain paths (root, filenames, and worktree locations).
  if (!categories.paths) categories.git = false;
  return categories;
}
function privateReport({ instanceId, machineId, generationStartedAt, host, pid, directory, worktree, sessions, git, events, eventsPartial, timeline, unassignedFileCount, unassignedFileChangesPartial, mcpHealth }, privacy) {
  const report = { instanceId, machineId, generationStartedAt, host, pid, sessions: sessions.map(session => {
    const result = { id: session.id, status: session.status };
    if (session.parentID) result.parentID = session.parentID;
    if (privacy.titles && session.title) result.title = session.title;
    if (privacy.paths && session.directory) result.directory = session.directory;
    if (privacy.toolActivity && session.activity) result.activity = session.activity;
    if (privacy.toolActivity && session.agent) result.agent = session.agent;
    if (privacy.tasks && session.todos) result.todos = session.todos;
    if (privacy.modelMetrics && session.model) result.model = session.model;
    if (privacy.modelMetrics && session.usage) result.usage = session.usage;
    if (privacy.modelMetrics) {
      if (session.lastCompactedAt) result.lastCompactedAt = session.lastCompactedAt;
      if (session.contextEstimateAt) result.contextEstimateAt = session.contextEstimateAt;
      if (session.compactionCount) result.compactionCount = session.compactionCount;
    }
    if (session.retry) result.retry = session.retry;
    if (session.errorCategory) result.errorCategory = session.errorCategory;
    if (privacy.permissionDetails && session.permissions?.length) result.permissions = session.permissions;
    for (const key of ['firstObservedAt', 'lastActivityAt', 'stateChangedAt']) if (session[key] !== undefined) result[key] = session[key];
    if (session.restored) result.restored = true;
    return result;
  }) };
  if (events?.length) report.events = events.filter(event =>
    (event.kind !== 'toolActivity' || privacy.toolActivity) &&
    (!['modelSnapshot', 'compaction'].includes(event.kind) || privacy.modelMetrics)).map(event => {
    const result = { ...event };
    if (result.attributes) {
      const attributes = { ...result.attributes };
      if (!privacy.toolActivity) { delete attributes.toolName; delete attributes.delegationId; delete result.toolCallId; delete result.messageId; }
      if (!privacy.modelMetrics) { delete attributes.providerId; delete attributes.modelId; delete attributes.variant; }
      if (!privacy.permissionDetails) { delete attributes.permissionType; delete attributes.permissionTitle; delete attributes.permissionId; }
      if (!privacy.paths) delete attributes.path;
      if (Object.keys(attributes).length) result.attributes = attributes;
      else delete result.attributes;
    } else if (!privacy.toolActivity) { delete result.toolCallId; delete result.messageId; }
    return result;
  });
  if (timeline) report.timeline = timeline;
  if (eventsPartial) report.eventsPartial = true;
  if (unassignedFileCount) report.unassignedFileCount = unassignedFileCount;
  if (unassignedFileChangesPartial) report.unassignedFileChangesPartial = true;
  if (privacy.mcpHealth && mcpHealth) report.mcpHealth = mcpHealth;
  if (privacy.paths) { report.directory = directory; report.worktree = worktree; }
  if (privacy.git) report.git = git;
  return report;
}

async function git(cwd, args) {
  const { stdout } = await exec('git', ['--no-optional-locks', '-C', cwd, ...args], {
    timeout: 4000, maxBuffer: 256 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trimEnd();
}
async function inspectGit(cwd) {
  try {
    const root = await git(cwd, ['rev-parse', '--show-toplevel']);
    const results = await Promise.allSettled([
      git(cwd, ['status', '--short', '--branch']),
      git(cwd, ['log', '-12', '--date=iso-strict', '--format=%h %ad %s']),
      git(cwd, ['worktree', 'list', '--porcelain']),
    ]);
    return { root, ...Object.fromEntries(['status', 'log', 'worktrees'].map((k, i) => [k,
      results[i].status === 'fulfilled' ? results[i].value : `Unavailable: ${results[i].reason.message.slice(0, 200)}`])) };
  } catch { return { unavailable: 'Not a Git repository, Git unavailable, or repository inaccessible' }; }
}

async function machineId() {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const directory = join(config, 'agentdashboard');
  const path = join(directory, 'machine-id');
  const legacyPath = join(config, 'opencode-supervisor', 'machine-id');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    const legacyId = (await readFile(legacyPath, 'utf8')).trim();
    if (legacyId) {
      try { await open(path, 'wx', 0o600).then(async file => { try { await file.writeFile(legacyId); } finally { await file.close(); } }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      return (await readFile(path, 'utf8')).trim();
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const id = randomUUID();
  const temporary = join(directory, `.machine-id-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(id);
    await file.close();
    await link(temporary, path);
    return id;
  } catch (error) {
    try { await file.close(); } catch {}
    if (error.code !== 'EEXIST') throw error;
    return (await readFile(path, 'utf8')).trim();
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60000;
export function retryDelay(failures, random = Math.random) {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 16));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export const AgentDashboardPlugin = async ({ directory, worktree, client }) => {
  let privacy;
  try { privacy = telemetryConfig(); } catch { return {}; }
  let endpoint;
  try { endpoint = new URL(process.env.AGENTDASHBOARD_URL || 'http://127.0.0.1:4317'); } catch { return {}; }
  const token = process.env.AGENTDASHBOARD_TOKEN;
  // Without a secret, telemetry must never leave this computer.
  if (!['http:', 'https:'].includes(endpoint.protocol)) return {};
  if (!token) {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) return {};
    if (endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
  }
  const instanceId = randomUUID();
  const generationStartedAt = Date.now();
  const machine = await machineId();
  const sessions = new Map();
  const unassignedFileKeys = new Set();
  let unassignedFileChangesPartial = false;
  let providerModelsPromise;
  const loadProviderModels = () => {
    if (providerModelsPromise) return providerModelsPromise;
    providerModelsPromise = (async () => {
      try {
      const response = await Promise.race([client.config.providers(), new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 1500); timer.unref?.();
      })]);
      const providers = response?.data?.providers || response?.providers || [];
      const providerModels = new Map();
      for (const provider of providers) for (const [id, model] of Object.entries(provider.models || {})) {
        providerModels.set(`${provider.id}:${id}`, { providerName: provider.name, name: model.name, contextLimit: model.limit?.context });
      }
      return providerModels;
      } catch { return undefined; }
    })();
    return providerModelsPromise;
  };
  const activityEvents = createActivityBuffer({ instanceId });
  let gitInfo = {}, lastGit = 0, sending = false, stopped = false, dirty = false, eventTimer;
  let retryTimer, failures = 0, nextAttempt = 0;
  let mcpHealth, lastMcpAttempt = 0, mcpInFlight = false;
  const session = id => {
    if (!sessions.has(id)) sessions.set(id, createSession(id, { title: 'Untitled session', directory, status: 'idle', activity: 'Ready' }));
    return sessions.get(id);
  };
  const info = (value, { restored = false } = {}) => {
    if (!value?.id) return;
    if (!sessions.has(value.id)) sessions.set(value.id, createSession(value.id, {
      title: value.title || 'Untitled session', parentID: value.parentID, directory: value.directory || directory,
      status: 'idle', activity: 'Ready',
    }, { restored }));
    else Object.assign(session(value.id), { title: value.title || 'Untitled session', parentID: value.parentID,
      directory: value.directory || directory });
  };
  const recordObserved = (value, kind, context = {}, timestamp) => activityEvents.record(value.id, kind, timestamp, {
    parentSessionId: value.parentID, ...context,
  });
  const refreshMcpHealth = (force = false) => {
    if (!privacy.mcpHealth || stopped || mcpInFlight || Date.now() - lastMcpAttempt < (force ? 1000 : 60000)) return;
    lastMcpAttempt = Date.now();
    if (typeof client?.mcp?.status !== 'function') {
      if (!mcpHealth) { mcpHealth = { available: false, status: 'unsupported', observedAt: new Date().toISOString(), servers: [] }; scheduleReport(); }
      return;
    }
    mcpInFlight = true;
    Promise.race([Promise.resolve().then(() => client.mcp.status()), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 1500); timer.unref?.();
    })]).then(response => { mcpHealth = normalizeMcpHealth(response); })
      .catch(() => { mcpHealth = { available: false, status: 'unavailable', observedAt: new Date().toISOString(), servers: [] }; })
      .finally(() => { mcpInFlight = false; scheduleReport(); });
  };
  const updatePermissionRequest = (s, permission, updated = false) => {
    const idValue = permission?.id || permission?.permissionID || permission?.permissionId;
    const id = typeof idValue === 'string' && idValue.length <= 200 ? idValue : undefined;
    const type = permissionType(permission?.type ?? permission?.permission);
    const sourceTime = suppliedTimestamp(permission?.time?.created ?? permission?.createdAt ?? permission?.timestamp);
    const requestedAt = sourceTime?.timestamp || new Date().toISOString();
    const current = s.permissions || [];
    let index = id ? current.findIndex(item => item.id === id) : -1;
    if (index < 0 && (!id || updated)) {
      const candidates = current.map((item, position) => ({ item, position })).filter(({ item }) => item.status === 'pending' && item.type === type && (!id || item.id === id));
      if (candidates.length === 1) index = candidates[0].position;
    }
    const previous = index >= 0 ? current[index] : undefined;
    const request = {
      ...(id ? { id } : {}), type, title: permissionTitles[type] || 'Permission details unavailable',
      requestedAt: previous?.requestedAt || requestedAt,
      timestampSource: previous?.timestampSource || sourceTime?.timestampSource || 'observed',
      status: 'pending',
    };
    if (previous && JSON.stringify(previous) === JSON.stringify(request)) return false;
    const next = [...current];
    if (index >= 0) next[index] = request;
    else next.push(request);
    s.permissions = next.slice(-50);
    recordObserved(s, 'waiting', {
      eventId: `permission:${s.id}:${id || type}:${type}:${request.requestedAt}:asked`,
      attributes: { ...(id ? { permissionId: id } : {}), permissionType: type, permissionTitle: request.title },
    }, request.requestedAt);
    return true;
  };
  const recordFileChange = (s, change, changeType, snapshotId) => {
    const path = safeFilePath(typeof change === 'string' ? change : change?.file || change?.path || change?.filename);
    if (!path) return;
    const fileKey = createHash('sha256').update(path).digest('hex');
    const additions = lineCount(change, ['additions', 'linesAdded', 'added']);
    const deletions = lineCount(change, ['deletions', 'linesRemoved', 'removed']);
    const eventId = `file:${s.id}:${changeType}:${snapshotId || ''}:${fileKey}:${additions ?? ''}:${deletions ?? ''}`;
    recordObserved(s, 'fileChange', {
      phase: 'files', eventId,
      attributes: { fileKey, ...(privacy.paths ? { path } : {}), ...(additions !== undefined ? { additions } : {}),
        ...(deletions !== undefined ? { deletions } : {}), changeType, ...(snapshotId ? { snapshotId } : {}) },
    });
    return fileKey;
  };
  const resolvePermissionRequest = (s, permission) => {
    const idValue = permission?.id || permission?.permissionID || permission?.permissionId;
    const id = typeof idValue === 'string' && idValue.length <= 200 ? idValue : undefined;
    const pending = (s.permissions || []).map((item, index) => ({ item, index })).filter(({ item }) => item.status === 'pending');
    const match = id ? pending.find(({ item }) => item.id === id)
      : pending.length === 1 ? pending[0] : undefined;
    if (!match) return false;
    const reply = permission?.reply ?? permission?.decision ?? permission?.response;
    const resolution = permissionResolution(reply);
    s.permissions = [...s.permissions];
    s.permissions[match.index] = { ...match.item, status: 'responded', resolution };
    recordObserved(s, 'permissionAnswered', {
      eventId: `permission:${s.id}:${id || match.item.type}:${match.item.requestedAt}:replied:${resolution}`,
      attributes: { ...(match.item.id ? { permissionId: match.item.id } : {}), permissionType: match.item.type,
        permissionTitle: match.item.title },
    });
    return true;
  };
  async function send() {
    if (stopped) return;
    if (sending) { dirty = true; return; }
    if (Date.now() < nextAttempt) return;
    sending = true;
    let succeeded = false;
    try {
      if (privacy.git && Date.now() - lastGit > 10000) { gitInfo = await inspectGit(directory); lastGit = Date.now(); }
      const response = await fetch(new URL('/api/report', endpoint), {
        method: 'POST', redirect: 'error', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
        body: JSON.stringify(privateReport({ instanceId, machineId: machine, generationStartedAt, host: process.env.AGENTDASHBOARD_HOST || hostname(), pid: process.pid,
          directory, worktree, sessions: [...sessions.values()], git: gitInfo, events: activityEvents.snapshot(),
          timeline: buildExecutionTimeline(activityEvents.snapshot(), [...sessions.values()], activityEvents.truncated),
          eventsPartial: activityEvents.truncated,
          unassignedFileCount: unassignedFileKeys.size, unassignedFileChangesPartial, mcpHealth }, privacy)), signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
      succeeded = true;
    } catch (error) {
      // Monitoring outages do not interrupt agent execution. Next heartbeat retries.
    }
    finally {
      sending = false;
      if (succeeded) { failures = 0; nextAttempt = 0; clearTimeout(retryTimer); retryTimer = undefined; }
      else {
        failures++;
        const delay = retryDelay(failures);
        nextAttempt = Date.now() + delay;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { retryTimer = undefined; void send(); }, delay);
        retryTimer.unref?.();
      }
      if (dirty && !stopped) { dirty = false; if (succeeded) scheduleReport(); }
    }
  }
  function scheduleReport() {
    if (eventTimer || stopped) return;
    const delay = Math.max(250, nextAttempt - Date.now());
    eventTimer = setTimeout(() => { eventTimer = undefined; void send(); }, delay);
    eventTimer.unref?.();
  }
  // Seed existing sessions, including restored sessions and children.
  try {
    const listed = await Promise.race([client.session.list({ query: { directory } }),
      new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 2000); t.unref?.(); })]);
    for (const value of listed.data || []) if (value.directory === directory) info(value, { restored: true });
    const statuses = await Promise.race([client.session.status({ query: { directory } }),
      new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 2000); t.unref?.(); })]);
    for (const [id, status] of Object.entries(statuses.data || {})) if (sessions.has(id)) session(id).status = status.type;
  } catch { /* Events still populate the dashboard when SDK discovery is unavailable. */ }
  void send();
  void refreshMcpHealth();
  const timer = setInterval(() => void send(), 5000); timer.unref?.();
  const mcpTimer = setInterval(() => refreshMcpHealth(), 60000); mcpTimer.unref?.();
  return {
    event: async ({ event }) => {
      const p = event.properties || {};
      if (event.type === 'server.instance.disposed' && p.directory === directory) { stopped = true; clearInterval(timer); clearInterval(mcpTimer); clearTimeout(eventTimer); clearTimeout(retryTimer); return; }
      if (event.type.startsWith('mcp.')) refreshMcpHealth(true);
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const existed = sessions.has(p.info?.id);
        if (event.type === 'session.created' && p.info?.id && !p.info.parentID) {
          const sessionDirectory = p.info.directory || directory;
          for (const [id, existing] of sessions) {
            if (id !== p.info.id && !existing.parentID && existing.directory === sessionDirectory) sessions.delete(id);
          }
        }
        info(p.info);
        if (event.type === 'session.created' && !existed) {
          const sourceTime = suppliedTimestamp(p.info?.time?.created ?? p.info?.createdAt);
          const delegationId = p.info?.delegationID || p.info?.parentCallID;
          recordObserved(session(p.info.id), 'created', {
            timestampSource: sourceTime?.timestampSource || 'observed',
            ...(typeof delegationId === 'string' && delegationId.length <= 200 ? { attributes: { delegationId } } : {}),
          }, sourceTime?.timestamp);
        }
      }
      if (event.type === 'session.deleted') {
        const deleted = sessions.get(p.info?.id) || { id: p.info?.id };
        const sourceTime = suppliedTimestamp(p.info?.time?.deleted ?? p.info?.deletedAt);
        recordObserved(deleted, 'deleted', { timestampSource: sourceTime?.timestampSource || 'observed' }, sourceTime?.timestamp);
        sessions.delete(p.info?.id);
      }
      if (p.sessionID) {
        const s = session(p.sessionID);
        if (event.type === 'session.status') {
          const status = p.status?.type;
          const changed = markState(s, status);
          if (status === 'retry') {
            let retry = safeRetrySnapshot(p.status);
            if (Number.isSafeInteger(s.retry?.attempt) && Number.isSafeInteger(retry?.attempt) && retry.attempt < s.retry.attempt) retry = s.retry;
            const retryChanged = JSON.stringify(s.retry) !== JSON.stringify(retry);
            if (changed || retryChanged) {
              s.retry = retry;
              recordObserved(s, 'retry', { attributes: retry, eventId: `retry:${s.id}:${retry?.attempt ?? 'unknown'}:${retry?.nextRetryAt ?? 'unknown'}` });
            }
          } else {
            if (changed) recordObserved(s, status);
            delete s.retry;
            if (status === 'error') s.errorCategory ||= 'unknown';
            else delete s.errorCategory;
          }
          if (s.status === 'idle') s.activity = 'Ready';
        }
        if (event.type === 'session.idle') { if (markState(s, 'idle')) recordObserved(s, 'idle'); delete s.retry; delete s.errorCategory; s.activity = 'Ready'; }
        if (event.type === 'session.error') {
          const category = safeErrorCategory(p.error);
          const changed = markState(s, 'error'), categoryChanged = category !== s.errorCategory;
          if (changed || categoryChanged) recordObserved(s, 'error', { attributes: { errorCategory: category }, eventId: `error:${s.id}:${category}` });
          s.errorCategory = category; delete s.retry; s.activity = 'Session error'; markActivity(s);
        }
        if (event.type === 'session.compacted') {
          const observedAt = Date.now();
          const sourceTime = suppliedTimestamp(p.time?.created ?? p.timestamp);
          const sourceId = p.id || p.compactionID || p.compactionId;
          const sourceKey = typeof sourceId === 'string' && sourceId.length <= 200 ? sourceId : sourceTime?.timestamp;
          if (sourceKey) {
            s.compactionEventIds ||= new Set();
            if (s.compactionEventIds.has(sourceKey)) return;
            s.compactionEventIds.add(sourceKey);
            while (s.compactionEventIds.size > 1000) s.compactionEventIds.delete(s.compactionEventIds.values().next().value);
          }
          if (!sourceTime && Number.isFinite(s.lastCompactionObservedAt) && observedAt - s.lastCompactionObservedAt < 1000) return;
          s.lastCompactionObservedAt = observedAt;
          const timestamp = sourceTime?.timestamp || new Date(observedAt).toISOString();
          if (!s.lastCompactedAt || Date.parse(timestamp) >= Date.parse(s.lastCompactedAt)) s.lastCompactedAt = timestamp;
          s.compactionCount = Math.min(1_000_000, (s.compactionCount || 0) + 1);
          recordObserved(s, 'compaction', { phase: 'model', timestampSource: sourceTime ? 'source' : 'observed',
            eventId: typeof sourceId === 'string' && sourceId.length <= 200 ? `compaction:${s.id}:${sourceId}` : `compaction:${s.id}:${timestamp}` }, timestamp);
          markActivity(s);
        }
        if (event.type === 'permission.asked' || event.type === 'permission.updated') {
          markState(s, 'waiting'); updatePermissionRequest(s, p); delete s.retry; delete s.errorCategory;
          s.activity = 'Waiting for permission'; markActivity(s);
        }
        if (event.type === 'permission.replied') {
          const matched = resolvePermissionRequest(s, p);
          const pendingPermission = s.permissions?.some(permission => permission.status === 'pending');
          if (!pendingPermission && markState(s, 'busy') && !matched) recordObserved(s, 'permissionAnswered');
          delete s.retry; delete s.errorCategory;
          s.activity = pendingPermission ? 'Waiting for permission' : 'Permission answered'; markActivity(s);
        }
        if (event.type === 'todo.updated') { s.todos = p.todos?.map(t => ({ content: t.content, status: t.status })); markActivity(s); }
        if (event.type === 'file.edited') recordFileChange(s, p.file || p.path || p, 'incremental');
        if (event.type === 'session.diff') {
          const changes = Array.isArray(p.diff) ? p.diff : Array.isArray(p.diffs) ? p.diffs : [];
          if (changes.length > 500) activityEvents.markTruncated();
          const boundedChanges = changes.slice(0, 500);
          const snapshots = boundedChanges.map(change => {
            const path = safeFilePath(change?.file || change?.path || change?.filename);
            if (!path) return undefined;
            return { fileKey: createHash('sha256').update(path).digest('hex'),
              additions: lineCount(change, ['additions', 'linesAdded', 'added']),
              deletions: lineCount(change, ['deletions', 'linesRemoved', 'removed']) };
          }).filter(Boolean);
          const snapshotId = createHash('sha256').update(JSON.stringify(snapshots)).digest('hex');
          recordObserved(s, 'fileChange', { phase: 'files', eventId: `file-snapshot:${s.id}:${snapshotId}`,
            attributes: { fileKey: '__snapshot__', changeType: 'snapshot', snapshotId } });
          for (const change of boundedChanges) recordFileChange(s, change, 'snapshot', snapshotId);
        }
      }
      if ((event.type === 'file.edited' || event.type === 'file.watcher.updated') && !p.sessionID) {
        const path = safeFilePath(p.file || p.path);
        if (path) {
          const fileKey = createHash('sha256').update(path).digest('hex');
          if (unassignedFileKeys.has(fileKey) || unassignedFileKeys.size < 10000) unassignedFileKeys.add(fileKey);
          else unassignedFileChangesPartial = true;
        }
      }
      if (event.type === 'message.updated' && p.info?.sessionID) {
        const s = session(p.info.sessionID); s.agent = p.info.agent || p.info.mode || s.agent;
        if (p.info.path?.cwd) s.directory = p.info.path.cwd;
        if (p.info.role === 'assistant' && typeof p.info.providerID === 'string' && typeof p.info.modelID === 'string') {
          const model = { providerID: p.info.providerID.slice(0, 200), modelID: p.info.modelID.slice(0, 200) };
          if (typeof p.info.variant === 'string') model.variant = p.info.variant.slice(0, 200);
          s.model = model;
          if (typeof p.info.id === 'string' && p.info.id.length <= 200) {
            const modelTime = suppliedTimestamp(p.info.time?.created ?? p.info.time?.completed);
            recordObserved(s, 'modelSnapshot', {
              phase: 'model', messageId: p.info.id, timestampSource: modelTime?.timestampSource || 'observed',
              eventId: `model:${s.id}:${p.info.id}`,
              attributes: { providerId: model.providerID, modelId: model.modelID, ...(model.variant ? { variant: model.variant } : {}) },
            }, modelTime?.timestamp);
          }
          void loadProviderModels().then(models => {
            const configured = models?.get(`${model.providerID}:${model.modelID}`);
            if (!configured || s.model !== model) return;
            if (typeof configured.providerName === 'string') model.providerName = configured.providerName.slice(0, 200);
            if (typeof configured.name === 'string') model.name = configured.name.slice(0, 200);
            if (Number.isSafeInteger(configured.contextLimit) && configured.contextLimit >= 0) model.contextLimit = configured.contextLimit;
            if (Number.isSafeInteger(model.contextLimit) && s.latestUsage) {
              const occupied = [s.latestUsage.input, s.latestUsage.cacheRead].filter(Number.isSafeInteger);
              if (occupied.length) s.usage.contextEstimate = occupied.reduce((sum, value) => sum + value, 0);
            }
            scheduleReport();
          });
        }
        if (p.info.role === 'assistant') updateUsage(s, p.info);
        markActivity(s);
      }
      if (event.type === 'message.part.updated' && p.part?.type === 'tool') {
        const part = p.part, s = session(part.sessionID);
        s.activity = `${part.tool}: ${part.state.status}`; markActivity(s);
        const status = part.state.status;
        const outcome = status === 'pending' ? undefined : status === 'running' ? 'started'
          : status === 'completed' ? 'completed' : status === 'error' ? 'failure' : undefined;
        const partId = part.callID || part.id;
        const messageId = part.messageID || part.messageId;
        if (['pending', 'running', 'completed', 'error'].includes(status) && partId && messageId) {
          const timeValue = status === 'completed' || status === 'error'
            ? part.state.time?.end || part.state.time?.completed
            : part.state.time?.start;
          const timestamp = Number.isFinite(timeValue) ? new Date(timeValue).toISOString()
            : typeof timeValue === 'string' && Number.isFinite(Date.parse(timeValue)) ? new Date(timeValue).toISOString() : undefined;
          recordObserved(s, 'toolActivity', {
            phase: 'tool', outcome, messageId, toolCallId: partId,
            timestampSource: timestamp ? 'source' : 'observed',
            eventId: `tool:${s.id}:${messageId}:${partId}:${status}`,
            attributes: { toolName: part.tool, toolStatus: status },
          }, timestamp);
        }
      }
      // Bound historical memory; active sessions are retained preferentially.
      if (sessions.size > 500) for (const [id, s] of sessions) { if (s.status === 'idle') sessions.delete(id); if (sessions.size <= 500) break; }
      scheduleReport();
    },
    'tool.execute.before': async input => {
      const s = session(input.sessionID); if (markState(s, 'busy')) recordObserved(s, 'busy'); s.activity = 'Agent working'; markActivity(s); scheduleReport();
    },
  };
};
