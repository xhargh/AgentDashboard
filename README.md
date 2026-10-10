# OpenCode Supervisor

> **Note:** This project is AI-generated, and not all features or configurations have been tested.

A Linux-friendly, browser-based GUI for watching many OpenCode instances across projects and computers. A small OpenCode plugin reports to a central Node.js companion; the companion serves the dashboard. No runtime npm dependencies or build step.

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

Open **http://127.0.0.1:4317**. The dashboard connects automatically without a login. Without `SUPERVISOR_TOKEN`, the companion always binds to `127.0.0.1`, ignoring `HOST`, and accepts only local connections. It also checks the request hostname and browser origin. Do not forward or proxy this unauthenticated mode to other computers; use network mode for that.

Install the plugin, then start OpenCode in your project:

```bash
npm run install-plugin
cd /path/to/your/project
opencode
```

No plugin token or URL is needed for the default local setup. If switching from network mode, remove `SUPERVISOR_TOKEN` from `.env` and unset it in the companion shell. Remove/unset `OPENCODE_SUPERVISOR_TOKEN` and any remote `OPENCODE_SUPERVISOR_URL` in the OpenCode shell. Restart both processes after changing their configuration. Without a token, the plugin only reports to loopback addresses and will not follow redirects.

`npm start` loads `.env` automatically; no sourcing is needed. Exported shell variables take precedence over `.env`. Direct `node src/server.js` and the systemd service use their process environment. A nonempty token shorter than 24 characters is a configuration error, not a fallback to local mode.

Restart any OpenCode processes that were already running. Repeat in other project directories or terminals. The installer honors `XDG_CONFIG_HOME`. To install for just one project instead:

```bash
node scripts/install-plugin.js /path/to/project
```

Use one installation scope per project to avoid loading two copies. The installer replaces `supervisor.js` if previously installed. Re-run it after updating the checkout. Remove that file to uninstall.

## Several computers over a LAN

Choose one computer to run the companion. Generate a shared secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`, then configure it on that machine:

```bash
export SUPERVISOR_TOKEN='your-generated-secret'
HOST=0.0.0.0 PORT=4317 npm start
```

A valid `SUPERVISOR_TOKEN` enables network mode and defaults to `HOST=0.0.0.0`; you can set `HOST` to a particular interface or loopback. Settings can also be placed in `.env`. The browser asks for the shared token when connecting.

Allow inbound TCP port 4317 from your LAN using your firewall. On every monitored computer, copy this repository, install the plugin, and configure OpenCode:

```bash
npm run install-plugin
export OPENCODE_SUPERVISOR_URL='http://192.168.1.10:4317'
export OPENCODE_SUPERVISOR_TOKEN='your-generated-secret'
# Optional stable, unique display name; defaults to OS hostname:
export OPENCODE_SUPERVISOR_HOST='linux-workstation'
opencode
```

Replace `192.168.1.10` with the companion machine's address. Open that address in a browser on any computer to view the combined fleet. Plugins push outbound reports; monitored computers need no inbound ports. Give machines distinct host labels so computer counts remain meaningful.

In network mode, all API requests require the shared bearer token, including dashboard reads. The browser keeps it only in memory. Plain HTTP exposes the token and telemetry to network observers: use it on a trusted LAN, or place the companion behind an HTTPS reverse proxy / encrypted private network. TLS terminates at your proxy; point plugins and the browser to its HTTPS URL. Do not publish the plain HTTP service to the internet. Token rotation requires updating the companion and restarting configured OpenCode instances.

By default, telemetry includes paths, session/task titles, tool activity, and Git status, filenames, worktrees, and commit subjects. It excludes prompts, assistant text, reasoning, raw tool arguments, and tool output. Tool/session titles can still contain sensitive information. Git is inspected on the monitored machine with bounded, read-only subprocesses, never through remotely supplied shell commands. Configure plugin privacy with `OPENCODE_SUPERVISOR_TELEMETRY`, a JSON object set in the OpenCode process environment. For example:

```bash
export OPENCODE_SUPERVISOR_TELEMETRY='{"titles":false,"tasks":false,"toolActivity":false,"paths":false,"git":false}'
```

The available categories are `titles`, `tasks`, `toolActivity`, `paths`, and `git`; each defaults to `true`. Setting a category to `false` omits its data in the plugin before transmission. Git snapshots include paths (repository roots, filenames, and worktree locations), so setting `paths` to `false` also disables `git`. The status-only profile is `{"profile":"status-only"}` and disables all five categories while retaining host/machine/instance identity, process ID, session IDs, parent relationships, and session statuses. Configuration must be valid JSON with known boolean categories; invalid settings disable reporting and produce a local diagnostic. Older reports remain accepted, including reports without optional session metadata or Git snapshots.

## Run as a Linux user service

Copy `packaging/opencode-supervisor.service` into `~/.config/systemd/user/`. Edit its `WorkingDirectory` and `ExecStart` to match this checkout and the output of `command -v node`.

Create `~/.config/opencode-supervisor/environment` (keep it readable only by your user):

```ini
SUPERVISOR_TOKEN=your-generated-secret
HOST=0.0.0.0
PORT=4317
```

Then:

```bash
chmod 600 ~/.config/opencode-supervisor/environment
systemctl --user daemon-reload
systemctl --user enable --now opencode-supervisor
journalctl --user -u opencode-supervisor -f
```

For token-free local access, leave `SUPERVISOR_TOKEN` empty or omit it from the service environment file. For authenticated local access, keep the token and set `HOST=127.0.0.1`. The user service normally follows your login session; enable user lingering separately if you want it running after logout.

## Configuration

| Process | Variable | Default |
|---|---|---|
| Companion | `SUPERVISOR_TOKEN` | Absent: local mode. Set to 24+ characters for network mode |
| Companion | `HOST` | No token: forced `127.0.0.1`. With token: `0.0.0.0` |
| Companion | `PORT` | `4317` |
| OpenCode | `OPENCODE_SUPERVISOR_TOKEN` | Absent: local reports only. Required for a network companion |
| OpenCode | `OPENCODE_SUPERVISOR_URL` | `http://127.0.0.1:4317` |
| OpenCode | `OPENCODE_SUPERVISOR_HOST` | OS hostname |
| OpenCode | `OPENCODE_SUPERVISOR_TELEMETRY` | All metadata categories enabled; accepts category booleans or `{"profile":"status-only"}` |

The plugin creates a stable machine ID in `$XDG_CONFIG_HOME/opencode-supervisor/machine-id` (or `~/.config/opencode-supervisor/machine-id` when `XDG_CONFIG_HOME` is unset). Each plugin process generation also gets a fresh instance ID. Display hostnames remain configurable and are not used as machine identity. Failed reports retry with exponential jitter from 0.5–60 seconds, without overlapping requests; successful reports reset the delay. Failure diagnostics are secret-free and limited to one per 30 seconds. Authentication/report-configuration errors are labeled separately from server, network, and timeout failures.

Session state is held in memory. Companion restarts recover from the next plugin heartbeat. Plugin restarts get new instance IDs while retaining the machine ID; old entries remain visibly offline until expiration. Older plugin reports without machine IDs remain accepted and are grouped by hostname. Idle sessions are retained up to a soft 500-session limit per plugin; active sessions are preferred. The companion accepts up to 1,000 sessions/report, 1 MiB/report and 2,000 retained instances.

“Active” means busy, retrying, or waiting for permission. Idle and errored sessions are visible but not counted as active. Idle main agents display **Waiting for input** in amber; idle subagents display **Finished** in muted blue. Finished is inferred from the subagent being idle, not a permanent closed state: a recalled subagent returns to busy/retry/waiting as its status changes. Permission waits have a separate **Waiting for permission** badge. Offline instances always show **Offline** instead of these live states. Subagents are sessions with an OpenCode `parentID`; the display links them to their parent title. Activity reflects the latest tool event, not private model reasoning. Git snapshots refresh approximately every ten seconds, independently of the GUI. Child session folders are displayed, while Git panels describe the plugin instance's project folder. Missing Git, unborn branches, and non-repository folders are handled without affecting OpenCode.

## Verification and development

```bash
npm run check
npm test
npm run smoke
```

Tests cover token-free local reporting, automatic dashboard connection, local-only binding, remote/foreign-origin rejection, network login, HTTP authentication and validation, cross-origin rejection, state revisions and conditional responses, multiple computers, disconnect expiry, plugin session events, parent/subagent relationships, actual Git status/log/worktree collection, and exclusion of raw tool arguments. They invoke the real HTTP request handler in memory so they run without permission to bind ports.

`npm run smoke` is a separate real-network test: it starts an isolated OpenCode server with this plugin, creates parent/child sessions through the OpenCode API, and waits for them in the companion. It needs `opencode` on PATH, permission to open localhost ports, and any network access required by OpenCode itself. It makes no LLM calls. Temporary files and processes are cleaned up.

Source layout:

- `src/plugin.js`: standalone file loaded by OpenCode; SDK discovery, event tracking, Git inspection, heartbeat/retry.
- `src/server.js`: authenticated report collection, stale detection, static GUI serving.
- `public/`: accessible, responsive dashboard; safe text rendering without HTML interpolation.
- `test/`: in-memory HTTP and plugin/Git integration tests.
- `scripts/`: plugin installer and real OpenCode smoke test.

If the dashboard stays empty, check that the plugin is installed in the correct scope, the companion is reachable, and (for network mode) the matching token and URL are exported **before** starting OpenCode. Network/report errors are intentionally swallowed by the plugin so monitoring cannot interrupt agent execution. The dashboard shows lost connectivity rather than claiming stale agents are active.
