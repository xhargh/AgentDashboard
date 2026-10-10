// Interpret OpenCode's idle state for display without changing its lifecycle.
export const FINISHED_SUBAGENT_GRACE_MS = 60_000;

export function isFinishedSubagentHidden(session, { now = Date.now(), graceMs = FINISHED_SUBAGENT_GRACE_MS } = {}) {
  if (!session.parentID || session.status !== 'idle') return false;
  const idleSince = Date.parse(session.stateChangedAt);
  return Number.isFinite(idleSince) && now - idleSince >= graceMs;
}

export function sessionState(session, online) {
  if (!online) return { label: 'Offline', className: '', activity: 'Disconnected · last reported activity below', detail: 'No recent heartbeat from this instance.' };
  if (session.status === 'idle') return session.parentID
    ? { label: 'Idle', className: 'finished', activity: 'Idle · available if recalled', detail: 'This subagent is idle and can run again if its parent resumes it.' }
    : { label: 'Waiting for input', className: 'input', activity: 'Waiting for your next message', detail: 'This main agent is idle and ready for user input.' };
  if (session.status === 'waiting') return { label: 'Waiting for permission', className: 'permission', activity: session.activity || 'Waiting for permission', detail: 'Permission is required to continue.' };
  return { label: session.status, className: ['busy', 'retry'].includes(session.status) ? 'busy' : '', activity: session.activity || 'Ready', detail: '' };
}
