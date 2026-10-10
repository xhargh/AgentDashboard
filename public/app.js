import { buildSessionTree, classifySessions, isActiveCategory, isFinishedSubagentHidden, sessionState } from './session-state.js';
const $ = id => document.getElementById(id);
let token = '', instances = [], pending = false, authRequired = false;
const expandedAgents = new Set();
const expandedActivity = new Set();
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const eventKinds = {
  created: ['Session created', 'activity-created'], busy: ['Working', 'activity-work'], idle: ['Became idle', 'activity-complete'],
  waiting: ['Permission requested', 'activity-permission'], error: ['Error', 'activity-error'], retry: ['Retrying', 'activity-work'],
  permissionAnswered: ['Permission answered', 'activity-permission'], deleted: ['Session ended', 'activity-complete'],
};
function activityEvents(instance, sessionId) {
  return (Array.isArray(instance.events) ? instance.events : [])
    .filter(event => event?.sessionId === sessionId && eventKinds[event.kind] && Number.isFinite(Date.parse(event.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-5);
}
function render() {
  const online = instances.filter(i => i.online);
  const sessionClassifications = new Map(instances.map(i => [i.instanceId, classifySessions(i.sessions, i.online)]));
  const classificationsFor = i => sessionClassifications.get(i.instanceId);
  const sessions = online.flatMap(i => i.sessions.map(s => ({ session: s, classification: classificationsFor(i).get(s.id) })));
  $('metrics').replaceChildren(...[
    ['Computers online', new Set(online.map(i => i.host)).size], ['OpenCode instances', online.length],
    ['Active agents', sessions.filter(({ session, classification }) => !session.parentID && isActiveCategory(classification)).length],
    ['Active subagents', sessions.filter(({ session, classification }) => session.parentID && isActiveCategory(classification)).length],
  ].map(([label, value]) => { const n = el('article', undefined, 'metric'); n.append(el('span', label), el('strong', value)); return n; }));
  const selected = $('host').value;
  $('host').replaceChildren(new Option('All computers', ''), ...[...new Set(instances.map(i => i.host))].sort().map(h => new Option(h, h)));
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
  for (const i of instances.filter(i => !selected || i.host === selected).sort((a, b) => Number(b.online) - Number(a.online) || a.host.localeCompare(b.host))) {
    const eligible = new Set();
    for (const s of i.sessions) {
      const classification = classificationsFor(i).get(s.id);
      if ($('hide-offline').checked && !i.online) continue;
      if ($('hide-finished').checked && isFinishedSubagentHidden(s)) continue;
      if ($('hide-waiting').checked && i.online && !s.parentID && classification.category === 'waiting-for-input' && !classification.childAttentionCount) continue;
      if ($('active').checked && (!i.online || !isActiveCategory(classification))) continue;
      const context = `${i.host} ${i.directory} ${s.title} ${s.directory} ${s.activity} ${s.agent}`;
      if (!context.toLowerCase().includes(query)) continue;
      const group = groups.find(([category]) => category === classification.category);
      if (group) eligible.add(s.id);
    }
    function hasEligible(node) { return eligible.has(node.session.id) || node.children.some(hasEligible); }
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
        summary.append(el('span', `${s.title} · ${display.label}`, 'tree-title'), el('span', `${children.length} child${children.length === 1 ? '' : 'ren'}`, 'tree-count'));
        if (classification.attentionRequired) summary.append(el('span', 'Attention in this branch', 'attention-summary'));
        container.append(summary);
      }
      const card = el('article', undefined, 'session-card');
      const row = el('div', undefined, `session ${s.parentID ? 'child' : ''}`), info = el('div');
      info.append(el('strong', s.title), el('p', `${i.host} · ${i.directory}`, 'muted'), el('p', i.online ? display.activity : `Last activity: ${s.activity || 'Ready'}`, 'activity'), el('code', s.directory));
      if (s.parentID) info.append(el('p', `Subagent of ${i.sessions.find(p => p.id === s.parentID)?.title || s.parentID}`, 'muted'));
      if (classification.childAttentionCount) info.append(el('p', `${classification.childAttentionCount} descendant session${classification.childAttentionCount === 1 ? '' : 's'} need attention`, 'attention-summary'));
      if (s.todos?.length) { const todos = el('ul', undefined, 'todos'); for (const t of s.todos) todos.append(el('li', `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'} ${t.content}`)); info.append(todos); }
      const events = activityEvents(i, s.id), activityKey = `${i.instanceId}:${s.id}`;
      const activity = el('details', undefined, 'activity-timeline');
      activity.open = expandedActivity.has(activityKey);
      activity.addEventListener('toggle', () => activity.open ? expandedActivity.add(activityKey) : expandedActivity.delete(activityKey));
      const activitySummary = el('summary', `Recent activity · ${events.length}`, 'activity-summary');
      activity.append(activitySummary);
      if (!events.length) activity.append(el('p', 'No recent activity reported.', 'empty activity-empty'));
      else {
        const list = el('ol', undefined, 'activity-list');
        for (const event of events) {
          const [label, kindClass] = eventKinds[event.kind], item = el('li', undefined, `activity-event ${kindClass}`);
          const date = new Date(event.timestamp), time = el('time', date.toLocaleString()); time.dateTime = date.toISOString();
          item.append(el('span', label, 'activity-kind'), time);
          list.append(item);
        }
        activity.append(list);
      }
      card.append(activity);
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
      groups.find(([category]) => category === (classification.attentionRequired ? 'needs-attention' : classification.category))?.[3].push({ i, root });
    }
  }
  for (const [id, heading, description, items] of groups) {
    if (!items.length && id !== 'needs-attention') continue;
    const section = el('section', undefined, `session-group group-${id}`);
    const title = el('div', undefined, 'group-heading');
    const h = el('h2', `${heading} · ${items.length}`); h.id = `group-${id}-heading`;
    title.append(h, el('p', description, 'muted')); section.append(title);
    if (!items.length) section.append(el('p', 'Nothing needs your attention right now.', 'empty'));
    for (const { i, root } of items) appendNode(section, root);
    fleet.append(section);
  }
  if (groups.every(([, , , items]) => !items.length)) {
    const empty = el('div', undefined, 'empty');
    empty.append(el('h3', instances.length ? 'No sessions match the current filters' : 'Ready for your first agent'), el('p', instances.length ? 'Adjust the filters to see more activity.' : 'Install the plugin and start OpenCode. For other computers, configure the companion URL and token.'));
    fleet.append(empty);
  }
}
async function poll() {
  if ((authRequired && !token) || pending) return;
  pending = true;
  const usedToken = token;
  const open = new Set([...document.querySelectorAll('details[open][data-instance]')].map(n => n.dataset.instance));
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
for (const id of ['host', 'search', 'active', 'hide-finished', 'hide-waiting', 'hide-offline']) $(id).addEventListener('input', render);
void poll();
setInterval(poll, 2000);
