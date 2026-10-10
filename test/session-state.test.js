import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionState } from '../public/session-state.js';

test('an idle parent awaiting input is distinct from its three finished subagents', () => {
  const parent = { id: 'main', status: 'idle', activity: 'Ready' };
  const children = [1, 2, 3].map(id => ({ id, parentID: 'main', status: 'idle', activity: 'Ready' }));
  const main = sessionState(parent, true);
  assert.equal(main.label, 'Waiting for input');
  for (const child of children) {
    const display = sessionState(child, true);
    assert.equal(display.label, 'Finished');
    assert.notEqual(display.className, main.className);
    assert.doesNotMatch(display.activity, /Waiting for your/);
  }
});

test('a recalled subagent resumes live activity and can finish again', () => {
  const child = { parentID: 'main', status: 'idle', activity: 'Ready' };
  assert.equal(sessionState(child, true).label, 'Finished');
  child.status = 'busy'; child.activity = 'Running bash';
  assert.equal(sessionState(child, true).label, 'busy');
  assert.equal(sessionState(child, true).activity, 'Running bash');
  child.status = 'waiting';
  assert.equal(sessionState(child, true).label, 'Waiting for permission');
  child.status = 'error';
  assert.equal(sessionState(child, true).label, 'error');
  child.status = 'idle';
  assert.equal(sessionState(child, true).label, 'Finished');
});

test('loss of connection overrides both idle interpretations', () => {
  for (const parentID of [undefined, 'main']) {
    assert.equal(sessionState({ parentID, status: 'idle' }, false).label, 'Offline');
  }
});
