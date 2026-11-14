# Answer a permission request from the screen (issue #4)

Size: a project across two repositories (this hub, `agentsdash-claude`). Page first, device later.

## Intent

A Claude Code session stops on a permission prompt. The user sees the tile on the hub page and answers Allow or Deny there. The answer resolves the prompt in Claude Code. The user does not have to switch to the terminal.

## Goals

- A tile with a pending permission shows the tool, its argument, and two buttons (Allow, Deny).
- A click resolves the prompt in Claude Code.
- Hub down, hub error, no click before the delay, or a click on a request already answered in the terminal: the terminal prompt is untouched.
- The wait is configurable (default 30 s, 0 turns the feature off).

## Non-goals

- Free choice among the options of `AskUserQuestion` (no hook can answer it).
- Buttons on the device touch screen and on the phone page (a LAN client is read-only; the device comes later).
- "Always allow" rules and edited tool input.

## Anti-goals

- A hub failure must never block or auto-answer a prompt.
- No answer is ever sent without a click.

## Constraints

- `notify.mjs` keeps its rule: never blocks, gives up after 1.5 s. The waiting code is a second hook script on `PermissionRequest`. Both run in parallel.
- Hub: standard library only, binds `127.0.0.1`, no CORS. The answer route is loopback only, no pairing cookie accepted.
- Protocol 2 stays: new routes are additive. `docs/protocol.md` lists them (a test checks this). `core` minor version goes up.

## Approaches

- A. One held request. The hook sends `POST /permission`, the hub keeps the response open until a click or the delay. **Picked.** One route, in-memory state, no polling.
- B. Deposit then poll `GET /permission/<id>` every 500 ms. Survives a dropped connection, costs about 60 requests per 30 s request.
- C. Subscribe to SSE and filter. Heavier hook logic, no gain over A.

## Design

Hub (`hub.mjs`, `model.mjs`):
- `POST /permission` body `{ session, agent, tool, cmd, detail, wait_s }` creates a pending request `{ id, session, agent, tool, cmd, detail, until }` and holds the response. It answers `{ decision: "allow" | "deny" | "none" }`.
- The state publishes it as `perm` on the session, next to `ask`.
- `POST /permission/answer` body `{ id, decision }` resolves it. Loopback only.
- A request resolves to `none` when: the delay passes, the hook connection closes, the session gets `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Stop` or `SessionEnd` (the terminal answered), `/dismiss` or `/reset` runs.
- One pending request per session and agent: a new one resolves the older one to `none`.
- Text goes through the usual `forDevice` path only when a device is fed; the page gets the full text.

Page (`web/screen.js`, `web/hub_page.js`):
- Like `drawQuestion`: a tile with `perm` draws the tool line, a shortened argument and two buttons, with a hit test in the tap handler. `hub_page.js` posts the answer.
- The tile shows a countdown of the remaining wait.

Adapter (`agentsdash-claude`):
- New `plugin/scripts/permission.mjs`: reads the hook payload, posts to the hub, waits.
  - `allow` prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`.
  - `deny` prints the same with `"behavior":"deny"` and a message ("Denied from the agentsdash screen").
  - `none`, any error, or hub missing: prints nothing, exit 0.
- `hooks.json`: second command on `PermissionRequest`, hook timeout above the cap (cap 120 s, timeout 130 s).
- Config key `permission_wait_s` in `~/.agentsdash/config.json` (default 30, 0 = skip, max 120). The old config path stays a fallback.
- The hub minimum `core` version in the adapter goes up to the release that has the route; an older core makes the script return `none`.

## Tests

- Hub: allow, deny, delay, connection closed, cleared by `PostToolUse`, replaced by a newer request, answer route refused from a LAN client, `docs/protocol.md` lists both routes.
- Adapter: output JSON for each decision, silence on error and on `wait_s` 0.
- Manual: a real Claude Code prompt with the hub up, the hub down, and a terminal answer during the wait.

## Open point for the builder

Check on a real session that a hook decision closes the terminal dialog, and that the hook waiting does not freeze the terminal beyond the delay. If the dialog stays open after a decision, the fallback is the same: `none` leaves the terminal in charge.

## Calls made without the user

- Cap 120 s and default 30 s.
- One pending request per session and agent.
- Deny message text.
