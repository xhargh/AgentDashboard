import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSession, markActivity, markState } from './session-lifecycle.js';
const exec = promisify(execFile);

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

export const SupervisorPlugin = async ({ directory, worktree, client }) => {
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
  const sessions = new Map();
  let gitInfo = {}, lastGit = 0, sending = false, stopped = false, dirty = false, eventTimer;
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
    sending = true;
    try {
      if (Date.now() - lastGit > 10000) { gitInfo = await inspectGit(directory); lastGit = Date.now(); }
      const response = await fetch(new URL('/api/report', endpoint), {
        method: 'POST', redirect: 'error', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId, host: process.env.OPENCODE_SUPERVISOR_HOST || hostname(), pid: process.pid,
          directory, worktree, sessions: [...sessions.values()], git: gitInfo }), signal: AbortSignal.timeout(3000),
      });
      await response.body?.cancel();
    } catch { /* Monitoring outages do not interrupt agent execution. Next heartbeat retries. */ }
    finally { sending = false; if (dirty && !stopped) { dirty = false; void send(); } }
  }
  function scheduleReport() {
    if (eventTimer || stopped) return;
    eventTimer = setTimeout(() => { eventTimer = undefined; void send(); }, 250);
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
      if (event.type === 'server.instance.disposed' && p.directory === directory) { stopped = true; clearInterval(timer); clearTimeout(eventTimer); return; }
      if (event.type === 'session.created' || event.type === 'session.updated') info(p.info);
      if (event.type === 'session.deleted') sessions.delete(p.info?.id);
      if (p.sessionID) {
        const s = session(p.sessionID);
        if (event.type === 'session.status') { markState(s, p.status.type); if (s.status === 'idle') s.activity = 'Ready'; }
        if (event.type === 'session.idle') { markState(s, 'idle'); s.activity = 'Ready'; }
        if (event.type === 'session.error') { markState(s, 'error'); s.activity = p.error?.data?.message || 'Session error'; markActivity(s); }
        if (event.type === 'permission.asked' || event.type === 'permission.updated') { markState(s, 'waiting'); s.activity = 'Waiting for permission'; markActivity(s); }
        if (event.type === 'permission.replied') { markState(s, 'busy'); s.activity = 'Permission answered'; markActivity(s); }
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
      const s = session(input.sessionID); markState(s, 'busy'); s.activity = `Running ${input.tool}`; markActivity(s); scheduleReport();
    },
  };
};
