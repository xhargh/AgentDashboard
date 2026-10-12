export const MAX_ACTIVITY_EVENTS = 200;
export const MAX_ACTIVITY_AGE_MS = 24 * 60 * 60 * 1000;

const summaries = {
  created: 'Session created', busy: 'Agent started working', idle: 'Agent became idle',
  waiting: 'Permission requested', error: 'Agent encountered an error', retry: 'Agent retrying',
  permissionAnswered: 'Permission answered', deleted: 'Session ended',
};

export function createActivityBuffer({ limit = MAX_ACTIVITY_EVENTS, maxAgeMs = MAX_ACTIVITY_AGE_MS, now = Date.now } = {}) {
  const events = [];
  let truncated = false;
  const prune = () => {
    const cutoff = now() - maxAgeMs;
    while (events.length && (events.length > limit || Date.parse(events[0].timestamp) < cutoff)) { events.shift(); truncated = true; }
  };
  return {
    record(sessionId, kind, timestamp = new Date(now()).toISOString()) {
      if (typeof sessionId !== 'string' || !sessionId || !summaries[kind]) return;
      const event = { sessionId, timestamp, kind, summary: summaries[kind] };
      // Insert by event time so delayed events cannot corrupt chronological history.
      let index = events.findIndex(item => Date.parse(item.timestamp) > Date.parse(timestamp));
      if (index < 0) index = events.length;
      events.splice(index, 0, event);
      prune();
    },
    snapshot() { prune(); return events.map(event => ({ ...event })); },
    get truncated() { prune(); return truncated; },
  };
}
