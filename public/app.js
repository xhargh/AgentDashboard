import { sessionState } from './session-state.js';
const $ = id => document.getElementById(id);
let token = '', instances = [], pending = false, authRequired = false;
const active = s => ['busy', 'retry', 'waiting'].includes(s.status);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
function render() {
  const online = instances.filter(i => i.online), sessions = online.flatMap(i => i.sessions);
  $('metrics').replaceChildren(...[
    ['Computers online', new Set(online.map(i => i.host)).size], ['OpenCode instances', online.length],
    ['Active agents', sessions.filter(s => !s.parentID && active(s)).length], ['Active subagents', sessions.filter(s => s.parentID && active(s)).length],
  ].map(([label, value]) => { const n = el('article', undefined, 'metric'); n.append(el('span', label), el('strong', value)); return n; }));
  const selected = $('host').value;
  $('host').replaceChildren(new Option('All computers', ''), ...[...new Set(instances.map(i => i.host))].sort().map(h => new Option(h, h)));
  $('host').value = selected;
  const query = $('search').value.toLowerCase();
  const fleet = $('fleet'); fleet.replaceChildren();
  for (const i of instances.filter(i => !selected || i.host === selected).sort((a, b) => Number(b.online) - Number(a.online) || a.host.localeCompare(b.host))) {
    const hiddenFinished = $('hide-finished').checked ? i.sessions.filter(s => s.parentID && s.status === 'idle').length : 0;
    const visible = i.sessions.filter(s => (!$('hide-finished').checked || !s.parentID || s.status !== 'idle') &&
      (!$('active').checked || (i.online && active(s))) &&
      `${i.host} ${i.directory} ${s.title} ${s.directory} ${s.activity} ${s.agent}`.toLowerCase().includes(query));
    if (!visible.length && ($('active').checked || query && !`${i.host} ${i.directory}`.toLowerCase().includes(query))) continue;
    const card = el('article', undefined, 'instance');
    const head = el('div', undefined, 'instance-head'), title = el('div');
    title.append(el('h3', i.directory.split('/').filter(Boolean).at(-1) || i.directory), el('code', i.directory));
    const meta = el('div', undefined, 'machine'); meta.append(el('strong', i.host), el('span', `${i.online ? '● Online' : '○ Offline'} · PID ${i.pid} · ${Math.max(0, Math.floor((Date.now() - i.lastSeen) / 1000))}s ago`, i.online ? 'online' : 'muted'));
    head.append(title, meta); card.append(head);
    for (const s of visible.sort((a, b) => (a.parentID || a.id).localeCompare(b.parentID || b.id) || Number(!!a.parentID) - Number(!!b.parentID))) {
      const display = sessionState(s, i.online);
      const row = el('div', undefined, `session ${s.parentID ? 'child' : ''}`), info = el('div');
      info.append(el('strong', `${s.parentID ? '↳ ' : ''}${s.title}`), el('p', i.online ? display.activity : `Last activity: ${s.activity || 'Ready'}`, 'activity'), el('code', s.directory));
      if (s.parentID) info.append(el('p', `Subagent of ${i.sessions.find(p => p.id === s.parentID)?.title || s.parentID}`, 'muted'));
      if (s.todos?.length) { const todos = el('ul', undefined, 'todos'); for (const t of s.todos) todos.append(el('li', `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'} ${t.content}`)); info.append(todos); }
      const state = el('div', undefined, 'session-state'), badge = el('span', display.label, `badge ${display.className}`);
      badge.title = display.detail;
      state.append(badge, el('small', s.agent || (s.parentID ? 'subagent' : 'agent')));
      row.append(info, state); card.append(row);
    }
    if (hiddenFinished) card.append(el('p', `${hiddenFinished} finished subagent${hiddenFinished === 1 ? '' : 's'} hidden`, 'empty'));
    if (!visible.length && !hiddenFinished) card.append(el('p', i.sessions.length ? 'No sessions match the current filters.' : i.online ? 'Connected. Waiting for session activity.' : 'Offline. No session activity recorded.', 'empty'));
    const details = el('details'); details.dataset.instance = i.instanceId; const summary = el('summary', 'Git workspace'); details.append(summary);
    if (i.git?.unavailable) details.append(el('p', i.git.unavailable, 'muted'));
    else { const grid = el('div', undefined, 'git-grid'); for (const [key, label] of [['status', 'Status'], ['log', 'Recent commits'], ['worktrees', 'Worktrees']]) { const block = el('section'); block.append(el('h4', label), el('pre', typeof i.git?.[key] === 'string' ? i.git[key] || 'Clean / empty' : 'Waiting for Git snapshot')); grid.append(block); } details.append(grid); }
    card.append(details); fleet.append(card);
  }
  if (!fleet.children.length) { const empty = el('div', undefined, 'empty'); empty.append(el('h3', instances.length ? 'No matching agents' : 'Ready for your first agent'), el('p', instances.length ? 'Adjust the filters to see more activity.' : 'Install the plugin and start OpenCode. For other computers, configure the companion URL and token.')); fleet.append(empty); }
}
async function poll() {
  if ((authRequired && !token) || pending) return;
  pending = true;
  const usedToken = token;
  const open = new Set([...document.querySelectorAll('details[open]')].map(n => n.dataset.instance));
  try {
    const response = await fetch('/api/state', { headers: usedToken ? { authorization: `Bearer ${usedToken}` } : {}, signal: AbortSignal.timeout(5000) });
    if (response.status === 401) {
      authRequired = true; $('login').hidden = false; $('dashboard').hidden = true; $('logout').hidden = true;
      $('connection').textContent = 'Network mode · token required';
      $('error').textContent = usedToken ? 'Invalid access token' : '';
      token = ''; return;
    }
    if (!response.ok) throw new Error(`Companion returned ${response.status}`);
    const data = await response.json(); if (token !== usedToken) return;
    authRequired = data.mode !== 'local';
    instances = data.instances; $('login').hidden = true; $('dashboard').hidden = false; $('logout').hidden = !authRequired;
    $('connection').textContent = authRequired ? '● Connected · network mode' : '● Connected · local only'; $('error').textContent = ''; render();
    document.querySelectorAll('details').forEach(n => n.open = open.has(n.dataset.instance));
  } catch (e) { $('connection').textContent = '○ Disconnected · retrying'; $('error').textContent = e.message; if (!$('dashboard').hidden) { instances = instances.map(i => ({ ...i, online: false })); render(); } }
  finally { pending = false; }
}
$('login').addEventListener('submit', e => { e.preventDefault(); token = $('token').value.trim(); $('token').value = ''; void poll(); });
$('logout').onclick = () => { token = ''; instances = []; $('dashboard').hidden = true; $('login').hidden = false; $('logout').hidden = true; $('connection').textContent = 'Disconnected'; };
for (const id of ['host', 'search', 'active', 'hide-finished']) $(id).addEventListener('input', render);
void poll();
setInterval(poll, 2000);
