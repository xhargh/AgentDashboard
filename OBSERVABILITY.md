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
| `timestampSource` | `source` when the SDK supplied the timestamp; otherwise `observed`. Duration calculations use source timestamps only. |
| `kind`, `phase`, `outcome` | Stable event kind and normalized lifecycle phase/result. |
| `source` | `observed` for direct SDK/plugin observations; `inferred` is reserved for explicitly marked derivations. |
| `messageId`, `toolCallId` | Optional correlation identifiers, included only when supplied by the source. |
| `summary` | Fixed, allowlisted display text; raw SDK text is not copied here. |
| `attributes` | Optional values from a small allowlist. Arbitrary payload keys and values are discarded. |

Current mappings are `created → lifecycle`, `busy → working`, `idle → idle`, `waiting`/`permissionAnswered → permission`, `error` → `error`, `retry` → `retry`, `deleted → lifecycle`, tool-part snapshots → `tool`, assistant message identities → `model`, and `session.compacted` → `model`. `error` has outcome `failure`; `deleted` has outcome `completed`; tool snapshots preserve pending/running state and map running/completed/error to started/completed/failure. The tool snapshot is keyed by session, message, tool-call/part ID, and state so re-delivery is idempotent. Model snapshots are keyed by session and assistant message ID; the UI sorts their timestamps and compares consecutive distinct identities, so repeated updates and out-of-order delivery do not create false transitions. Model and compaction events are removed when `modelMetrics` privacy is disabled. Compaction events do not infer token savings; the current SDK signal provides no pre/post measurement. Without source time, timestamps mean observation time, not a verified tool start or finish; durations remain unavailable unless both endpoints have source timestamps.

The dashboard joins tool snapshots by session, message ID and call/part ID. It reports durations only when both endpoint timestamps are source-provided. A running call with a known SDK start may show elapsed time so far (one minute or longer is labeled long-running); an observed-only start never gets a fabricated duration. When a session ends or its instance disconnects without a terminal tool event, the call is shown incomplete and elapsed time stops at the last known observation.

File-change observations carry a one-way file key for de-duplication and only source-supplied addition/deletion counts. File paths are included only when `paths` telemetry is enabled; patch text and file contents are never included. Session diff snapshots replace the prior per-file snapshot in the dashboard projection, while later incremental edits are applied after that snapshot. Events without an owning session contribute only to the separately labeled unassigned workspace file count.

Reports without `schemaVersion` continue to be accepted as legacy events. New consumers must tolerate absent optional IDs, attributes, and fields from older reports. Events are count/age bounded; pruning sets truncation metadata and timeline projections remain marked partial rather than asserting completeness.

## Privacy and transport

The adapter emits only fixed summaries and allowlisted fields. Tool identifiers/names are removed when `toolActivity` privacy is disabled; provider/model attributes are removed when `modelMetrics` is disabled. Status-only telemetry keeps lifecycle facts while stripping those optional categories. Raw prompts, message bodies, tool arguments/results, error payloads, and arbitrary SDK metadata are not part of this contract.
