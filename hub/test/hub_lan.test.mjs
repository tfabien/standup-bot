import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startHub } from '../hub.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hubl-'));

/** A request with a chosen Host header (fetch cannot set it). */
function call(hub, { method = 'GET', p = '/', host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: hub.port, method, path: p, headers: { Host: host ?? `lan.test:${hub.port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withLan(fn) {
  const userDir = tmp();
  const hub = await startHub({ port: 0, userDir, config: { relay: { mode: 'none' }, quotas: false }, lan: { enabled: true, treatAllAsRemote: true, hosts: ['lan.test'] } });
  const token = fs.readFileSync(path.join(userDir, 'lan-token'), 'utf8').trim();
  try { await fn(hub, token); } finally { await hub.close(); }
}
const cookie = (t) => ({ Cookie: `agentsdash_token=${t}` });

test('remote_without_cookie_is_401', () => withLan(async (hub) => {
  assert.equal((await call(hub, { p: '/state' })).status, 401);
}));

test('pair_with_bad_token_is_401', () => withLan(async (hub) => {
  assert.equal((await call(hub, { p: '/pair?t=bad' })).status, 401);
}));

test('pair_sets_cookie_and_state_is_readable_without_the_token', () => withLan(async (hub, token) => {
  const r = await call(hub, { p: `/pair?t=${token}` });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/phone');
  const set = r.headers['set-cookie'][0];
  assert.match(set, /agentsdash_token=/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  const s = await call(hub, { p: '/state', headers: cookie(token) });
  assert.equal(s.status, 200);
  assert.ok(!s.body.includes(token), 'the token never appears in the state');
}));

test('token_in_query_on_another_route_does_not_authenticate', () => withLan(async (hub, token) => {
  assert.equal((await call(hub, { p: `/state?t=${token}` })).status, 401);
}));

test('foreign_host_is_403_even_with_cookie', () => withLan(async (hub, token) => {
  assert.equal((await call(hub, { p: '/state', host: 'evil.example', headers: cookie(token) })).status, 403);
}));

test('remote_cannot_write_or_use_other_methods', () => withLan(async (hub, token) => {
  for (const p of ['/event', '/settings', '/shutdown']) {
    assert.equal((await call(hub, { method: 'POST', p, headers: { ...cookie(token), 'Content-Type': 'application/json' }, body: '{}' })).status, 403, p);
  }
  assert.equal((await call(hub, { method: 'OPTIONS', p: '/state', headers: cookie(token) })).status, 403);
  assert.equal((await call(hub, { p: '/market', headers: cookie(token) })).status, 403);
}));

test('remote_cannot_read_pair_info', () => withLan(async (hub, token) => {
  assert.equal((await call(hub, { p: '/pair-info', headers: cookie(token) })).status, 403);
}));

test('default_hub_has_no_pair_url_and_loopback_is_unchanged', async () => {
  const hub = await startHub({ port: 0, userDir: tmp(), config: { relay: { mode: 'none' }, quotas: false } });
  try {
    const r = await fetch(`http://127.0.0.1:${hub.port}/pair-info`);
    assert.deepEqual(await r.json(), { enabled: false, url: null });
    assert.equal((await fetch(`http://127.0.0.1:${hub.port}/state`)).status, 200);
    assert.equal(hub.host, '127.0.0.1');
  } finally { await hub.close(); }
});

test('lan_hub_binds_the_configured_address', async () => {
  const hub = await startHub({ port: 0, userDir: tmp(), config: { relay: { mode: 'none' }, quotas: false }, lan: { enabled: true, bind: '127.0.0.1' } });
  try { assert.equal(hub.host, '127.0.0.1'); } finally { await hub.close(); }
});

test('post_lan_turns_phone_access_on_and_off_while_the_hub_runs', async () => {
  const userDir = tmp();
  const configFile = path.join(userDir, 'config.json');
  const hub = await startHub({ port: 0, userDir, configFile, config: { relay: { mode: 'none' }, quotas: false }, lan: { bind: '0.0.0.0' } });
  const base = `http://127.0.0.1:${hub.port}`;
  const lanPost = (enabled) => fetch(`${base}/lan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  try {
    assert.deepEqual(await (await fetch(`${base}/pair-info`)).json(), { enabled: false, url: null });
    const on = await lanPost(true);
    assert.deepEqual(await on.json(), { ok: true, enabled: true });
    assert.equal((await fetch(`${base}/health`)).status, 200, 'the hub still answers on its port after the rebind');
    assert.equal((await (await fetch(`${base}/pair-info`)).json()).enabled, true);
    assert.match(fs.readFileSync(path.join(userDir, 'lan-token'), 'utf8').trim(), /^[0-9a-f]{32}$/);
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).lan.enabled, true);
    const off = await lanPost(false);
    assert.deepEqual(await off.json(), { ok: true, enabled: false });
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/pair-info`)).json(), { enabled: false, url: null });
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).lan.enabled, false);
  } finally { await hub.close(); }
});

test('post_lan_refuses_a_bad_body', async () => {
  const hub = await startHub({ port: 0, userDir: tmp(), config: { relay: { mode: 'none' }, quotas: false } });
  try {
    const r = await fetch(`http://127.0.0.1:${hub.port}/lan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }) });
    assert.equal(r.status, 400);
  } finally { await hub.close(); }
});

test('remote_cannot_post_lan', () => withLan(async (hub, token) => {
  const r = await call(hub, { method: 'POST', p: '/lan', headers: { ...cookie(token), 'Content-Type': 'application/json' }, body: '{"enabled":false}' });
  assert.equal(r.status, 403);
}));

test('lan_client_cannot_answer_or_open_permission', () => withLan(async (hub, token) => {
  for (const p of ['/permission', '/permission/answer']) {
    const r = await call(hub, { method: 'POST', p, headers: { ...cookie(token), 'Content-Type': 'application/json' }, body: '{"id":"x","decision":"allow","session":"abcd","agent":"lead","tool":"Bash"}' });
    assert.equal(r.status, 403, p);
  }
}));
