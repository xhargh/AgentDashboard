import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityBuffer } from '../src/activity-events.js';

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
  const buffer = createActivityBuffer({ now: () => Date.parse('2026-10-10T00:00:00Z') });
  buffer.record('session', 'waiting', '2026-10-10T00:00:00Z', 'prompt/tool output secret');
  buffer.record('session', 'permission: secret args');
  const events = buffer.snapshot();
  assert.deepEqual(events, [{ sessionId: 'session', timestamp: '2026-10-10T00:00:00Z', kind: 'waiting', summary: 'Permission requested' }]);
  assert.doesNotMatch(JSON.stringify(events), /secret|prompt|tool output/);
});
