import test from 'node:test';
import assert from 'node:assert/strict';
import { createPermissions } from '../permissions.mjs';

const REQ = { session: 'abcd', agent: 'lead', tool: 'Bash', cmd: 'git status', detail: 'git status', wait_s: 30 };

/** A store with a manual clock: timers fire only when `fire()` is called. */
function fake() {
  const timers = new Map();
  let n = 0;
  const perms = createPermissions({
    now: () => 1000,
    setTimer: (fn, ms) => { timers.set(++n, { fn, ms }); return n; },
    clearTimer: (id) => timers.delete(id),
  });
  return { perms, timers, fire: () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } } };
}

test('answer_allow_resolves_allow', async () => {
  const { perms } = fake();
  const { id, promise } = perms.open(REQ);
  assert.equal(perms.answer(id, 'allow'), true);
  assert.equal(await promise, 'allow');
});

test('answer_deny_resolves_deny', async () => {
  const { perms } = fake();
  const { id, promise } = perms.open(REQ);
  assert.equal(perms.answer(id, 'deny'), true);
  assert.equal(await promise, 'deny');
});

test('delay_resolves_none', async () => {
  const { perms, fire } = fake();
  const { promise } = perms.open(REQ);
  fire();
  assert.equal(await promise, 'none');
  assert.equal(perms.view('abcd'), null);
});

test('wait_s_is_clamped_to_1_120', () => {
  const { perms, timers } = fake();
  perms.open({ ...REQ, session: 'a', wait_s: 0 });
  perms.open({ ...REQ, session: 'b', wait_s: 9999 });
  perms.open({ ...REQ, session: 'c', wait_s: undefined });
  assert.deepEqual([...timers.values()].map((t) => t.ms), [1000, 120000, 30000]);
});

test('view_shows_tool_cmd_detail_and_until', () => {
  const { perms } = fake();
  const { id } = perms.open(REQ);
  assert.deepEqual(perms.view('abcd'), { id, tool: 'Bash', cmd: 'git status', detail: 'git status', until: 31000 });
  assert.equal(perms.view('other'), null);
});

test('same_session_and_agent_replaces_older', async () => {
  const { perms } = fake();
  const first = perms.open(REQ);
  const second = perms.open({ ...REQ, cmd: 'ls' });
  assert.equal(await first.promise, 'none');
  assert.equal(perms.view('abcd').id, second.id);
  assert.equal(perms.answer(first.id, 'allow'), false);
});

test('different_agent_keeps_both_but_view_shows_latest', async () => {
  const { perms } = fake();
  const lead = perms.open(REQ);
  const sub = perms.open({ ...REQ, agent: 'ab12', cmd: 'ls' });
  assert.equal(perms.view('abcd').id, sub.id);
  assert.equal(perms.answer(lead.id, 'allow'), true);
  assert.equal(await lead.promise, 'allow');
  assert.equal(perms.view('abcd').id, sub.id);
});

test('clear_session_resolves_none', async () => {
  const { perms } = fake();
  const a = perms.open(REQ);
  const b = perms.open({ ...REQ, agent: 'ab12' });
  assert.equal(perms.clearSession('abcd'), true);
  assert.equal(await a.promise, 'none');
  assert.equal(await b.promise, 'none');
  assert.equal(perms.clearSession('abcd'), false);
});

test('clear_all_resolves_every_session', async () => {
  const { perms } = fake();
  const a = perms.open(REQ);
  const b = perms.open({ ...REQ, session: 'zzzz' });
  perms.clearAll();
  assert.equal(await a.promise, 'none');
  assert.equal(await b.promise, 'none');
});

test('cancel_removes_view', async () => {
  const { perms } = fake();
  const { id, promise } = perms.open(REQ);
  perms.cancel(id);
  assert.equal(await promise, 'none');
  assert.equal(perms.view('abcd'), null);
});

test('answer_unknown_id_is_false', () => {
  assert.equal(fake().perms.answer('nope', 'allow'), false);
});

test('answer_with_other_decision_is_false', async () => {
  const { perms } = fake();
  const { id } = perms.open(REQ);
  assert.equal(perms.answer(id, 'maybe'), false);
  assert.ok(perms.view('abcd'), 'still pending');
});

test('on_change_fires_on_open_and_resolve', () => {
  const { perms } = fake();
  let n = 0;
  perms.onChange(() => { n++; });
  const { id } = perms.open(REQ);
  assert.equal(n, 1);
  perms.answer(id, 'deny');
  assert.equal(n, 2);
});
