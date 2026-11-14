#!/usr/bin/env node
// Agent hub: receives the plugin's events (same wire format as the gadget), keeps the state,
// serves the browser page and pushes the state over SSE. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, ICON_TYPES } from './themes_loader.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createModel, PROTOCOL_VERSION } from './model.mjs';
import { createPermissions } from './permissions.mjs';
import { validRules } from './rules.mjs';
import { SOURCE_RE, parseSource, listSource } from './market_source.mjs';
import { installTheme, removeTheme, readInstalled, saveUserTheme } from './market_install.mjs';
import { validatePalettePart } from './web/theme_schema.js';
import { annotate, createUpdater } from './market_update.mjs';
import { installFirstTheme } from './market_bootstrap.mjs';
import { loadConfig, defaultConfigPath } from './config.mjs';
import { createHttpRelay, defaultLockFile } from './relay_http.mjs';
import { createSerialRelay, listSerialPorts } from './relay_serial.mjs';
import { parseRelay, sameRelay } from './relay_config.mjs';
import { stateDir, userDir, migrateUserDir } from './paths.mjs';
import { COOKIE, setLan, isLoopback, loadOrCreateToken, tokenMatches, lanHosts, privateAddresses, parseCookie, REMOTE_ROUTES, isRemoteStatic } from './lan.mjs';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const MAX_BODY = 64 * 1024;
const SOUNDS = ['all', 'ask', 'off'];
const OVERRIDE_KEY = /^[a-z0-9-]{1,32}(\/[a-z0-9-]{1,32})?$/;
/** `{ "<theme>" | "<theme>/<variant>": { colors?, accent? } }`: the user's color edits. The whole value is refused when any entry is invalid. */
const validOverrides = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 64
  && Object.entries(v).every(([k, o]) => OVERRIDE_KEY.test(k) && o && typeof o === 'object' && !Array.isArray(o) && validatePalettePart(o).ignored.length === 0);
/** `{ "<theme>": ["lookKey", ...] }`: the looks the user ticked per theme. The whole value is refused when any entry is invalid. */
const validLooks = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 64
  && Object.entries(v).every(([k, l]) => /^[a-z0-9-]{1,32}$/.test(k) && Array.isArray(l) && l.length <= 12 && l.every((x) => typeof x === 'string' && /^[a-z0-9-]{1,32}$/.test(x)));
// Settings shared by every page, with what each accepts. Anything else in a POST is ignored.
const SETTING_RULES = {
  sound: (v) => SOUNDS.includes(v),
  max_tiles: (v) => Number.isInteger(v) && v >= 0 && v <= 32,        // tiles per page, 0 = Auto (what fits the window)
  theme: (v) => typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v),
  pulse: (v) => typeof v === 'boolean',
  dim_idle: (v) => typeof v === 'boolean',
  rules: validRules,                                                  // per-project icon pack and badge color
  marketSources: (v) => Array.isArray(v) && v.length <= MAX_SOURCES && v.every((x) => typeof x === 'string' && SOURCE_RE.test(x)) && new Set(v).size === v.length,
  done_excerpt: (v) => ['first', 'last', 'off'].includes(v),          // what a session waiting for you shows: first or last paragraph of its reply, or the fixed text
  themeVariant: (v) => v === '' || (typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v)),   // variant of the theme, '' for the base
  themeLooks: validLooks,                                             // the looks ticked per theme (see activeLooks in theme_schema.js)
  themeOverrides: validOverrides,                                     // the user's color edits per theme or theme/variant
  themeAutoUpdate: (v) => typeof v === 'boolean',                     // install newer versions of marketplace themes (every 6 hours)
  rate_alert_k: (v) => [0, 20, 40, 80].includes(v),                  // token rate readout: 0 = off, else orange from this many thousand tokens per minute, red from 3 times that
};
const MAX_SOURCES = 10;
const SETTING_DEFAULTS = { sound: 'ask', max_tiles: 0, theme: 'default', pulse: true, dim_idle: true, done_excerpt: 'first', themeVariant: '', themeOverrides: {}, themeLooks: {}, rules: [], marketSources: ['tfabien/agentsdash-themes'], themeAutoUpdate: true, rate_alert_k: 20 };
const validSettings = (o) => Object.fromEntries(Object.entries(SETTING_RULES).filter(([k, ok]) => o && k in o && ok(o[k])).map(([k]) => [k, o[k]]));
const TICK_MS = 1000;
const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const pluginVersion = (() => { try { return JSON.parse(fs.readFileSync(path.join(HUB_DIR, 'package.json'), 'utf8')).version ?? ''; } catch { return ''; } })();
const realScript = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {{port?: number, host?: string, config?: object, now?: () => number}} opts
 * @returns {Promise<{port: number, host: string, model: object, close: () => Promise<void>, onChange: (fn) => void, onEvent: (fn) => void, onUsage: (fn) => void}>}
 */
export function startHub(opts = {}) {
  const config = opts.config ?? loadConfig();
  const now = opts.now ?? (() => Date.now());
  // LAN access for a phone is opt-in (config `lan`); `treatAllAsRemote` and `hosts` exist for tests, whose client connects from loopback.
  const lan = { enabled: false, bind: '0.0.0.0', ...(config.lan ?? {}), ...(opts.lan ?? {}) };
  let host = opts.host ?? (lan.enabled ? lan.bind : '127.0.0.1');
  const wantedPort = opts.port ?? (Number(String(config.host).split(':')[1]) || 8765);
  const model = createModel({ maxSessions: config.max_sessions });
  const startedAt = Date.now();
  // Settings shared by every page (and kept in a file for the next hub): beeps (default: only when something needs you), which view
  // opens, tiles on the hub page, pulse on events, grey idle sessions.
  const settingsFile = opts.settingsFile ?? null;
  let settings = { ...SETTING_DEFAULTS };
  if (settingsFile) { try { settings = { ...settings, ...validSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))) }; } catch { /* defaults */ } }
  const clients = new Set();
  const eventTaps = [];
  const usageTaps = [];
  const dismissTaps = [];
  const settingsTaps = [];
  const changeTaps = [];
  // Permission requests held for the page (POST /permission): the hook waits, a click on the page answers.
  const perms = createPermissions();
  perms.onChange(() => publish());
  const CLEARING_EVTS = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'Stop', 'SessionEnd']);    // the terminal moved on

  // The relay to the device: chosen in the config file, or from the page (POST /relay), which swaps it while the hub runs.
  let relayConf = config.relay ?? { mode: 'none' };
  let serial = null;
  let relay = null;
  const relayInfo = () => (relay ? { mode: relayConf.mode, ...(serial ? { port: relayConf.port } : { host: relayConf.host }), ...relay.status() } : null);
  // Themes and icon packs from the built-in and user folders. `iconFiles` maps a served URL to its file: no path comes from a request.
  const catalogDirs = { builtinDir: opts.builtinDir ?? HUB_DIR, userDir: opts.userDir ?? userDir() };
  const tokenFile = lan.tokenFile ?? path.join(catalogDirs.userDir, 'lan-token');
  let lanToken = lan.enabled ? loadOrCreateToken(tokenFile) : null;
  let catalog = { themes: [], packs: [], errors: [] };
  let iconFiles = new Map();
  function reloadCatalog() {
    catalog = loadCatalog(catalogDirs);
    iconFiles = new Map();
    for (const dir of [catalogDirs.builtinDir, catalogDirs.userDir]) {       // same order as the loader: the user folder wins
      for (const p of catalog.packs) {
        for (const url of Object.values(p.roles)) {
          const file = path.join(dir, 'icons', p.name, path.basename(url));
          if (fs.existsSync(file)) iconFiles.set(url, file);
        }
      }
    }
  }
  reloadCatalog();

  // Marketplace: themes of GitHub repositories (market_source.mjs), installed into the user folder (market_install.mjs) and kept
  // current by a timer (market_update.mjs). The page talks to these routes only, never to GitHub.
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const builtinNames = () => new Set(loadCatalog({ builtinDir: catalogDirs.builtinDir, userDir: null }).themes.map((t) => t.name));
  const cacheFile = path.join(catalogDirs.userDir, 'market-cache.json');
  const store = {
    read: () => { try { const d = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; } },
    write: (data) => { try { fs.mkdirSync(catalogDirs.userDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(data), 'utf8'); } catch { /* the listing is only fetched again */ } },
  };
  const updater = createUpdater({
    store,
    getInstalled: () => readInstalled(catalogDirs.userDir),
    list: (source) => listSource(source, fetchFn),
    install: (theme) => installTheme({ theme, userDir: catalogDirs.userDir, builtinNames: builtinNames(), fetchFn }),
    isActive: () => settings.themeAutoUpdate && (clients.size > 0 || model.toState(now()).sessions.length > 0),
    onDone: () => { reloadCatalog(); publish(); },
  });
  updater.start();
  // First launch (only when asked: the hub process, not the tests): no theme at all, so one is downloaded and applied. Retried every 10 minutes while none exists.
  const firstTheme = async () => {
    const name = await installFirstTheme({
      sources: settings.marketSources,
      preferred: config.first_theme,
      hasTheme: () => catalog.themes.length > 0,
      list: (source) => updater.list(source),
      install: (theme) => installTheme({ theme, userDir: catalogDirs.userDir, builtinNames: builtinNames(), fetchFn }),
    });
    if (!name) return;
    reloadCatalog();
    if (settings.theme === 'default') saveSettings({ theme: name });
    publish();
  };
  const firstThemeTimer = opts.firstRunTheme ? setInterval(() => { if (catalog.themes.length === 0) firstTheme(); }, 10 * 60 * 1000) : null;
  firstThemeTimer?.unref?.();
  if (opts.firstRunTheme) setTimeout(firstTheme, 0);
  const withPerm = (st) => ({ ...st, sessions: st.sessions.map((s) => ({ ...s, perm: perms.view(s.id) })) });
  const stateJson = () => ({ ...withPerm(model.toState(now())), boot: startedAt, settings, catalog, ...(relayInfo() ? { relay: relayInfo() } : {}) });
  const publish = () => {
    const payload = JSON.stringify(stateJson());
    for (const res of clients) res.write(`data: ${payload}\n\n`);
    for (const fn of changeTaps) { try { fn(); } catch { /* a tap never breaks the hub */ } }
  };
  const text = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(body); };
  const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  function serveStatic(res, urlPath) {
    const rel = urlPath === '/' || urlPath === '/hub' || urlPath === '/hub/' ? 'hub.html' : urlPath === '/phone' ? 'phone.html' : decodeURIComponent(urlPath.slice(1));
    const file = path.join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return text(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });   // the page files change with the hub version
    fs.createReadStream(file).pipe(res);
  }

  /** Applies validated settings: memory, the gadget taps and the settings file. */
  function saveSettings(next) {
    settings = { ...settings, ...next };
    for (const fn of settingsTaps) { try { fn({ sound: settings.sound }); } catch { /* tap errors stay local */ } }
    if (settingsFile) { try { fs.writeFileSync(settingsFile, JSON.stringify(settings), 'utf8'); } catch { /* the setting still holds until the hub stops */ } }
  }

  /** The JSON body of a request as an object, or null after answering 400 or 413. */
  async function jsonBody(req, res) {
    try {
      const body = JSON.parse(await readBody(req));
      if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    } catch (e) { if (e.status === 413) { text(res, 413, 'body too large'); return null; } }
    text(res, 400, 'invalid JSON');
    return null;
  }

  async function handle(req, res) {
    // No CORS: other web pages cannot read the state. A request must name this hub in Host (DNS rebinding) and, when it carries
    // an Origin (a browser POST from another page), that Origin must be the hub itself. The plugin sends no Origin.
    const port = server.address().port;
    const url = new URL(req.url, 'http://x');
    const route = `${req.method} ${url.pathname}`;
    // A LAN client (phone): same Host and Origin rule over the LAN names, then the pairing cookie, then read-only routes (lan.mjs).
    const remote = lan.enabled && (lan.treatAllAsRemote || !isLoopback(req.socket.remoteAddress));
    const self = remote ? lanHosts(port, lan.hosts) : new Set(['127.0.0.1', 'localhost', '[::1]'].map((h) => `${h}:${port}`));
    if (!self.has(req.headers.host)) return text(res, 403, 'forbidden host');
    if (req.headers.origin !== undefined && !self.has(String(req.headers.origin).replace(/^http:\/\//, ''))) return text(res, 403, 'forbidden origin');
    if (remote && route !== 'GET /pair') {
      if (!tokenMatches(parseCookie(req.headers.cookie, COOKIE), lanToken)) return text(res, 401, 'unauthorized');
      if (!REMOTE_ROUTES.has(route) && !(req.method === 'GET' && isRemoteStatic(url.pathname))) return text(res, 403, 'forbidden');
    }
    switch (route) {
      case 'GET /pair':                             // the only route a client reaches without the cookie: it sets it
        if (!lanToken || !tokenMatches(url.searchParams.get('t') ?? undefined, lanToken)) return text(res, 401, 'unauthorized');
        res.writeHead(302, { Location: '/phone', 'Set-Cookie': `${COOKIE}=${lanToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000` });
        return res.end();
      case 'GET /pair-info': {                      // loopback only (a remote client is stopped above)
        const ip = privateAddresses()[0];
        return json(res, { enabled: lan.enabled, url: lanToken && ip ? `http://${ip}:${port}/pair?t=${lanToken}` : null });
      }
      case 'POST /lan': {                           // loopback only: the page and pair.mjs turn phone access on or off while the hub runs
        const body = await jsonBody(req, res);
        if (!body) return undefined;
        if (typeof body.enabled !== 'boolean') return text(res, 400, 'enabled must be true or false');
        setLanEnabled(body.enabled);
        return json(res, { ok: true, enabled: lan.enabled });
      }
      case 'GET /health': return json(res, { ok: true, version: pluginVersion, core: pluginVersion, protocol: PROTOCOL_VERSION, script: realScript, startedAt });
      case 'POST /shutdown':                       // a newer plugin asks the old hub to leave (it starts a fresh one itself)
        text(res, 200, 'bye');
        if (opts.onShutdown) setTimeout(opts.onShutdown, 50);
        return undefined;
      case 'GET /state': return json(res, stateJson());
      case 'POST /reload':                          // rescan the theme and icon folders (the body, if any, is ignored)
        await readBody(req).catch(() => '');
        reloadCatalog();
        publish();
        return text(res, 200, 'ok');
      case 'GET /market': {
        const listings = await Promise.all(settings.marketSources.map((source) => updater.list(source)));
        const installed = readInstalled(catalogDirs.userDir);
        const themes = annotate(listings.flatMap((l) => l.themes), installed).map(({ files: _files, branch: _branch, ...t }) => t);
        const userThemes = loadCatalog({ builtinDir: null, userDir: catalogDirs.userDir }).themes.map((t) => t.name).filter((n) => !builtinNames().has(n));
        return json(res, { sources: settings.marketSources, installed, userThemes, themes, errors: listings.flatMap((l) => l.errors), lastCheck: updater.lastCheck(), refreshedAt: updater.refreshedAt(settings.marketSources), autoUpdate: settings.themeAutoUpdate });
      }
      case 'POST /market/refresh':                  // forget every listing: the next GET /market fetches them again
        await readBody(req).catch(() => '');
        updater.forget();
        return text(res, 200, 'ok');
      case 'POST /market/sources': {
        const body = await jsonBody(req, res);
        if (!body) return undefined;
        const add = body.add === undefined ? null : parseSource(body.add);
        if (body.add !== undefined && !add) return text(res, 400, 'a source is owner/repo of GitHub');
        const next = [...settings.marketSources.filter((s) => s !== body.remove), ...(add && !settings.marketSources.includes(add) ? [add] : [])];
        if (!SETTING_RULES.marketSources(next)) return text(res, 400, `at most ${MAX_SOURCES} sources`);
        saveSettings({ marketSources: next });
        updater.forget();
        publish();
        return text(res, 200, 'ok');
      }
      case 'POST /market/install': {
        const body = await jsonBody(req, res);
        if (!body) return undefined;
        if (!settings.marketSources.includes(body.source)) return text(res, 400, 'unknown source');
        const theme = (await updater.list(body.source)).themes.find((t) => t.name === body.name);
        if (!theme) return text(res, 400, 'unknown theme');
        try { await installTheme({ theme, userDir: catalogDirs.userDir, builtinNames: builtinNames(), fetchFn }); } catch (err) { return text(res, 400, err.message); }
        reloadCatalog();
        saveSettings({ theme: theme.name, themeVariant: '' });          // a new theme is applied at once, on every page
        publish();
        return text(res, 200, 'ok');
      }
      case 'POST /market/remove': {
        const body = await jsonBody(req, res);
        if (!body) return undefined;
        const name = String(body.name ?? '');
        try { if (!removeTheme({ name, userDir: catalogDirs.userDir, builtinNames: builtinNames() })) return text(res, 404, 'no such theme in the user folder'); } catch (err) { return text(res, 400, err.message); }
        if (settings.theme === name) saveSettings({ theme: 'default', themeVariant: '' });
        const kept = Object.fromEntries(Object.entries(settings.themeOverrides).filter(([k]) => k !== name && !k.startsWith(`${name}/`)));
        if (Object.keys(kept).length !== Object.keys(settings.themeOverrides).length) saveSettings({ themeOverrides: kept });
        if (name in settings.themeLooks) saveSettings({ themeLooks: Object.fromEntries(Object.entries(settings.themeLooks).filter(([k]) => k !== name)) });
        reloadCatalog();
        publish();
        return text(res, 200, 'ok');
      }
      case 'POST /themes': {                         // saves the current look (a theme, a variant, the user's edits) as a user theme
        const body = await jsonBody(req, res);
        if (!body) return undefined;
        const base = catalog.themes.find((t) => t.name === body.theme);
        if (!base) return text(res, 400, 'unknown theme');
        const override = validatePalettePart(body.override);
        try {
          saveUserTheme({ name: String(body.name ?? ''), label: typeof body.label === 'string' ? body.label : undefined, theme: base, variant: typeof body.variant === 'string' ? body.variant : '', override, looks: Array.isArray(body.looks) ? body.looks : undefined, userDir: catalogDirs.userDir, builtinNames: builtinNames(), overwrite: body.overwrite === true });
        } catch (err) { return text(res, /exists$/.test(err.message) ? 409 : 400, err.message); }
        reloadCatalog();
        saveSettings({ theme: String(body.name), themeVariant: '' });
        publish();
        return text(res, 200, 'ok');
      }
      case 'POST /market/update': {
        const body = await jsonBody(req, res);
        if (!body) return undefined;
        const result = await updater.check(typeof body.name === 'string' ? body.name : undefined);
        reloadCatalog();
        publish();
        return json(res, result);
      }
      case 'GET /relay': return json(res, relayInfo() ?? { mode: 'none' });
      case 'GET /relay/ports': return json(res, await (opts.listPorts ?? listSerialPorts)());
      case 'POST /relay/test': return json(res, await testRelay());
      case 'POST /relay': {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { return e.status === 413 ? text(res, 413, 'body too large') : text(res, 400, 'invalid JSON'); }
        const parsed = await parseRelay(body, opts.lookup);
        if (parsed.error) return text(res, 400, parsed.error);
        const saved = swapRelay(parsed.relay);
        publish();
        return json(res, { ok: true, saved });
      }
      case 'POST /serial/release':
      case 'POST /serial/open':
        if (!serial) return text(res, 404, 'not in serial mode');
        if (route.endsWith('release')) serial.release(); else serial.reopen();
        return text(res, 200, 'ok');
      case 'GET /events': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(stateJson())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }
      case 'POST /permission': {                    // a PermissionRequest hook waits here for Allow or Deny (loopback only)
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { return e.status === 413 ? text(res, 413, 'body too large') : text(res, 400, 'invalid JSON'); }
        const str = (v) => (typeof v === 'string' ? v : '');
        if (!body || !str(body.session) || !str(body.agent) || !str(body.tool)) return text(res, 400, 'session, agent and tool are required');
        const { id, promise } = perms.open({ session: str(body.session), agent: str(body.agent), tool: str(body.tool), cmd: str(body.cmd), detail: str(body.detail), wait_s: body.wait_s });
        res.on('close', () => perms.cancel(id));     // the hook went away: nothing to answer any more
        return json(res, { decision: await promise });
      }
      case 'POST /permission/answer': {             // the page taps Allow or Deny (loopback only)
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { return e.status === 413 ? text(res, 413, 'body too large') : text(res, 400, 'invalid JSON'); }
        if (body?.decision !== 'allow' && body?.decision !== 'deny') return text(res, 400, 'decision must be allow or deny');
        return perms.answer(String(body.id ?? ''), body.decision) ? text(res, 200, 'ok') : text(res, 404, 'unknown request');
      }
      case 'POST /event':
      case 'POST /usage':
      case 'POST /select':
      case 'POST /dismiss':
      case 'POST /settings':
      case 'POST /reset': {
        let body;
        try {
          const raw = await readBody(req);
          body = route === 'POST /reset' && !raw.trim() ? {} : JSON.parse(raw);
        } catch (e) {
          return e.status === 413 ? text(res, 413, 'body too large') : text(res, 400, 'invalid JSON');
        }
        if (route === 'POST /event') {
          if (!model.applyEvent(body, now())) return text(res, 400, 'session, agent and a valid state are required');
          if (CLEARING_EVTS.has(body.evt)) perms.clearSession(String(body.session));
          for (const fn of eventTaps) { try { fn(body); } catch { /* tap errors stay local */ } }
        } else if (route === 'POST /usage') {
          if (!body || typeof body.v !== 'number') return text(res, 400, 'v is required');
          model.applyUsage(body, now());
          for (const fn of usageTaps) { try { fn(body); } catch { /* tap errors stay local */ } }
        } else if (route === 'POST /dismiss') {
          const id = String(body?.session ?? '');
          if (!model.dismiss(id)) return text(res, 404, 'unknown session');
          perms.clearSession(id);
          for (const fn of dismissTaps) { try { fn({ session: id }); } catch { /* tap errors stay local */ } }
        } else if (route === 'POST /settings') {
          const next = validSettings(body);
          if (!Object.keys(next).length) return text(res, 400, 'no valid setting: sound (all, ask, off), max_tiles (0 for Auto, 1 to 32), theme (a theme name), pulse, dim_idle, done_excerpt (first, last, off), rules (a list of {match, iconPack?, badgeColor?}), marketSources (a list of owner/repo), themeAutoUpdate (true or false), rate_alert_k (0, 20, 40, 80)');
          saveSettings(next);
        } else if (route === 'POST /select') {
          if (!body || !model.select(String(body.session ?? ''), String(body.agent ?? 'lead'), now(), Number.isFinite(body.hold_ms) ? body.hold_ms : 30000)) return text(res, 404, 'unknown session or agent');
        } else {
          model.clear();
          perms.clearAll();
        }
        publish();
        return text(res, 200, 'ok');
      }
      default:
        if (req.method === 'GET' && url.pathname.startsWith('/icons/')) {
          const file = iconFiles.get(url.pathname);   // exact catalog URL only, so traversal and unlisted names are 404
          if (!file) return text(res, 404, 'not found');
          let data;
          try { data = fs.readFileSync(file); } catch { return text(res, 404, 'not found'); }
          res.writeHead(200, { 'Content-Type': ICON_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Security-Policy': 'sandbox', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
          return res.end(data);
        }
        if (req.method === 'GET') return serveStatic(res, url.pathname);
        return text(res, 404, 'not found');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) text(res, 500, 'error'); else res.end(); });
  });
  const timer = setInterval(() => { model.prune(now()); if (clients.size) publish(); }, TICK_MS);
  timer.unref();

  // Relay to a gadget (Wi-Fi or USB): every accepted event and usage report is forwarded as received. The taps read the current relay.
  function buildRelay() {
    serial = relayConf.mode === 'serial' && relayConf.port ? createSerialRelay({ path: relayConf.port, ...(opts.serial ?? {}) }) : null;
    relay = serial ?? (relayConf.mode === 'http' && relayConf.host ? createHttpRelay({ host: relayConf.host, ...(opts.http ?? {}) }) : null);
    relay?.send('/settings', { sound: settings.sound });   // the gadget buzzer follows the hub setting from the start
  }
  eventTaps.push((body) => { const { plan_items: _items, ...forDevice } = body; relay?.send('/event', forDevice); });     // the gadget has no use for the plan list
  usageTaps.push((body) => relay?.send('/usage', body));
  dismissTaps.push((body) => relay?.send('/dismiss', body));
  settingsTaps.push((body) => relay?.send('/settings', body));
  buildRelay();

  /** Swaps the relay while the hub runs and writes the choice into the `relay` key of the config file (the other keys stay). */
  function swapRelay(next) {
    if (!sameRelay(next, relayConf)) {
      serial?.release();                     // frees the COM port before another relay may open it
      relay?.stop?.();
      relayConf = next;
      buildRelay();
      serial?.start();
    }
    if (!opts.configFile) return false;
    try {
      let data = {};
      try { const parsed = JSON.parse(fs.readFileSync(opts.configFile, 'utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed; } catch { /* a new file */ }
      fs.mkdirSync(path.dirname(opts.configFile), { recursive: true });
      fs.writeFileSync(opts.configFile, `${JSON.stringify({ ...data, relay: next }, null, 2)}
`, 'utf8');
      return true;
    } catch { return false; }                // the choice still holds until the hub stops
  }

  /** The Test button: one real request to the device (GET /state over Wi-Fi), or the state of the open port over USB. */
  async function testRelay() {
    if (!relay) return { ok: false, error: 'no device configured' };
    if (serial) {
      const st = serial.status();
      return st.connected ? { ok: true, detail: `port ${relayConf.port} is open` } : { ok: false, error: st.released ? 'port released for another tool' : st.lastError || 'port not open' };
    }
    if (fs.existsSync(opts.http?.lockFile ?? defaultLockFile())) return { ok: false, error: 'a screen upload is running, try again when it is done' };
    const started = Date.now();
    try {
      const r = await (opts.http?.fetchImpl ?? globalThis.fetch)(`http://${relayConf.host}/state`, { signal: AbortSignal.timeout(2000) });
      await r.arrayBuffer();
      return r.ok ? { ok: true, detail: `answered in ${Date.now() - started} ms` } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, error: String(e?.cause?.code ?? e?.message ?? e) }; }
  }

  serial?.start();

  let started = false;
  let boundPort = wantedPort;
  /** Phone access on or off: the config file, the token, and the listening address (open connections stay, new ones use the new address). */
  function setLanEnabled(enabled) {
    lan.enabled = enabled;
    lanToken = enabled ? (lanToken ?? loadOrCreateToken(tokenFile)) : null;
    if (opts.configFile) { try { setLan(opts.configFile, enabled); } catch { /* it still holds until the hub stops */ } }
    if (opts.host) return;                                   // an explicit host (tests) is never moved
    const next = enabled ? lan.bind : '127.0.0.1';
    if (next === host || !started) return;
    host = next;
    server.close();
    server.listen(boundPort, host);
  }

  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      if (!started) { clearInterval(timer); clearInterval(firstThemeTimer); updater.stop(); reject(e); return; }
      process.stderr.write(`agentsdash hub: cannot listen on ${host} (${e.code ?? e.message}), back to 127.0.0.1
`);   // a rebind that failed
      lan.enabled = false; lanToken = null; host = '127.0.0.1';
      try { server.listen(boundPort, host); } catch { /* the hub keeps running without a listener */ }
    });
    server.listen(wantedPort, host, () => {
      started = true;
      boundPort = server.address().port;
      resolve({
        port: server.address().port, host, model,
        onEvent: (fn) => eventTaps.push(fn),
        onUsage: (fn) => usageTaps.push(fn),
        onChange: (fn) => changeTaps.push(fn),
        close: () => new Promise((done) => {
          clearInterval(timer);
          clearInterval(firstThemeTimer);
          updater.stop();
          serial?.release();
          relay?.stop?.();
          for (const res of clients) res.end();
          perms.clearAll();
          clients.clear();
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}

// `node hub.mjs`: run as the hub process.
// realpath: Node reports import.meta.url as the real path, argv[1] may go through a symlink (e.g. a linked ~/.claude)
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (isMain) {
  migrateUserDir();
  const settingsFile = path.join(stateDir(), 'hub-settings.json');
  const oldSettings = path.join(os.tmpdir(), 'agent-gadget-plugin', 'hub-settings.json');      // before the rename the settings lived here
  try { if (!fs.existsSync(settingsFile) && fs.existsSync(oldSettings)) { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.copyFileSync(oldSettings, settingsFile); } } catch { /* start without them */ }
  startHub({ firstRunTheme: true, settingsFile, configFile: defaultConfigPath(), onShutdown: () => process.exit(0) }).then((hub) => {
    process.stderr.write(`agentsdash hub listening on http://${hub.host}:${hub.port}/\n`);
  }).catch((e) => {
    process.stderr.write(`agentsdash hub: cannot start (${e.code ?? e.message})\n`);
    process.exit(1);
  });
}
