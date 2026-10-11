import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSession, markActivity, markState } from './session-lifecycle.js';
import { createActivityBuffer } from './activity-events.js';
const exec = promisify(execFile);

const TELEMETRY_CATEGORIES = ['titles', 'tasks', 'toolActivity', 'paths', 'git'];
function telemetryConfig(value = process.env.OPENCODE_SUPERVISOR_TELEMETRY) {
  if (value === undefined || value === '') return Object.fromEntries(TELEMETRY_CATEGORIES.map(category => [category, true]));
  let config;
  try { config = JSON.parse(value); } catch { throw new Error('OPENCODE_SUPERVISOR_TELEMETRY must be valid JSON'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('OPENCODE_SUPERVISOR_TELEMETRY must be an object');
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
function privateReport({ instanceId, machineId, generationStartedAt, host, pid, directory, worktree, sessions, git, events }, privacy) {
  const report = { instanceId, machineId, generationStartedAt, host, pid, sessions: sessions.map(session => {
    const result = { id: session.id, status: session.status };
    if (session.parentID) result.parentID = session.parentID;
    if (privacy.titles && session.title) result.title = session.title;
    if (privacy.paths && session.directory) result.directory = session.directory;
    if (privacy.toolActivity && session.activity) result.activity = session.activity;
    if (privacy.toolActivity && session.agent) result.agent = session.agent;
    if (privacy.tasks && session.todos) result.todos = session.todos;
    return result;
  }) };
  if (events?.length) report.events = events;
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

function reportFailure(response) {
  const status = response.status;
  if (status === 401 || status === 403) return `authentication (HTTP ${status})`;
  if (status === 400 || status === 413) return `rejected report (HTTP ${status})`;
  if (status >= 500 && status <= 599) return `server failure (HTTP ${status})`;
  return `HTTP failure (${status})`;
}
function transportFailure(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError'
    ? 'timeout' : 'network failure';
}
async function machineId() {
  const directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode-supervisor');
  const path = join(directory, 'machine-id');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
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
function reportWarning(category) {
  // Deliberately omit request/response bodies, credentials, and error messages.
  console.warn(`[AgentDashboard] Telemetry report failed: ${category}`);
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60000;
const DIAGNOSTIC_INTERVAL_MS = 30000;
export function retryDelay(failures, random = Math.random) {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 16));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export const SupervisorPlugin = async ({ directory, worktree, client }) => {
  let privacy;
  try { privacy = telemetryConfig(); } catch (error) { console.warn(`[AgentDashboard] ${error.message}`); return {}; }
  let endpoint;
  try { endpoint = new URL(process.env.OPENCODE_SUPERVISOR_URL || 'http://127.0.0.1:4317'); } catch { return {}; }
  const token = process.env.OPENCODE_SUPERVISOR_TOKEN;
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
  const activityEvents = createActivityBuffer();
  let gitInfo = {}, lastGit = 0, sending = false, stopped = false, dirty = false, eventTimer;
  let retryTimer, failures = 0, nextAttempt = 0, lastDiagnostic = 0;
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
        body: JSON.stringify(privateReport({ instanceId, machineId: machine, generationStartedAt, host: process.env.OPENCODE_SUPERVISOR_HOST || hostname(), pid: process.pid,
          directory, worktree, sessions: [...sessions.values()], git: gitInfo, events: activityEvents.snapshot() }, privacy)), signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        noteFailure(reportFailure(response));
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
      succeeded = true;
    } catch (error) {
      try { noteFailure(transportFailure(error)); } catch { /* Diagnostics must not affect agent execution. */ }
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
  function noteFailure(category) {
    const now = Date.now();
    if (now - lastDiagnostic < DIAGNOSTIC_INTERVAL_MS) return;
    lastDiagnostic = now;
    try { reportWarning(category); } catch { /* Diagnostics must not affect agent execution. */ }
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
        const existed = sessions.has(p.info?.id); info(p.info);
        if (event.type === 'session.created' && !existed) activityEvents.record(p.info.id, 'created');
      }
      if (event.type === 'session.deleted') { activityEvents.record(p.info?.id, 'deleted'); sessions.delete(p.info?.id); }
      if (p.sessionID) {
        const s = session(p.sessionID);
        if (event.type === 'session.status') { const changed = markState(s, p.status.type); if (changed) activityEvents.record(s.id, p.status.type); if (s.status === 'idle') s.activity = 'Ready'; }
        if (event.type === 'session.idle') { if (markState(s, 'idle')) activityEvents.record(s.id, 'idle'); s.activity = 'Ready'; }
        if (event.type === 'session.error') { if (markState(s, 'error')) activityEvents.record(s.id, 'error'); s.activity = 'Session error'; markActivity(s); }
        if (event.type === 'permission.asked' || event.type === 'permission.updated') { if (markState(s, 'waiting')) activityEvents.record(s.id, 'waiting'); s.activity = 'Waiting for permission'; markActivity(s); }
        if (event.type === 'permission.replied') { if (markState(s, 'busy')) activityEvents.record(s.id, 'permissionAnswered'); s.activity = 'Permission answered'; markActivity(s); }
        if (event.type === 'todo.updated') { s.todos = p.todos?.map(t => ({ content: t.content, status: t.status })); markActivity(s); }
      }
      if (event.type === 'message.updated' && p.info?.sessionID) {
        const s = session(p.info.sessionID); s.agent = p.info.agent || p.info.mode || s.agent;
        if (p.info.path?.cwd) s.directory = p.info.path.cwd;
        markActivity(s);
      }
      if (event.type === 'message.part.updated' && p.part?.type === 'tool') {
        const part = p.part, s = session(part.sessionID);
        s.activity = `${part.tool}: ${part.state.title || part.state.status}`; markActivity(s);
      }
      // Bound historical memory; active sessions are retained preferentially.
      if (sessions.size > 500) for (const [id, s] of sessions) { if (s.status === 'idle') sessions.delete(id); if (sessions.size <= 500) break; }
      scheduleReport();
    },
    'tool.execute.before': async input => {
      const s = session(input.sessionID); if (markState(s, 'busy')) activityEvents.record(s.id, 'busy'); s.activity = 'Agent working'; markActivity(s); scheduleReport();
    },
  };
};
