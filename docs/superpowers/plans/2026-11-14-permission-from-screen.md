# Permission from the screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer a Claude Code permission prompt with Allow or Deny buttons on the hub page, with the terminal prompt as the fallback.

**Architecture:** A `PermissionRequest` hook script posts `POST /permission` and waits on the held response. The hub keeps the pending request in a small store, publishes it as `perm` on the session in the state, and resolves it from `POST /permission/answer` (page click), a delay, a closed connection, or a clearing event of the session. Any resolution other than allow or deny prints nothing in the hook, so the terminal prompt stays.

**Tech Stack:** Node >= 18, standard library only, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-14-permission-from-screen-design.md`

## Global Constraints

- Hub: standard library only, binds `127.0.0.1`, no CORS. Both new routes are absent from `REMOTE_ROUTES` in `hub/lan.mjs` (a LAN client gets 403).
- Wire protocol stays 2 (additive routes). Both routes are listed in `docs/protocol.md` (test `protocol_doc.test.mjs`).
- Raise `version` in `hub/package.json` (minor) once, in Task 2.
- `notify.mjs` is untouched: it never blocks, gives up after 1.5 s. The waiting code is a separate script.
- Wait: config key `permission_wait_s`, default 30, 0 turns the feature off, hub clamps to 1..120. Hook timeout in `hooks.json` is 130.
- Deny message: `Denied from the agentsdash screen`.
- Comments, docs and on-screen text in English.
- Run tests with `node --test hub/test/*.test.mjs` (no directory argument).
- Work in a worktree of each repository; the checkout is shared with other sessions.

## Review Focus

- Hook connection closes while pending: the request disappears and the tile loses its buttons.
- Two requests for the same session and agent (parallel tools): the older resolves to `none`, only one `perm` is shown.
- Answer for an unknown or already resolved id: 404, no effect.
- Terminal answered during the wait (`PostToolUse` of the session): the held response ends with `none`.
- Hub restart or older core without the route: the hook prints nothing and exits 0 within the delay.

---

### Task 1: Pending permission store

**Files:**
- Create: `hub/permissions.mjs`
- Test: `hub/test/permissions.test.mjs`

**Interfaces:**
- Produces: `createPermissions({ now?: () => number, setTimer?, clearTimer? })` returning
  - `open({ session, agent, tool, cmd, detail, wait_s }): { id: string, promise: Promise<'allow'|'deny'|'none'> }` (clamps `wait_s` to 1..120, default 30; replaces and resolves `none` any pending request of the same session and agent)
  - `answer(id: string, decision: 'allow'|'deny'): boolean` (false when unknown or decision invalid)
  - `cancel(id: string): void` (resolves `none`, used when the connection closes)
  - `clearSession(session: string): boolean` (resolves every pending request of the session to `none`; true when one existed)
  - `clearAll(): void`
  - `view(session: string): { id, tool, cmd, detail, until } | null` (`until` is epoch ms; `agent` is not shown)
  - `onChange(fn)` called after every open, resolve or clear, so the hub can publish.

- [ ] **Step 1: Write the failing tests** in `hub/test/permissions.test.mjs`: `answer_allow_resolves_allow`, `answer_deny_resolves_deny`, `delay_resolves_none` (fake timer), `wait_s_is_clamped_to_1_120`, `same_session_and_agent_replaces_older`, `different_agent_keeps_both_but_view_shows_latest`, `clear_session_resolves_none`, `cancel_removes_view`, `answer_unknown_id_is_false`, `answer_with_other_decision_is_false`, `on_change_fires_on_open_and_resolve`.
- [ ] **Step 2: Run** `node --test hub/test/permissions.test.mjs`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement `createPermissions`** in `hub/permissions.mjs` with a `Map` keyed by id (`crypto.randomUUID()`), one timer per request cleared on resolve.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `hub: pending permission store (#4)`.

### Task 2: Hub routes, state, clearing, protocol doc

**Files:**
- Modify: `hub/hub.mjs` (routes near `case 'POST /event'`, `stateJson`, `/event`, `/dismiss`, `/reset` handling), `hub/package.json`, `docs/protocol.md`
- Test: `hub/test/hub_permission.test.mjs`; `hub/test/hub_lan.test.mjs` (answer route refused for a LAN client)

**Interfaces:**
- Consumes: `createPermissions` from Task 1.
- Produces:
  - `POST /permission` body `{ session, agent, tool, cmd, detail, wait_s }` (400 without `session`, `agent` or `tool`). The response stays open and ends with JSON `{ "decision": "allow" | "deny" | "none" }`. A closed request calls `cancel`.
  - `POST /permission/answer` body `{ id, decision }` answers `ok` (200) or 404 `unknown request`; 400 for a decision other than `allow` or `deny`.
  - `perm` on each session of `GET /state` and `/events`: `null`, or `{ id, tool, cmd, detail, until }`.
  - A session event with `evt` in `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Stop`, `SessionEnd`, plus `POST /dismiss` and `POST /reset`, calls `clearSession` or `clearAll`.

- [ ] **Step 1: Write the failing tests** in `hub/test/hub_permission.test.mjs`, using the helpers of `hub.test.mjs`: `post_permission_then_answer_allow` (state shows `perm` while held, then the held response says allow and `perm` is null), `answer_deny`, `delay_returns_none` (`wait_s` 1), `closed_connection_removes_perm`, `post_tool_use_event_returns_none`, `dismiss_returns_none`, `answer_unknown_id_is_404`, `answer_bad_decision_is_400`, `missing_fields_is_400`. In `hub_lan.test.mjs`: `lan_client_cannot_answer_or_open_permission` (403 for both routes).
- [ ] **Step 2: Run** `node --test hub/test/hub_permission.test.mjs hub/test/hub_lan.test.mjs`. Expected: FAIL, routes missing.
- [ ] **Step 3: Implement** the two routes in `hub/hub.mjs` as their own `case` entries (the `POST /permission` case writes the response only when the promise settles, and publishes on the store's `onChange`); add `perm` to the state of each session in `stateJson()`; call the clearing functions from the event, dismiss and reset paths. Keep both routes off `REMOTE_ROUTES`.
- [ ] **Step 4: Document** both routes (headings `### POST /permission`, `### POST /permission/answer`) and the `perm` field in `docs/protocol.md`; raise the minor `version` in `hub/package.json`.
- [ ] **Step 5: Run** `node --test hub/test/*.test.mjs`. Expected: all PASS, including `protocol_doc.test.mjs` and `core_standalone.test.mjs` (the new module is in `hub/`).
- [ ] **Step 6: Commit** `hub: POST /permission holds a request until a click (#4)`.

### Task 3: Buttons on the page

**Files:**
- Modify: `hub/web/screen.js` (drawing in the tile with `s.perm`, `hitTest`), `hub/web/hub_page.js` (click handler near line 147)
- Test: `hub/test/screen.test.mjs`, `hub/test/web.test.mjs`

**Interfaces:**
- Consumes: `perm` on the session from Task 2.
- Produces: `hitTest` returns `{ kind: 'permAllow' }` or `{ kind: 'permDeny' }` for the two buttons of a tile whose session has `perm`; while `perm` is set the plan bar and sub-agent rows give no hits. `hub_page.js` posts `POST /permission/answer` with `{ id: s.perm.id, decision: 'allow' | 'deny' }` on those hits.

- [ ] **Step 1: Write the failing tests**: in `screen.test.mjs`, `perm_tile_draws_tool_cmd_and_two_buttons` (the tool and the first characters of `cmd` appear in the drawn text, via the test's existing draw recorder), `hit_test_allow_and_deny_buttons`, `hit_test_ignores_plan_bar_while_perm`; in `web.test.mjs`, `page_posts_answer_for_perm_click` (the posted body has the `perm` id and the decision).
- [ ] **Step 2: Run** `node --test hub/test/screen.test.mjs hub/test/web.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** a `drawPermission(perm, x, y, w, p)` next to `drawQuestion` in `screen.js`: tool line in `COLOR.NEEDS`, the argument wrapped over up to 2 lines, then an Allow button (`COLOR.WORKING`) and a Deny button (`COLOR.ERROR`) side by side at the bottom of the panel, plus the remaining seconds from `perm.until`. Add the two hit rectangles to `hitTest` before the plan-bar test. Mirror the same two buttons in the same 480x272 units so the device port can reuse them.
- [ ] **Step 4: Wire** the two hit kinds in the click handler of `hub_page.js` with the same `fetch` style as `/dismiss`; the state update arrives through SSE, no local change.
- [ ] **Step 5: Run** `node --test hub/test/*.test.mjs`. Expected: PASS.
- [ ] **Step 6: Commit** `page: Allow and Deny buttons on a tile with a permission request (#4)`.

### Task 4: Adapter hook (repository `agentsdash-claude`)

**Files:**
- Create: `plugin/scripts/permission.mjs`
- Modify: `plugin/hooks/hooks.json` (second command on `PermissionRequest`, `"timeout": 130`), `plugin/scripts/hub_client.mjs` (minimum core version), `plugin/scripts/common.mjs` only if `pluginConfig` cannot return `permission_wait_s`, `plugin/README.md`, `INSTALL.md`
- Test: `plugin/test/permission.test.mjs`

**Interfaces:**
- Consumes: `POST /permission` of Task 2 (answer `{ decision }`), the hub host resolution of `hubHost()` and `pluginConfig()` from `common.mjs`.
- Produces: `decide(payload, { host, waitS, post }): Promise<'allow'|'deny'|'none'>` and `outputFor(decision): string | null` exported from `permission.mjs`; the script, run directly, prints `outputFor(...)` when not null and always exits 0.
  - allow → `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
  - deny → same with `"behavior":"deny","message":"Denied from the agentsdash screen"`
  - none → `null`, nothing printed.

- [ ] **Step 1: Write the failing tests**: `allow_prints_allow_json`, `deny_prints_deny_json_with_message`, `none_prints_nothing`, `hub_unreachable_is_none` (connection refused, within 1 s), `old_core_without_route_is_none` (404), `wait_zero_skips_the_request` (the fake `post` is not called), `wait_is_capped_at_120`, `body_carries_session_agent_tool_cmd_detail` (cmd and detail built like `toolParts` of `notify.mjs`; export that helper from `notify.mjs` or `common.mjs` instead of copying it), `mask_sends_tool_name_only` (same `AGENTSDASH_MASK=1` rule as `notify.mjs`).
- [ ] **Step 2: Run** `node --test plugin/test/permission.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `permission.mjs`: read stdin, call `decide`, print. Request timeout is `waitS` plus 2 s; any error returns `none`.
- [ ] **Step 4: Register** the script in `hooks.json` after the `notify.mjs` entry (both run in parallel), and raise `MIN_CORE` in `hub_client.mjs` to the core version of Task 2 (the older-core case already returns `none`, the raise only drives the auto-update).
- [ ] **Step 5: Document** `permission_wait_s` (default 30, 0 = off, max 120) in `plugin/README.md` and `INSTALL.md`; refresh `hub/test/fixtures/events*.jsonl` in the core repository only if the adapter's recorded events changed (they do not in this task).
- [ ] **Step 6: Run** the adapter test suite (`node --test plugin/test/*.test.mjs`). Expected: PASS.
- [ ] **Step 7: Commit** `plugin: PermissionRequest waits for an Allow or Deny from the hub (#4)`.

### Task 5: Real-session check and release notes

**Files:**
- Modify: none in code unless the check fails (then the failing task is reopened).

- [ ] **Step 1: Run the checkout hub** with the Task 2 build and the plugin from the Task 4 worktree; start a Claude Code session that needs a permission (`Bash` command not on the allow list).
- [ ] **Step 2: Click Allow** on the tile: the command runs, the terminal dialog closes. Repeat with Deny: Claude reports the denial message.
- [ ] **Step 3: Check the fallbacks**: stop the hub, trigger a prompt, the terminal dialog is the only answer; with the hub up, answer in the terminal during the wait, the tile loses its buttons.
- [ ] **Step 4: Record** in the PR description whether a hook decision closes the terminal dialog (the open point of the spec), and whether the terminal waited for the hook beyond the delay.
- [ ] **Step 5: Push both branches, open one PR per repository, squash merge** (default flow of this project); merge the core first.
