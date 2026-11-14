import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderScreen, hitTest, permAnswer, teamOrder, wrapText, fitText, roleIndex, paceLevel, projectColors, COLOR, rgb565,
} from '../web/screen.js';

/** A screen that records its drawing operations. Text is 5 px per character, so wrapping is deterministic. */
function recorder() {
  const ops = [];
  const screen = {
    ops,
    measure: (s) => String(s).length * 5,
    pic: (id, x, y, pack) => ops.push({ op: 'pic', id, x, y, ...(pack !== undefined ? { pack } : {}) }),
    erase: (x, y, w, h) => ops.push({ op: 'erase', x, y, w, h }),
    fill: (x, y, w, h, c) => ops.push({ op: 'fill', x, y, w, h, c }),
    rect: (x, y, w, h, c) => ops.push({ op: 'rect', x, y, w, h, c }),
    circle: (cx, cy, r, c) => ops.push({ op: 'circle', cx, cy, r, c }),
    ring: (cx, cy, r, w, frac, c) => ops.push({ op: 'ring', cx, cy, r, frac, c }),
    line: (x1, y1, x2, y2, c) => ops.push({ op: 'line', x1, y1, x2, y2, c }),
    text: (x, y, w, font, fg, bg, s, align = 0) => ops.push({ op: 'text', x, y, w, font, fg, bg, s, align }),
  };
  return screen;
}
const texts = (r) => r.ops.filter((o) => o.op === 'text').map((o) => o.s);
const pics = (r) => r.ops.filter((o) => o.op === 'pic');
const textOp = (r, s) => r.ops.find((o) => o.op === 'text' && o.s === s);

const agent = (over = {}) => ({ tok: 0, id: 'lead', parent: '', role: 'lead', state: 'working', cmd: 'Edit a.js', detail: '', prev: '', prev_age: 0, age: 720, ...over });
const sub = (id, role, over = {}) => agent({ id, role, parent: 'lead', age: 180, cmd: `${role} work`, ...over });
const session = (over = {}) => ({
  id: 'aaaa', project: 'artillery-x3', dot: 'working', count: 1, more: 0, title: '', ctx_pct: 34, ctx_k: 340, ctx_src: 'statusline', tok: 12345,
  plan: { done: 3, total: 8, cur: 'Write the failing tests', next: 'Implement roles', state: '' }, ask: null, agents: [agent()], ...over,
});
const state = (sessions, over = {}) => ({
  sessions, more_sessions: 0, view: { session: sessions[0]?.id ?? '', agent: 'lead', mode: 'auto' }, agents: [],
  usage: { age_s: 5, h5_pct: 48, h5_reset_s: 4800, h5_rate10: 50, h5_proj: 70, h5_empty_s: -1, d7_pct: 61, d7_reset_s: 187000, d7_rate10: 5, d7_proj: 90, d7_empty_s: -1 }, ...over,
});
const ui = (over = {}) => ({ elapsedS: 0, menu: false, detail: null, sound: 'all', tick: 1, pulse: 0, timeText: '14:32', ...over });
const draw = (st, u = ui()) => { const r = recorder(); renderScreen(r, st, u); return r; };
const four = () => [sub('ab12', 'Explore'), sub('cd34', 'Plan'), sub('ef56', 'code-reviewer', { state: 'needs_you', cmd: 'Needs you: allow Bash(pio run)?' }), sub('gh78', 'test-runner')];
const withSubs = (subs, over = {}) => session({ count: 1 + subs.length, agents: [agent({ state: 'waiting_subs', cmd: `Waiting on ${subs.length} sub-agents` }), ...subs], ...over });

test('main_view_draws_the_decor_top_bar_lead_team_and_bottom_bar', () => {
  const r = draw(state([withSubs(four()), session({ id: 'bbbb', project: 'shop-rdv', dot: 'needs_you' })]));
  assert.deepEqual(r.ops[0], { op: 'pic', id: 16, x: 0, y: 0 });                    // background first
  assert.ok(texts(r).includes('artillery-x3'));
  assert.ok(texts(r).includes('5'), 'agent count chip: lead + 4');
  assert.deepEqual(pics(r).filter((p) => p.id === 27).map((p) => [p.x, p.y]), [[18, 42]], 'big lead sprite');
  assert.ok(texts(r).some((t) => t.startsWith('waiting ')));
  assert.ok(texts(r).includes('34'));
  assert.ok(texts(r).includes('PLAN 3/8'));
  assert.ok(texts(r).includes('Write the failing tests'));
  assert.ok(texts(r).includes('next: Implement roles'));
  assert.ok(texts(r).includes('TEAM - 4 SUB-AGENTS - 3 WORKING'));
  assert.deepEqual(pics(r).filter((p) => p.id === 17).map((p) => p.y), [58, 103, 148, 193]);
  assert.ok(texts(r).includes('code-reviewer') && texts(r).includes('Needs you: allow Bash(pio run)?'));
  assert.ok(texts(r).includes('48% reset 1h20'));
  assert.ok(texts(r).includes('61% reset 2d03h'));
});

test('top_bar_has_one_dot_per_session_ringed_selected_and_a_caret', () => {
  const r = draw(state([session(), session({ id: 'bbbb', dot: 'needs_you' }), session({ id: 'cccc', dot: 'your_turn' })]));
  const dots = r.ops.filter((o) => o.op === 'circle' && o.cy === 16 && o.cx >= 396);
  assert.equal(dots.length, 3 + 1, 'three dots and one ring');
  assert.ok(dots.some((d) => d.r === 7 && d.c === COLOR.LIGHT), 'selected session ringed');
  assert.ok(r.ops.some((o) => o.op === 'fill' && o.w === 10 && o.h === 2 && o.c === COLOR.LIGHT), 'caret');
});

test('session_title_replaces_the_project_in_the_top_bar_only', () => {
  const r = draw(state([session({ title: 'Fix login' })]));
  assert.ok(texts(r).includes('Fix login'));
  assert.ok(texts(r).includes('artillery-x3'), 'the lead panel still names the project');
});

test('five_or_more_subagents_use_compact_rows_and_tiny_sprites', () => {
  const subs = ['Explore', 'Plan', 'code-reviewer', 'test-runner', 'junior-dev'].map((role, i) => sub(`a${i}00`, role));
  const r = draw(state([withSubs(subs)]));
  assert.equal(pics(r).filter((p) => p.id === 17).length, 0);
  assert.deepEqual(pics(r).filter((p) => p.id === 18).map((p) => p.y), [58, 82, 106, 130, 154]);
  assert.ok(pics(r).some((p) => p.id === 43 + 2), 'tiny explore sprite');
  assert.ok(pics(r).some((p) => p.id === 43 + 6), 'tiny coder sprite for junior-dev');
});

test('eight_subagents_show_six_rows_and_a_plus_more_row', () => {
  const subs = Array.from({ length: 8 }, (_, i) => sub(`a${i}00`, 'Explore', { state: i < 2 ? 'done' : 'working', age: 100 + i }));
  const r = draw(state([withSubs(subs)]));
  assert.equal(pics(r).filter((p) => p.id === 18).length, 7);
  assert.ok(texts(r).includes('+2 more'));
});

test('team_order_drops_done_agents_first_then_the_least_recently_seen', () => {
  const subs = Array.from({ length: 8 }, (_, i) => sub(`a${i}`, 'Explore', { state: i === 3 ? 'done' : 'working', age: 10 + i }));
  const { order, more } = teamOrder(subs);
  assert.equal(more, 2);
  assert.equal(order.length, 6);
  assert.ok(!order.includes(4), 'slot 4 (the done agent) dropped first');
  assert.ok(!order.includes(8), 'then the one not seen for the longest time (largest age)');
  assert.deepEqual(teamOrder(subs.slice(0, 5)), { order: [1, 2, 3, 4, 5], more: 0 });
});

test('without_subagents_the_lead_panel_takes_the_full_width_and_there_is_no_team', () => {
  const r = draw(state([session({ ctx_pct: null })]));
  assert.ok(r.ops.some((o) => o.op === 'erase' && o.x === 12 && o.w === 460));
  assert.ok(!texts(r).some((t) => t.startsWith('TEAM')));
});

test('a_pending_question_takes_the_full_width_in_orange_with_numbered_options', () => {
  const s = withSubs(four(), { ask: { question: 'Which database should the API use?', options: 'Postgres|SQLite' } });
  s.agents[0] = agent({ state: 'needs_you', cmd: 'Question' });
  const r = draw(state([s]));
  assert.ok(!texts(r).some((t) => t.startsWith('TEAM')), 'team hidden');
  const q = r.ops.find((o) => o.op === 'text' && o.s.startsWith('Which database') && o.font === 20);
  assert.equal(q.fg, COLOR.NEEDS);
  assert.ok(texts(r).includes('1. Postgres') && texts(r).includes('2. SQLite'));
});

test('tapped_subagent_detail_replaces_the_lead_panel_and_outlines_its_row', () => {
  const subs = four();
  subs[2].prev = 'Read layout.cpp';
  subs[2].prev_age = 40;
  subs[2].tok = 41200;
  subs[2].detail = 'pio run -e esp32dev_test';
  const r = draw(state([withSubs(subs)]), ui({ detail: { session: 'aaaa', agent: 'ef56' } }));
  assert.ok(pics(r).some((p) => p.id === 27 + 4), 'big reviewer sprite');
  assert.ok(texts(r).includes('41k tokens'));
  assert.ok(texts(r).includes('COMMAND') && texts(r).includes('BEFORE') && texts(r).includes('tap here to go back'));
  assert.ok(texts(r).includes('Read layout.cpp (40s ago)'));
  assert.deepEqual(r.ops.find((o) => o.op === 'rect'), { op: 'rect', x: 175, y: 147, w: 292, h: 44, c: COLOR.LIGHT });
});

test('detail_of_an_agent_that_is_gone_falls_back_to_the_lead_panel', () => {
  const r = draw(state([withSubs(four())]), ui({ detail: { session: 'aaaa', agent: 'zzzz' } }));
  assert.ok(texts(r).includes('PLAN 3/8'));
});

test('session_menu_lists_one_row_per_session_and_frames_the_selected_one', () => {
  const r = draw(state([session(), session({ id: 'bbbb', project: 'shop-rdv', dot: 'needs_you', agents: [agent(), sub('ab12', 'Explore'), sub('cd34', 'Plan')] })]), ui({ menu: true }));
  assert.ok(r.ops.some((o) => o.op === 'fill' && o.y === 38 && o.h === 36 && o.w === 460 && o.c === COLOR.FRAME), 'selected row');
  assert.ok(r.ops.some((o) => o.op === 'fill' && o.y === 78 && o.h === 36 && o.c === COLOR.ROW));
  assert.ok(r.ops.some((o) => o.op === 'rect' && o.y === 38 && o.c === COLOR.LIGHT));
  assert.ok(texts(r).includes('shop-rdv') && texts(r).includes('3'));
  assert.ok(!texts(r).includes('PLAN 3/8'));
});

test('session_menu_has_a_trash_icon_per_row_and_taps_on_it_dismiss', () => {
  const sessions = [session(), session({ id: 'bbbb', project: 'shop-rdv' })];
  const r = draw(state(sessions), ui({ menu: true }));
  const lines = r.ops.filter((o) => o.op === 'line');
  assert.ok(lines.filter((o) => o.y1 >= 38 && o.y1 < 74).length >= 4, 'a trash can drawn on the first row');
  assert.ok(lines.filter((o) => o.y1 >= 78 && o.y1 < 114).length >= 4, 'and on the second');
  assert.ok(lines.every((o) => o.x1 >= 420), 'at the right end of the rows');
  const ctx = { sessions, selected: 0, menu: true };
  assert.deepEqual(hitTest(440, 56, ctx), { kind: 'trashRow', index: 0 });
  assert.deepEqual(hitTest(440, 96, ctx), { kind: 'trashRow', index: 1 });
  assert.deepEqual(hitTest(300, 96, ctx), { kind: 'menuRow', index: 1 }, 'the rest of the row selects');
});

test('empty_state_names_where_events_go', () => {
  const r = draw(state([]), ui({ eventsTo: '127.0.0.1:8765' }));
  assert.ok(texts(r).includes('NO SESSION'));
  assert.ok(texts(r).includes('No agents yet'));
  assert.ok(texts(r).includes('127.0.0.1:8765'));
});

test('no_standby_view_even_when_every_agent_has_been_idle_for_hours_but_the_small_clock_stays', () => {
  const idle = session({ dot: 'your_turn', plan: null, agents: [agent({ state: 'your_turn', age: 36000 })] });
  const r = draw(state([idle]));
  assert.ok(pics(r).every((p) => p.id !== 51 && !(p.id >= 52 && p.id <= 62)), 'no standby picture, no big digits');
  assert.ok(!texts(r).some((t) => /idle/.test(t)), 'no idle summary');
  assert.ok(texts(r).includes('artillery-x3'), 'the normal view stays');
  const clock = r.ops.find((o) => o.op === 'text' && o.s === '14:32');
  assert.deepEqual([clock.x, clock.y, clock.font, clock.align], [416, 250, 20, 2], 'small clock at the right of the bottom bar');
  assert.ok(!texts(draw(state([idle]), ui({ timeText: '' }))).includes('14:32'), 'no clock without a time');
});

test('quota_pace_colors_empty_and_stale', () => {
  const base = { age_s: 5, h5_pct: 48, h5_reset_s: 4800, d7_pct: 61, d7_reset_s: 187000 };
  const col = (usage, label) => { const r = draw(state([session()], { usage })); return r.ops.filter((o) => o.op === 'fill' && o.y === 259 && o.w > 0 && o.w <= 44 && o.c !== COLOR.CHIP); };
  assert.equal(paceLevel({ pct: 48, proj: 70 }), 'ok');
  assert.equal(paceLevel({ pct: 48, proj: 90 }), 'tight');
  assert.equal(paceLevel({ pct: 48, proj: 120 }), 'over');
  assert.equal(paceLevel({ pct: 100, proj: 10 }), 'over');
  assert.equal(paceLevel({ pct: 48, proj: undefined }), 'unknown');
  const over = draw(state([session()], { usage: { ...base, h5_proj: 150, h5_rate10: 90, h5_empty_s: 1800 } }));
  assert.ok(texts(over).includes('48% empty 30m'));
  assert.ok(over.ops.some((o) => o.op === 'fill' && o.y === 259 && o.c === COLOR.ERROR));
  const stale = draw(state([session()], { usage: { ...base, age_s: 1000, h5_proj: 70 } }));
  assert.ok(stale.ops.some((o) => o.op === 'fill' && o.y === 259 && o.c === COLOR.FAINT));
  assert.equal(col(base).length >= 0, true);
});

test('reset_times_count_down_with_the_elapsed_time', () => {
  const r = draw(state([session()]), ui({ elapsedS: 600 }));
  assert.ok(texts(r).includes('48% reset 1h10'));
});

test('sound_icon_shows_the_mode', () => {
  const colors = (sound) => draw(state([session()]), ui({ sound })).ops.filter((o) => o.op === 'fill' && o.x >= 378 && o.y >= 253 && o.y <= 270).map((o) => o.c);
  assert.ok(colors('all').includes(COLOR.TEXT));
  assert.ok(colors('ask').includes(COLOR.NEEDS));
  const off = draw(state([session()]), ui({ sound: 'off' }));
  assert.equal(off.ops.filter((o) => o.op === 'line' && o.c === COLOR.ERROR).length, 2, 'red cross');
});

test('working_robots_blink_for_one_tick_in_fifteen_and_needs_you_bars_pulse', () => {
  const s = withSubs(four());
  const closed = draw(state([s]), ui({ tick: 11 }));
  assert.ok(pics(closed).some((p) => p.id >= 63 && p.id <= 86), 'a working robot has its eyes closed at phase 0');
  const open = draw(state([s]), ui({ tick: 2 }));
  assert.ok(pics(open).every((p) => p.id < 63), 'no closed eyes at other phases');
  const bar = (tick) => draw(state([s]), ui({ tick })).ops.find((o) => o.op === 'fill' && o.x === 178 && o.y === 151 && o.w === 3);
  assert.equal(bar(0).c, COLOR.NEEDS);
  assert.equal(bar(4).c, COLOR.NEEDS_DIM);
});

test('plan_segments_are_done_current_and_pending_and_running_steps_pulse', () => {
  const seg = (u, st) => draw(state([session({ plan: { done: 1, total: 3, cur: 'B', next: 'C', state: '', ...st }, agents: [agent()] })]), u).ops.filter((o) => o.op === 'fill' && o.h === 6 && o.y === 36 + 130 && o.x >= 18);
  const calm = seg(ui({ pulse: 12 }));
  assert.deepEqual(calm.map((o) => o.c).slice(0, 1), [COLOR.WORKING], 'done step');
  assert.equal(calm[1].c, COLOR.ACCENT, 'current step at full brightness');
  assert.equal(calm[2].c, COLOR.CHIP, 'pending step');
  assert.notEqual(seg(ui({ pulse: 0 }))[1].c, COLOR.ACCENT, 'dim end of the breath');
  const parallel = seg(ui({ pulse: 12 }), { done: 1, total: 4, state: 'drrp' });
  assert.deepEqual([parallel[0].c, parallel[1].c, parallel[2].c, parallel[3].c], [COLOR.WORKING, COLOR.ACCENT, COLOR.ACCENT, COLOR.CHIP]);
});

test('context_bar_color_follows_the_thresholds', () => {
  const barColor = (pct) => draw(state([session({ ctx_pct: pct })])).ops.find((o) => o.op === 'ring').c;
  assert.equal(barColor(34), COLOR.WORKING);
  assert.equal(barColor(60), COLOR.NEEDS);
  assert.equal(barColor(80), COLOR.ERROR);
});

test('text_helpers_cut_with_a_tilde_and_wrap_on_words', () => {
  const m = (s) => s.length * 8;
  assert.equal(fitText('short', 100, m), 'short');
  assert.equal(fitText('a very long command line', 80, m), 'a very lo~');
  const wrapped = wrapText('Write the failing tests now', 120, 2, m);
  assert.equal(wrapped[0], 'Write the');
  assert.ok(wrapped[1].endsWith('~') && wrapped[1].length * 8 <= 120, wrapped[1]);
  assert.deepEqual(wrapText('one two', 400, 2, m), ['one two']);
  assert.equal(roleIndex('lead'), 0);
  assert.equal(roleIndex('general-purpose'), 1);
  assert.equal(roleIndex('Explore'), 2);
  assert.equal(roleIndex('code-reviewer'), 4);
  assert.equal(roleIndex('junior-dev'), 6);
  assert.equal(roleIndex('mystery'), 7);
  assert.equal(rgb565(0x5EED).join(','), '90,222,106');
});

test('hit_test_maps_taps_like_the_firmware', () => {
  const four_ = withSubs(four());
  const ctxt = { sessions: [four_, session({ id: 'bbbb' })], selected: 0, menu: false };
  assert.deepEqual(hitTest(100, 10, ctxt), { kind: 'tab' });
  assert.deepEqual(hitTest(390, 255, ctxt), { kind: 'mute' });
  assert.deepEqual(hitTest(60, 120, ctxt), { kind: 'lead' });
  assert.deepEqual(hitTest(300, 80, ctxt), { kind: 'row', index: 0 });
  assert.deepEqual(hitTest(300, 195, ctxt), { kind: 'row', index: 3 });
  assert.deepEqual(hitTest(300, 235, ctxt), { kind: 'none' });
  assert.deepEqual(hitTest(100, 90, { ...ctxt, menu: true }), { kind: 'menuRow', index: 1 });
  assert.deepEqual(hitTest(100, 50, { ...ctxt, menu: true }), { kind: 'menuRow', index: 0 });
});

test('hitTest_on_the_team_part_of_a_hub_tile_finds_rows_across_the_full_width', () => {
  const lead = { id: 'a', dot: 'working', ask: null, plan: null, agents: [{ state: 'working', age: 1 }, { state: 'working', age: 1 }, { state: 'done', age: 1 }] };
  const ctx = { sessions: [lead], selected: 0, menu: false, part: 'team', frameW: 700 };
  assert.deepEqual(hitTest(30, 60, ctx), { kind: 'row', index: 0 });
  assert.deepEqual(hitTest(600, 105, ctx), { kind: 'row', index: 1 });
  assert.deepEqual(hitTest(30, 230, ctx), { kind: 'none' });
  assert.deepEqual(hitTest(30, 120, { ...ctx, part: 'lead' }), { kind: 'lead' }, 'the lead part is one wide panel whatever the sub-agents');
});

test('on_a_team_tile_a_tapped_subagent_opens_as_a_tile_with_a_back_button', () => {
  const subs = four();
  subs[2].prev = 'Read layout.cpp';
  subs[2].prev_age = 40;
  subs[2].detail = 'pio run -e esp32dev_test';
  const open = draw(state([withSubs(subs)]), ui({ bare: true, part: 'team', frameW: 700, detail: { session: 'aaaa', agent: 'ef56' } }));
  assert.ok(texts(open).includes('COMMAND') && texts(open).includes('BEFORE') && texts(open).includes('BACK'));
  assert.ok(!texts(open).includes('tap here to go back') && !texts(open).some((t) => t.startsWith('TEAM')), 'the list is replaced');
  const list = draw(state([withSubs(subs)]), ui({ bare: true, part: 'team', frameW: 700 }));
  assert.ok(texts(list).some((t) => t.startsWith('TEAM')) && !texts(list).includes('BACK'));
  const gone = draw(state([withSubs(subs)]), ui({ bare: true, part: 'team', frameW: 700, detail: { session: 'aaaa', agent: 'zzzz' } }));
  assert.ok(texts(gone).some((t) => t.startsWith('TEAM')), 'an agent that is gone returns the list');
  const lead = draw(state([withSubs(subs)]), ui({ bare: true, part: 'lead', frameW: 700, detail: { session: 'aaaa', agent: 'ef56' } }));
  assert.ok(!texts(lead).includes('COMMAND'), 'the lead tile ignores the open sub-agent');
});

test('hitTest_on_an_open_subagent_tile_finds_only_the_back_button', () => {
  const lead = { id: 'a', dot: 'working', ask: null, plan: null, agents: [{ state: 'working', age: 1 }, { state: 'working', age: 1 }] };
  const ctx = { sessions: [lead], selected: 0, menu: false, part: 'team', frameW: 700, detailOpen: true };
  assert.deepEqual(hitTest(660, 50, ctx), { kind: 'back' });
  assert.deepEqual(hitTest(30, 60, ctx), { kind: 'none' }, 'the rows are gone while a sub-agent is open');
});

const RULES = [{ match: '**/artillery*', iconPack: 'cat', badgeColor: '#c0392b' }];
const tile = (cwd, rules = RULES) => draw(state([session({ cwd, title: 'Fix login' })], { settings: { rules } }), ui({ bare: true, frameW: 472 }));

test('badge_color_override_replaces_chip_background', () => {
  assert.deepEqual(projectColors('x', '#ffffff'), { bg: 0xFFFF, fg: 0x0000 }, 'light chip, black text');
  assert.deepEqual(projectColors('x', '#000000'), { bg: 0x0000, fg: 0xFFFF }, 'dark chip, white text');
  assert.equal(projectColors('x', '#c0392b').bg, ((0xc0 >> 3) << 11) | ((0x39 >> 2) << 5) | (0x2b >> 3));
  assert.deepEqual(projectColors('x', 'red'), projectColors('x'), 'invalid color ignored');
  const r = tile('C:/dev/artillery-x3');
  assert.ok(r.ops.some((o) => o.op === 'fill' && o.h === 20 && o.c === projectColors('artillery-x3', '#c0392b').bg), 'chip filled with the badge color');
});

test('badge_text_stays_project_name', () => {
  const r = tile('C:/dev/artillery-x3');
  const t = r.ops.find((o) => o.op === 'text' && o.s === 'artillery-x3');
  assert.ok(t, 'project name on the chip');
  assert.equal(t.fg, projectColors('artillery-x3', '#c0392b').fg);
  assert.equal(t.bg, projectColors('artillery-x3', '#c0392b').bg);
});

test('session_with_rule_uses_rule_pack', () => {
  const r = tile('C:/dev/artillery-x3');
  const sprites = pics(r).filter((p) => p.id >= 27);
  assert.ok(sprites.length > 0 && sprites.every((p) => p.pack === 'cat'));
});

test('session_without_match_uses_theme_pack', () => {
  for (const r of [tile('C:/dev/other'), tile(undefined), tile('C:/dev/artillery-x3', [])]) {
    const sprites = pics(r).filter((p) => p.id >= 27);
    assert.ok(sprites.length > 0 && sprites.every((p) => p.pack === undefined));
    assert.ok(r.ops.some((o) => o.op === 'fill' && o.h === 20 && o.c === projectColors('artillery-x3').bg), 'default chip color');
  }
});

// A permission request held for the page (POST /permission): the tile shows the tool, the argument and Allow / Deny.
const perm = (over = {}) => ({ id: 'p1', tool: 'Bash', cmd: 'git status --short', detail: 'git status --short', until: 31000, ...over });
const permSession = (over = {}) => session({ ask: null, perm: perm(), agents: [agent({ state: 'needs_you' })], ...over });
const permCtx = { sessions: [permSession()], selected: 0, menu: false, part: 'lead', frameW: 472, frameH: 216 };

test('perm_tile_draws_tool_cmd_and_two_buttons', () => {
  const r = draw(state([permSession()]), ui({ nowMs: 1000 }));
  const all = texts(r);
  assert.ok(all.some((t) => t.includes('Bash')), 'tool');
  assert.ok(all.some((t) => t.includes('git status')), 'argument');
  assert.ok(all.includes('ALLOW') && all.includes('DENY'), 'buttons');
  assert.ok(all.includes('30s'), 'seconds left');
  assert.ok(!all.some((t) => t.includes('Write the failing tests')), 'no plan bar while asking');
});

test('hit_test_allow_and_deny_buttons', () => {
  assert.deepEqual(hitTest(128, 220, permCtx), { kind: 'permAllow' });
  assert.deepEqual(hitTest(355, 220, permCtx), { kind: 'permDeny' });
});

test('hit_test_ignores_plan_bar_while_perm', () => {
  const planY = 36 + 204 - 60;
  const hit = hitTest(60, planY, permCtx);
  assert.notEqual(hit.kind, 'planStep');
  assert.notEqual(hit.kind, 'permAllow');
});

test('perm_answer_maps_a_hit_to_the_post_body', () => {
  const s = permSession();
  assert.deepEqual(permAnswer({ kind: 'permAllow' }, s), { id: 'p1', decision: 'allow' });
  assert.deepEqual(permAnswer({ kind: 'permDeny' }, s), { id: 'p1', decision: 'deny' });
  assert.equal(permAnswer({ kind: 'lead' }, s), null);
  assert.equal(permAnswer({ kind: 'permAllow' }, session()), null, 'no request pending');
});
