const timestamp = () => new Date().toISOString();

export function createSession(id, fields = {}, { restored = false } = {}) {
  const observedAt = timestamp();
  return {
    id,
    ...fields,
    firstObservedAt: observedAt,
    lastActivityAt: restored ? null : observedAt,
    stateChangedAt: restored ? null : observedAt,
    ...(restored ? { restored: true } : {}),
  };
}

export function markActivity(session, at = timestamp()) {
  session.lastActivityAt = at;
}

export function markState(session, status, at = timestamp()) {
  if (session.status === status) return false;
  session.status = status;
  session.stateChangedAt = at;
  if (['busy', 'retry', 'waiting', 'error'].includes(status)) markActivity(session, at);
  return true;
}
