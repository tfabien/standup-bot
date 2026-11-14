# agentsdash protocol

The wire contract between an adapter (the code that watches an agent: Claude Code hooks, a Codex client...), the hub, and the pages and devices that read the hub.
An adapter or a device is correct when it follows this document. A test (`hub/test/protocol_doc.test.mjs`) fails when a route or an event field of the code is missing here, or when a route listed here no longer exists.

The protocol version is **2**. `GET /health` reports it as `protocol` (see below). An adapter declares the protocol it speaks and refuses a hub that answers another one.

## Transport rules

- The hub listens on `127.0.0.1` (default port 8765). Bodies are JSON (`Content-Type: application/json`), at most 64 KiB (413 above).
- A request must name the hub in `Host` (`127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`), else 403 `forbidden host`.
- A request that carries an `Origin` header must carry the hub's own origin, else 403 `forbidden origin`. Adapters send no `Origin`. There is no CORS.
- Text keeps its full Unicode and length on the hub. Only identifiers are cut (4 characters). Devices get text through `forDevice` (see `device-protocol.md`).
- An adapter never blocks its agent: short timeouts (a hook gives up after 1.5 s), no output, no failure when the hub is down.

## Event and usage routes

### POST /event

One agent reports its state. The body is a v2 event; the full state of that agent travels in every event, so a dropped event is repaired by the next one.
Answers 200 `ok`, or 400 `session, agent and a valid state are required`.

| Field | Type | Meaning |
|---|---|---|
| `v` | number | Always `2`. |
| `session` | string | Session id, cut to 4 characters. Required. |
| `agent` | string | `lead` for the main agent, else a sub-agent id (4 characters). Required. |
| `state` | string | `needs_you`, `error`, `your_turn`, `working` or `done`. Required. |
| `project` | string | Project name shown on the tile. |
| `cwd` | string | Full working directory. Stays on the hub (per-project rules), never sent to a device. |
| `role` | string | Role of a sub-agent (its type). |
| `evt` | string | Name of the source event (`PreToolUse`, `Stop`, `SubagentStop`, `SessionStart`, `UserPromptSubmit`, `SessionEnd`...). The hub reacts to some of them. |
| `cmd` | string | What the agent is doing, one line. |
| `detail` | string | Extra line under `cmd`. |
| `title` | string | Title of the session. |
| `model` | string | Model name. |
| `tok` | number | Tokens of this agent. Absent or not a number means unknown. |
| `stok` | number | Tokens of the whole session (lead only). |
| `ctx_pct` | number | Context used, percent (lead only). |
| `ctx_k` | number | Context used, thousands of tokens (lead only). |
| `plan_done` | number | Finished steps of the task list (lead only). |
| `plan_total` | number | Steps of the task list. 0 means no list. |
| `plan_items` | string[] | Up to 30 steps, each `<mark> <title>` where the first character is the step state. |
| `plan_cur` | string | Title of the step in progress. Present even when empty (an empty string clears it). |
| `plan_next` | string | Title of the next step. Present even when empty. |
| `plan_state` | string | Short state of the list. |
| `question` | string | A question waiting for the user (lead only). |
| `options` | string | The answers offered, in one line. |
| `reply_first` | string | First paragraph of the last reply, 300 characters. Only a `Stop` carries it; any later event clears it. |
| `reply_last` | string | Last paragraph of the last reply, 300 characters. |

An old v0.1 body `{ "agent": "<name>", "state": "working|waiting|done|error", "task": "..." }` is still accepted and becomes a session of its own.

### POST /usage

Quotas and context from a status line or a poller. The body must hold `v` (a number, currently `1`), else 400 `v is required`.

| Field | Type | Meaning |
|---|---|---|
| `v` | number | Version of this body, `1`. |
| `session` | string | Session id (4 characters). An unknown session creates no tile. |
| `ctx_pct`, `ctx_k` | number | Context used of that session. |
| `ctx_max_k` | number | Size of the context window, thousands of tokens. |
| `h5_pct`, `d7_pct` | number | Quota used in the 5 hour and 7 day windows, percent. |
| `h5_reset_s`, `d7_reset_s` | number | Seconds until the window resets. |
| `h5_rate10`, `d7_rate10` | number | Pace over the last 10 minutes. |
| `h5_proj`, `d7_proj` | number | Projected use at the reset, percent. |
| `h5_empty_s`, `d7_empty_s` | number | Seconds until the quota is empty at the current pace. |

### POST /dismiss

Body `{ "session": "<id>" }`. Hides a session; it returns with its next working, error or needs-you event. 404 `unknown session`.

### POST /permission

A `PermissionRequest` hook asks the page for Allow or Deny. Body `{ "session", "agent", "tool", "cmd", "detail", "wait_s" }` (strings, `wait_s` a number of seconds, default 30, clamped to 1..120). 400 when `session`, `agent` or `tool` is missing. The response stays open until the user taps, then answers `{ "decision": "allow" | "deny" | "none" }`. `none` means nobody decided: the delay passed, a newer request of the same session and agent replaced it, or the session moved on (`PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Stop`, `SessionEnd`, `/dismiss`, `/reset`). A hook that gets `none`, an error or a 404 (older core) prints nothing, so the terminal prompt decides. Loopback only: a LAN client gets 403.

### POST /permission/answer

Body `{ "id": "<id>", "decision": "allow" | "deny" }`, sent by the page with the `perm.id` of a session. 400 `decision must be allow or deny`, 404 `unknown request`. Loopback only.

### POST /settings

Settings shared by every page. Body: any of `sound` (`all`, `ask`, `off`), `max_tiles` (0 to 32), `theme`, `pulse`, `dim_idle`, `done_excerpt` (`first`, `last`, `off`), `rules`, `marketSources`, `themeAutoUpdate`, `themeVariant`, `themeLooks`, `themeOverrides`, `rate_alert_k` (0, 20, 40 or 80: 0 hides the token rate readout of the tiles, else it turns orange from that many thousand tokens per minute and red from 3 times that). Invalid entries are ignored; 400 when none is valid.

### POST /select

Body `{ "session": "<id>", "agent": "lead", "hold_ms": 30000 }`. Puts a session and agent in focus for `hold_ms`. 404 `unknown session or agent`.

### POST /reset

Forgets every session. The body may be empty.

## Reading routes

### GET /state

The whole state as JSON: `sessions` (each with `id`, `project`, `cwd`, `dot`, `count`, `more`, `title`, `ctx_pct`, `ctx_k`, `ctx_src`, `tok`, `rate`, `plan`, `ask`, `perm` (`null`, or `{ id, tool, cmd, detail, until }` with `until` in epoch milliseconds, while a hook waits for Allow or Deny), `agents`), `more_sessions`, `view`, `usage` (when quotas are known), `agents` (flat v0.1 list), `boot`, `settings`, `catalog`, and `relay` (when a device relay is set).
`rate` is `{ "tok_min": number }`, the tokens per minute of the session over the last 5 minutes, or `null` with fewer than 2 samples.
Each entry of `agents` holds `id`, `parent`, `role`, `state`, `cmd`, `detail`, `tok`, `model`, `prev`, `prev_age`, `age` and, after a `Stop`, `reply_first` and `reply_last`.

### GET /events

Server-sent events: the state above is sent on connect, then after every change.

### GET /health

`{ "ok": true, "version": "<core version>", "core": "<core version>", "protocol": 2, "script": "<path of hub.mjs>", "startedAt": <ms> }`.
`core` and `protocol` are the compatibility check: an adapter keeps a running hub only when `protocol` matches the one it speaks and `core` is not older than the minimum it needs. A hub that predates this field answers without `core` and `protocol`; treat that as protocol 2 with an unknown core.

#### How an adapter picks a core

An adapter finds a core in this order: a folder or script the user names (`AGENTSDASH_CORE_DIR`), a hub folder next to the adapter (a checkout), then the highest
`~/.agentsdash/core/<version>/` with `package.json` `protocol` equal to the protocol it speaks and `version` not below its minimum. With none, it downloads the newest
GitHub release whose asset is named `agentsdash-core-<version>-p<protocol>.tar.gz` (plus `.sha256`) and checks the digest before unpacking. It leaves a running hub
alone when `/health` shows the same `protocol` and a `core` at or above its minimum, and asks any other hub to stop with `POST /shutdown`.

#### How an adapter updates a core

An adapter that runs an installed core (not a checkout, not a folder named by `AGENTSDASH_CORE_DIR`) looks for a newer release once a day, on the first event after 24 hours (stamp `core_update.stamp` in the state folder).
It runs the same download as a first install: the newest non-draft, non-prerelease release with a `-p<protocol>` asset for the protocol it speaks, digest checked, unpacked into its own `~/.agentsdash/core/<version>/` folder.
The running hub is not touched. The next hub start runs the highest installed folder, and a hub whose `core` is above the adapter's minimum is never replaced. A failed check (offline, bad digest) leaves the old core and retries the next day.

### POST /shutdown

Asks the hub to exit (a newer client starts a fresh one). Answers `bye`.

### POST /reload

Rescans the theme and icon folders.

## LAN access (phone)

Off by default. `lan.enabled` in the config file (or `AGENTSDASH_LAN=1`) binds the hub to `lan.bind` (default `0.0.0.0`). A client that does not connect from loopback must carry the cookie `agentsdash_token`, else 401.
It may call only `GET /phone`, `/manifest.webmanifest`, `/state`, `/events`, `/health` and the static files and icons the page loads (anything else: 403), and its `Host` must be a private address or the name of the machine. The token lives in `~/.agentsdash/lan-token`.

### GET /pair

`?t=<token>`: a matching token answers `302` to `/phone` and sets the cookie (HttpOnly, SameSite=Lax); any other token answers 401.

### GET /pair-info

Loopback only. Answers `{ "enabled": <bool>, "url": "http://<private ip>:<port>/pair?t=<token>" }`; `url` is `null` when phone access is off or the machine has no private address.

### POST /lan

Loopback only. Body `{ "enabled": true|false }` (else 400). Turns phone access on or off while the hub runs: the hub writes `lan.enabled` to the config file, creates the token when needed and moves its listener to `lan.bind` (on) or `127.0.0.1` (off); open connections stay. Answers `{ "ok": true, "enabled": <bool> }`.

## Hub management routes

Used by the page. An adapter does not need them.

| Route | Meaning |
|---|---|
| GET /market | Theme marketplace: sources, installed themes, listings, errors. |
| POST /market/refresh | Forget the cached listings. |
| POST /market/sources | Body `{ "add": "owner/repo" }` or `{ "remove": "owner/repo" }`. |
| POST /market/install | Body `{ "source": "owner/repo", "name": "<theme>" }`. Installs and applies a theme. |
| POST /market/remove | Body `{ "name": "<theme>" }`. Removes a user theme. |
| POST /market/update | Body `{ "name": "<theme>" }` or empty. Checks for newer versions. |
| POST /themes | Saves the current look as a user theme. |
| GET /relay | State of the device relay (`mode` is `none`, `http` or `serial`). |
| GET /relay/ports | Serial ports found. |
| POST /relay/test | Sends a probe through the relay. |
| POST /relay | Sets the relay (see `device-protocol.md`). |
| POST /serial/release | Frees the serial port (for a firmware upload). |
| POST /serial/open | Opens the serial port again. |

`GET /icons/<pack>/<file>` serves the icon files listed in the catalog only (sandboxed SVG or PNG). Any other `GET` serves a file of the page (`/` is the hub page).
