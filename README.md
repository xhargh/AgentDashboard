# AgentDashboard

> **Note:** This project is AI-generated, and not all features or configurations have been tested.

AgentDashboard is a Linux-friendly, browser-based GUI for watching many OpenCode instances across projects and computers. A small OpenCode plugin reports to a central Node.js companion; the companion serves the dashboard. No runtime npm dependencies or build step.

- Counts online computers, OpenCode instances, active root agents, and active subagents.
- Shows session titles, agent roles, tool activity, working folders, parent relationships, permission waits, and task lists.
- Shows Git status, the last 12 commits, and worktrees for each instance's project.
- The **Agents** section has a collapsible **Filter agents** panel, folded by default. It filters by computer, text, or active sessions, and can hide idle main agents waiting for input. **Hide offline agents** is enabled by default. **Hide finished subagents** is enabled by default: it hides idle subagents, keeps idle main agents visible, and automatically reveals subagents when they resume. Uncheck it to inspect finished sessions. Each project shows how many finished subagents are hidden. Git workspaces show status, recent commits, and worktrees under **Git workspace**; non-Git folders have no Git panel.
- Reports every five seconds and on events; the GUI polls every two seconds. State responses include a monotonic revision and `ETag`; unchanged polls return an empty `304` response. Meaningful report changes, heartbeat-derived online/offline transitions, and instance expiry advance the revision. Missing instances turn offline after 20 seconds and expire after 24 hours.

The GUI runs in Firefox, Chromium, or another modern Linux browser. This is a monitoring application: start OpenCode instances normally in your terminals. It does not launch agents, issue prompts, or modify repositories.

## Quick start on one machine

Requires Node.js **22.16+** (or 24+), Git, and OpenCode with the classic plugin hooks API. OpenCode 1.18.35 is installed in the development environment; a live OpenCode integration run could not be performed there because local socket binding is restricted. The plugin follows the [official plugin API](https://docs.opencode.ai/docs/plugins/) and [SDK event types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts). The experimental v2 plugin API is not targeted.

From this checkout, start the companion with no token configured:

```bash
npm start
```

Open **http://127.0.0.1:4317**. The dashboard connects automatically without a login. Without `AGENTDASHBOARD_TOKEN`, the companion always binds to `127.0.0.1`, ignoring the configured host, and accepts only local connections. It also checks the request hostname and browser origin. Do not forward or proxy this unauthenticated mode to other computers; use network mode for that.

Install the plugin, then start OpenCode in your project:

```bash
npm run install-plugin
cd /path/to/your/project
opencode
```

No plugin token or URL is needed for the default local setup. If switching from network mode, remove the token from `.env` and unset it in the companion shell. Remove/unset the plugin token and any remote plugin URL in the OpenCode shell. Restart both processes after changing their configuration. Without a token, the plugin only reports to loopback addresses and will not follow redirects.

`npm start` loads `.env` automatically; no sourcing is needed. Exported shell variables take precedence over `.env`. Direct `node src/server.js` and the systemd service use their process environment. A nonempty token shorter than 24 characters is a configuration error, not a fallback to local mode.

Restart any OpenCode processes that were already running. Repeat in other project directories or terminals. The installer honors `XDG_CONFIG_HOME`. To install for just one project instead:

```bash
node scripts/install-plugin.js /path/to/project
```

Use one installation scope per project to avoid loading two copies. The installer places a single `AgentDashboardPlugin.js` file in the OpenCode plugins directory and removes files left by older installer versions. Re-run it after updating the checkout. Remove `AgentDashboardPlugin.js` to uninstall.

## Several computers over a LAN

Choose one computer to run the companion. Generate a shared secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`, then configure it on that machine:

```bash
export AGENTDASHBOARD_TOKEN='your-generated-secret'
AGENTDASHBOARD_HOST=0.0.0.0 AGENTDASHBOARD_PORT=4317 npm start
```

A valid `AGENTDASHBOARD_TOKEN` enables network mode and defaults to `AGENTDASHBOARD_HOST=0.0.0.0`; you can set the host to a particular interface or loopback. Settings can also be placed in `.env`. The browser asks for the shared token when connecting.

Allow inbound TCP port 4317 from your LAN using your firewall. On every monitored computer, copy this repository, install the plugin, and configure OpenCode:

```bash
npm run install-plugin
export AGENTDASHBOARD_URL='http://192.168.1.10:4317'
export AGENTDASHBOARD_TOKEN='your-generated-secret'
# Optional stable, unique display name; defaults to OS hostname:
export AGENTDASHBOARD_HOST='linux-workstation'
opencode
```

Replace `192.168.1.10` with the companion machine's address. Open that address in a browser on any computer to view the combined fleet. Plugins push outbound reports; monitored computers need no inbound ports. Give machines distinct host labels so computer counts remain meaningful.

In network mode, all API requests require the shared bearer token, including dashboard reads. The browser keeps it only in memory. Plain HTTP exposes the token and telemetry to network observers: use it on a trusted LAN, or place the companion behind an HTTPS reverse proxy / encrypted private network. TLS terminates at your proxy; point plugins and the browser to its HTTPS URL. Do not publish the plain HTTP service to the internet. Token rotation requires updating the companion and restarting configured OpenCode instances.

The report sent to `/api/report` contains an instance UUID, stable machine UUID, host label, process ID, and a session list. Every session includes its ID and status, plus its parent session ID when present. By default it also contains session titles (`titles`), todo text/status (`tasks`), tool/agent activity (`toolActivity`), session/project/worktree paths (`paths`), a Git snapshot (`git`) with repository root, short status, recent commit subjects/dates, and worktree details, and model identifiers/variant/configured context capacity (`modelMetrics`). Git inspection uses bounded, read-only local subprocesses; no remotely supplied shell commands are run. Reports never include conversation prompts, assistant messages or model reasoning, raw tool arguments, or tool outputs. Titles, todo text, activity strings, model/provider identifiers, variants, Git subjects/status, and paths may themselves reveal sensitive information.

Configure plugin privacy with `AGENTDASHBOARD_TELEMETRY`, a JSON object set in the OpenCode process environment. For example:

```bash
export AGENTDASHBOARD_TELEMETRY='{"titles":false,"tasks":false,"toolActivity":false,"paths":false,"git":false,"modelMetrics":false}'
```

The available categories are `titles`, `tasks`, `toolActivity`, `paths`, `git`, and `modelMetrics`; each defaults to `true`. Setting a category to `false` removes that category from the JSON report before `fetch` is called. Git snapshots include paths (repository roots, filenames, and worktree locations), so setting `paths` to `false` also disables `git`. `modelMetrics` covers provider/model identifiers, variants, configured context limits, and reported usage counters. Usage totals are per session and sum the last 100 distinct assistant message snapshots; repeated updates replace that message's snapshot, and `partial: true` indicates older messages were evicted. Input, output, reasoning, cache-read, and cache-write are kept separate; no grand total is emitted because providers may report categories with overlapping semantics. The dashboard's lifetime counter is explicitly `input + output`; the breakdown preserves the other reported categories separately. The latest context estimate uses the most recent assistant message's input plus cache-read counters when available and requires a configured context limit. This follows OpenCode's current token fields, where cached input is provided separately as `tokens.cache.read`, but provider accounting may differ. It is an estimate of the last reported request, not a live context measurement or a value derived from lifetime totals; it can fall after compaction. Restored sessions have no lifetime totals until new assistant usage arrives. The status-only profile is `{"profile":"status-only"}` and disables all six categories while retaining host/machine/instance identity, process ID, session IDs, parent relationships, session statuses, and lifecycle timestamps. Configuration must be valid JSON with known boolean categories; invalid settings disable reporting and produce a local diagnostic. Older reports remain accepted, including reports without optional session metadata or Git snapshots.

### OpenCode model and token fields

The installed classic OpenCode CLI/SDK inspected for this release is OpenCode 1.18.35. Its generated `AssistantMessage` type for `message.updated` contains `id`, `sessionID`, `role`, `time`, `modelID`, `providerID`, `mode`, `path`, `cost`, `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, and `tokens.cache.write`. The configured provider catalog returns providers with model records containing `name` and `limit.context`; telemetry uses these configured values when the lookup is supported. The inspected generated type does not declare an assistant `variant`, so the UI shows **Variant unavailable** unless an event/runtime version actually supplies one. An optional string variant is accepted when present, without interpreting it as a normalized reasoning level. These generated types establish the SDK contract; event values from an actual model completion must still be checked against the installed runtime and provider.

Model/provider names, IDs, variants, token counts, and configured context limits are transmitted when `modelMetrics` is enabled. Metadata is sent in the normal event-triggered report (coalesced to at least 250 ms) and the 5-second heartbeat. No prompt, assistant prose, reasoning text, raw tool arguments/results, or credentials are sent. `modelMetrics: false` strips the whole model/usage object at the plugin's outbound boundary; `status-only` does the same. A provider catalog lookup failure does not block OpenCode and leaves model display name/context capacity unavailable. Unsupported token fields are omitted rather than replaced with zeros; unknown values render as unavailable/pending. The dashboard highlights estimated context at 75% and 90%; these are fixed display thresholds, not alerts or a provider-enforced limit.

#### Optional real-model verification

The regular test suite and `npm run smoke` do not make inference calls and do not require model credentials. To verify a real completion, configure a provider/model in OpenCode, start the companion, then launch OpenCode with this plugin and the telemetry URL/token environment configured. Prompt a root agent to complete a small task and, if your configured agent supports delegation, to ask a subagent to perform a separate task. Confirm that the dashboard reports each session's own provider/model and final token counters, while no prompt or response text appears in the report. Repeat with `AGENTDASHBOARD_TELEMETRY='{"modelMetrics":false}'` to confirm the metrics disappear. This check is opt-in because it can incur provider charges and depends on provider-specific reporting; do not make it a CI prerequisite. Record the OpenCode and provider versions with any observed discrepancy.

Privacy filtering limits report contents, but does not encrypt a connection. Network mode over plain HTTP exposes both the bearer token and report data to network observers; use HTTPS (for example, a reverse proxy with TLS) or an encrypted private network, and restrict access to a trusted/private network. The default local mode sends only to loopback and requires no token. Avoid exposing the plain HTTP companion directly to the internet.

## Desktop window prototype (Linux)

The optional Tauri prototype opens the dashboard in a native AgentDashboard window at `http://127.0.0.1:4317`. Start the companion separately first (`npm start` from this checkout); the desktop window does not launch or stop it. The wrapper navigates directly to the companion, so the dashboard and its `/api/state` requests retain the companion's HTTP loopback origin. No local-mode security checks have been changed to accommodate the webview. A branded system-tray icon toggles the window on a left click and its tooltip summarizes online instances, sessions, and sessions needing attention. Tooltip availability and presentation depend on the desktop environment; environments without tray support continue with the window alone.

Build a Linux x86_64 executable with Docker BuildKit (no host Rust, Tauri CLI, Node.js, or webview development packages required):

```bash
DOCKER_BUILDKIT=1 docker build -f Dockerfile.tauri --output type=local,dest=dist .
```

Docker needs access to download the Rust base image, Debian packages, and Cargo crates. The resulting `dist/AgentDashboard` executable targets Linux x86_64 and is dynamically linked. It needs an active X11 or Wayland desktop session, GTK 3, WebKit2GTK 4.1, librsvg, and the runtime dependencies of those libraries. On Debian/Ubuntu install the main runtime packages with:

```bash
sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0 librsvg2-2
```

Then, with the companion running:

```bash
chmod +x dist/AgentDashboard
./dist/AgentDashboard
```

This is a prototype executable only: no installer, updater, bundled Node runtime, or companion lifecycle management is included. Cross-platform builds are not covered.

### Local-mode webview validation status

Local mode currently serves the dashboard successfully from loopback (HTTP 200 with the existing restrictive CSP). Direct probes against the running companion rejected a non-local `Host` and a cross-origin `/api/state` request with HTTP 403. The server continues to require a loopback peer and localhost `Host`, and applies same-origin and Fetch Metadata checks to API requests.

The native Tauri window could not be launched in the implementation environment: the host has no `webkit2gtk-4.1` or GTK development/runtime packages installed. Therefore, acceptance of the actual WebKit request's peer address, `Host`, `Origin`, and Fetch Metadata headers remains unverified here. Since the app navigates to the companion's loopback URL rather than loading a Tauri-origin frontend or proxying requests, it is expected to use the companion origin; confirm on a Linux host with WebKit2GTK 4.1 installed. If native WebKit is rejected, resolve the incompatibility by designing an explicitly constrained same-origin integration and reviewing it against the security model; do not relax local-mode peer, host, origin, or cross-site checks.

## Run as a Linux user service

For a new installation, create `~/.config/agentdashboard/environment` as shown below, then install `packaging/agentdashboard.service` as `~/.config/systemd/user/agentdashboard.service`. Edit the checkout path and Node executable in the unit if needed. For an existing installation, stop and disable the old unit **before** starting the new one. Both units use the same default port, so running both can cause a bind failure or duplicate companion processes. Keep the old environment file; copy it to the new location and rename its variables as described below:

For an existing installation, first run `systemctl --user disable --now opencode-supervisor`, then copy `~/.config/opencode-supervisor/environment` to `~/.config/agentdashboard/environment` and rename its keys to the `AGENTDASHBOARD_*` names below. Update OpenCode launch environment variables the same way. Legacy environment variable names are no longer read. Once the new service is verified, remove the old unit file from `~/.config/systemd/user/` and reload systemd. The old environment file and configuration directory are not deleted.

Create `~/.config/agentdashboard/environment` (keep it readable only by your user):

```ini
AGENTDASHBOARD_TOKEN=your-generated-secret
AGENTDASHBOARD_HOST=0.0.0.0
AGENTDASHBOARD_PORT=4317
```

Then:

```bash
chmod 600 ~/.config/agentdashboard/environment
mkdir -p ~/.config/systemd/user
cp packaging/agentdashboard.service ~/.config/systemd/user/agentdashboard.service
systemctl --user daemon-reload
systemctl --user enable --now agentdashboard
journalctl --user -u agentdashboard -f
```

For token-free local access, leave `AGENTDASHBOARD_TOKEN` empty or omit it from the service environment file. For authenticated local access, keep the token and set `AGENTDASHBOARD_HOST=127.0.0.1`. The user service normally follows your login session; enable user lingering separately if you want it running after logout.

## Configuration

| Process | Variable | Default |
|---|---|---|
| Companion | `AGENTDASHBOARD_TOKEN` | Absent: local mode. Set to 24+ characters for network mode |
| Companion | `AGENTDASHBOARD_HOST` | No token: forced `127.0.0.1`. With token: `0.0.0.0` |
| Companion | `AGENTDASHBOARD_PORT` | `4317` |
| OpenCode | `AGENTDASHBOARD_TOKEN` | Absent: local reports only. Required for a network companion |
| OpenCode | `AGENTDASHBOARD_URL` | `http://127.0.0.1:4317` |
| OpenCode | `AGENTDASHBOARD_HOST` | OS hostname |
| OpenCode | `AGENTDASHBOARD_TELEMETRY` | All metadata categories enabled; accepts category booleans or `{"profile":"status-only"}` |

Only the documented `AGENTDASHBOARD_*` environment names are read. Existing settings must be renamed during upgrade: companion `SUPERVISOR_TOKEN` → `AGENTDASHBOARD_TOKEN`, `HOST` → `AGENTDASHBOARD_HOST`, `PORT` → `AGENTDASHBOARD_PORT`; plugin `OPENCODE_SUPERVISOR_URL` → `AGENTDASHBOARD_URL`, `OPENCODE_SUPERVISOR_TOKEN` → `AGENTDASHBOARD_TOKEN`, `OPENCODE_SUPERVISOR_HOST` → `AGENTDASHBOARD_HOST`, and `OPENCODE_SUPERVISOR_TELEMETRY` → `AGENTDASHBOARD_TELEMETRY`. No-token companion mode binds only to loopback, and no-token plugins refuse non-loopback URLs. New machine IDs are stored in `$XDG_CONFIG_HOME/agentdashboard/machine-id` (or `~/.config/agentdashboard/machine-id`). If only the old `opencode-supervisor/machine-id` exists, its value is copied forward without changing or deleting the old ID. Each plugin process generation also gets a fresh instance ID. Display hostnames remain configurable and are not used as machine identity. Failed reports retry with exponential jitter from 0.5–60 seconds, without overlapping requests; successful reports reset the delay. Failure diagnostics are secret-free and limited to one per 30 seconds. Authentication/report-configuration errors are labeled separately from server, network, and timeout failures.

Session state is held in memory. Companion restarts recover from the next plugin heartbeat. Plugin restarts get new instance IDs while retaining the machine ID; old entries remain visibly offline until expiration. Older plugin reports without machine IDs remain accepted and are grouped by hostname. Idle sessions are retained up to a soft 500-session limit per plugin; active sessions are preferred. Companion limits are fixed: 2,000 instances, 1,000 sessions/report and 20,000 aggregate retained sessions, 200 events/report and 10,000 aggregate retained events (for event-enabled reports), 4,096 characters per general string field (200 for event summaries), and 1 MiB/report. Oversized report bodies receive HTTP 413; invalid or overlong fields receive HTTP 400. At fleet capacity, the companion evicts offline/idle instances first and then the oldest; live instances with busy, retrying, or permission-waiting sessions are retained preferentially. If capacity is occupied by retained activity, a report that cannot fit receives HTTP 503. Age-based expiration runs at most once per minute on API traffic rather than scanning the fleet on every request.
Plugin generations report a stable machine ID, process ID, and generation start time. A newer generation with the same machine ID and process ID marks the prior generation **Replaced**; different process IDs remain separate concurrent instances. Replaced and merely offline instances remain distinguishable and are retained for up to 24 hours.

“Active” includes working or retrying agents, permission waits, errors, and parent summaries with child attention. Offline classification takes precedence over stale session status, so an offline permission wait is not active. Idle main agents display **Waiting for input** in amber; idle subagents are classified as recently finished and remain visible through the existing grace period before the finished-subagent filter hides them. A recalled subagent returns to its current working, permission, or error classification as its reported status changes. Parent rows summarize child branches with attention-required descendants. These categories are derived for monitoring; the original OpenCode status is preserved. Subagents are sessions with an OpenCode `parentID`; the display links them to their parent title. Activity reflects the latest tool event, not private model reasoning. Git snapshots refresh approximately every ten seconds, independently of the GUI. Child session folders are displayed, while Git panels describe the plugin instance's project folder. Missing Git, unborn branches, and non-repository folders are handled without affecting OpenCode.

## Verification and development

### Run all CI checks in Docker

Install Docker Engine or Docker Desktop with BuildKit support; the host does not need Node.js, npm, Chromium, or Playwright dependencies. From the repository root, run:

```bash
docker build -t agentdashboard-ci .
docker run --rm -v "$PWD:/workspace" -w /workspace -e CI=1 agentdashboard-ci
```

The image is based on the official Playwright `v1.56.1-noble` image, which pins Chromium and its Linux runtime dependencies to the Playwright version in `package.json`; the image includes Node 22.16 or newer. The container runs `npm ci`, `npm test`, `npm run check`, and `npm run test:e2e` in that order. The workflow in `.github/workflows/e2e.yml` builds and runs the same image for browser E2E.

The current directory is mounted at `/workspace`, so the lockfile and source are read directly from the checkout. `npm ci` installs dependencies in the container; `node_modules` is ignored by the Docker build and is not needed on the host. Docker needs network access during image build and `npm ci` to download the base image and npm packages. Playwright starts its test server on `127.0.0.1:4317` inside the container. The tests reach it internally, so no host port needs to be published; if you do publish the port for debugging, bind it to `127.0.0.1` rather than exposing it to the LAN. No external test server or service is required.

```bash
npm run check
npm test
npm run smoke
```

Tests cover token-free local reporting, automatic dashboard connection, local-only binding, remote/foreign-origin rejection, network login, HTTP authentication and validation, cross-origin rejection, state revisions and conditional responses, multiple computers, disconnect expiry, plugin session events, parent/subagent relationships, actual Git status/log/worktree collection, and exclusion of raw tool arguments. They invoke the real HTTP request handler in memory so they run without permission to bind ports.

Final hardening validation adds a deterministic sustained workload of 8 machine identities, 64 sessions per machine (nested parent/subagent trees), and 10 report rounds (512 retained sessions / 80 sustained reports), followed by an outage and companion restart with heartbeat repopulation. It checks unchanged versus meaningful state revisions, retention, status-only payload contents, and uses generous ceilings of 3 MB of report traffic, 5 MB of polled state traffic, 1 MB for the final retained-state snapshot, and 64 MB of observed Node heap growth. An additional maximum-size report test retains 1,000 sessions with model and usage metadata within the 1 MiB request cap and verifies unchanged metrics do not alter the ETag. These are local in-process bounds, not claims about physical LAN throughput or a multi-day deployment.

`npm run smoke` is the separate, opt-in live-runtime smoke test; neither `npm test` nor `npm run check` needs OpenCode or live ports. It starts an isolated OpenCode server with this plugin, creates parent/child sessions through the OpenCode API, verifies their reported relationship, idle state, and lifecycle timestamps, then checks disconnection and recovery after restarting the OpenCode process. Restart checks that the machine identity is stable while the process/instance identity changes. Smoke config, data, cache, state, and home directories are temporary; the test uses no existing OpenCode config and cleans up its processes and files. It makes no LLM calls.

The live smoke requires `opencode` on `PATH`, permission to bind localhost ports, and any network access OpenCode itself needs. Its no-LLM server/session operations verify creation and initial idle telemetry, but do not cause agent execution, so busy/idle resumption, permission waits/replies, retry/error events, and their reporting remain covered by deterministic plugin tests rather than this live smoke. Those execution-driven scenarios depend on an agent run and, for permissions and failures, suitable runtime/tool conditions; they are not silently treated as live-runtime coverage.

Known limits: companion state is memory-only, so a restart depends on subsequent plugin heartbeats and does not restore history. The sustained workload uses deterministic in-memory HTTP dispatch and synthetic machines; it does not emulate real WAN latency, packet loss distributions, or multi-day memory behavior. The no-LLM OpenCode smoke passed against OpenCode 1.18.35 and verifies lifecycle reporting only; it does not verify token values from a real inference or provider-specific context semantics. Model completion verification is documented above as an opt-in manual check. Browser E2E passed in the repository's pinned Playwright Docker image; the host's Ubuntu 26.04 installation cannot download a compatible Playwright Chromium for direct local execution.

Source layout:

- `src/plugin.js`: standalone file loaded by OpenCode; SDK discovery, event tracking, Git inspection, heartbeat/retry.
- `src/server.js`: authenticated report collection, stale detection, static GUI serving.
- `public/`: accessible, responsive dashboard; safe text rendering without HTML interpolation.
- `test/`: in-memory HTTP and plugin/Git integration tests.
- `scripts/`: plugin installer and real OpenCode smoke test.

If the dashboard stays empty, check that the plugin is installed in the correct scope, the companion is reachable, and (for network mode) the matching token and URL are exported **before** starting OpenCode. Network/report errors are intentionally swallowed by the plugin so monitoring cannot interrupt agent execution. The dashboard shows lost connectivity rather than claiming stale agents are active.
