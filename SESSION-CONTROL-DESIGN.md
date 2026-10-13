# Optional session control: threat model and interface proposal

## Decision

AgentDashboard remains read-only by default. Session control is not implemented in the ordinary report/plugin channel and must never be enabled by notification settings or telemetry categories. Any future control feature requires a separate, explicit per-machine opt-in, separate authorization material, a user confirmation for each action, and a reviewed request/response protocol.

The current plugin-to-companion report flow is outbound-only. Do not open an HTTP listener on monitored OpenCode machines and do not proxy `client.session.*` methods directly to a browser. A control request should be queued by the companion and delivered only when the owning plugin next makes its outbound heartbeat; the plugin must respond through the same authenticated channel.

## Assets and trust boundaries

- **Agent execution and session content:** prompts, tool arguments/results, permission choices, and source/workspace data stay on the monitored machine unless a separately opted-in feature explicitly requests a bounded field.
- **Companion state:** the companion is a relay, not an execution authority. It stores requests only in memory until response/expiry and never logs request payloads or transcript text.
- **Dashboard user:** network-mode access to read-only telemetry does not imply authority to control an agent.
- **OpenCode plugin:** validates the target instance/session immediately before acting; browser-provided session IDs and action payloads are untrusted.

Threats include bearer-token leakage, cross-machine/project targeting, stale session IDs after `/new`, replayed requests, malicious or compromised dashboard clients, notification/banner disclosure, oversized payloads, and a command being retried after an uncertain network result.

## Proposed request envelope

```json
{
  "requestId": "random one-time ID",
  "nonce": "random one-time value",
  "issuedAt": "timestamp",
  "expiresAt": "timestamp",
  "machineId": "exact machine UUID",
  "instanceId": "exact plugin generation UUID",
  "sessionId": "exact session UUID",
  "action": "abort | prompt | permission-response",
  "payload": { "...": "action-specific, bounded fields only" }
}
```

The companion binds requests to the authenticated dashboard principal and exact machine/instance/session. The plugin checks all three IDs against its current in-memory ownership before calling the SDK. Expired, duplicate, unknown-action, or mismatched requests are rejected. The nonce/request ID is consumed before invoking the SDK so a lost response cannot replay an action. Every response contains only request ID, accepted/rejected status, and a fixed safe error category; no prompts, arguments, or SDK error text are logged.

Control authorization uses a separate control credential and permission from the read-only bearer token. Control is disabled unless both the monitored machine and companion explicitly enable it. Network control is disabled over plaintext HTTP; require HTTPS and per-machine authorization rather than relying on the shared read-only fleet token. Start with abort and permission response only; prompt submission requires a separate design for prompt-size limits and preview.

## User interaction and audit

- The dashboard shows a confirmation naming the action, machine, instance, and session; no action is issued from stale UI state alone.
- The ordinary agent card and notifications never expose control affordances unless control mode is enabled.
- Show pending, confirmed, rejected, expired, and outcome-unknown states. Do not automatically retry uncertain actions.
- Keep an in-memory, bounded audit trail containing request ID, target IDs, action kind, requesting principal, timestamps, and result category. It contains no prompt text, permission pattern, tool arguments, or credentials.
- Clicking a notification may focus AgentDashboard only; do not imply that an external OpenCode terminal was focused.

## Verification required before implementation

Tests must cover disabled-by-default behavior, missing/weak control credentials, authorization separation from read access, cross-machine and cross-session rejection, replay/expiry, stale sessions, concurrent clients, request size bounds, disconnect during execution, unknown outcomes, safe logs, and explicit confirmation. A future implementation PR must also verify that ordinary monitoring remains passive and that enabling one control action cannot silently enable other actions.

## On-demand transcript/tool inspection relationship

Read-only transcript and raw tool inspection should use the same outbound request/response relay, but with a distinct `sessionTranscript`/`toolDetails` opt-in and stricter response bounds. Require both local permission and dashboard user expansion before fetching; return short-lived responses only, never persist raw content in companion state, and require HTTPS for network mode. Keep these inspection requests distinct from session-control actions and never accept them under status-only telemetry.
