const intervalKinds = new Set(['busy', 'idle', 'waiting', 'error', 'retry']);

// Intervals are event observations, not a reconstruction of status polling.
export function buildExecutionTimeline(events, sessions, truncated = false) {
  const ids = new Set(sessions.map(session => session.id));
  const intervals = [];
  let partial = Boolean(truncated);
  const ordered = (Array.isArray(events) ? events : []).filter(event => ids.has(event.sessionId) &&
    Number.isFinite(Date.parse(event.timestamp))).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const grouped = new Map();
  for (const event of ordered) {
    if (!grouped.has(event.sessionId)) grouped.set(event.sessionId, []);
    grouped.get(event.sessionId).push(event);
  }
  for (const session of sessions) {
    const history = grouped.get(session.id) || [];
    if (!history.length || history[0].kind !== 'created' || truncated) partial = true;
    let current;
    let created = false;
    for (const event of history) {
      if (event.kind === 'created') {
        if (created) { partial = true; continue; }
        created = true;
        continue;
      }
      if (event.kind === 'deleted') {
        if (current) { current.endAt = event.timestamp; intervals.push(current); current = undefined; }
        continue;
      }
      const status = event.kind === 'permissionAnswered' ? 'busy' : event.kind;
      if (!intervalKinds.has(status)) continue;
      if (current) {
        const priorAt = Date.parse(current.startAt), nextAt = Date.parse(event.timestamp);
        if (nextAt <= priorAt) { partial = true; continue; }
        if (current.status === status) continue;
        current.endAt = event.timestamp;
        intervals.push(current);
      }
      current = { sessionId: session.id, startAt: event.timestamp, endAt: null, status };
    }
    if (current) intervals.push(current);
  }
  return { partial, intervals };
}
