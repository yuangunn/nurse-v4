// 여러 개 만들기 (결정 1-86) — node scripts/test_multi_make.mjs
// 방향 키워드는 같은 배점을 건드리지 않는 것끼리만 한 표에 · 표는 차례로 한 장씩(추가 생성 없음, 목표 차이·시간 상한은 공통) ·
// 만든 표는 이름 붙여 저장 · 견주는 숫자 · 고른 표를 화면에 연다. 원티드가 아닌 사전입력 표시(결정 1-84)도 여기서 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
const store = new Map();
global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : String(k).startsWith('ns_genpref:') ? '{"time":20}' : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
global.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
global.EventSource = class { close() {} };
for (const f of ['undo-redo', 'drag-select', 'analysis', 'paste-import', 'profiles', 'dev-tools', 'nurse-manage',
  'settings-defs', 'solver', 'view-helpers', 'preinput-io', 'grid-interactions', 'schedule-features',
  'misc-features', 'redesign']) require(`../frontend/js/modules/${f}.js`);
const app = new Function(fs.readFileSync(new URL('../frontend/js/app.js', import.meta.url), 'utf8') + '\nreturn app;')();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RULES = [
  { id: 1, name: '단독 나이트 감점', rule_type: 'pattern', params: { pattern: ['non_night', 'night', 'non_night'] }, score: -200, enabled: true },
  { id: 3, name: '야간 근무 공평성', rule_type: 'night_fairness', params: {}, score: -50, enabled: true },
  { id: 4, name: 'V(연차) 사용 페널티', rule_type: 'specific_shift', params: { shift_code: 'V', condition: 'all' }, score: -500, enabled: true },
  { id: 5, name: '연속 휴일 보상', rule_type: 'consecutive_same', params: { period: 'rest' }, score: 30, enabled: true },
  { id: 6, name: '퐁당퐁당 회피', rule_type: 'pattern', params: { pattern: ['work', 'rest_leave', 'work'] }, score: -20, enabled: true },
  { id: 10, name: '주휴 뒤에 OFF 붙이기', rule_type: 'transition', params: { from: 'specific:주', to: 'specific:OF' }, score: 150, enabled: true },
  { id: 11, name: 'OFF 뒤에 주휴 붙이기', rule_type: 'transition', params: { from: 'specific:OF', to: 'specific:주' }, score: 150, enabled: true },
];
const SHIFTS = [['D', 'day'], ['E', 'evening'], ['N', 'night'], ['NC', 'night'], ['OF', 'rest'], ['주', 'rest'], ['V', 'leave']].map(([code, period]) => ({ code, period, name: code }));
const dk = (d) => `2026-12-${String(d).padStart(2, '0')}`;
const row = (codes, from = 6) => Object.fromEntries(codes.split(' ').map((c, i) => [dk(from + i), c]));
function make(results) {
  const a = app();
  Object.assign(a, { year: 2026, month: 12, mipGap: 0.02, generateTimeout: 20, solver: 'highs', currentProfile: 'w1', holidays: [],
    nurses: [{ id: 'a', name: '간호01', capable_shifts: ['D', 'E', 'N'] }, { id: 'b', name: '간호02', capable_shifts: ['D', 'E', 'N'] }],
    shifts: SHIFTS, scoringRules: RULES.map(r => ({ ...r, params: { ...r.params } })), loadFairnessLedger: null });
  a.toast = () => {}; a._scrollLogs = () => {}; a.loadSavedList = async () => {};
  const calls = [], saved = [];
  a.api = async (method, path, body) => {
    if (path === '/api/generate') { calls.push(body); return typeof results[0] === 'function' ? results.shift()(a) : results.shift(); }
    if (method === 'POST' && path === '/api/schedules') { saved.push(body); return { id: saved.length }; }
    if (method === 'GET' && path === '/api/schedules') return saved.map((s, i) => ({ id: i + 1, name: s.name, year: s.year, month: s.month }));
    if (method === 'DELETE') { saved[+path.split('/').pop() - 1].deleted = true; return {}; }
    return {};
  };
  return { a, calls, saved };
}
const res = (sched, extra = {}) => ({ success: true, schedule: sched, extended_schedule: sched, message: '근무표가 생성되었습니다.', mip_gap_percent: 1.5, objective: 100, mip_dual_bound: 98, model_fingerprint: 'f', relaxed_cells: {}, ...extra });
const score = (body, id) => body.scoring_rules.find(r => r.id === id).score;

// ① 키워드 — 같은 배점을 건드리면 한 표에 함께 고르지 못한다
{
  const { a } = make([]);
  const ids = a.rdMakeKeywords().map(k => k.id);
  assert.deepEqual(ids, ['night.a', 'night.b', 'rest.a', 'rest.b', 'weekend.a', 'weekend.b', 'oneoff', 'onecap', 'nosix']);
  a.multiToggle(0, 'night.a');
  assert.equal(a.multiClash(0, 'night.b'), '야간 묶어서', '야간 묶어서 ↔ 야간 고르게');
  assert.equal(a.multiClash(0, 'rest.b'), null); assert.equal(a.multiClash(0, 'night.a'), null, '이미 고른 것은 끌 수 있다');
  a.multiToggle(0, 'night.b'); assert.deepEqual(a.multi.tables[0].keys, ['night.a'], '부딪히는 것은 켜지지 않는다');
  a.multiToggle(0, 'rest.b');
  assert.equal(a.multiClash(0, 'oneoff'), '연속 휴일 길게', '둘 다 주휴 옆 OFF·퐁당퐁당을 건드린다');
  assert.equal(a.multiClash(0, 'rest.a'), '연속 휴일 길게');
  assert.equal(a.multiLabel(a.multi.tables[0].keys), '야간 묶어서 + 연속 휴일 길게'); assert.equal(a.multiLabel([]), '균형 (지금 설정 그대로)');
  a.multiToggle(0, 'night.a'); assert.deepEqual(a.multi.tables[0].keys, ['rest.b']);
  // 같은 묶음의 표는 한 번만 만든다 · 네 장까지
  a.multi.tables = [{ keys: [] }, { keys: ['oneoff'] }, { keys: [] }, { keys: ['oneoff'] }]; a.multiAdd();
  assert.equal(a.multi.tables.length, 4); assert.deepEqual(a.multiPlan.map(p => p.label), ['균형 (지금 설정 그대로)', '1오프 줄이기']);
  // '1오프 몰지 않기'는 배점이 아니라 규칙을 켠다 (결정 1-98) — 다른 키워드와 겹치지 않고, 그 표의 요청에만 rules 를 바꿔 싣는다. 설정 값은 그대로
  a.rules = { maxOneOff: false, maxOneOffCount: 3, weeklyOff: true };
  assert.equal(a._kwClash(['oneoff', 'rest.a'], 'onecap'), null); assert.deepEqual(a._kwRules(['oneoff']), {});
  assert.deepEqual(a._kwRules(['oneoff', 'onecap']), { rules: { maxOneOff: true, maxOneOffCount: 3, weeklyOff: true } }); assert.equal(a.rules.maxOneOff, false);
  // 6일 연속 없이 — 배점은 건드리지 않고 이 표의 요청에만 규칙을 끈다. 다른 키워드와 함께 고를 수 있다
  assert.deepEqual(a._kwRules(['nosix']), { rules: { maxOneOff: false, maxOneOffCount: 3, weeklyOff: true, longRunLastResort: false } }); assert.equal(a._kwClash(['oneoff', 'night.a'], 'nosix'), null);
  a.mk.count = 'one'; a.mk.keys = ['onecap']; assert.equal(a.makeHasCap, true); a.mk.keys = []; assert.equal(a.makeHasCap, false);
  a.mk.count = 'multi'; a.multi.tables = [{ keys: [] }, { keys: ['onecap'] }]; assert.equal(a.makeHasCap, true);
  assert.deepEqual(a.multiPlan.map(p => p.label), ['균형 (지금 설정 그대로)', '1오프 몰지 않기']);
}
// ② 차례로 한 장씩 — 공통 설정이 모든 요청에, 방향마다 배점이 곱해지고, 추가 생성은 하지 않는다. 만든 표는 이름 붙여 저장
{
  const S1 = { a: row('D D D D OF D D D D 주 OF E'), b: row('N OF OF D D V E E OF OF D D') };
  const S2 = { a: row('D D D D OF OF D D D 주 OF E'), b: row('N N OF OF D D E E OF OF D D') };
  const { a, calls, saved } = make([() => sleep(40).then(() => res(S1, { mip_gap_percent: 4.2 })), res(S2), { success: false, message: '만들 수 없습니다\n자세한 까닭' }]);
  a.multi.gap = 0.05; a.multi.cap = 10; a.multi.tables = [{ keys: [] }, { keys: ['oneoff', 'night.a'] }, { keys: ['rest.a'] }];
  a.allowPreRelax = true;
  const run = a.multiRun(); await sleep(10);
  assert.equal(a.generating, true, '만드는 동안 다른 만들기는 막힌다'); assert.deepEqual([a.mk.count, a.mk.step], ['multi', 'run']);
  await run;
  assert.equal(calls.length, 3, '표마다 한 번 — 차이가 목표보다 커도(4.2% > 5% 아님) 이어 찾지 않는다');
  assert.deepEqual(calls.map(c => [c.mip_gap, c.time_limit, c.allow_pre_relax, 'warm_start' in c]), [[0.05, 600, true, false], [0.05, 600, true, false], [0.05, 600, true, false]]);
  assert.equal(calls[0].scoring_rules, undefined, '균형은 설정 값 그대로(싣지 않는다)');
  assert.deepEqual([score(calls[1], 1), score(calls[1], 3), score(calls[1], 10), score(calls[1], 11), score(calls[1], 6), score(calls[1], 4)], [-400, -25, 300, 300, -40, -500]);
  assert.deepEqual([score(calls[2], 4), score(calls[2], 5), score(calls[2], 1)], [-1000, 15, -200]);
  assert.deepEqual(a.multi.results.map(r => r.state), ['done', 'done', 'fail']); assert.equal(a.multi.results[2].msg, '만들 수 없습니다');
  assert.deepEqual([a.generating, a.multi.running, a.mk.step], [false, false, 'cmp']);
  assert.deepEqual(saved.map(s => [s.name, s.year, s.month]), [['12월 · 균형 (지금 설정 그대로)', 2026, 12], ['12월 · 야간 묶어서 + 1오프 줄이기', 2026, 12]]);
  assert.deepEqual(saved[1].schedule, S2);
  // 숫자 — 12/6 부터(지난달 표의 주는 뺀다). a: 4-1-4 인 1오프 하나(긴 근무 사이). b: 단독 야간 하나 · D D V E E 의 V 도 하루짜리 휴무
  const st = a.multi.results[0].stats;
  assert.deepEqual([st.one, st.heavy, st.nine, st.singleN, st.v, st.relaxed, st.gap], [2, 1, 0, 1, 1, 0, 4.2]);
  const st2 = a.multi.results[1].stats;
  assert.deepEqual([st2.one, st2.heavy, st2.singleN, st2.v], [0, 0, 0, 0]);
  assert.equal(a.multiBest('one', a.multi.results[1]), true); assert.equal(a.multiBest('one', a.multi.results[0]), false);
  assert.equal(a.multiBest('relaxed', a.multi.results[0]), false, '모두 같으면 표시하지 않는다');
  // ③ 고른 표를 연다 — 화면의 표·차이가 그 표의 것이 되고 자동저장본으로 삼는다. 이어 찾을 수 있게 그 표의 요청을 기억한다
  a.makeViewMulti(); assert.deepEqual([a.mk.open, a.mk.step], [true, 'cmp']); a.multiPick(1); await sleep(5);
  assert.deepEqual(a.schedule, S2); assert.equal(a.mipGapPercent, 1.5); assert.deepEqual([a.mk.open, a.multi.picked, a.activeTab], [false, 1, 'schedule']);
  assert.equal(score(a.contBase.payload, 1), -400, '더 찾기는 그 표의 방향 그대로');
  assert.equal(saved.at(-1).name, '자동저장 2026-12');
  a.multiPick(2); assert.equal(a.multi.picked, 1, '만들지 못한 표는 열지 않는다');
  // 다시 만들면 같은 이름의 옛 저장본을 바꾼다
  a.api = ((orig) => async (m, p, b) => (p === '/api/generate' ? res(S1) : orig(m, p, b)))(a.api);
  a.multi.tables = [{ keys: [] }]; await a.multiRun();
  assert.equal(saved.filter(s => s.name === '12월 · 균형 (지금 설정 그대로)' && !s.deleted).length, 1);
}
// ④ 멈추면 남은 표는 만들지 않는다
{
  const S1 = { a: row('D D OF'), b: row('E E OF') };
  const { a, calls } = make([(app_) => { app_.multiStop(); return res(S1, { stopped: true }); }, res(S1)]);
  a.multi.tables = [{ keys: [] }, { keys: ['oneoff'] }, { keys: ['rest.a'] }];
  global.fetch = async () => ({});
  await a.multiRun();
  assert.equal(calls.length, 1);
  assert.deepEqual(a.multi.results.map(r => r.state), ['done', 'skip', 'skip']);
  assert.deepEqual([a.generating, a.stopRequested], [false, false]);
}
// ⑤ 원티드가 아닌 사전입력 (결정 1-84) — 칸마다 표시하면 원티드 색·수에서 빠진다. 넣어 둔 값이 바뀌면 표시가 풀린다
{
  const { a } = make([]);
  a.prevSchedule = { a: { [dk(10)]: 'OF', [dk(11)]: 'D', [dk(13)]: '주' } };
  const d = (n) => new Date(2026, 11, n);
  assert.equal(a.rdWantedCount, 2); assert.equal(a.rdCanMarkWanted('a', d(13)), false, '주휴는 원래 원티드가 아니다'); assert.equal(a.rdCanMarkWanted('a', d(12)), false, '빈칸');
  a.toggleNotWanted('a', d(11));
  assert.deepEqual([a.isWanted('a', d(11)), a.isNotWanted('a', d(11)), a.isWanted('a', d(10)), a.rdWantedCount], [false, true, true, 1]);
  assert.deepEqual(a.notWanted, { a: { [dk(11)]: 'D' } });
  a.prevSchedule = { a: { [dk(10)]: 'OF', [dk(11)]: 'E' } };
  assert.deepEqual([a.isNotWanted('a', d(11)), a.isWanted('a', d(11))], [false, true], '값이 바뀌면 다시 원티드');
  a.prevSchedule = { a: { [dk(10)]: 'OF', [dk(11)]: 'D' } }; a.toggleNotWanted('a', d(11));
  assert.deepEqual(a.notWanted, {}, '다시 누르면 푼다');
}
// 마법사에서 여러 개 (결정 1-93) — 몇 개 → 방향 → 시간 → 만드는 중 → 견주기. 지난번 고른 표들을 기억하고 '지난번처럼 만들기'로 다시 돈다
{
  store.clear();
  const S = { a: row('D D D OF OF D D D OF OF D D'), b: row('N N OF OF D D E E OF OF D D') };
  const { a, calls } = make([() => sleep(30).then(() => res(S)), res(S), res(S), res(S)]);
  a.makeOpen(); assert.deepEqual([a.mk.step, a.mk.count], ['count', 'one']);
  a.makePick('multi'); assert.deepEqual(a.makeSteps(), ['count', 'dir', 'time', 'run', 'cmp']);
  a.multi.tables = [{ keys: [] }, { keys: ['oneoff'] }]; a.makeNext(); assert.equal(a.mk.step, 'time'); a.multi.gap = 0.05; a.multi.cap = 10;
  a.makeStart(); await sleep(5); assert.equal(a.mk.step, 'run'); while (a.multi.running) await sleep(5);
  assert.deepEqual([a.mk.step, calls.length, a.mk.open], ['cmp', 2, true]);
  assert.equal(a.makeLastText, '여러 개 · 2장 (균형 / 1오프 줄이기)');
  a.makeBack(); assert.equal(a.mk.step, 'dir', '견주기에서 방향을 바꿔 다시');
  // 새로 열면 지난번 표들이 채워져 있고, 지난번처럼 만들기가 그대로 다시 만든다
  a.multi.tables = [{ keys: [] }]; a.mk.open = false; a.makeOpen();
  assert.deepEqual([a.mk.count, a.multi.tables.map(t => t.keys), a.multi.gap, a.multi.cap], ['multi', [[], ['oneoff']], 0.05, 10]);
  a.makeAgain(); await sleep(5); while (a.multi.running) await sleep(5);
  assert.equal(calls.length, 4);
  // 만드는 중에 만들기를 누르면 진행 화면이 열린다
  a.multi.running = true; a.mk.open = false; a.makeOpen(); assert.deepEqual([a.mk.open, a.mk.step], [true, 'run']); a.multi.running = false;
}
console.log('test_multi_make: OK');
