// Derive dashboard classifications without changing OpenCode's lifecycle values.
export const FINISHED_SUBAGENT_GRACE_MS = 60_000;

export function isFinishedSubagentHidden(session, { now = Date.now(), graceMs = FINISHED_SUBAGENT_GRACE_MS } = {}) {
  if (!session.parentID || session.status !== 'idle') return false;
  const idleSince = Date.parse(session.stateChangedAt);
  return Number.isFinite(idleSince) && now - idleSince >= graceMs;
}

export function classifySessions(sessions, online) {
  const classifications = new Map(sessions.map(session => {
    let category;
    if (!online) category = 'offline';
    else if (session.status === 'waiting' || session.status === 'error') category = 'needs-attention';
    else if (session.status === 'busy' || session.status === 'retry') category = 'working';
    else if (session.status === 'idle' && session.parentID) category = 'recently-finished';
    else if (session.status === 'idle') category = 'waiting-for-input';
    else category = 'unknown';
    return [session.id, { category, attentionRequired: category === 'needs-attention', childAttentionCount: 0 }];
  }));

  const children = new Map();
  for (const session of sessions) {
    if (!classifications.has(session.parentID)) continue;
    if (!children.has(session.parentID)) children.set(session.parentID, []);
    children.get(session.parentID).push(session.id);
  }

  const summarized = new Set();
  function summarize(id, visiting = new Set()) {
    if (summarized.has(id) || visiting.has(id)) return classifications.get(id)?.attentionRequired || false;
    const parent = classifications.get(id);
    if (!parent) return false;
    visiting.add(id);
    for (const childID of children.get(id) || []) {
      if (summarize(childID, visiting)) parent.childAttentionCount++;
    }
    visiting.delete(id);
    parent.attentionRequired ||= parent.childAttentionCount > 0;
    summarized.add(id);
    return parent.attentionRequired;
  }
  for (const session of sessions) summarize(session.id);
  return classifications;
}

export function buildSessionTree(sessions) {
  const nodes = new Map(sessions.map(session => [session.id, { session, children: [] }]));
  const roots = [];
  const parentById = new Map();
  for (const session of sessions) {
    if (nodes.has(session.parentID) && session.parentID !== session.id) parentById.set(session.id, session.parentID);
  }

  // Break one edge in each parent cycle, choosing the earliest session as its root.
  const settled = new Set();
  for (const session of sessions) {
    const path = [], positions = new Map();
    let id = session.id;
    while (parentById.has(id) && !settled.has(id)) {
      if (positions.has(id)) {
        const cycle = path.slice(positions.get(id));
        const root = cycle.reduce((first, candidate) => sessions.indexOf(nodes.get(candidate).session) < sessions.indexOf(nodes.get(first).session) ? candidate : first);
        parentById.delete(root);
        break;
      }
      positions.set(id, path.length); path.push(id); id = parentById.get(id);
    }
    path.forEach(item => settled.add(item));
  }

  for (const session of sessions) {
    const node = nodes.get(session.id), parentID = parentById.get(session.id);
    if (parentID && nodes.has(parentID)) nodes.get(parentID).children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function isActiveCategory(classification) {
  return classification?.category === 'working' || classification?.attentionRequired === true;
}

// Presentation maps derived categories to familiar dashboard labels/classes.
export function sessionState(session, online, classification) {
  const category = classification?.category ?? classifySessions([session], online).get(session.id).category;
  if (category === 'offline') return { label: 'Offline', className: '', activity: 'Disconnected · last reported activity below', detail: 'No recent heartbeat from this instance.' };
  if (category === 'recently-finished') return { label: 'Idle', className: 'finished', activity: 'Idle · available if recalled', detail: 'This subagent is idle and can run again if its parent resumes it.' };
  if (category === 'waiting-for-input') return { label: 'Waiting for input', className: 'input', activity: session.activity || 'Waiting for input', detail: 'This main agent is idle and ready for user input.' };
  if (category === 'needs-attention') return session.status === 'waiting'
    ? { label: 'Waiting for permission', className: 'permission', activity: session.activity || 'Waiting for permission', detail: 'Permission is required to continue.' }
    : { label: 'Error · attention required', className: 'permission', activity: session.activity || 'Session error', detail: 'This session encountered an error and needs attention.' };
  return { label: session.status, className: '', activity: session.activity || session.status || 'Unknown state', detail: 'Unrecognized OpenCode lifecycle state.' };
}
