import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityBuffer, normalizeObservabilityEvent } from '../src/activity-events.js';

test('activity history is chronological even when events arrive out of order', () => {
  const buffer = createActivityBuffer({ now: () => Date.parse('2026-10-10T00:00:03Z') });
  buffer.record('session', 'idle', '2026-10-10T00:00:03.000Z');
  buffer.record('session', 'created', '2026-10-10T00:00:01.000Z');
  assert.deepEqual(buffer.snapshot().map(event => event.kind), ['created', 'idle']);
});

test('activity history is bounded by count and age', () => {
  let time = Date.parse('2026-10-10T00:00:00Z');
  const buffer = createActivityBuffer({ limit: 2, maxAgeMs: 1000, now: () => time });
  buffer.record('s', 'created');
  buffer.record('s', 'busy');
  buffer.record('s', 'waiting');
  assert.deepEqual(buffer.snapshot().map(event => event.kind), ['busy', 'waiting']);
  time += 1001;
  assert.deepEqual(buffer.snapshot(), []);
});

test('event schema allowlists kinds and fixed summaries, never caller content', () => {
  const buffer = createActivityBuffer({ instanceId: 'instance', now: () => Date.parse('2026-10-10T00:00:00Z') });
  buffer.record('session', 'waiting', '2026-10-10T00:00:00Z', {
    parentSessionId: 'parent', attributes: { permissionType: 'file', command: 'secret prompt/tool output' },
  });
  buffer.record('session', 'permission: secret args');
  buffer.record('session', 'waiting', '2026-10-10T00:00:00Z', {
    parentSessionId: 'parent', attributes: { permissionType: 'file', command: 'secret prompt/tool output' },
  });
  const events = buffer.snapshot();
  assert.equal(events.length, 1, 'replayed event snapshots are idempotent');
  assert.deepEqual(events[0], {
    schemaVersion: 1,
    id: events[0].id,
    instanceId: 'instance',
    sessionId: 'session',
    timestamp: '2026-10-10T00:00:00Z',
    kind: 'waiting',
    phase: 'permission',
    source: 'observed',
    timestampSource: 'observed',
    summary: 'Permission requested',
    parentSessionId: 'parent',
    attributes: { permissionType: 'file' },
  });
  assert.match(events[0].id, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(events), /secret|prompt|tool output/);
});

test('normalizer rejects missing timestamps and assigns stable IDs to observed source facts', () => {
  assert.equal(normalizeObservabilityEvent({ sessionId: 's', kind: 'busy' }), undefined);
  const input = { instanceId: 'i', sessionId: 's', kind: 'busy', timestamp: '2026-10-10T00:00:00Z' };
  const first = normalizeObservabilityEvent(input);
  const replay = normalizeObservabilityEvent(input);
  assert.equal(first.id, replay.id);
  assert.equal(first.source, 'observed');
  assert.equal(first.phase, 'working');
});

test('tool-part replays deduplicate by stable call ID while state changes remain distinct', () => {
  const buffer = createActivityBuffer({ instanceId: 'i', now: () => Date.parse('2026-10-10T00:00:02Z') });
  const context = { phase: 'tool', outcome: 'started', messageId: 'm', toolCallId: 'call', eventId: 'call:running' };
  buffer.record('s', 'toolActivity', '2026-10-10T00:00:00Z', context);
  buffer.record('s', 'toolActivity', '2026-10-10T00:00:01Z', context);
  buffer.record('s', 'toolActivity', '2026-10-10T00:00:02Z', { ...context, outcome: 'completed', eventId: 'call:completed' });
  assert.deepEqual(buffer.snapshot().map(event => event.outcome), ['started', 'completed']);
  assert.ok(buffer.snapshot().every(event => event.timestamp));
});
