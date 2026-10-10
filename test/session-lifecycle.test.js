import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, markActivity, markState } from '../src/session-lifecycle.js';

test('new sessions record their first observation, activity, and initial state', () => {
  const session = createSession('new');
  assert.equal(session.firstObservedAt, session.lastActivityAt);
  assert.equal(session.firstObservedAt, session.stateChangedAt);
  assert.equal(session.restored, undefined);
});

test('restored sessions record observation without inventing historical activity or state changes', () => {
  const session = createSession('restored', { status: 'idle' }, { restored: true });
  assert.ok(session.firstObservedAt);
  assert.equal(session.lastActivityAt, null);
  assert.equal(session.stateChangedAt, null);
  assert.equal(session.restored, true);
});

test('unchanged status heartbeats do not reset timestamps; real state changes do', () => {
  const session = createSession('s', { status: 'idle' });
  const originalState = session.stateChangedAt;
  const originalActivity = session.lastActivityAt;
  assert.equal(markState(session, 'idle', '2026-10-10T00:00:01.000Z'), false);
  assert.equal(session.stateChangedAt, originalState);
  assert.equal(session.lastActivityAt, originalActivity);
  assert.equal(markState(session, 'busy', '2026-10-10T00:00:02.000Z'), true);
  assert.equal(session.stateChangedAt, '2026-10-10T00:00:02.000Z');
  assert.equal(session.lastActivityAt, '2026-10-10T00:00:02.000Z');
});

test('activity and idle state changes maintain independent timestamps', () => {
  const session = createSession('s', { status: 'busy' });
  markActivity(session, '2026-10-10T00:00:03.000Z');
  assert.equal(session.lastActivityAt, '2026-10-10T00:00:03.000Z');
  const activity = session.lastActivityAt;
  markState(session, 'idle', '2026-10-10T00:00:04.000Z');
  assert.equal(session.stateChangedAt, '2026-10-10T00:00:04.000Z');
  assert.equal(session.lastActivityAt, activity);
});

test('sessions from older reports can omit lifecycle timestamps', () => {
  const legacy = { id: 'legacy', status: 'idle' };
  assert.equal(legacy.firstObservedAt, undefined);
  assert.doesNotThrow(() => markState(legacy, 'idle'));
  assert.equal(legacy.stateChangedAt, undefined);
});
