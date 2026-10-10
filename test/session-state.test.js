import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINISHED_SUBAGENT_GRACE_MS, isFinishedSubagentHidden, sessionState } from '../public/session-state.js';

test('an idle parent awaiting input is distinct from its three finished subagents', () => {
  const parent = { id: 'main', status: 'idle', activity: 'Ready' };
  const children = [1, 2, 3].map(id => ({ id, parentID: 'main', status: 'idle', activity: 'Ready' }));
  const main = sessionState(parent, true);
  assert.equal(main.label, 'Waiting for input');
  for (const child of children) {
    const display = sessionState(child, true);
    assert.equal(display.label, 'Idle');
    assert.notEqual(display.className, main.className);
    assert.doesNotMatch(display.activity, /Waiting for your/);
  }
});

test('a recalled subagent resumes live activity and can finish again', () => {
  const child = { parentID: 'main', status: 'idle', activity: 'Ready' };
  child.stateChangedAt = new Date(0).toISOString();
  assert.equal(sessionState(child, true).label, 'Idle');
  child.status = 'busy'; child.activity = 'Running bash';
  assert.equal(sessionState(child, true).label, 'busy');
  assert.equal(sessionState(child, true).activity, 'Running bash');
  child.status = 'waiting';
  assert.equal(sessionState(child, true).label, 'Waiting for permission');
  child.status = 'error';
  assert.equal(sessionState(child, true).label, 'error');
  child.status = 'idle';
  assert.equal(sessionState(child, true).label, 'Idle');
});

test('finished-subagent filter observes a 60-second idle grace and reveals resumed work immediately', () => {
  const now = 120_000;
  const child = { parentID: 'main', status: 'idle', stateChangedAt: new Date(now - 59_999).toISOString() };
  assert.equal(FINISHED_SUBAGENT_GRACE_MS, 60_000);
  assert.equal(isFinishedSubagentHidden(child, { now }), false);
  child.stateChangedAt = new Date(now - 60_000).toISOString();
  assert.equal(isFinishedSubagentHidden(child, { now }), true);
  child.status = 'busy';
  assert.equal(isFinishedSubagentHidden(child, { now }), false);
});

test('finished-subagent filter never hides main agents and keeps unknown lifecycle times visible', () => {
  const now = 120_000;
  assert.equal(isFinishedSubagentHidden({ status: 'idle', stateChangedAt: new Date(0).toISOString() }, { now }), false);
  assert.equal(isFinishedSubagentHidden({ parentID: 'main', status: 'idle' }, { now }), false);
});

test('loss of connection overrides both idle interpretations', () => {
  for (const parentID of [undefined, 'main']) {
    assert.equal(sessionState({ parentID, status: 'idle' }, false).label, 'Offline');
  }
});
