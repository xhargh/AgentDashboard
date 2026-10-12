import { createHash } from 'node:crypto';

export const MAX_ACTIVITY_EVENTS = 200;
export const MAX_ACTIVITY_AGE_MS = 24 * 60 * 60 * 1000;

const summaries = {
  created: 'Session created', busy: 'Agent started working', idle: 'Agent became idle',
  waiting: 'Permission requested', error: 'Agent encountered an error', retry: 'Agent retrying',
  permissionAnswered: 'Permission answered', deleted: 'Session ended', toolActivity: 'Tool activity',
};
const phases = {
  created: 'lifecycle', busy: 'working', idle: 'idle', waiting: 'permission',
  error: 'error', retry: 'retry', permissionAnswered: 'permission', deleted: 'lifecycle', toolActivity: 'tool',
};
const outcomes = { error: 'failure', deleted: 'completed' };
const safeAttributeKeys = new Set(['attempt', 'durationMs', 'toolName', 'toolStatus', 'providerId', 'modelId', 'permissionType', 'nextRetryAt']);

function safeAttributes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!safeAttributeKeys.has(key)) continue;
    if ((typeof item === 'string' && item.length <= 100) || (Number.isSafeInteger(item) && item >= 0)) result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}

export function normalizeObservabilityEvent({ instanceId = 'legacy', sessionId, timestamp, kind, ...context }) {
  if (typeof sessionId !== 'string' || !sessionId || !summaries[kind] || !Number.isFinite(Date.parse(timestamp))) return undefined;
  if (typeof instanceId !== 'string' || instanceId.length > 100) instanceId = 'legacy';
  const event = {
    schemaVersion: 1,
    id: typeof context.eventId === 'string' && context.eventId.length <= 200
      ? createHash('sha256').update(JSON.stringify([instanceId, context.eventId])).digest('hex')
      : createHash('sha256').update(JSON.stringify([instanceId, sessionId, timestamp, kind,
        context.parentSessionId, context.messageId, context.toolCallId])).digest('hex'),
    instanceId,
    sessionId,
    timestamp,
    kind,
    phase: ['lifecycle', 'working', 'idle', 'permission', 'error', 'retry', 'tool'].includes(context.phase) ? context.phase : phases[kind],
    source: context.source === 'inferred' ? 'inferred' : 'observed',
    timestampSource: context.timestampSource === 'source' ? 'source' : 'observed',
    summary: summaries[kind],
  };
  if (typeof context.parentSessionId === 'string' && context.parentSessionId.length <= 200) event.parentSessionId = context.parentSessionId;
  if (typeof context.messageId === 'string' && context.messageId.length <= 200) event.messageId = context.messageId;
  if (typeof context.toolCallId === 'string' && context.toolCallId.length <= 200) event.toolCallId = context.toolCallId;
  if (['started', 'completed', 'failure', 'cancelled'].includes(context.outcome)) event.outcome = context.outcome;
  else if (outcomes[kind]) event.outcome = outcomes[kind];
  const attributes = safeAttributes(context.attributes);
  if (attributes) event.attributes = attributes;
  return event;
}

export function createActivityBuffer({ instanceId = 'legacy', limit = MAX_ACTIVITY_EVENTS, maxAgeMs = MAX_ACTIVITY_AGE_MS, now = Date.now } = {}) {
  const events = [];
  const ids = new Set();
  let truncated = false;
  const prune = () => {
    const cutoff = now() - maxAgeMs;
    while (events.length && (events.length > limit || Date.parse(events[0].timestamp) < cutoff)) {
      ids.delete(events.shift().id);
      truncated = true;
    }
  };
  return {
    record(sessionId, kind, timestamp = new Date(now()).toISOString(), context = {}) {
      const event = normalizeObservabilityEvent({ instanceId, sessionId, timestamp, kind, ...context });
      if (!event || ids.has(event.id)) return;
      ids.add(event.id);
      // Insert by event time so delayed events cannot corrupt chronological history.
      let index = events.findIndex(item => Date.parse(item.timestamp) > Date.parse(event.timestamp));
      if (index < 0) index = events.length;
      events.splice(index, 0, event);
      prune();
    },
    snapshot() { prune(); return events.map(event => ({ ...event, ...(event.attributes ? { attributes: { ...event.attributes } } : {}) })); },
    get truncated() { prune(); return truncated; },
  };
}
