import { buildSessionTree, classifySessions, compareSessions, isActiveCategory, isFinishedSubagentHidden, sessionMatchesSearch, sessionState } from './session-state.js';
const $ = id => document.getElementById(id);
let token = '', instances = [], revision = null, pending = false, authRequired = false;
let notificationEnabled = false, initializedAttention = false;
let nativeNotificationActionRegistered = false;
let transcriptOptIn = false, transcriptAccessToken = '';
const transcriptStates = new Map();
const transcriptRequestsInFlight = new Set();
const transcriptRequestIds = new Map();
const transcriptCancelled = new Set();
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
const expandedSessionGroups = new Set();
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
  toolActivity: ['Tool activity', 'activity-work'], fileChange: ['File change', 'activity-work'],
  compaction: ['Context compacted', 'activity-complete'],
};
function activityEvents(instance, sessionId) {
  return (Array.isArray(instance.events) ? instance.events : [])
    .filter(event => event?.sessionId === sessionId && eventKinds[event.kind] && Number.isFinite(Date.parse(event.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-5);
}
function toolExecutionSpans(instance, sessionId) {
  const calls = new Map();
  const allEvents = Array.isArray(instance.events) ? instance.events : [];
  const session = instance.sessions.find(candidate => candidate.id === sessionId);
  const deleted = allEvents.find(event => event?.sessionId === sessionId && event.kind === 'deleted');
  const terminated = Boolean(session?.archived || deleted || session?.status === 'idle');
  const terminatedAt = Number.isFinite(session?.archivedAt) ? session.archivedAt
    : deleted?.timestamp || (session?.status === 'idle' ? session.stateChangedAt : undefined);
  const events = allEvents.filter(event =>
    event?.sessionId === sessionId && event.kind === 'toolActivity' && event.toolCallId && event.messageId && Number.isFinite(Date.parse(event.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const event of events) {
    const key = `${event.messageId}\0${event.toolCallId}`;
    if (!calls.has(key)) calls.set(key, { toolName: event.attributes?.toolName });
    const call = calls.get(key);
    call.callId = event.toolCallId;
    if (event.attributes?.toolName) call.toolName = event.attributes.toolName;
    if (event.attributes?.toolStatus) call.toolStatus = event.attributes.toolStatus;
    if (event.outcome === 'started' && !call.start) call.start = event;
    if (['completed', 'failure', 'cancelled'].includes(event.outcome)) call.finish = event;
  }
  return [...calls.values()].map(call => {
    const startAt = call.start?.timestampSource === 'source' ? Date.parse(call.start.timestamp) : undefined;
    const endAt = call.finish?.timestampSource === 'source' ? Date.parse(call.finish.timestamp) : undefined;
    const ongoingCall = !call.finish && call.toolStatus !== 'pending';
    const observedUntil = !ongoingCall ? undefined : Number.isFinite(terminatedAt) ? terminatedAt
      : terminatedAt ? Date.parse(terminatedAt) : terminated ? instance.lastSeen : instance.online ? Date.now() : instance.lastSeen;
    const durationOngoing = ongoingCall && !terminated && instance.online && Number.isFinite(startAt);
    return {
      toolName: call.toolName,
      callId: call.callId,
      toolStatus: call.toolStatus,
      outcome: call.finish?.outcome,
      started: Boolean(call.start),
      startObservedAt: call.start?.timestamp,
      endObservedAt: call.finish?.timestamp || (terminated ? terminatedAt : undefined),
      startSource: call.start?.timestampSource,
      endSource: call.finish?.timestampSource || (terminated ? 'observed' : undefined),
      durationMs: Number.isFinite(startAt) && Number.isFinite(endAt) && endAt >= startAt ? endAt - startAt
        : ongoingCall && Number.isFinite(startAt) && Number.isFinite(observedUntil) && observedUntil >= startAt ? observedUntil - startAt : undefined,
      durationOngoing,
      incompleteReason: !call.finish && terminated ? 'session ended' : !call.finish && !instance.online ? 'connection lost' : undefined,
    };
  });
}
function delegationLifecycle(instance, child) {
  const lifecycle = (Array.isArray(instance.events) ? instance.events : []).filter(event =>
    event?.sessionId === child.id && ['created', 'deleted'].includes(event.kind) && Number.isFinite(Date.parse(event.timestamp)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const segments = [];
  for (const event of lifecycle) {
    if (event.kind === 'created') segments.push({ start: event, end: undefined });
    else {
      const active = [...segments].reverse().find(segment => !segment.end && Date.parse(event.timestamp) >= Date.parse(segment.start.timestamp));
      if (active) active.end = event;
    }
  }
  const latest = segments.at(-1);
  const parentId = child.parentID;
  const parentToolCalls = parentId ? toolExecutionSpans(instance, parentId) : [];
  const delegationId = latest?.start.attributes?.delegationId;
  const taskCall = delegationId ? parentToolCalls.find(call => call.callId === delegationId) : undefined;
  const dispatchDelay = taskCall?.startSource === 'source' && latest?.start.timestampSource === 'source'
    ? Date.parse(latest.start.timestamp) - Date.parse(taskCall.startObservedAt) : undefined;
  const startAt = latest?.start.timestamp;
  const endAt = latest?.end?.timestamp;
  const durationMs = startAt && endAt ? Math.max(0, Date.parse(endAt) - Date.parse(startAt)) : undefined;
  const sourceTimed = latest?.start.timestampSource === 'source' && latest?.end?.timestampSource === 'source';
  return { latest, segments, delegationId, taskCall, dispatchDelay, durationMs, sourceTimed };
}
function lifecycleMarkers(instance, session, descendants) {
  const events = Array.isArray(instance.events) ? instance.events : [];
  const markers = events.filter(event => event?.sessionId === session.id && ['created', 'deleted'].includes(event.kind) && Number.isFinite(Date.parse(event.timestamp)))
    .map(event => ({ timestamp: event.timestamp, kind: event.kind }));
  if (!session.parentID) {
    const childEnds = events.filter(event => event?.kind === 'deleted' && descendants.some(child => child.id === event.sessionId && child.parentID === session.id));
    for (const end of childEnds) {
      const resumed = events.filter(event => event?.sessionId === session.id && event.kind === 'busy' && Date.parse(event.timestamp) > Date.parse(end.timestamp))
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0];
      if (resumed) markers.push({ timestamp: resumed.timestamp, kind: 'parent-resumed' });
    }
  }
  return markers;
}
function sessionFileChanges(instance, sessionId) {
  const events = (Array.isArray(instance.events) ? instance.events : []).filter(event =>
    event?.sessionId === sessionId && event.kind === 'fileChange' && event.attributes?.fileKey);
  let snapshotIndex = -1, snapshotId;
  for (let index = 0; index < events.length; index++) if (events[index].attributes.changeType === 'snapshot' && events[index].attributes.fileKey === '__snapshot__') {
    snapshotIndex = index; snapshotId = events[index].attributes.snapshotId;
  }
  const files = new Map();
  events.forEach((event, index) => {
    const attributes = event.attributes;
    if (attributes.fileKey === '__snapshot__') return;
    const belongsToLatestSnapshot = snapshotId && attributes.changeType === 'snapshot' && attributes.snapshotId === snapshotId;
    const isLaterIncremental = snapshotIndex >= 0 && index > snapshotIndex && attributes.changeType === 'incremental';
    if (snapshotIndex >= 0 ? !belongsToLatestSnapshot && !isLaterIncremental : attributes.changeType === 'snapshot') return;
    files.set(attributes.fileKey, { path: attributes.path, additions: attributes.additions, deletions: attributes.deletions });
  });
  const changes = [...files.values()];
  const additions = changes.filter(change => Number.isSafeInteger(change.additions));
  const deletions = changes.filter(change => Number.isSafeInteger(change.deletions));
  return {
    files: changes,
    additions: additions.reduce((sum, change) => sum + change.additions, 0),
    deletions: deletions.reduce((sum, change) => sum + change.deletions, 0),
    countsPartial: additions.length < changes.length || deletions.length < changes.length,
    historyPartial: Boolean(instance.eventsPartial),
  };
}
function modelTransitions(instance, sessionId) {
  const seen = new Set();
  const snapshots = (Array.isArray(instance.events) ? instance.events : []).filter(event => {
    if (event?.sessionId !== sessionId || event.kind !== 'modelSnapshot' || !event.attributes?.providerId || !event.attributes?.modelId || !Number.isFinite(Date.parse(event.timestamp))) return false;
    const key = event.id || event.messageId;
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  }).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const transitions = [];
  let previous;
  for (const event of snapshots) {
    const model = { providerId: event.attributes.providerId, modelId: event.attributes.modelId, variant: event.attributes.variant };
    if (previous && (previous.providerId !== model.providerId || previous.modelId !== model.modelId || previous.variant !== model.variant)) {
      transitions.push({ previous, next: model, timestamp: event.timestamp, timestampSource: event.timestampSource });
    }
    previous = model;
  }
  return transitions;
}
function formatDuration(milliseconds) {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms`
    : milliseconds < 60000 ? `${(milliseconds / 1000).toFixed(1)} s` : `${(milliseconds / 60000).toFixed(1)} min`;
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
  const rows = [parent, ...descendants].map(session => ({ session, intervals: intervals.filter(item => item.sessionId === session.id),
    lifecycle: lifecycleMarkers(instance, session, descendants) }));
  const compactions = rows.map(row => ({ ...row, events: (Array.isArray(instance.events) ? instance.events : []).filter(event =>
    event?.sessionId === row.session.id && event.kind === 'compaction' && Number.isFinite(Date.parse(event.timestamp))) }));
  const intervalEnd = (item, session) => item.endAt ? Date.parse(item.endAt)
    : session.archived ? (session.archivedAt || Date.parse(item.startAt))
      : instance.online ? Date.now() : (instance.lastSeen || Date.parse(item.startAt));
  const relevant = rows.flatMap(row => row.intervals.filter((item, index, list) =>
    !(item.status === 'idle' && index === list.length - 1 && item.endAt === null)));
  details.append(el('summary', 'Execution timeline', 'execution-heading'));
  const observedCompactions = compactions.flatMap(row => row.events);
  const observedLifecycle = rows.flatMap(row => row.lifecycle);
  if (!relevant.length && !observedCompactions.length && !observedLifecycle.length) {
    const message = !instance.timeline
      ? 'Timeline unavailable: this report does not include timeline history.'
      : instance.timeline.partial
        ? 'Partial history: no observed state transitions are available in the retained event history.'
        : 'No observed state transitions in the retained event history.';
    details.append(el('p', message, 'timeline-message'));
    return details;
  }
  const relevantSet = new Set(relevant);
  const times = [
    ...rows.flatMap(row => row.intervals.filter(item => relevantSet.has(item))
      .flatMap(item => [Date.parse(item.startAt), intervalEnd(item, row.session)])),
    ...observedCompactions.map(event => Date.parse(event.timestamp)),
    ...observedLifecycle.map(event => Date.parse(event.timestamp)),
  ].filter(Number.isFinite);
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
    for (const event of compactions.find(item => item.session.id === row.session.id)?.events || []) {
      const marker = el('span', undefined, 'timeline-compaction-marker');
      marker.setAttribute('aria-label', `Context compacted at ${formatTimestamp(event.timestamp)}`);
      marker.title = `Context compacted · ${formatTimestamp(event.timestamp)}`;
      marker.dataset.time = String(Date.parse(event.timestamp));
      marker.style.left = `${Math.max(0, (Date.parse(event.timestamp) - min) / span * 100)}%`;
      track.append(marker);
    }
    for (const event of row.lifecycle) {
      const marker = el('span', undefined, `timeline-lifecycle-marker timeline-lifecycle-${event.kind}`);
      const label = event.kind === 'created' ? 'Session start observed' : event.kind === 'deleted' ? 'Session end observed'
        : 'Parent activity observed after child end; causal linkage unavailable';
      marker.setAttribute('aria-label', `${label} at ${formatTimestamp(event.timestamp)}`);
      marker.title = `${label} · ${formatTimestamp(event.timestamp)}`;
      marker.dataset.time = String(Date.parse(event.timestamp));
      marker.style.left = `${Math.max(0, (Date.parse(event.timestamp) - min) / span * 100)}%`;
      track.append(marker);
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
  const compactionLegend = el('span', undefined, 'timeline-legend-item');
  compactionLegend.append(el('span', undefined, 'timeline-compaction-swatch'), el('span', 'Compaction'));
  legend.append(compactionLegend);
  const lifecycleLegend = el('span', undefined, 'timeline-legend-item');
  lifecycleLegend.append(el('span', undefined, 'timeline-lifecycle-swatch'), el('span', 'Session lifecycle'));
  legend.append(lifecycleLegend);
  const disclosure = el('details', undefined, 'timeline-details');
  disclosure.append(el('summary', 'Show interval details'), list);
  details.append(legend, disclosure);
  details.append(el('p', instance.timeline?.partial
    ? `Partial history: earlier transitions may be missing or truncated; earliest known event ${formatTimestamp(min)}.`
    : !relevant.length ? 'Lifecycle/compaction markers show observed events; state intervals are unavailable.'
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
      for (const marker of track.querySelectorAll('.timeline-compaction-marker')) {
        const time = Number(marker.dataset.time);
        marker.hidden = time < visibleStart || time > visibleEnd;
        marker.style.left = `${Math.min(100, Math.max(0, (time - visibleStart) / visibleSpan * 100))}%`;
      }
      for (const marker of track.querySelectorAll('.timeline-lifecycle-marker')) {
        const time = Number(marker.dataset.time);
        marker.hidden = time < visibleStart || time > visibleEnd;
        marker.style.left = `${Math.min(100, Math.max(0, (time - visibleStart) / visibleSpan * 100))}%`;
      }
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
  if (session.lastCompactedAt) {
    const estimateAt = Date.parse(session.contextEstimateAt), compactedAt = Date.parse(session.lastCompactedAt);
    const note = Number.isFinite(estimateAt) && compactedAt > estimateAt
      ? `Compaction observed at ${formatTimestamp(session.lastCompactedAt)} after the latest context estimate; post-compaction usage is pending. Savings are not measured.`
      : Number.isFinite(estimateAt)
        ? `Compaction observed at ${formatTimestamp(session.lastCompactedAt)}; latest estimate is from ${formatTimestamp(session.contextEstimateAt)}. Savings are not measured.`
        : `Compaction observed at ${formatTimestamp(session.lastCompactedAt)}; context estimate unavailable.`;
    metrics.append(el('p', note, 'compaction-context'));
  }
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
    const workspaceRootId = i.sessions.find(session => !session.parentID && i.sessions.some(child => child.parentID === session.id))?.id
      || i.sessions.find(session => !session.parentID)?.id;
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
      container.open = expandedAgents.has(key);
      container.addEventListener('toggle', () => {
        if (container.open) expandedAgents.add(key);
        else expandedAgents.delete(key);
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
       if (!s.parentID && i.unassignedFileCount) info.append(el('p', `Workspace changes not attributed to a session · ${i.unassignedFileChangesPartial ? 'at least ' : ''}${i.unassignedFileCount} file${i.unassignedFileCount === 1 ? '' : 's'}`, 'unassigned-changes'));
       if (s.status === 'retry') {
         const elapsed = Number.isFinite(Date.parse(s.stateChangedAt)) ? formatDuration(Math.max(0, Date.now() - Date.parse(s.stateChangedAt))) : undefined;
         const deadline = s.retry?.nextRetryAt, wait = Number.isFinite(Date.parse(deadline)) ? Date.parse(deadline) - Date.now() : undefined;
         const retryText = `Retrying · attempt ${s.retry?.attempt ?? 'unavailable'}${elapsed ? ` · ${elapsed} in retry state` : ''}` +
           (deadline ? wait > 0 ? ` · next retry in ${formatDuration(wait)}` : ` · next retry deadline ${formatTimestamp(deadline)}` : ' · next retry time unavailable');
         info.append(el('p', retryText, 'retry-context'));
       }
       if (s.status === 'error') info.append(el('p', `Last safe error category · ${s.errorCategory || 'unavailable'}`, 'error-context'));
       if (s.permissions?.length) {
         const pendingPermissions = s.permissions.filter(permission => permission.status === 'pending').length;
         const permissionDetails = el('details', undefined, 'permission-details');
         permissionDetails.append(el('summary', `Permissions · ${pendingPermissions} waiting`, 'permission-summary'));
         const permissionList = el('ul', undefined, 'permission-list');
         for (const permission of s.permissions) {
           const item = el('li', undefined, 'permission-item');
           const title = permission.title || 'Permission details unavailable';
           item.append(el('strong', `${title} · ${permission.type || 'type unavailable'}`));
           if (permission.status === 'pending') {
             const observedAt = Date.parse(permission.requestedAt);
             const clock = i.online ? Date.now() : i.lastSeen;
             const elapsed = Number.isFinite(observedAt) && Number.isFinite(clock) ? formatDuration(Math.max(0, clock - observedAt)) : undefined;
             item.append(el('small', `${i.online ? 'Waiting' : 'Unresolved · agent offline'}${elapsed ? ` · ${elapsed}` : ' · elapsed time unavailable'}${permission.timestampSource === 'observed' ? ' · request time observed locally' : ''}`));
           } else if (permission.status === 'responded') {
             item.append(el('small', permission.resolution === 'approved' ? 'Responded · approved' : permission.resolution === 'rejected' ? 'Responded · rejected' : 'Responded · result unavailable'));
           } else item.append(el('small', permission.status === 'ended' ? 'Session ended before reply was observed' : 'Resolution unknown'));
           permissionList.append(item);
         }
         permissionDetails.append(permissionList); info.append(permissionDetails);
       }
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
          if (event.attributes?.permissionTitle) item.append(el('span', `${event.attributes.permissionTitle} · ${event.attributes.permissionType || 'permission type unavailable'}`, 'activity-detail'));
          if (event.kind === 'fileChange' && event.attributes?.fileKey !== '__snapshot__') {
            const details = [event.attributes?.path || 'File path unavailable'];
            if (Number.isSafeInteger(event.attributes?.additions)) details.push(`+${event.attributes.additions}`);
            if (Number.isSafeInteger(event.attributes?.deletions)) details.push(`−${event.attributes.deletions}`);
            item.append(el('span', details.join(' · '), 'activity-detail'));
          }
          list.append(item);
        }
        activity.append(list);
      }
      const toolCalls = toolExecutionSpans(i, s.id);
      let toolDetails;
      if (toolCalls.length) {
        const completedDurations = toolCalls.filter(call => !call.durationOngoing && Number.isFinite(call.durationMs));
        const activeDurations = toolCalls.filter(call => call.durationOngoing && Number.isFinite(call.durationMs));
        const failures = toolCalls.filter(call => call.outcome === 'failure').length;
        const active = toolCalls.filter(call => !call.outcome && (call.toolStatus === 'running' || call.started && call.toolStatus !== 'pending')).length;
        const pending = toolCalls.filter(call => !call.outcome && call.toolStatus === 'pending').length;
        const longRunning = toolCalls.filter(call => Number.isFinite(call.durationMs) && call.durationMs >= 60000).length;
        toolDetails = el('details', undefined, 'tool-spans');
        const recordedDuration = completedDurations.length
          ? ` · recorded ${formatDuration(completedDurations.reduce((sum, call) => sum + call.durationMs, 0))}${completedDurations.length < toolCalls.length ? ' · partial' : ''}` : '';
        const activeDuration = activeDurations.length
          ? ` · active elapsed ${formatDuration(activeDurations.reduce((sum, call) => sum + call.durationMs, 0))}` : '';
        toolDetails.append(el('summary', `Tool calls · ${toolCalls.length}${failures ? ` · ${failures} failed` : ''}${pending ? ` · ${pending} pending` : ''}${active ? ` · ${active} active` : ''}${longRunning ? ` · ${longRunning} long-running` : ''}${recordedDuration}${activeDuration}${i.eventsPartial ? ' · history partial' : ''}`, 'tool-spans-summary'));
        if (i.eventsPartial) toolDetails.append(el('p', 'Some tool events may have been truncated; unavailable starts or outcomes are not inferred.', 'timeline-message'));
        const byTool = new Map();
        for (const call of toolCalls) {
          const name = call.toolName || 'Tool unavailable';
          if (!byTool.has(name)) byTool.set(name, []);
          byTool.get(name).push(call);
        }
        const categories = el('ul', undefined, 'tool-category-summary');
        for (const [name, calls] of byTool) {
          const known = calls.filter(call => Number.isFinite(call.durationMs) && !call.durationOngoing);
          const duration = known.length
            ? ` · recorded ${formatDuration(known.reduce((sum, call) => sum + call.durationMs, 0))}${known.length < calls.length ? ' · partial' : ''}` : '';
          categories.append(el('li', `${name} · ${calls.length} call${calls.length === 1 ? '' : 's'}${duration}`));
        }
        toolDetails.append(categories);
        if (toolCalls.length > 100) toolDetails.append(el('p', 'Showing the latest 100 calls.', 'timeline-message'));
        const toolList = el('ol', undefined, 'tool-span-list');
        for (const call of toolCalls.slice(-100)) {
          const item = el('li', undefined, 'tool-span');
          const result = call.outcome === 'completed' ? 'Completed' : call.outcome === 'failure' ? 'Failed'
            : call.outcome === 'cancelled' ? 'Cancelled' : call.incompleteReason ? `Incomplete · ${call.incompleteReason}`
              : call.toolStatus === 'pending' ? 'Pending' : 'Running';
          const label = `${call.toolName || 'Tool'} · ${result}${call.durationMs === undefined ? '' : ` · ${formatDuration(call.durationMs)}${call.durationOngoing ? ' so far' : ''}`}`;
          item.append(el('span', label));
          const times = [];
          if (call.startObservedAt) times.push(call.startSource === 'source'
            ? `started ${formatTimestamp(call.startObservedAt)}` : `start time unavailable · first observed ${formatTimestamp(call.startObservedAt)}`);
          else times.push('start time unavailable');
          if (call.endObservedAt) times.push(call.endSource === 'source'
            ? `ended ${formatTimestamp(call.endObservedAt)}` : `end time unavailable · last observed ${formatTimestamp(call.endObservedAt)}`);
          else if (!call.outcome) times.push('end time unavailable');
          item.append(el('small', times.join(' · ')));
          toolList.append(item);
        }
        toolDetails.append(toolList);
      }
      const fileChanges = sessionFileChanges(i, s.id);
      let fileDetails;
      if (fileChanges.files.length) {
        fileDetails = el('details', undefined, 'file-changes');
        const additions = fileChanges.files.every(change => Number.isSafeInteger(change.additions)) ? fileChanges.additions : 'unavailable';
        const deletions = fileChanges.files.every(change => Number.isSafeInteger(change.deletions)) ? fileChanges.deletions : 'unavailable';
        const stats = ` · +${additions} / −${deletions}${fileChanges.countsPartial ? ' lines partial' : ''}`;
        fileDetails.append(el('summary', `File changes · ${fileChanges.files.length}${stats}${fileChanges.historyPartial ? ' · history partial' : ''}`, 'file-changes-summary'));
        if (fileChanges.historyPartial) fileDetails.append(el('p', 'File-change history may be incomplete.', 'timeline-message'));
        const list = el('ul', undefined, 'file-change-list');
        for (const change of fileChanges.files) {
          const count = Number.isSafeInteger(change.additions) || Number.isSafeInteger(change.deletions)
            ? ` · +${change.additions ?? 'unavailable'} / −${change.deletions ?? 'unavailable'}` : '';
          list.append(el('li', `${change.path || 'File path unavailable'}${count}`));
        }
        fileDetails.append(list);
      }
      const state = el('div', undefined, 'session-state');
      state.append(el('small', s.agent || (s.parentID ? 'subagent' : 'agent'))); row.append(info, state); card.append(row, activity);
      if (toolDetails) card.append(toolDetails);
      if (fileDetails) card.append(fileDetails);
      const changes = modelTransitions(i, s.id);
      if (changes.length) {
        const modelDetails = el('details', undefined, 'model-history');
        modelDetails.append(el('summary', `Model changes · ${changes.length}${i.eventsPartial ? ' · history partial' : ''}`, 'model-history-summary'));
        if (i.eventsPartial) modelDetails.append(el('p', 'Earlier model transitions may be unavailable.', 'timeline-message'));
        const list = el('ol', undefined, 'model-history-list');
        for (const change of changes) {
          const previous = `${change.previous.providerId}/${change.previous.modelId}${change.previous.variant ? ` · ${change.previous.variant}` : ''}`;
          const next = `${change.next.providerId}/${change.next.modelId}${change.next.variant ? ` · ${change.next.variant}` : ''}`;
          const time = change.timestampSource === 'source' ? formatTimestamp(change.timestamp) : `observed ${formatTimestamp(change.timestamp)}`;
          list.append(el('li', `${previous} → ${next} · ${time}`));
        }
        modelDetails.append(list); card.append(modelDetails);
      }
      if (s.parentID) {
        const lifecycle = delegationLifecycle(i, s);
        const delegationDetails = el('details', undefined, 'delegation-lifecycle');
        delegationDetails.append(el('summary', `Child lifecycle · ${lifecycle.segments.length} observed run${lifecycle.segments.length === 1 ? '' : 's'}`, 'delegation-summary'));
        const lifecycleList = el('ul', undefined, 'delegation-lifecycle-list');
        if (!lifecycle.segments.length) lifecycleList.append(el('li', 'Start time unavailable · session restored or created before observed history'));
        for (const segment of lifecycle.segments) {
          const startText = segment.start.timestampSource === 'source' ? `Start ${formatTimestamp(segment.start.timestamp)}`
            : `First observed ${formatTimestamp(segment.start.timestamp)}`;
          const endText = segment.end ? segment.end.timestampSource === 'source'
            ? `finish ${formatTimestamp(segment.end.timestamp)}` : `last observed ${formatTimestamp(segment.end.timestamp)}` : 'Finish not observed';
          const duration = segment.end ? Math.max(0, Date.parse(segment.end.timestamp) - Date.parse(segment.start.timestamp)) : undefined;
          const timing = duration === undefined ? '' : ` · ${lifecycle.sourceTimed ? 'source-timed interval' : 'observed lifecycle span'} ${formatDuration(duration)}`;
          lifecycleList.append(el('li', `${startText} · ${endText}${timing}`));
        }
        if (lifecycle.taskCall) lifecycleList.append(el('li', `Explicitly linked to task call ${lifecycle.delegationId}${lifecycle.dispatchDelay >= 0 ? ` · dispatch-to-start ${formatDuration(lifecycle.dispatchDelay)}` : ''}`));
        else lifecycleList.append(el('li', 'Task-call correlation unavailable; parent relationship is observed from session metadata'));
        delegationDetails.append(lifecycleList); card.append(delegationDetails);
      }
      const transcriptKey = `${i.instanceId}:${s.id}`;
      const transcriptState = transcriptStates.get(transcriptKey);
      const transcript = el('details', undefined, 'session-transcript');
      transcript.dataset.agentKey = `transcript:${transcriptKey}`;
      const transcriptSummary = transcriptState?.status === 'ready'
        ? `Session log · ${transcriptState.messages.length} messages${transcriptState.partial ? ' · partial' : ''}`
        : !i.transcriptEnabled ? 'Session log · unavailable on this plugin'
          : transcriptState?.status === 'loading' ? 'Session log · loading'
            : 'Session log · collapsed; expands on explicit request';
      transcript.append(el('summary', transcriptSummary, 'session-transcript-summary'));
      transcript.addEventListener('toggle', () => {
        if (transcript.open && transcriptState?.status !== 'ready' && transcriptState?.status !== 'loading') void loadSessionTranscript(i, s);
        else if (!transcript.open && transcriptRequestsInFlight.has(transcriptKey)) void cancelSessionTranscript(i, s);
      });
      if (transcriptState?.message) transcript.append(el('p', transcriptState.message, 'transcript-status'));
      if (transcriptState?.status === 'ready') {
        const messages = el('ol', undefined, 'transcript-messages');
        for (const message of transcriptState.messages) {
          const item = el('li', undefined, 'transcript-message');
          const time = message.timestamp ? ` · ${formatTimestamp(message.timestamp)}` : ' · time unavailable';
          item.append(el('strong', `${message.role}${time}`));
          for (const part of message.parts) {
            if (part.type === 'text') item.append(el('p', part.text, 'transcript-text'));
            else if (part.type === 'tool') item.append(el('p', `Tool ${part.name} · ${part.status}`, 'transcript-tool'));
            else item.append(el('p', 'Attachment content unavailable in the session log view.', 'transcript-status'));
          }
          messages.append(item);
        }
        transcript.append(messages);
      }
      card.append(transcript);
      if (i.git?.root && !s.parentID) {
        const details = el('details'); details.dataset.instance = i.instanceId; details.append(el('summary', gitSummary(i.git)));
        const grid = el('div', undefined, 'git-grid');
        for (const [key, label] of [['status', 'Status'], ['log', 'Recent commits'], ['worktrees', 'Worktrees']]) { const block = el('section'); block.append(el('h4', label), el('pre', typeof i.git[key] === 'string' ? i.git[key] || 'Clean / empty' : 'Waiting for Git snapshot')); grid.append(block); }
        details.append(grid); card.append(details);
      }
      if (!s.parentID && s.id === workspaceRootId && i.mcpHealth) {
        const health = i.mcpHealth, servers = Array.isArray(health.servers) ? health.servers : [];
        const healthDetails = el('details', undefined, 'mcp-health');
        let summary = health.status === 'unsupported' ? 'Workspace MCP status unavailable in this SDK'
          : health.status === 'unavailable' ? 'Workspace MCP status temporarily unavailable'
            : servers.length ? `Workspace MCP servers · ${servers.filter(server => server.state === 'connected').length} connected · ${servers.filter(server => server.state === 'failed').length} failed · ${servers.filter(server => server.state === 'auth-required').length} auth required`
              : 'Workspace MCP servers · none reported';
        if (health.partial) summary += ' · partial';
        healthDetails.append(el('summary', summary, 'mcp-health-summary'));
        const list = el('ul', undefined, 'mcp-health-list');
        for (const server of servers) {
          const change = server.lastTransitionAt ? ` · last observed ${formatTimestamp(server.lastTransitionAt)}` : '';
          list.append(el('li', `${server.name} · ${server.state}${change}`));
        }
        if (health.status === 'unavailable') healthDetails.append(el('p', 'The MCP status query failed; agent execution was not interrupted.', 'timeline-message'));
        healthDetails.append(list); card.append(healthDetails);
      }
      if (!s.parentID && s.id === workspaceRootId && i.lspHealth) {
        const health = i.lspHealth, lsp = health.lsp || {}, formatter = health.formatter || {}, diagnostics = health.diagnostics;
        const lspServers = Array.isArray(lsp.servers) ? lsp.servers : [], formatters = Array.isArray(formatter.formatters) ? formatter.formatters : [];
        const healthDetails = el('details', undefined, 'lsp-health');
        const lspSummary = lsp.status === 'unsupported' ? 'LSP unavailable in this SDK'
          : lsp.status === 'unavailable' ? 'LSP status temporarily unavailable'
            : `LSP · ${lspServers.filter(server => server.state === 'connected').length} connected · ${lspServers.filter(server => server.state === 'failed').length} failed`;
        const formatterSummary = formatter.status === 'unsupported' || formatter.status === 'unavailable'
          ? 'formatter status unavailable' : `${formatters.filter(item => item.state === 'available').length} formatters available`;
        const diagnosticSummary = !diagnostics?.available ? 'diagnostics unavailable'
          : `${diagnostics.errors + diagnostics.warnings + diagnostics.information + diagnostics.hints} diagnostics${diagnostics.partial ? ' · partial' : ''}`;
        healthDetails.append(el('summary', `Workspace health · ${lspSummary} · ${formatterSummary} · ${diagnosticSummary}`, 'lsp-health-summary'));
        const list = el('ul', undefined, 'lsp-health-list');
        for (const server of lspServers) list.append(el('li', `LSP ${server.name} · ${server.state}${server.lastTransitionAt ? ` · last observed ${formatTimestamp(server.lastTransitionAt)}` : ''}`));
        for (const item of formatters) list.append(el('li', `Formatter ${item.name} · ${item.state}`));
        if (diagnostics?.available) list.append(el('li', `Diagnostics · ${diagnostics.errors} errors · ${diagnostics.warnings} warnings · ${diagnostics.information} information · ${diagnostics.hints} hints`));
        if (lsp.status === 'unavailable' || formatter.status === 'unavailable') healthDetails.append(el('p', 'An environment status query failed; agent execution was not interrupted.', 'timeline-message'));
        healthDetails.append(list); card.append(healthDetails);
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
    section.open = expandedSessionGroups.has(id);
    section.addEventListener('toggle', () => section.open ? expandedSessionGroups.add(id) : expandedSessionGroups.delete(id));
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
function safeNotificationLabel(session) {
  const title = typeof session.title === 'string' ? session.title.trim().replace(/\s+/g, ' ') : '';
  if (!title || title.length > 80 || /[\\/]|https?:|\b(token|password|secret|credential|command|authorization)\b/i.test(title)) {
    return session.parentID ? 'Subagent' : 'Agent';
  }
  return title;
}
function attentionReason(session, now = Date.now()) {
  if (session.status === 'waiting') {
    const pending = (session.permissions || []).filter(permission => permission.status === 'pending');
    const preview = pending.slice(0, 2).map(permission => permission.title || permission.type).filter(Boolean).join(', ');
    return { signature: `waiting:${pending.map(permission => permission.id || `${permission.type}:${permission.requestedAt}`).sort().join(',')}`,
      reason: preview ? `Permission required · ${preview}` : 'Permission required · details unavailable' };
  }
  if (session.status === 'error') {
    const category = session.errorCategory || 'unavailable';
    return { signature: `error:${category}`, reason: `Error · ${category}` };
  }
  if (session.status === 'retry') {
    const deadline = Date.parse(session.retry?.nextRetryAt);
    const elapsed = Date.parse(session.stateChangedAt);
    const scheduledLong = Number.isFinite(deadline) && deadline - now >= 60000;
    const retryingLong = Number.isFinite(elapsed) && now - elapsed >= 60000;
    if (scheduledLong) return { signature: 'retry:long', reason: `Retry scheduled for ${formatTimestamp(session.retry.nextRetryAt)}` };
    if (retryingLong) return { signature: 'retry:long', reason: `Retrying for ${formatDuration(now - elapsed)}` };
  }
  return undefined;
}
function rootSessionFor(instance, session) {
  let current = session, visited = new Set();
  while (current.parentID && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = instance.sessions.find(candidate => candidate.id === current.parentID);
    if (!parent) break;
    current = parent;
  }
  return current;
}
async function dispatchAttentionNotification(title, body, tag) {
  if (!notificationEnabled) return;
  const tauriNotification = globalThis.__TAURI__?.notification;
  if (tauriNotification?.sendNotification && tauriNotification?.isPermissionGranted) {
    try {
      let granted = await tauriNotification.isPermissionGranted();
      if (!granted) granted = (await tauriNotification.requestPermission()) === 'granted';
      if (granted) { registerNativeNotificationActions(); tauriNotification.sendNotification({ title, body }); }
      return;
    } catch { return; }
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => { focusDashboard(); notification.close(); };
  } catch {}
}
function focusDashboard() {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (invoke) void invoke('focus_dashboard').catch(() => {});
  else { window.focus(); $('main')?.focus?.(); }
}
async function requestNotificationPermission() {
  const native = globalThis.__TAURI__?.notification;
  if (native?.isPermissionGranted && native?.requestPermission) {
    try {
      let granted = await native.isPermissionGranted();
      if (!granted) granted = (await native.requestPermission()) === 'granted';
      return Boolean(granted);
    } catch { return false; }
  }
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'default') return (await Notification.requestPermission()) === 'granted';
  return Notification.permission === 'granted';
}
function registerNativeNotificationActions() {
  const onAction = globalThis.__TAURI__?.notification?.onAction;
  if (onAction && !nativeNotificationActionRegistered) {
    nativeNotificationActionRegistered = true;
    void onAction(() => focusDashboard()).catch(() => { nativeNotificationActionRegistered = false; });
  }
}
function updateAttentionNotifications(nextInstances) {
  let count = 0;
  const currentStatuses = new Map(), retained = new Set(), alertsByRoot = new Map();
  for (const instance of nextInstances) {
    for (const session of instance.sessions) {
      const identity = `${instance.instanceId}:${session.id}`;
      retained.add(identity);
      if (!instance.online) continue;
      const attention = session.status === 'waiting' || session.status === 'error' || Boolean(attentionReason(session));
      if (attention) count++;
      const notice = attentionReason(session);
      if (!notice) { currentStatuses.set(identity, `status:${session.status}`); continue; }
      currentStatuses.set(identity, notice.signature);
      const previous = previousStatuses.get(identity);
      if (!initializedAttention || previous === notice.signature) continue;
      const root = rootSessionFor(instance, session), rootIdentity = `${instance.instanceId}:${root.id}`;
      if (!alertsByRoot.has(rootIdentity)) alertsByRoot.set(rootIdentity, { root, entries: new Map() });
      alertsByRoot.get(rootIdentity).entries.set(identity, { session, reason: notice.reason });
    }
  }
  for (const identity of previousStatuses.keys()) if (!retained.has(identity)) previousStatuses.delete(identity);
  for (const [identity, signature] of currentStatuses) previousStatuses.set(identity, signature);
  initializedAttention = true;
  if ($('tab-count')?.checked) document.title = count ? `(${count}) ${originalTitle}` : originalTitle;
  for (const [rootIdentity, alert] of alertsByRoot) {
    const entries = [...alert.entries.values()];
    const body = entries.slice(0, 3).map(({ session, reason }) => `${safeNotificationLabel(session)}: ${reason}`).join(' · ');
    const title = `${safeNotificationLabel(alert.root)} needs attention`;
    void dispatchAttentionNotification(title, body, rootIdentity);
  }
}
async function loadSessionTranscript(instance, session) {
  const key = `${instance.instanceId}:${session.id}`;
  if (transcriptRequestsInFlight.has(key) || transcriptStates.get(key)?.status === 'ready') return;
  transcriptCancelled.delete(key);
  if (!transcriptOptIn) transcriptStates.set(key, { status: 'blocked', message: 'Enable Session log access in Filter agents to request messages.' });
  else if (!transcriptAccessToken) transcriptStates.set(key, { status: 'blocked', message: 'Enter the separate session log access key in Filter agents.' });
  else if (!instance.transcriptEnabled) transcriptStates.set(key, { status: 'unavailable', message: 'Session logs are not enabled by the monitored OpenCode plugin.' });
  else {
    transcriptRequestsInFlight.add(key);
    transcriptStates.set(key, { status: 'loading', message: 'Requesting messages from the monitored instance…' });
    render();
    try {
      const headers = { 'content-type': 'application/json', 'x-agentdashboard-transcript-token': transcriptAccessToken };
      if (token) headers.authorization = `Bearer ${token}`;
      const request = await fetch('/api/transcript/request', {
        method: 'POST', headers, body: JSON.stringify({ instanceId: instance.instanceId, sessionId: session.id, limit: 50 }),
        signal: AbortSignal.timeout(4000),
      });
      if (request.status !== 202) throw new Error('unavailable');
      const { requestId, expiresAt } = await request.json();
      transcriptRequestIds.set(key, requestId);
      if (transcriptCancelled.has(key)) {
        await cancelSessionTranscript(instance, session);
        throw new Error('cancelled');
      }
      let result;
      while (Date.now() < expiresAt) {
        if (transcriptCancelled.has(key)) throw new Error('cancelled');
        await new Promise(resolve => setTimeout(resolve, 300));
        const response = await fetch(`/api/transcript/result?requestId=${encodeURIComponent(requestId)}`, {
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-agentdashboard-transcript-token': transcriptAccessToken },
          signal: AbortSignal.timeout(4000),
        });
        if (response.status === 200) { result = await response.json(); break; }
        if (response.status !== 202) throw new Error('unavailable');
      }
      if (!result) throw new Error('expired');
      transcriptStates.set(key, result.available ? { status: 'ready', ...result }
        : { status: 'unavailable', message: 'This OpenCode instance cannot provide session messages.' });
    } catch (error) {
      const cancelled = error.message === 'cancelled' || transcriptCancelled.has(key);
      transcriptStates.set(key, { status: cancelled ? 'cancelled' : 'unavailable', message: error.message === 'expired'
        ? 'Session log request expired; expand to try again.' : cancelled ? 'Session log request cancelled.' : 'Session log is unavailable from this instance.' });
    } finally {
      transcriptRequestsInFlight.delete(key);
      transcriptRequestIds.delete(key); transcriptCancelled.delete(key);
      render();
    }
    return;
  }
  render();
}
async function cancelSessionTranscript(instance, session) {
  const key = `${instance.instanceId}:${session.id}`;
  transcriptCancelled.add(key);
  transcriptStates.set(key, { status: 'cancelled', message: 'Cancelling session log request…' });
  const requestId = transcriptRequestIds.get(key);
  if (!requestId) return;
  const headers = { 'content-type': 'application/json', 'x-agentdashboard-transcript-token': transcriptAccessToken };
  if (token) headers.authorization = `Bearer ${token}`;
  await fetch('/api/transcript/cancel', { method: 'POST', headers,
    body: JSON.stringify({ requestId, instanceId: instance.instanceId, sessionId: session.id }), signal: AbortSignal.timeout(3000) }).catch(() => {});
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
    const attention = sessions.filter(session => attentionReason(session)).length;
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
  const native = globalThis.__TAURI__?.notification;
  if (!native?.sendNotification && !('Notification' in window)) {
    event.target.checked = false; notificationEnabled = false;
    $('notifications-help').textContent = 'Notifications are not supported in this browser or desktop webview.';
    return;
  }
  if (!await requestNotificationPermission()) {
    event.target.checked = false; notificationEnabled = false;
    $('notifications-help').textContent = 'Notification permission was not granted.';
  } else if (native?.sendNotification) registerNativeNotificationActions();
});
$('session-log-enabled').addEventListener('change', event => {
  transcriptOptIn = event.target.checked;
  if (!transcriptOptIn) transcriptStates.clear();
  render();
});
$('session-log-token').addEventListener('input', event => {
  if (transcriptAccessToken !== event.target.value) transcriptStates.clear();
  transcriptAccessToken = event.target.value;
});
$('tab-count').addEventListener('change', () => {
  if (!$('tab-count').checked) document.title = originalTitle;
  else {
    const count = instances.filter(i => i.online).flatMap(i => i.sessions).filter(s => attentionReason(s)).length;
    document.title = count ? `(${count}) ${originalTitle}` : originalTitle;
  }
});
void poll();
setInterval(poll, 2000);
