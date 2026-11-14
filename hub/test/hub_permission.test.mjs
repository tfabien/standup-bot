import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHub } from '../hub.mjs';

const EV = { v: 2, session: 'abcd', project: 'proj', agent: 'lead', role: 'lead', evt: 'PermissionRequest', state: 'needs_you', cmd: 'Approve? Bash git status', detail: '' };
const REQ = { session: 'abcd', agent: 'lead', tool: 'Bash', cmd: 'git status', detail: 'git status', wait_s: 30 };
const post = (hub, p, body, raw, init = {}) => fetch(`http://127.0.0.1:${hub.port}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ?? JSON.stringify(body), ...init,
});
const state = async (hub) => (await fetch(`http://127.0.0.1:${hub.port}/state`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withHub(fn) {
  const hub = await startHub({ port: 0, config: { relay: { mode: 'none' }, quotas: false }, userDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hubu-')) });
  try { await fn(hub); } finally { await hub.close(); }
}

/** Waits until the state shows (or stops showing) a perm on session abcd. */
async function permOf(hub, want = true) {
  for (let i = 0; i < 50; i++) {
    const s = (await state(hub)).sessions.find((x) => x.id === 'abcd');
    if (Boolean(s?.perm) === want) return s?.perm ?? null;
    await sleep(20);
  }
  throw new Error(`perm ${want ? 'never showed' : 'never cleared'}`);
}

test('post_permission_then_answer_allow', () => withHub(async (hub) => {
  await post(hub, '/event', EV);
  const held = post(hub, '/permission', REQ);
  const perm = await permOf(hub);
  assert.equal(perm.tool, 'Bash');
  assert.equal(perm.cmd, 'git status');
  const r = await post(hub, '/permission/answer', { id: perm.id, decision: 'allow' });
  assert.equal(r.status, 200);
  assert.deepEqual(await (await held).json(), { decision: 'allow' });
  await permOf(hub, false);
}));

test('answer_deny', () => withHub(async (hub) => {
  await post(hub, '/event', EV);
  const held = post(hub, '/permission', REQ);
  const perm = await permOf(hub);
  await post(hub, '/permission/answer', { id: perm.id, decision: 'deny' });
  assert.deepEqual(await (await held).json(), { decision: 'deny' });
}));

test('delay_returns_none', () => withHub(async (hub) => {
  await post(hub, '/event', EV);
  const r = await post(hub, '/permission', { ...REQ, wait_s: 1 });
  assert.deepEqual(await r.json(), { decision: 'none' });
  await permOf(hub, false);
}));

test('closed_connection_removes_perm', () => withHub(async (hub) => {
  await post(hub, '/event', EV);
  const ctl = new AbortController();
  const held = post(hub, '/permission', REQ, undefined, { signal: ctl.signal }).catch(() => null);
  await permOf(hub);
  ctl.abort();
  await held;
  await permOf(hub, false);
}));

test('post_tool_use_event_returns_none', () => withHub(async (hub) => {
  await post(hub, '/event', EV);
  const held = post(hub, '/permission', REQ);
  await permOf(hub);
  await post(hub, '/event', { ...EV, evt: 'PostToolUse', state: 'working', cmd: 'Bash git status' });
  assert.deepEqual(await (await held).json(), { decision: 'none' });
}));

test('dismiss_returns_none', () => withHub(async (hub) => {
  await post(hub, '/event', EV);
  const held = post(hub, '/permission', REQ);
  await permOf(hub);
  await post(hub, '/dismiss', { session: 'abcd' });
  assert.deepEqual(await (await held).json(), { decision: 'none' });
}));

test('reset_returns_none', () => withHub(async (hub) => {
  await post(hub, '/event', EV);
  const held = post(hub, '/permission', REQ);
  await permOf(hub);
  await post(hub, '/reset', {});
  assert.deepEqual(await (await held).json(), { decision: 'none' });
}));

test('answer_unknown_id_is_404', () => withHub(async (hub) => {
  const r = await post(hub, '/permission/answer', { id: 'nope', decision: 'allow' });
  assert.equal(r.status, 404);
}));

test('answer_bad_decision_is_400', () => withHub(async (hub) => {
  await post(hub, '/event', EV);
  const held = post(hub, '/permission', { ...REQ, wait_s: 1 });
  const perm = await permOf(hub);
  const r = await post(hub, '/permission/answer', { id: perm.id, decision: 'maybe' });
  assert.equal(r.status, 400);
  await held;
}));

test('missing_fields_is_400', () => withHub(async (hub) => {
  assert.equal((await post(hub, '/permission', { agent: 'lead', tool: 'Bash' })).status, 400);
  assert.equal((await post(hub, '/permission', { session: 'abcd', tool: 'Bash' })).status, 400);
  assert.equal((await post(hub, '/permission', { session: 'abcd', agent: 'lead' })).status, 400);
  assert.equal((await post(hub, '/permission', null, '{not json')).status, 400);
}));
