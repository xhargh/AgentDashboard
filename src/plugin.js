import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSession, markActivity, markState } from './session-lifecycle.js';
import { createActivityBuffer } from './activity-events.js';
import { buildExecutionTimeline } from './execution-timeline.js';
const exec = promisify(execFile);

const TELEMETRY_CATEGORIES = ['titles', 'tasks', 'toolActivity', 'paths', 'git', 'modelMetrics'];
const MAX_USAGE_MESSAGES = 100;
const USAGE_KEYS = [['input', 'input'], ['output', 'output'], ['reasoning', 'reasoning'], ['cacheRead', 'cache', 'read'], ['cacheWrite', 'cache', 'write']];
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
    if (Number.isSafeInteger(session.model?.contextLimit)) {
      const occupied = [session.latestUsage.input, session.latestUsage.cacheRead].filter(Number.isSafeInteger);
      if (occupied.length) session.usage.contextEstimate = occupied.reduce((sum, value) => sum + value, 0);
    }
  }
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
function privateReport({ instanceId, machineId, generationStartedAt, host, pid, directory, worktree, sessions, git, events, timeline }, privacy) {
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
    for (const key of ['firstObservedAt', 'lastActivityAt', 'stateChangedAt']) if (session[key] !== undefined) result[key] = session[key];
    if (session.restored) result.restored = true;
    return result;
  }) };
  if (events?.length) report.events = events.filter(event => event.kind !== 'toolActivity' || privacy.toolActivity).map(event => {
    const result = { ...event };
    if (result.attributes) {
      const attributes = { ...result.attributes };
      if (!privacy.toolActivity) { delete attributes.toolName; delete result.toolCallId; delete result.messageId; }
      if (!privacy.modelMetrics) { delete attributes.providerId; delete attributes.modelId; }
      if (Object.keys(attributes).length) result.attributes = attributes;
      else delete result.attributes;
    } else if (!privacy.toolActivity) { delete result.toolCallId; delete result.messageId; }
    return result;
  });
  if (timeline) report.timeline = timeline;
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
          timeline: buildExecutionTimeline(activityEvents.snapshot(), [...sessions.values()], activityEvents.truncated) }, privacy)), signal: AbortSignal.timeout(3000),
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
  const timer = setInterval(() => void send(), 5000); timer.unref?.();
  return {
    event: async ({ event }) => {
      const p = event.properties || {};
      if (event.type === 'server.instance.disposed' && p.directory === directory) { stopped = true; clearInterval(timer); clearTimeout(eventTimer); clearTimeout(retryTimer); return; }
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const existed = sessions.has(p.info?.id);
        if (event.type === 'session.created' && p.info?.id && !p.info.parentID) {
          const sessionDirectory = p.info.directory || directory;
          for (const [id, existing] of sessions) {
            if (id !== p.info.id && !existing.parentID && existing.directory === sessionDirectory) sessions.delete(id);
          }
        }
        info(p.info);
        if (event.type === 'session.created' && !existed) recordObserved(session(p.info.id), 'created');
      }
      if (event.type === 'session.deleted') {
        const deleted = sessions.get(p.info?.id) || { id: p.info?.id };
        recordObserved(deleted, 'deleted'); sessions.delete(p.info?.id);
      }
      if (p.sessionID) {
        const s = session(p.sessionID);
        if (event.type === 'session.status') { const changed = markState(s, p.status.type); if (changed) recordObserved(s, p.status.type); if (s.status === 'idle') s.activity = 'Ready'; }
        if (event.type === 'session.idle') { if (markState(s, 'idle')) recordObserved(s, 'idle'); s.activity = 'Ready'; }
        if (event.type === 'session.error') { if (markState(s, 'error')) recordObserved(s, 'error'); s.activity = 'Session error'; markActivity(s); }
        if (event.type === 'permission.asked' || event.type === 'permission.updated') { if (markState(s, 'waiting')) recordObserved(s, 'waiting'); s.activity = 'Waiting for permission'; markActivity(s); }
        if (event.type === 'permission.replied') { if (markState(s, 'busy')) recordObserved(s, 'permissionAnswered'); s.activity = 'Permission answered'; markActivity(s); }
        if (event.type === 'todo.updated') { s.todos = p.todos?.map(t => ({ content: t.content, status: t.status })); markActivity(s); }
      }
      if (event.type === 'message.updated' && p.info?.sessionID) {
        const s = session(p.info.sessionID); s.agent = p.info.agent || p.info.mode || s.agent;
        if (p.info.path?.cwd) s.directory = p.info.path.cwd;
        if (p.info.role === 'assistant' && typeof p.info.providerID === 'string' && typeof p.info.modelID === 'string') {
          const model = { providerID: p.info.providerID.slice(0, 200), modelID: p.info.modelID.slice(0, 200) };
          if (typeof p.info.variant === 'string') model.variant = p.info.variant.slice(0, 200);
          s.model = model;
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
        if (outcome && partId && messageId) {
          const timeValue = status === 'completed' || status === 'error'
            ? part.state.time?.end || part.state.time?.completed
            : part.state.time?.start;
          const timestamp = Number.isFinite(timeValue) ? new Date(timeValue).toISOString()
            : typeof timeValue === 'string' && Number.isFinite(Date.parse(timeValue)) ? new Date(timeValue).toISOString() : undefined;
          recordObserved(s, 'toolActivity', {
            phase: 'tool', outcome, messageId, toolCallId: partId,
            eventId: `tool:${s.id}:${messageId}:${partId}:${status}`,
            attributes: { toolName: part.tool },
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
