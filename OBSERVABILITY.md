# Observability event contract

OpenCode lifecycle observations are normalized in the plugin before they enter the event buffer or leave the machine. The browser's recent-activity list and execution timeline consume the same retained event history; the timeline is a state-interval projection of that stream.

## Version 1

Each normalized event contains:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Contract version (`1`). |
| `id` | Stable SHA-256 identifier derived from instance, session, observed timestamp, kind, and available correlation IDs. Repeated delivery of the same observation is idempotent within the retained buffer. |
| `instanceId`, `sessionId` | OpenCode plugin generation and owning session. |
| `parentSessionId` | Parent relationship when known. |
| `timestamp` | SDK-provided fact time when available, otherwise the adapter's observation time. It is not reconstructed from status snapshots. |
| `kind`, `phase`, `outcome` | Stable event kind and normalized lifecycle phase/result. |
| `source` | `observed` for direct SDK/plugin observations; `inferred` is reserved for explicitly marked derivations. |
| `messageId`, `toolCallId` | Optional correlation identifiers, included only when supplied by the source. |
| `summary` | Fixed, allowlisted display text; raw SDK text is not copied here. |
| `attributes` | Optional values from a small allowlist. Arbitrary payload keys and values are discarded. |

Current mappings are `created → lifecycle`, `busy → working`, `idle → idle`, `waiting`/`permissionAnswered → permission`, `error → error`, `retry → retry`, `deleted → lifecycle`, and tool-part snapshots → `tool`. `error` has outcome `failure`; `deleted` has outcome `completed`; tool snapshots map running/completed/error to started/completed/failure. The tool snapshot is keyed by session, message, tool-call/part ID, and state so re-delivery is idempotent. Without source time, its timestamp means observation time, not a verified tool start or finish.

Reports without `schemaVersion` continue to be accepted as legacy events. New consumers must tolerate absent optional IDs, attributes, and fields from older reports. Events are count/age bounded; pruning sets truncation metadata and timeline projections remain marked partial rather than asserting completeness.

## Privacy and transport

The adapter emits only fixed summaries and allowlisted fields. Tool identifiers/names are removed when `toolActivity` privacy is disabled; provider/model attributes are removed when `modelMetrics` is disabled. Status-only telemetry keeps lifecycle facts while stripping those optional categories. Raw prompts, message bodies, tool arguments/results, error payloads, and arbitrary SDK metadata are not part of this contract.
