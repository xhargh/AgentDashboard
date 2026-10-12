import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionTimeline } from '../src/execution-timeline.js';

const session = { id: 'parent' }, child = { id: 'child' };
const event = (sessionId, kind, timestamp) => ({ sessionId, kind, timestamp });

test('orders concurrent observed transitions and leaves final states ongoing', () => {
  const result = buildExecutionTimeline([
    event('parent', 'busy', '2026-10-12T00:00:01Z'), event('child', 'busy', '2026-10-12T00:00:02Z'),
    event('parent', 'idle', '2026-10-12T00:00:05Z'), event('child', 'error', '2026-10-12T00:00:06Z'),
  ], [session, child]);
  assert.deepEqual(result.intervals.map(({ sessionId, status, endAt }) => [sessionId, status, endAt]), [
    ['parent', 'busy', '2026-10-12T00:00:05Z'], ['parent', 'idle', null],
    ['child', 'busy', '2026-10-12T00:00:06Z'], ['child', 'error', null],
  ]);
  assert.equal(result.partial, true);
});

test('marks restored, missing and truncated history partial; ignores invalid timestamps', () => {
  const events = [event('parent', 'created', '2026-10-12T00:00:00Z'), event('parent', 'busy', 'invalid')];
  assert.deepEqual(buildExecutionTimeline(events, [session]), { partial: false, intervals: [] });
  assert.equal(buildExecutionTimeline([], [session]).partial, true);
  assert.equal(buildExecutionTimeline([event('parent', 'created', '2026-10-12T00:00:00Z')], [session], true).partial, true);
});

test('keeps event-provided statuses and does not invent intervals from current session status', () => {
  const result = buildExecutionTimeline([event('parent', 'created', '2026-10-12T00:00:00Z')], [{ ...session, status: 'busy' }]);
  assert.deepEqual(result.intervals, []);
});

test('duplicate creation and repeated status observations do not erase or split known intervals', () => {
  const result = buildExecutionTimeline([
    event('parent', 'created', '2026-10-12T00:00:00Z'),
    event('parent', 'busy', '2026-10-12T00:00:01Z'),
    event('parent', 'busy', '2026-10-12T00:00:02Z'),
    event('parent', 'created', '2026-10-12T00:00:03Z'),
    event('parent', 'idle', '2026-10-12T00:00:04Z'),
  ], [session]);
  assert.deepEqual(result.intervals, [
    { sessionId: 'parent', startAt: '2026-10-12T00:00:01Z', endAt: '2026-10-12T00:00:04Z', status: 'busy' },
    { sessionId: 'parent', startAt: '2026-10-12T00:00:04Z', endAt: null, status: 'idle' },
  ]);
  assert.equal(result.partial, true);
});
