// Interpret OpenCode's idle state for display without changing its lifecycle.
export function sessionState(session, online) {
  if (!online) return { label: 'Offline', className: '', activity: 'Disconnected · last reported activity below', detail: 'No recent heartbeat from this instance.' };
  if (session.status === 'idle') return session.parentID
    ? { label: 'Finished', className: 'finished', activity: 'Work finished · available if recalled', detail: 'This subagent is idle. It can run again if its parent resumes it.' }
    : { label: 'Waiting for input', className: 'input', activity: 'Waiting for your next message', detail: 'This main agent is idle and ready for user input.' };
  if (session.status === 'waiting') return { label: 'Waiting for permission', className: 'permission', activity: session.activity || 'Waiting for permission', detail: 'Permission is required to continue.' };
  return { label: session.status, className: ['busy', 'retry'].includes(session.status) ? 'busy' : '', activity: session.activity || 'Ready', detail: '' };
}
