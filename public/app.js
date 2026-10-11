import { buildSessionTree, classifySessions, isActiveCategory, isFinishedSubagentHidden, sessionMatchesSearch, sessionState } from './session-state.js';
const $ = id => document.getElementById(id);
let token = '', instances = [], revision = null, pending = false, authRequired = false;
let notificationEnabled = false, initializedAttention = false;
const previousStatuses = new Map();
const originalTitle = document.title;
const numberFormat = new Intl.NumberFormat();
const machineKey = i => i.machineId || `legacy:${i.host}`;
const expandedAgents = new Set();
const expandedActivity = new Set();
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
function reconcile(parent, desired) {
  if (!parent.querySelectorAll) { parent.replaceChildren(...desired.children); return; }
  const keyed = new Map([...parent.querySelectorAll('[data-agent-key]')].map(node => [node.dataset.agentKey, node]));
  function sync(current, next) {
    if (current.nodeType === Node.TEXT_NODE) { if (current.textContent !== next.textContent) current.textContent = next.textContent; return current; }
    for (const attr of [...current.attributes]) if (!(current.tagName === 'DETAILS' && attr.name === 'open') && !next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    for (const attr of [...next.attributes]) if (!(current.tagName === 'DETAILS' && attr.name === 'open') && current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    reconcileChildren(current, [...next.childNodes]);
    return current;
  }
  function reconcileChildren(target, children) {
    let position = 0;
    for (const next of children) {
      const key = next.dataset?.agentKey;
      let current = key ? keyed.get(key) : target.childNodes[position];
      if (!key && current?.dataset?.agentKey) current = null;
      if (current && (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName)) current = null;
      if (!current) current = next;
      else sync(current, next);
      const atPosition = target.childNodes[position];
      if (atPosition !== current) target.insertBefore(current, atPosition || null);
      position++;
    }
    while (target.childNodes.length > position) target.lastChild.remove();
  }
  reconcileChildren(parent, [...desired.childNodes]);
}
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
function renderMetrics(info, session, online) {
  const metrics = el('section', undefined, 'agent-metrics');
  const model = session.model;
  const modelLabel = model?.providerID && (model.name || model.modelID)
    ? `${model.providerName || model.providerID} / ${model.name || model.modelID}` : 'Model unavailable';
  metrics.append(el('p', modelLabel, 'model-label'));
  metrics.append(el('p', model?.variant ? `${model.variant} variant` : 'Variant unavailable', 'variant-label'));
  const usage = session.usage;
  if (Number.isSafeInteger(usage?.contextEstimate) && Number.isSafeInteger(model?.contextLimit) && model.contextLimit > 0) {
    const used = usage.contextEstimate, limit = model.contextLimit, percentage = Math.min(100, used / limit * 100);
    const context = el('div', undefined, `context-metric${percentage >= 90 ? ' context-critical' : percentage >= 75 ? ' context-warning' : ''}`);
    context.append(el('span', `Context estimate · ${numberFormat.format(used)} / ${numberFormat.format(limit)} (${Math.round(percentage)}%)${online ? '' : ' · last reported'}`));
    const progress = el('progress'); progress.max = limit; progress.value = Math.min(used, limit);
    progress.setAttribute('aria-label', `Estimated context usage ${numberFormat.format(used)} of ${numberFormat.format(limit)} tokens`);
    progress.setAttribute('aria-valuetext', `${Math.round(percentage)} percent estimated`);
    context.append(progress);
    if (percentage >= 90) context.append(el('strong', 'Context estimate is at least 90%', 'context-warning-text'));
    else if (percentage >= 75) context.append(el('strong', 'Context estimate is at least 75%', 'context-warning-text'));
    metrics.append(context);
  } else metrics.append(el('p', 'Context unavailable', 'context-unavailable'));
  if (!usage) metrics.append(el('p', 'Usage pending', 'usage-pending'));
  else {
    const input = usage.input || 0, output = usage.output || 0;
    const lifetime = el('div', undefined, 'usage-metric');
    lifetime.append(el('strong', `${numberFormat.format(input + output)} input + output tokens`));
    if (usage.partial) lifetime.append(el('small', ' · partial history'));
    if (!online) lifetime.append(el('small', ' · last reported'));
    const breakdown = el('details', undefined, 'usage-breakdown');
    breakdown.append(el('summary', 'Usage breakdown'));
    const list = el('dl');
    for (const [key, label] of [['input', 'Input'], ['output', 'Output'], ['reasoning', 'Reasoning'], ['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write']]) {
      list.append(el('dt', label), el('dd', usage[key] === undefined ? 'Unknown' : numberFormat.format(usage[key])));
    }
    breakdown.append(list); metrics.append(lifetime, breakdown);
  }
  info.append(metrics);
}
function render() {
  const online = instances.filter(i => i.online);
  const sessionClassifications = new Map(instances.map(i => [i.instanceId, classifySessions(i.sessions, i.online)]));
  const classificationsFor = i => sessionClassifications.get(i.instanceId);
  const sessions = online.flatMap(i => i.sessions.map(s => ({ session: s, classification: classificationsFor(i).get(s.id) })));
  const metrics = el('div');
  metrics.append(...[
    ['Computers online', new Set(online.map(machineKey)).size], ['OpenCode instances', online.length],
    ['Active agents', sessions.filter(({ session, classification }) => !session.parentID && isActiveCategory(classification)).length],
    ['Active subagents', sessions.filter(({ session, classification }) => session.parentID && isActiveCategory(classification)).length],
  ].map(([label, value]) => { const n = el('article', undefined, 'metric'); n.append(el('span', label), el('strong', value)); return n; }));
  reconcile($('metrics'), metrics);
  const selected = $('host').value;
  const machines = new Map(instances.map(i => [machineKey(i), i]));
  $('computer-filter').hidden = !authRequired && machines.size < 2;
  const options = [...machines].sort((a, b) => a[1].host.localeCompare(b[1].host)).map(([key, i]) =>
    new Option(instances.filter(other => other.host === i.host).length > 1 ? `${i.host} (${key.slice(0, 8)})` : i.host, key));
  if (!$('host').options || $('host').options.length !== options.length + 1 || options.some((option, index) => $('host').options[index + 1]?.value !== option.value)) {
    $('host').replaceChildren(new Option('All computers', ''), ...options);
  }
  $('host').value = selected;
  const query = $('search').value.toLowerCase();
  const fleet = el('div');
  const groups = [
    ['needs-attention', 'Needs attention', 'Permission requests and errors', []],
    ['working', 'Working', 'Currently active sessions', []],
    ['waiting-for-input', 'Waiting for input', 'Idle main agents ready for your next message', []],
    ['recently-finished', 'Recently finished', 'Completed subagents available if recalled', []],
    ['offline', 'Offline', 'Instances no longer reporting', []],
  ];
  let hiddenOffline = 0;
  for (const i of instances.filter(i => !selected || machineKey(i) === selected || i.host === selected).sort((a, b) => Number(b.online) - Number(a.online) || a.host.localeCompare(b.host))) {
    if ($('hide-offline').checked && !i.online) { hiddenOffline++; continue; }
    const eligible = new Set();
    for (const s of i.sessions) {
      const classification = classificationsFor(i).get(s.id);
      if ($('hide-offline').checked && !i.online) continue;
      if ($('hide-finished').checked && isFinishedSubagentHidden(s)) continue;
      if ($('hide-waiting').checked && i.online && !s.parentID && classification.category === 'waiting-for-input' && !classification.childAttentionCount) continue;
      if ($('active').checked && (!i.online || !isActiveCategory(classification))) continue;
      if (!sessionMatchesSearch(s, query, i.host, i.directory)) continue;
      const group = groups.find(([category]) => category === classification.category);
      if (group) eligible.add(s.id);
    }
    function hasEligible(node) { return eligible.has(node.session.id) || node.children.some(hasEligible); }
    if (!i.online && i.sessions.length === 0) groups.find(([id]) => id === 'offline')[3].push({ i, instanceOnly: true });
    function appendNode(parent, node) {
      if (!hasEligible(node)) return;
      const { session: s, children } = node, classification = classificationsFor(i).get(s.id);
      const display = sessionState(s, i.online, classification), key = `${i.instanceId}:${s.id}`;
      const container = children.length ? el('details', undefined, 'agent-tree') : el('div', undefined, 'agent-tree');
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
      if (!i.machineId) {
        card.append(el('p', 'This instance is using a legacy host-based identity because its report has no machine ID. Update or reinstall the OpenCode Supervisor plugin to use a stable machine identity.', 'instance-warning'));
      }
      const row = el('div', undefined, `session ${s.parentID ? 'child' : ''}`), info = el('div', undefined, 'session-info');
      info.append(el('strong', s.title || 'Session'), el('p', i.directory ? `${i.host} · ${i.directory}` : i.host, 'muted'), el('p', i.online ? display.activity : `Last activity: ${s.activity || 'Ready'}`, 'activity'), el('code', s.directory));
       if (s.parentID) info.append(el('p', `Subagent of ${i.sessions.find(p => p.id === s.parentID)?.title || s.parentID}`, 'muted'));
       if (classification.childAttentionCount) info.append(el('p', `${classification.childAttentionCount} descendant session${classification.childAttentionCount === 1 ? '' : 's'} need attention`, 'attention-summary'));
       renderMetrics(info, s, i.online);
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
      const state = el('div', undefined, 'session-state'), badge = el('span', display.label, `badge ${display.className}`); badge.title = display.detail;
      state.append(badge, el('small', s.agent || (s.parentID ? 'subagent' : 'agent'))); row.append(info, state); card.append(row, activity);
      if (i.git?.root && !s.parentID) {
        const details = el('details'); details.dataset.instance = i.instanceId; details.append(el('summary', 'Git workspace'));
        const grid = el('div', undefined, 'git-grid');
        for (const [key, label] of [['status', 'Status'], ['log', 'Recent commits'], ['worktrees', 'Worktrees']]) { const block = el('section'); block.append(el('h4', label), el('pre', typeof i.git[key] === 'string' ? i.git[key] || 'Clean / empty' : 'Waiting for Git snapshot')); grid.append(block); }
        details.append(grid); card.append(details);
      }
      container.append(card);
      if (children.length) { const nested = el('div', undefined, 'agent-tree-children'); for (const child of children) appendNode(nested, child); container.append(nested); }
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
  reconcile($('fleet'), fleet);
}
function updateAttentionNotifications(nextInstances) {
  const live = nextInstances.filter(i => i.online);
  let count = 0;
  const currentStatuses = new Map();
  for (const instance of live) {
    for (const session of instance.sessions) {
      const identity = `${instance.instanceId}:${session.id}`;
      currentStatuses.set(identity, session.status);
      const attention = session.status === 'waiting' || session.status === 'error';
      if (attention) count++;
      const previous = previousStatuses.get(identity);
      if (initializedAttention && attention && previous !== undefined && previous !== session.status) {
        if (notificationEnabled && 'Notification' in window && Notification.permission === 'granted') {
          try { new Notification(session.status === 'waiting' ? 'Permission required' : 'Agent error', { body: `${session.title} · ${instance.host}` }); } catch {}
        }
      }
    }
  }
  previousStatuses.clear();
  for (const [identity, status] of currentStatuses) previousStatuses.set(identity, status);
  initializedAttention = true;
  if ($('tab-count')?.checked) document.title = count ? `(${count}) ${originalTitle}` : originalTitle;
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
      revision = null;
      authRequired = true; $('login').hidden = false; $('dashboard').hidden = true; $('logout').hidden = true;
      $('connection').textContent = 'Network mode · token required';
      $('connection').dataset.state = 'disconnected';
      $('error').textContent = usedToken ? 'Invalid access token' : '';
      token = ''; return;
    }
    if (response.status === 304) return;
    if (!response.ok) throw new Error(`Companion returned ${response.status}`);
    const data = await response.json(); if (token !== usedToken) return;
    authRequired = data.mode !== 'local';
    revision = data.revision;
    updateAttentionNotifications(data.instances);
    instances = data.instances; $('login').hidden = true; $('dashboard').hidden = false; $('logout').hidden = !authRequired;
    $('connection').textContent = authRequired ? '● Connected · network mode' : '● Connected · local only'; $('error').textContent = ''; render();
    $('connection').dataset.state = 'connected';
    document.querySelectorAll('details[data-instance]').forEach(n => n.open = open.has(n.dataset.instance));
  } catch (e) { revision = null; initializedAttention = false; previousStatuses.clear(); $('connection').textContent = '○ Disconnected · retrying'; $('connection').dataset.state = 'disconnected'; $('error').textContent = e.message; if (!$('dashboard').hidden) { instances = instances.map(i => ({ ...i, online: false })); render(); } }
  finally { pending = false; }
}
$('login').addEventListener('submit', e => { e.preventDefault(); token = $('token').value.trim(); $('token').value = ''; void poll(); });
$('logout').onclick = () => { token = ''; revision = null; instances = []; $('dashboard').hidden = true; $('login').hidden = false; $('logout').hidden = true; $('connection').textContent = 'Disconnected'; $('connection').dataset.state = 'disconnected'; };
for (const id of ['host', 'search', 'active', 'hide-finished', 'hide-waiting', 'hide-offline']) $(id).addEventListener('input', render);
$('notifications').addEventListener('change', async event => {
  notificationEnabled = event.target.checked;
  if (!notificationEnabled) return;
  if (!('Notification' in window)) { event.target.checked = false; notificationEnabled = false; $('notifications-help').textContent = 'Browser notifications are not supported in this browser.'; return; }
  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { event.target.checked = false; notificationEnabled = false; }
  } else if (Notification.permission !== 'granted') { event.target.checked = false; notificationEnabled = false; }
});
$('tab-count').addEventListener('change', () => {
  if (!$('tab-count').checked) document.title = originalTitle;
  else {
    const count = instances.filter(i => i.online).flatMap(i => i.sessions).filter(s => s.status === 'waiting' || s.status === 'error').length;
    document.title = count ? `(${count}) ${originalTitle}` : originalTitle;
  }
});
void poll();
setInterval(poll, 2000);
