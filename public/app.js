import { buildSessionTree, classifySessions, compareSessions, isActiveCategory, isFinishedSubagentHidden, sessionMatchesSearch, sessionState } from './session-state.js';
const $ = id => document.getElementById(id);
let token = '', instances = [], revision = null, pending = false, authRequired = false;
let notificationEnabled = false, initializedAttention = false;
const previousStatuses = new Map();
const originalTitle = document.title;
const numberFormat = new Intl.NumberFormat();
const validSortFields = new Set(['activity', 'status', 'context', 'tokens', 'name']);
const sortLabels = { activity: 'recent activity', status: 'status', context: 'current-context token usage', tokens: 'cumulative token usage', name: 'session name' };
const savedSortField = globalThis.localStorage?.getItem('agentdashboard-session-sort');
const savedSortDirection = globalThis.localStorage?.getItem('agentdashboard-session-sort-direction');
let sortField = validSortFields.has(savedSortField) ? savedSortField : 'activity';
let sortDirection = savedSortDirection === 'asc' ? 'asc' : 'desc';
const sortNodes = nodes => [...nodes].sort((a, b) => compareSessions(a.session, b.session, sortField, sortDirection));
const machineKey = i => i.machineId || `legacy:${i.host}`;
const expandedAgents = new Set();
const collapsedAgents = new Set();
const expandedSubagentGroups = new Set();
const expandedActivity = new Set();
const expandedExecution = new Set();
const timelineRanges = new Map();
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
function formatTimestamp(value) {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function gitSummary(git) {
  const changes = typeof git.status === 'string'
    ? git.status.split('\n').filter(line => line && !line.startsWith('##')).length : null;
  const worktrees = typeof git.worktrees === 'string' ? (git.worktrees.match(/^worktree /gm) || []).length : null;
  const commitDate = typeof git.log === 'string' ? git.log.split('\n')[0]?.split(/\s+/)[1] : null;
  const lastCommit = commitDate && Number.isFinite(Date.parse(commitDate)) ? formatTimestamp(commitDate) : 'unavailable';
  const changeSummary = changes === 0 ? 'clean' : `${changes ?? 'unavailable'} change${changes === 1 ? '' : 's'}`;
  const worktreeSummary = worktrees === null || worktrees > 1
    ? `${worktrees ?? 'unavailable'} worktrees`
    : '';
  return ['Git workspace', changeSummary, worktreeSummary, `last commit ${lastCommit}`].filter(Boolean).join(' · ');
}
function reconcile(parent, desired) {
  if (!parent.querySelectorAll) { parent.replaceChildren(...desired.children); return; }
  const keyed = new Map([...parent.querySelectorAll('[data-agent-key]')].map(node => [node.dataset.agentKey, node]));
  function sync(current, next) {
    if (current.nodeType === Node.TEXT_NODE) { if (current.textContent !== next.textContent) current.textContent = next.textContent; return current; }
    for (const attr of [...current.attributes]) if (!(current.tagName === 'DETAILS' && attr.name === 'open' && !current.classList.contains('execution-timeline')) && !next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    for (const attr of [...next.attributes]) if (!(current.tagName === 'DETAILS' && attr.name === 'open' && !current.classList.contains('execution-timeline')) && current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
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
function descendantSessions(session, sessions) {
  const children = new Map();
  for (const candidate of sessions) {
    if (!candidate.parentID) continue;
    if (!children.has(candidate.parentID)) children.set(candidate.parentID, []);
    children.get(candidate.parentID).push(candidate);
  }
  const descendants = [], visited = new Set([session.id]);
  function visit(parentID) {
    for (const child of children.get(parentID) || []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id); descendants.push(child); visit(child.id);
    }
  }
  visit(session.id);
  return descendants;
}
function renderExecutionTimeline(instance, parent) {
  const key = `execution:${instance.instanceId}:${parent.id}`;
  const details = el('details', undefined, 'execution-timeline');
  details.dataset.agentKey = key;
  details.open = expandedExecution.has(key);
  details.addEventListener('toggle', () => details.open ? expandedExecution.add(key) : expandedExecution.delete(key));
  const intervalList = instance.timeline?.intervals;
  const intervals = Array.isArray(intervalList) ? intervalList : [];
  const descendants = descendantSessions(parent, instance.sessions);
  const rows = [parent, ...descendants].map(session => ({ session, intervals: intervals.filter(item => item.sessionId === session.id) }));
  const intervalEnd = (item, session) => item.endAt ? Date.parse(item.endAt)
    : session.archived ? (session.archivedAt || Date.parse(item.startAt))
      : instance.online ? Date.now() : (instance.lastSeen || Date.parse(item.startAt));
  const relevant = rows.flatMap(row => row.intervals.filter((item, index, list) =>
    !(item.status === 'idle' && index === list.length - 1 && item.endAt === null)));
  details.append(el('summary', 'Execution timeline', 'execution-heading'));
  if (!relevant.length) {
    const message = !instance.timeline
      ? 'Timeline unavailable: this report does not include timeline history.'
      : instance.timeline.partial
        ? 'Partial history: no observed state transitions are available in the retained event history.'
        : 'No observed state transitions in the retained event history.';
    details.append(el('p', message, 'timeline-message'));
    return details;
  }
  const relevantSet = new Set(relevant);
  const times = rows.flatMap(row => row.intervals.filter(item => relevantSet.has(item))
    .flatMap(item => [Date.parse(item.startAt), intervalEnd(item, row.session)])).filter(Number.isFinite);
  const min = Math.min(...times), max = Math.max(...times), span = Math.max(1, max - min);
  const chart = el('div', undefined, 'timeline-chart'); chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', 'Observed session states on a shared wall-clock time scale');
  const axis = el('div', undefined, 'timeline-axis');
  axis.append(el('span', formatTimestamp(min)), el('span', formatTimestamp(max)));
  chart.append(axis);
  const savedRange = timelineRanges.get(key) || [0, 1000];
  const rangeControls = el('div', undefined, 'timeline-range-controls');
  const rangeStartLabel = el('label', 'From');
  const rangeStart = el('input'); rangeStart.type = 'range'; rangeStart.min = '0'; rangeStart.max = '999'; rangeStart.value = String(savedRange[0]);
  rangeStart.setAttribute('aria-label', 'Timeline range start'); rangeStartLabel.append(rangeStart);
  const rangeEndLabel = el('label', 'To');
  const rangeEnd = el('input'); rangeEnd.type = 'range'; rangeEnd.min = '1'; rangeEnd.max = '1000'; rangeEnd.value = String(savedRange[1]);
  rangeEnd.setAttribute('aria-label', 'Timeline range end'); rangeEndLabel.append(rangeEnd);
  rangeControls.append(rangeStartLabel, rangeEndLabel);
  for (const row of rows) {
    const line = el('div', undefined, 'timeline-row');
    const sessionLabel = `${row.session.title || 'Session'}${row.session.archived ? row.session.ended ? ' · ended' : ' · last observed' : instance.online ? '' : ' · offline'}`;
    line.append(el('span', sessionLabel, 'timeline-session'));
    const track = el('div', undefined, 'timeline-track');
    const visibleIntervals = row.intervals.filter((item, index, list) =>
      !(item.status === 'idle' && index === list.length - 1 && item.endAt === null));
    if (!visibleIntervals.length) {
      const unknown = el('span', 'Unknown · partial history', 'timeline-interval timeline-unknown');
      unknown.style.left = '0'; unknown.style.width = '100%';
      track.append(unknown);
    }
    for (const item of visibleIntervals) {
      const start = Date.parse(item.startAt), end = intervalEnd(item, row.session);
      const block = el('span', item.status, `timeline-interval timeline-${item.status}`);
      block.dataset.startAt = item.startAt;
      block.dataset.endAt = String(end);
      block.style.left = `${Math.max(0, (start - min) / span * 100)}%`;
      block.style.width = `${Math.max(0.5, (end - start) / span * 100)}%`;
      const endLabel = item.endAt ? ` – ${formatTimestamp(end)}` : row.session.archived || !instance.online
        ? ` – ${formatTimestamp(end)} · last observed` : ' · ongoing';
      block.title = `${item.status} · ${formatTimestamp(item.startAt)}${endLabel}`;
      track.append(block);
    }
    line.append(track); chart.append(line);
  }
  if (relevant.some(item => !item.endAt) && (instance.online || Number.isFinite(instance.lastSeen))) {
    for (const track of chart.querySelectorAll('.timeline-track')) {
      const marker = el('span', undefined, 'timeline-now');
      marker.setAttribute('aria-hidden', 'true');
      const markerTime = instance.online ? Date.now() : instance.lastSeen;
      marker.style.left = `${Math.max(0, (markerTime - min) / span * 100)}%`;
      marker.dataset.time = String(markerTime);
      track.append(marker);
    }
  }
  const list = el('ol', undefined, 'timeline-list');
  for (const item of [...relevant].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))) {
    const session = instance.sessions.find(candidate => candidate.id === item.sessionId);
    const end = intervalEnd(item, session || parent);
    const endLabel = item.endAt ? ` to ${formatTimestamp(end)}` : session?.archived || !instance.online
      ? ` to ${formatTimestamp(end)} · last observed` : ' · ongoing';
    const text = `${session?.title || 'Session'} · ${item.status} · ${formatTimestamp(item.startAt)}${endLabel}`;
    list.append(el('li', text));
  }
  details.append(chart, rangeControls);
  const legend = el('div', undefined, 'timeline-legend');
  for (const [label, state] of [['Working', 'busy'], ['Idle', 'idle'], ['Permission wait', 'waiting'], ['Retry', 'retry'], ['Error', 'error'], ['Offline', 'offline'], ['Unknown/partial', 'unknown']]) {
    const item = el('span', undefined, 'timeline-legend-item');
    item.append(el('span', undefined, `timeline-swatch timeline-${state}`), el('span', label)); legend.append(item);
  }
  const disclosure = el('details', undefined, 'timeline-details');
  disclosure.append(el('summary', 'Show interval details'), list);
  details.append(legend, disclosure);
  details.append(el('p', instance.timeline?.partial
    ? `Partial history: earlier transitions may be missing or truncated; earliest known event ${formatTimestamp(min)}.`
    : 'Intervals show observed event times; they do not represent compute time.', 'timeline-message'));
  function applyRange(active) {
    let from = Number(rangeStart.value), to = Number(rangeEnd.value);
    if (from >= to) {
      if (active === rangeStart) to = Math.min(1000, from + 1);
      else from = Math.max(0, to - 1);
    }
    rangeStart.value = String(from); rangeEnd.value = String(to);
    timelineRanges.set(key, [from, to]);
    const visibleStart = min + span * from / 1000, visibleEnd = min + span * to / 1000;
    const visibleSpan = Math.max(1, visibleEnd - visibleStart);
    axis.firstChild.textContent = formatTimestamp(visibleStart);
    axis.lastChild.textContent = formatTimestamp(visibleEnd);
    for (const track of chart.querySelectorAll('.timeline-track')) {
      for (const block of track.querySelectorAll('.timeline-interval')) {
        if (!block.dataset.startAt) { block.hidden = false; block.style.left = '0%'; block.style.width = '100%'; continue; }
        const start = Date.parse(block.dataset.startAt), end = Number(block.dataset.endAt);
        block.hidden = end < visibleStart || start > visibleEnd;
        block.style.left = `${Math.max(0, (start - visibleStart) / visibleSpan * 100)}%`;
        block.style.width = `${Math.max(0.5, (Math.min(end, visibleEnd) - Math.max(start, visibleStart)) / visibleSpan * 100)}%`;
      }
      const marker = track.querySelector('.timeline-now');
      if (marker) marker.style.left = `${Math.min(100, Math.max(0, (Number(marker.dataset.time) - visibleStart) / visibleSpan * 100))}%`;
    }
  }
  rangeStart.addEventListener('input', () => applyRange(rangeStart));
  rangeEnd.addEventListener('input', () => applyRange(rangeEnd));
  applyRange();
  return details;
}
function tokenCount(usage) { return (usage?.input || 0) + (usage?.output || 0); }
function renderMetrics(info, session, online, sessions) {
  const metrics = el('section', undefined, 'agent-metrics');
  const model = session.model;
  const modelLabel = model?.providerID && (model.name || model.modelID)
    ? `${model.providerName || model.providerID} / ${model.name || model.modelID}` : 'Model unavailable';
  metrics.append(el('p', modelLabel, 'model-label'));
  if (model?.variant) metrics.append(el('p', `${model.variant} variant`, 'variant-label'));
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
    const lifetime = el('div', undefined, 'usage-metric');
    lifetime.append(el('strong', `Own · ${numberFormat.format(tokenCount(usage))} input + output tokens`));
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
  if (!session.parentID) {
    const descendants = descendantSessions(session, sessions);
    if (descendants.length) {
      const agents = [session, ...descendants], known = agents.filter(candidate => candidate.usage);
      const total = known.length ? numberFormat.format(known.reduce((sum, candidate) => sum + tokenCount(candidate.usage), 0)) : 'pending';
      const detail = total === 'pending' ? '' : ` input + output tokens${known.length < agents.length ? ' · some usage pending' : ''}`;
      metrics.append(el('p', `Total with subagents · ${total}${detail}`, 'aggregate-usage'));
    }
  }
  info.append(metrics);
}
function render() {
  const online = instances.filter(i => i.online);
  const sessionClassifications = new Map(instances.map(i => [i.instanceId, classifySessions(i.sessions, i.online)]));
  const classificationsFor = i => sessionClassifications.get(i.instanceId);
  const sessions = online.flatMap(i => i.sessions.map(s => ({ session: s, classification: classificationsFor(i).get(s.id) })));
  const metrics = el('div');
  const metricItems = [
    ['OpenCode instances', online.length, 'Online instance reports; one computer may run several'],
    ['Active agents', sessions.filter(({ session, classification }) => !session.parentID && isActiveCategory(classification)).length, 'Top-level sessions needing attention or doing work'],
    ['Active subagents', sessions.filter(({ session, classification }) => session.parentID && isActiveCategory(classification)).length, 'Child sessions needing attention or doing work'],
  ];
  if (authRequired) metricItems.unshift(['Computers online', new Set(online.map(machineKey)).size, 'Distinct online computers']);
  metrics.append(...metricItems.map(([label, value, detail], index) => {
    const n = el('article', undefined, 'metric');
    const labelRow = el('div', undefined, 'metric-label');
    labelRow.append(el('span', label));
    const tooltipId = `metric-tooltip-${index}`;
    const help = el('button', '?', 'metric-help');
    help.type = 'button';
    help.setAttribute?.('aria-label', 'Metric description');
    help.setAttribute?.('aria-describedby', tooltipId);
    const tooltip = el('span', detail, 'metric-tooltip');
    tooltip.id = tooltipId;
    tooltip.setAttribute?.('role', 'tooltip');
    labelRow.append(help, tooltip);
    n.append(labelRow, el('strong', value));
    return n;
  }));
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
  $('session-sort').value = sortField;
  $('sort-direction').textContent = sortDirection === 'asc' ? '↑' : '↓';
  $('sort-direction').setAttribute?.('aria-label', `Sort direction: ${sortDirection === 'asc' ? 'ascending' : 'descending'}`);
  const fleet = el('div');
  const groups = [
    ['needs-attention', 'Needs attention', 'Permission requests and errors', []],
    ['working', 'Working', 'Currently active sessions', []],
    ['waiting-for-input', 'Waiting for input', 'Idle top-level sessions ready for your next message · count is sessions across all computers and instances', []],
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
    function appendNode(parent, node, compact = false, depth = 0) {
      if (!hasEligible(node)) return;
      const { session: s, children } = node, classification = classificationsFor(i).get(s.id);
      const display = sessionState(s, i.online, classification), key = `${i.instanceId}:${s.id}`;
      const container = el('details', undefined, `agent-tree${compact ? ' subagent-row' : ''}`);
      container.dataset.agentKey = key;
      if (compact) container.style.setProperty('--tree-depth', depth);
      container.open = expandedAgents.has(key) || (!compact && !children.length && !collapsedAgents.has(key));
      container.addEventListener('toggle', () => {
        if (container.open) { expandedAgents.add(key); collapsedAgents.delete(key); }
        else { expandedAgents.delete(key); collapsedAgents.add(key); }
      });
      const summary = el('summary', undefined, 'agent-tree-summary');
      summary.append(el('span', s.title || 'Session', 'tree-title'));
      const summaryBadge = el('span', display.label, `badge ${display.className}`);
      summaryBadge.title = display.detail;
      summary.append(summaryBadge);
      if (!compact && children.length) {
        const count = descendantSessions(s, i.sessions).filter(child => eligible.has(child.id)).length;
        summary.append(el('span', `${count} ${count === 1 ? 'child' : 'children'}`, 'tree-count'));
      }
      if (classification.attentionRequired) summary.append(el('span', 'Attention in this branch', 'attention-summary'));
      const activityText = s.activity?.trim();
      if (activityText && !/^(ready|idle|waiting for input|waiting for permission)$/i.test(activityText) && activityText !== display.label) {
        summary.append(el('span', activityText, 'tree-activity'));
      }
      const directory = s.directory || i.directory;
      if (directory) {
        const path = el('span', directory, 'tree-directory');
        path.title = directory;
        path.setAttribute('aria-label', `Working directory: ${directory}`);
        summary.append(path);
      }
      container.append(summary);
      const card = el('article', undefined, 'session-card');
      if (!i.machineId) {
        card.append(el('p', 'This instance is using a legacy host-based identity because its report has no machine ID. Update or reinstall the AgentDashboard plugin to use a stable machine identity.', 'instance-warning'));
      }
      const row = el('div', undefined, `session ${s.parentID ? 'child' : ''}`), info = el('div', undefined, 'session-info');
      info.append(el('p', `Computer ${i.host} · OpenCode instance PID ${i.pid ?? 'unknown'}`, 'muted'));
       if (s.parentID) info.append(el('p', `Subagent of ${i.sessions.find(p => p.id === s.parentID)?.title || s.parentID}`, 'muted'));
       if (classification.childAttentionCount) info.append(el('p', `${classification.childAttentionCount} descendant session${classification.childAttentionCount === 1 ? '' : 's'} need attention`, 'attention-summary'));
        renderMetrics(info, s, i.online, i.sessions);
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
          const date = new Date(event.timestamp), time = el('time', formatTimestamp(event.timestamp)); time.dateTime = date.toISOString();
          item.append(el('span', label, 'activity-kind'), time);
          list.append(item);
        }
        activity.append(list);
      }
      const state = el('div', undefined, 'session-state');
      state.append(el('small', s.agent || (s.parentID ? 'subagent' : 'agent'))); row.append(info, state); card.append(row, activity);
      if (i.git?.root && !s.parentID) {
        const details = el('details'); details.dataset.instance = i.instanceId; details.append(el('summary', gitSummary(i.git)));
        const grid = el('div', undefined, 'git-grid');
        for (const [key, label] of [['status', 'Status'], ['log', 'Recent commits'], ['worktrees', 'Worktrees']]) { const block = el('section'); block.append(el('h4', label), el('pre', typeof i.git[key] === 'string' ? i.git[key] || 'Clean / empty' : 'Waiting for Git snapshot')); grid.append(block); }
        details.append(grid); card.append(details);
      }
      if (!compact) card.append(renderExecutionTimeline(i, s));
      if (!compact && children.length) {
        const descendants = descendantSessions(s, i.sessions);
        const visible = descendants.filter(child => eligible.has(child.id));
        const section = el('details', undefined, 'subagent-group');
        const groupKey = `subagents:${key}`;
        section.dataset.agentKey = groupKey;
        section.open = expandedSubagentGroups.has(groupKey);
        section.addEventListener('toggle', () => section.open ? expandedSubagentGroups.add(groupKey) : expandedSubagentGroups.delete(groupKey));
        const header = el('summary', `Subagents · ${visible.length}${descendants.length > visible.length ? ` · ${descendants.length - visible.length} hidden` : ''}`, 'subagent-heading');
        const attention = descendants.filter(child => ['waiting', 'error'].includes(child.status) && eligible.has(child.id)).length;
        if (attention) header.append(el('span', `${attention} need attention`, 'attention-summary'));
        section.append(header);
        const byId = new Map(buildSessionTree(i.sessions).flatMap(function flatten(n) { return [n, ...n.children.flatMap(flatten)]; }).map(n => [n.session.id, n]));
        for (const child of visible.sort((a, b) => {
          const na = byId.get(a.id), nb = byId.get(b.id);
          return compareSessions(na.session, nb.session, sortField, sortDirection);
        })) {
          let level = 0, parentId = child.parentID;
          while (parentId && parentId !== s.id) { level++; parentId = i.sessions.find(candidate => candidate.id === parentId)?.parentID; }
          appendNode(section, byId.get(child.id), true, level);
        }
        card.append(section);
      }
      container.append(card);
      parent.append(container);
    }
    for (const root of buildSessionTree(i.sessions)) {
      if (!hasEligible(root)) continue;
      const classification = classificationsFor(i).get(root.session.id);
      const category = classification.attentionRequired ? 'needs-attention' : classification.category;
      groups.find(([id]) => id === category)?.[3].push({ i, root, appendNode });
    }
  }
  if (sortField !== 'status') {
    const sessions = groups.flatMap(([, , , items]) => items.filter(item => item.root));
    const offlineInstances = groups.find(([id]) => id === 'offline')[3].filter(item => item.instanceOnly);
    groups.splice(0, groups.length,
      ['sorted-sessions', 'Sessions', `Sorted by ${sortLabels[sortField]}`, sessions],
      ...(offlineInstances.length ? [['offline', 'Offline', 'Instances no longer reporting', offlineInstances]] : []));
  }
  for (const [id, heading, description, items] of groups) {
    if (!items.length) continue;
    items.sort((a, b) => a.root && b.root ? compareSessions(a.root.session, b.root.session, sortField, sortDirection) : a.root ? -1 : b.root ? 1 : 0);
    const section = el('details', undefined, `session-group group-${id}`);
    section.dataset.agentKey = `group:${id}`;
    section.open = true;
    const title = el('summary', undefined, 'group-heading');
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
function updateTrayStatus(status) {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (invoke) void invoke('update_tray_status', { status }).catch(() => {});
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
    const online = instances.filter(instance => instance.online);
    const sessions = online.flatMap(instance => instance.sessions || []);
    const attention = sessions.filter(session => ['waiting', 'error'].includes(session.status)).length;
    updateTrayStatus(`AgentDashboard · ${online.length} instance${online.length === 1 ? '' : 's'} · ${sessions.length} sessions${attention ? ` · ${attention} need attention` : ''}`);
    document.querySelectorAll('details[data-instance]').forEach(n => n.open = open.has(n.dataset.instance));
  } catch (e) { revision = null; initializedAttention = false; previousStatuses.clear(); $('connection').textContent = '○ Disconnected · retrying'; $('connection').dataset.state = 'disconnected'; $('error').textContent = e.message; updateTrayStatus('AgentDashboard · Disconnected'); if (!$('dashboard').hidden) { instances = instances.map(i => ({ ...i, online: false })); render(); } }
  finally { pending = false; }
}
$('login').addEventListener('submit', e => { e.preventDefault(); token = $('token').value.trim(); $('token').value = ''; void poll(); });
$('logout').onclick = () => { token = ''; revision = null; instances = []; $('dashboard').hidden = true; $('login').hidden = false; $('logout').hidden = true; $('connection').textContent = 'Disconnected'; $('connection').dataset.state = 'disconnected'; };
for (const id of ['host', 'search', 'active', 'hide-finished', 'hide-waiting', 'hide-offline']) $(id).addEventListener('input', render);
$('session-sort').addEventListener('change', event => { sortField = event.target.value; globalThis.localStorage?.setItem('agentdashboard-session-sort', sortField); render(); });
$('sort-direction').addEventListener('click', () => { sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'; globalThis.localStorage?.setItem('agentdashboard-session-sort-direction', sortDirection); render(); });
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
