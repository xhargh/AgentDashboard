import { isFinishedSubagentHidden, sessionState } from './session-state.js';
const $ = id => document.getElementById(id);
let token = '', instances = [], revision = null, pending = false, authRequired = false;
const active = s => ['busy', 'retry', 'waiting'].includes(s.status);
const machineKey = i => i.machineId || `legacy:${i.host}`;
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
function render() {
  const online = instances.filter(i => i.online), sessions = online.flatMap(i => i.sessions || []);
  $('metrics').replaceChildren(...[
    ['Computers online', new Set(online.map(machineKey)).size], ['OpenCode instances', online.length],
    ['Active agents', sessions.filter(s => !s.parentID && active(s)).length], ['Active subagents', sessions.filter(s => s.parentID && active(s)).length],
  ].map(([label, value]) => { const n = el('article', undefined, 'metric'); n.append(el('span', label), el('strong', value)); return n; }));
  const selected = $('host').value;
  const machines = new Map(instances.map(i => [machineKey(i), i]));
  $('host').replaceChildren(new Option('All computers', ''), ...[...machines].sort((a, b) => a[1].host.localeCompare(b[1].host)).map(([key, i]) =>
    new Option(instances.filter(other => other.host === i.host).length > 1 ? `${i.host} (${key.slice(0, 8)})` : i.host, key)));
  $('host').value = selected;
  const query = $('search').value.toLowerCase();
  const fleet = $('fleet'); fleet.replaceChildren();
  let hiddenOffline = 0;
  for (const i of instances.filter(i => !selected || machineKey(i) === selected).sort((a, b) => Number(b.online) - Number(a.online) || a.host.localeCompare(b.host))) {
    if ($('hide-offline').checked && !i.online) { hiddenOffline++; continue; }
    const instanceSessions = i.sessions || [];
    const hiddenFinished = $('hide-finished').checked ? instanceSessions.filter(s => isFinishedSubagentHidden(s)).length : 0;
    const visible = instanceSessions.filter(s => (!$('hide-finished').checked || !isFinishedSubagentHidden(s)) &&
      (!$('hide-waiting').checked || !i.online || s.parentID || s.status !== 'idle') &&
      (!$('active').checked || (i.online && active(s))) &&
      `${i.host} ${i.directory || ''} ${s.title || ''} ${s.directory || ''} ${s.activity || ''} ${s.agent || ''}`.toLowerCase().includes(query));
    if (!visible.length && ($('active').checked || query && !`${i.host} ${i.directory || ''}`.toLowerCase().includes(query))) continue;
    const card = el('article', undefined, 'instance');
    const head = el('div', undefined, 'instance-head'), title = el('div');
    const path = i.directory || 'Path hidden';
    title.append(el('h3', i.directory ? i.directory.split('/').filter(Boolean).at(-1) || i.directory : 'Monitored instance'), el('code', path));
    const meta = el('div', undefined, 'machine'); meta.append(el('strong', i.host), el('span', `${i.online ? '● Online' : '○ Offline'} · PID ${i.pid} · ${Math.max(0, Math.floor((Date.now() - i.lastSeen) / 1000))}s ago`, i.online ? 'online' : 'muted'));
    head.append(title, meta); card.append(head);
    for (const s of visible.sort((a, b) => (a.parentID || a.id).localeCompare(b.parentID || b.id) || Number(!!a.parentID) - Number(!!b.parentID))) {
      const display = sessionState(s, i.online);
      const row = el('div', undefined, `session ${s.parentID ? 'child' : ''}`), info = el('div');
      info.append(el('strong', `${s.parentID ? '↳ ' : ''}${s.title || 'Session'}`), el('p', i.online ? display.activity : `Last activity: ${s.activity || 'Unavailable'}`, 'activity'));
      if (s.directory) info.append(el('code', s.directory));
      if (s.parentID) info.append(el('p', `Subagent of ${i.sessions?.find(p => p.id === s.parentID)?.title || s.parentID}`, 'muted'));
      if (s.todos?.length) { const todos = el('ul', undefined, 'todos'); for (const t of s.todos) todos.append(el('li', `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'} ${t.content || ''}`)); info.append(todos); }
      const state = el('div', undefined, 'session-state'), badge = el('span', display.label, `badge ${display.className}`);
      badge.title = display.detail;
      state.append(badge, el('small', s.agent || (s.parentID ? 'subagent' : 'agent')));
      row.append(info, state); card.append(row);
    }
    if (hiddenFinished) card.append(el('p', `${hiddenFinished} finished subagent${hiddenFinished === 1 ? '' : 's'} hidden`, 'empty'));
    if (!visible.length && !hiddenFinished) card.append(el('p', instanceSessions.length ? 'No sessions match the current filters.' : i.online ? 'Connected. Waiting for session activity.' : 'Offline. No session activity recorded.', 'empty'));
    if (i.git?.root) {
      const details = el('details'); details.dataset.instance = i.instanceId; const summary = el('summary', 'Git workspace'); details.append(summary);
      const grid = el('div', undefined, 'git-grid');
      for (const [key, label] of [['status', 'Status'], ['log', 'Recent commits'], ['worktrees', 'Worktrees']]) {
        const block = el('section'); block.append(el('h4', label), el('pre', typeof i.git[key] === 'string' ? i.git[key] || 'Clean / empty' : 'Waiting for Git snapshot')); grid.append(block);
      }
      details.append(grid); card.append(details);
    }
    fleet.append(card);
  }
  if (!fleet.children.length) {
    const empty = el('div', undefined, 'empty');
    const hidden = hiddenOffline ? `${hiddenOffline} offline instance${hiddenOffline === 1 ? '' : 's'} hidden. ` : '';
    empty.append(el('h3', instances.length ? 'No matching agents' : 'Ready for your first agent'), el('p', instances.length ? `${hidden}Adjust the filters to see more activity.` : 'Install the plugin and start OpenCode. For other computers, configure the companion URL and token.'));
    fleet.append(empty);
  }
}
async function poll() {
  if ((authRequired && !token) || pending) return;
  pending = true;
  const usedToken = token;
  const open = new Set([...document.querySelectorAll('details[open]')].map(n => n.dataset.instance));
  try {
    const headers = usedToken ? { authorization: `Bearer ${usedToken}` } : {};
    if (revision !== null) headers['if-none-match'] = `"${revision}"`;
    const response = await fetch('/api/state', { headers, signal: AbortSignal.timeout(5000) });
    if (response.status === 401) {
      revision = null; authRequired = true; $('login').hidden = false; $('dashboard').hidden = true; $('logout').hidden = true;
      $('connection').textContent = 'Network mode · token required';
      $('error').textContent = usedToken ? 'Invalid access token' : '';
      token = ''; return;
    }
    if (response.status === 304) return;
    if (!response.ok) throw new Error(`Companion returned ${response.status}`);
    const data = await response.json(); if (token !== usedToken) return;
    authRequired = data.mode !== 'local';
    revision = data.revision; instances = data.instances; $('login').hidden = true; $('dashboard').hidden = false; $('logout').hidden = !authRequired;
    $('connection').textContent = authRequired ? '● Connected · network mode' : '● Connected · local only'; $('error').textContent = ''; render();
    document.querySelectorAll('details').forEach(n => n.open = open.has(n.dataset.instance));
  } catch (e) { revision = null; $('connection').textContent = '○ Disconnected · retrying'; $('error').textContent = e.message; if (!$('dashboard').hidden) { instances = instances.map(i => ({ ...i, online: false })); render(); } }
  finally { pending = false; }
}
$('login').addEventListener('submit', e => { e.preventDefault(); token = $('token').value.trim(); $('token').value = ''; void poll(); });
$('logout').onclick = () => { token = ''; revision = null; instances = []; $('dashboard').hidden = true; $('login').hidden = false; $('logout').hidden = true; $('connection').textContent = 'Disconnected'; };
for (const id of ['host', 'search', 'active', 'hide-finished', 'hide-waiting', 'hide-offline']) $(id).addEventListener('input', render);
void poll();
setInterval(poll, 2000);
