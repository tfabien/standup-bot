// Pending permission requests: a Claude Code PermissionRequest hook posts one and waits; the page answers Allow or Deny.
// A request ends with 'allow', 'deny' or 'none' (delay, closed connection, cleared by the session moving on, replaced).
// 'none' makes the hook print nothing, so the terminal prompt decides.
import crypto from 'node:crypto';

export const DEFAULT_WAIT_S = 30;
export const MAX_WAIT_S = 120;

const clampWait = (v) => (Number.isFinite(v) ? Math.min(MAX_WAIT_S, Math.max(1, Math.trunc(v))) : DEFAULT_WAIT_S);

export function createPermissions(opts = {}) {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const pending = new Map();                           // id -> {id, session, agent, tool, cmd, detail, until, timer, resolve}
  const listeners = [];
  const changed = () => { for (const fn of listeners) { try { fn(); } catch { /* listener errors stay local */ } } };

  function finish(id, decision) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimer(p.timer);
    p.resolve(decision);
    return true;
  }

  function open({ session, agent, tool, cmd = '', detail = '', wait_s: waitS }) {
    for (const p of [...pending.values()]) if (p.session === session && p.agent === agent) finish(p.id, 'none');
    const id = crypto.randomUUID();
    const wait = clampWait(waitS);
    const promise = new Promise((resolve) => {
      const timer = setTimer(() => { if (finish(id, 'none')) changed(); }, wait * 1000);
      pending.set(id, { id, session, agent, tool, cmd, detail, until: now() + wait * 1000, timer, resolve });
    });
    changed();
    return { id, promise };
  }

  function answer(id, decision) {
    if (decision !== 'allow' && decision !== 'deny') return false;
    if (!finish(id, decision)) return false;
    changed();
    return true;
  }

  function cancel(id) {
    if (finish(id, 'none')) changed();
  }

  function clearSession(session) {
    let any = false;
    for (const p of [...pending.values()]) if (p.session === session) any = finish(p.id, 'none') || any;
    if (any) changed();
    return any;
  }

  function clearAll() {
    let any = false;
    for (const p of [...pending.values()]) any = finish(p.id, 'none') || any;
    if (any) changed();
  }

  /** The newest pending request of a session, as the page shows it. */
  function view(session) {
    let last = null;
    for (const p of pending.values()) if (p.session === session) last = p;
    return last && { id: last.id, tool: last.tool, cmd: last.cmd, detail: last.detail, until: last.until };
  }

  return { open, answer, cancel, clearSession, clearAll, view, onChange: (fn) => { listeners.push(fn); } };
}
