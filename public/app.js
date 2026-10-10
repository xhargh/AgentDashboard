import { buildSessionTree, classifySessions, isActiveCategory, isFinishedSubagentHidden, sessionState } from './session-state.js';
const $ = id => document.getElementById(id);
let token = '', instances = [], revision = null, pending = false, authRequired = false;
const machineKey = i => i.machineId || `legacy:${i.host}`;
const expandedAgents = new Set();
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
function render() {
  const online = instances.filter(i => i.online);
  const sessionClassifications = new Map(instances.map(i => [i.instanceId, classifySessions(i.sessions, i.online)]));
  const classificationsFor = i => sessionClassifications.get(i.instanceId);
  const sessions = online.flatMap(i => i.sessions.map(s => ({ session: s, classification: classificationsFor(i).get(s.id) })));
  $('metrics').replaceChildren(...[
    ['Computers online', new Set(online.map(machineKey)).size], ['OpenCode instances', online.length],
    ['Active agents', sessions.filter(({ session, classification }) => !session.parentID && isActiveCategory(classification)).length],
    ['Active subagents', sessions.filter(({ session, classification }) => session.parentID && isActiveCategory(classification)).length],
  ].map(([label, value]) => { const n = el('article', undefined, 'metric'); n.append(el('span', label), el('strong', value)); return n; }));
  const selected = $('host').value;
  const machines = new Map(instances.map(i => [machineKey(i), i]));
  $('host').replaceChildren(new Option('All computers', ''), ...[...machines].sort((a, b) => a[1].host.localeCompare(b[1].host)).map(([key, i]) => new Option(i.host, key)));
  $('host').value = selected;
  const query = $('search').value.toLowerCase();
  const fleet = $('fleet'); fleet.replaceChildren();
  const groups = [
    ['needs-attention', 'Needs attention', 'Permission requests and errors', []],
    ['working', 'Working', 'Currently active sessions', []],
    ['waiting-for-input', 'Waiting for input', 'Idle main agents ready for your next message', []],
    ['recently-finished', 'Recently finished', 'Completed subagents available if recalled', []],
    ['offline', 'Offline', 'Instances no longer reporting', []],
  ];
  let hiddenOffline = 0;
  for (const i of instances.filter(i => !selected || machineKey(i) === selected).sort((a, b) => Number(b.online) - Number(a.online) || a.host.localeCompare(b.host))) {
    if ($('hide-offline').checked && !i.online) { hiddenOffline++; continue; }
    const eligible = new Set();
    for (const s of i.sessions) {
      const classification = classificationsFor(i).get(s.id);
      if ($('hide-offline').checked && !i.online) continue;
      if ($('hide-finished').checked && isFinishedSubagentHidden(s)) continue;
      if ($('hide-waiting').checked && i.online && !s.parentID && classification.category === 'waiting-for-input' && !classification.childAttentionCount) continue;
      if ($('active').checked && (!i.online || !isActiveCategory(classification))) continue;
      const context = `${i.host} ${i.directory} ${s.title} ${s.directory} ${s.activity} ${s.agent}`;
      if (!context.toLowerCase().includes(query)) continue;
      eligible.add(s.id);
    }
    function hasEligible(node) { return eligible.has(node.session.id) || node.children.some(hasEligible); }
    if (!i.online && i.sessions.length === 0) groups.find(([id]) => id === 'offline')[3].push({ i, instanceOnly: true });
    function appendNode(parent, node) {
      if (!hasEligible(node)) return;
      const { session: s, children } = node, classification = classificationsFor(i).get(s.id);
      const display = sessionState(s, i.online, classification), key = `${i.instanceId}:${s.id}`;
      const container = children.some(hasEligible) ? el('details', undefined, 'agent-tree') : el('div', undefined, 'agent-tree');
      container.dataset.agentKey = key;
      if (container.tagName === 'DETAILS') {
        container.open = expandedAgents.has(key);
        container.addEventListener('toggle', () => container.open ? expandedAgents.add(key) : expandedAgents.delete(key));
        const summary = el('summary', undefined, 'agent-tree-summary');
        summary.append(el('span', `${s.title || 'Session'} · ${display.label}`, 'tree-title'), el('span', `${children.length} child${children.length === 1 ? '' : 'ren'}`, 'tree-count'));
        if (classification.attentionRequired) summary.append(el('span', 'Attention in this branch', 'attention-summary'));
        container.append(summary);
      }
      const card = el('article', undefined, 'session-card');
      const row = el('div', undefined, `session ${s.parentID ? 'child' : ''}`), info = el('div');
       info.append(el('strong', s.title || 'Session'), el('p', `${i.host} · ${i.directory}`, 'muted'), el('p', i.online ? display.activity : `Last activity: ${s.activity || 'Ready'}`, 'activity'), el('code', s.directory));
      if (s.parentID) info.append(el('p', `Subagent of ${i.sessions.find(p => p.id === s.parentID)?.title || s.parentID}`, 'muted'));
      if (classification.childAttentionCount) info.append(el('p', `${classification.childAttentionCount} descendant session${classification.childAttentionCount === 1 ? '' : 's'} need attention`, 'attention-summary'));
      if (s.todos?.length) { const todos = el('ul', undefined, 'todos'); for (const t of s.todos) todos.append(el('li', `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'} ${t.content}`)); info.append(todos); }
      const state = el('div', undefined, 'session-state'), badge = el('span', display.label, `badge ${display.className}`); badge.title = display.detail;
      state.append(badge, el('small', s.agent || (s.parentID ? 'subagent' : 'agent'))); row.append(info, state); card.append(row);
      if (i.git?.root && !s.parentID) {
        const details = el('details'); details.dataset.instance = i.instanceId; details.append(el('summary', 'Git workspace'));
        const grid = el('div', undefined, 'git-grid');
        for (const [key, label] of [['status', 'Status'], ['log', 'Recent commits'], ['worktrees', 'Worktrees']]) { const block = el('section'); block.append(el('h4', label), el('pre', typeof i.git[key] === 'string' ? i.git[key] || 'Clean / empty' : 'Waiting for Git snapshot')); grid.append(block); }
        details.append(grid); card.append(details);
      }
      container.append(card);
      if (children.some(hasEligible)) { const nested = el('div', undefined, 'agent-tree-children'); for (const child of children) appendNode(nested, child); container.append(nested); }
      parent.append(container);
    }
    for (const root of buildSessionTree(i.sessions)) {
      if (!hasEligible(root)) continue;
      const classification = classificationsFor(i).get(root.session.id);
      const category = classification.attentionRequired ? 'needs-attention' : classification.category;
      groups.find(([id]) => id === category)?.[3].push({ i, root, appendNode });
    }
  }
  for (const [id, heading, description, items] of groups) {
    if (!items.length && id !== 'needs-attention') continue;
    const section = el('section', undefined, `session-group group-${id}`);
    const title = el('div', undefined, 'group-heading');
    const h = el('h2', `${heading} · ${items.length}`); h.id = `group-${id}-heading`;
    title.append(h, el('p', description, 'muted')); section.append(title);
    if (!items.length) section.append(el('p', 'Nothing needs your attention right now.', 'empty'));
    for (const item of items) {
      if (item.root) item.appendNode(section, item.root);
      else if (item.instanceOnly) section.append(el('article', `${item.i.host} · ${item.i.online ? '● Online' : item.i.replaced ? '↻ Replaced' : '○ Offline'} · PID ${item.i.pid ?? 'unknown'}`, 'session-card'));
    }
    fleet.append(section);
  }
  if (groups.every(([, , , items]) => !items.length)) {
    const empty = el('div', undefined, 'empty');
    empty.append(el('h3', instances.length ? 'No sessions match the current filters' : 'Ready for your first agent'), el('p', instances.length ? `${hiddenOffline} offline instances hidden. Adjust the filters to see more activity.` : 'Install the plugin and start OpenCode. For other computers, configure the companion URL and token.'));
    fleet.append(empty);
  }
}
async function poll() {
  if ((authRequired && !token) || pending) return;
  pending = true;
  const usedToken = token;
  const open = new Set([...document.querySelectorAll('details[open][data-instance]')].map(n => n.dataset.instance));
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
    document.querySelectorAll('details[data-instance]').forEach(n => n.open = open.has(n.dataset.instance));
  } catch (e) { revision = null; $('connection').textContent = '○ Disconnected · retrying'; $('error').textContent = e.message; if (!$('dashboard').hidden) { instances = instances.map(i => ({ ...i, online: false })); render(); } }
  finally { pending = false; }
}
$('login').addEventListener('submit', e => { e.preventDefault(); token = $('token').value.trim(); $('token').value = ''; void poll(); });
$('logout').onclick = () => { token = ''; revision = null; instances = []; $('dashboard').hidden = true; $('login').hidden = false; $('logout').hidden = true; $('connection').textContent = 'Disconnected'; };
for (const id of ['host', 'search', 'active', 'hide-finished', 'hide-waiting', 'hide-offline']) $(id).addEventListener('input', render);
void poll();
setInterval(poll, 2000);
