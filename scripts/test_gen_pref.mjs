// 어떤 근무표를 원하세요? (결정 1-77) — node scripts/test_gen_pref.mjs
// 달마다 한 번 고르고 기억한다 · 고른 쪽의 배점을 곱해 요청에만 싣는다 · '멈출 때까지 계속'은 끝날 때마다 그 표에서 다시 잇는다 ·
// 이어 찾는 동안 계산 현황·걸린 시간을 처음부터 다시 세지 않는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
const store = new Map();
global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
global.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
global.EventSource = class { close() {} };
for (const f of ['undo-redo', 'drag-select', 'analysis', 'paste-import', 'profiles', 'dev-tools', 'nurse-manage',
  'settings-defs', 'solver', 'view-helpers', 'preinput-io', 'grid-interactions', 'schedule-features',
  'misc-features', 'redesign']) require(`../frontend/js/modules/${f}.js`);
const app = new Function(fs.readFileSync(new URL('../frontend/js/app.js', import.meta.url), 'utf8') + '\nreturn app;')();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RULES = [
  { id: 1, name: '단독 나이트 감점', rule_type: 'pattern', params: { pattern: ['non_night', 'night', 'non_night'] }, score: -200, enabled: true },
  { id: 2, name: '연속 동일 야간 근무 보상', rule_type: 'consecutive_same', params: { period: 'night' }, score: 15, enabled: true },
  { id: 3, name: '야간 근무 공평성', rule_type: 'night_fairness', params: {}, score: -50, enabled: true },
  { id: 4, name: 'V(연차) 사용 페널티', rule_type: 'specific_shift', params: { shift_code: 'V', condition: 'all' }, score: -500, enabled: true },
  { id: 5, name: '연속 휴일 보상', rule_type: 'consecutive_same', params: { period: 'rest' }, score: 30, enabled: true },
  { id: 6, name: '퐁당퐁당 회피', rule_type: 'pattern', params: { pattern: ['work', 'rest_leave', 'work'] }, score: -20, enabled: true },
  { id: 7, name: '주말·공휴일 근무 공평성', rule_type: 'weekend_fairness', params: {}, score: -30, enabled: true },
  { id: 8, name: '희망 근무 반영 보상', rule_type: 'wish', params: {}, score: 50, enabled: true },
  { id: 9, name: 'D→E 순방향 보상', rule_type: 'transition', params: { from: 'day', to: 'evening' }, score: 20, enabled: true },
];
const S1 = { a: { '2026-12-15': 'D', '2026-12-16': 'E' } }, S2 = { a: { '2026-12-15': 'E', '2026-12-16': 'E' } };
const res = (extra = {}) => ({ success: true, schedule: S1, extended_schedule: S1, message: '근무표가 생성되었습니다.',
  mip_gap_percent: 8.7, objective: 4295, mip_dual_bound: 3920, model_fingerprint: 'f1', engine: 'HiGHS', ...extra });

function make(results, hook) {
  const a = app();
  Object.assign(a, { year: 2026, month: 12, mipGap: 0.02, generateTimeout: 20, solver: 'highs', currentProfile: 'w1',
    nurses: [{ id: 'a', name: '간호01' }], scoringRules: RULES.map(r => ({ ...r, params: { ...r.params } })), loadFairnessLedger: null });
  a._autoSaveSchedule = async () => { a.rdSaved = true; };
  a.toast = () => {}; a._scrollLogs = () => {};
  const calls = [];
  a.api = async (method, path, body) => {
    if (path !== '/api/generate') return {};
    calls.push(body); if (hook) hook(a, calls.length);
    return results.shift();
  };
  return { a, calls };
}
const done = async (a) => { await sleep(5); while (a.generating) await sleep(5); await sleep(5); while (a.generating) await sleep(5); };
const score = (body, id) => body.scoring_rules.find(r => r.id === id).score;

// ① 만들기는 마법사에서 시작한다 (결정 1-93) — 몇 개 → 방향 → 찾는 시간. 고른 적이 없으면 generate() 도 요청을 보내지 않고 마법사를 연다
{
  store.clear();
  const { a, calls } = make([res({ mip_gap_percent: 1 })]);
  await a.generate();
  assert.equal(calls.length, 0);
  assert.deepEqual([a.mk.open, a.mk.step, a.mk.count], [true, 'count', 'one']);
  assert.deepEqual([a.mk.keys, a.mk.time, a.mk.quick], [[], 20, true]);
  assert.equal(a.rdPrefSummary, ''); assert.equal(a.makeLastText, '', '처음에는 지난번처럼 만들기가 없다');
  assert.deepEqual(a.makeSteps(), ['count', 'dir', 'time']);
  a.makePick('one'); assert.equal(a.mk.step, 'dir');
  a.makeToggle('night.a'); assert.equal(a.makeClash('night.b'), '야간 묶어서'); a.makeToggle('night.b'); assert.deepEqual(a.mk.keys, ['night.a'], '부딪히는 방향은 켜지지 않는다');
  assert.match(a.makeDirHint, /^야간 묶어서 — /);
  a.makeNext(); assert.equal(a.mk.step, 'time'); a.makeBack(); assert.equal(a.mk.step, 'dir'); a.makeNext();
  a.mk.time = 60; a.mk.quick = false;   // 초안 먼저(1-89)를 끄면 고른 시간 그대로
  a.makeStart(); await done(a);
  assert.equal(a.mk.open, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].time_limit, 3600, '고른 시간으로');
  assert.deepEqual([score(calls[0], 1), score(calls[0], 2), score(calls[0], 3)], [-400, 30, -25], '묶어서 — 단독 나이트·연속 야간 ×2, 야간 공평 ×0.5');
  assert.deepEqual([score(calls[0], 4), score(calls[0], 9)], [-500, 20], '다른 규칙은 그대로');
  assert.equal(a.scoringRules[0].score, -200, '설정의 값은 바꾸지 않는다');
  assert.equal(a.rdPrefSummary, '야간 묶어서 · 60분'); assert.equal(a.makeLastText, '하나만 · 야간 묶어서 · 60분');
  // 같은 달에 다시 — 단추는 늘 마법사를 열고, 지난번 고른 것이 채워져 있다. '지난번처럼 만들기'는 바로 시작한다
  const { a: b, calls: c2 } = make([res({ mip_gap_percent: 1 })]);
  b.makeOpen(); assert.deepEqual([b.mk.open, b.mk.step, b.mk.count, b.mk.keys, b.mk.time, b.mk.quick], [true, 'count', 'one', ['night.a'], 60, false]);
  b.makeAgain(); await done(b);
  assert.deepEqual([b.mk.open, c2.length, c2[0].time_limit], [false, 1, 3600]);
  // 다른 달은 그 달에 고른 것이 없다 — 지난번 고른 것에서 시작한다
  const { a: c, calls: c3 } = make([res({ mip_gap_percent: 1 })]);
  c.month = 11; await c.generate();
  assert.deepEqual([c.mk.open, c3.length], [true, 0]);
  assert.deepEqual([c.mk.keys, c.mk.time, c.mk.quick], [['night.a'], 60, false]);
  // 1오프 줄이기는 하나만 만들 때도 고를 수 있다 — 연속 휴일 길게와는 함께 못 고른다
  c.makePick('one'); c.makeToggle('oneoff'); assert.deepEqual(c.mk.keys, ['night.a', 'oneoff']); assert.equal(c.makeClash('rest.b'), '1오프 줄이기');
}
// ② 모두 균형이면 규칙을 싣지 않는다(서버가 설정 값을 쓴다) · 손으로 고친 값 위에 곱한다 · 양쪽이 같은 규칙을 건드리면 곱이 쌓인다
{
  store.clear();
  const { a } = make([]);
  store.set(a._genPrefKey(), JSON.stringify({ quick: false, night: 'mid', rest: 'mid', weekend: 'mid', time: 20 }));
  assert.deepEqual(a.genPrefPatch(), {});
  store.set(a._genPrefKey(), JSON.stringify({ quick: false, night: 'b', rest: 'b', weekend: 'a', time: 20 }));
  a.scoringRules[2].score = -80;                                   // 야간 공평성을 손으로 -80 으로
  const p = a.genPrefPatch(), s = id => p.scoring_rules.find(r => r.id === id).score;
  assert.deepEqual([s(3), s(1)], [-240, -100], '고르게 — 야간 공평 ×3(고친 값 위에), 단독 나이트 ×0.5');
  assert.deepEqual([s(5), s(6), s(4)], [90, -40, -250], '연속 휴일 길게');
  assert.deepEqual([s(7), s(8)], [-90, 25], '주말 근무를 고르게');
  assert.equal(p.mip_gap, undefined);
  assert.equal(a.rdPrefSummary, '야간 고르게 + 연속 휴일 길게 + 주말 근무 고르게 · 20분');   // 옛 저장 값(세 축)도 키워드로 읽는다
  // 저장한 값이 망가져 있어도 기본으로 읽는다
  store.set(a._genPrefKey(), JSON.stringify({ quick: false, night: 'x', time: 999 }));
  assert.deepEqual(a.genPrefGet(), { keys: [], time: 20, quick: false });
}
// ③ 멈출 때까지 계속 — 끝날 때마다 그 표에서 다시 잇는다 (오차 0). 더 좋은 표가 없어도 잇고, 가장 좋은 표(차이 0.1% 안)면 끝난다.
//    이어 찾는 동안 계산 현황·걸린 시간·찾은 표 수는 이어 간다
{
  store.clear();
  const feedAt = {};
  const { a, calls } = make([
    res(),                                                                                         // 1번째: 8.7%
    res({ schedule: S2, extended_schedule: S2, continued: true, improved: true, objective: 4100, mip_dual_bound: 3980, mip_gap_percent: 2.9 }),
    res({ schedule: S2, extended_schedule: S2, continued: true, improved: false, objective: 4100, mip_dual_bound: 4010 }),   // 더 좋은 표 없음
    res({ schedule: S1, extended_schedule: S1, continued: true, improved: true, objective: 4012, mip_dual_bound: 4010, mip_gap_percent: 0.05 }),
  ], (app_, n) => {
    feedAt[n] = { phases: app_.solveStats.phases.length, round: app_.genRound, cont: app_.continuing };
    app_._pushLog('Presolving model\n100 rows, 50 cols, 300 nonzeros\n' +
      ` L       ${n}       0         0   0.00%   -4300           -${4200 - n * 10}              2.38%        5      3      0        40     1.0s`);
  });
  store.set(a._genPrefKey(), JSON.stringify({ quick: false, night: 'mid', rest: 'mid', weekend: 'mid', time: 'endless' }));
  assert.equal(a.rdPrefSummary, '고르게 균형 · 멈출 때까지');
  await a.generate(); await sleep(5);
  for (let i = 0; i < 400 && (a.generating || calls.length < 4); i++) await sleep(5);
  assert.equal(calls.length, 4, '가장 좋은 표가 나올 때까지 네 번');
  assert.deepEqual(calls.map(c => c.mip_gap), [0, 0, 0, 0]);
  assert.deepEqual(calls.slice(1).map(c => c.prev_fingerprint), ['f1', 'f1', 'f1']);
  assert.deepEqual(calls.slice(1).map(c => c.prev_objective), [4295, 4100, 4100]);
  assert.equal(calls[2].prev_bound, 3980); assert.equal(calls[3].prev_bound, 4010, '더 좋은 표가 없던 찾기의 하한도 이어 준다');
  assert.deepEqual(a.schedule, S1); assert.equal(a.mipGapPercent, 0.05);
  assert.deepEqual([feedAt[1], feedAt[4]], [{ phases: 0, round: 1, cont: false }, { phases: 3, round: 4, cont: true }], '앞 찾기의 계산 현황을 지우지 않는다');
  assert.equal(a.solveStats.phases.length, 4); assert.equal(a.solveStats.found, 4);
  assert.deepEqual(a.genRounds.map(r => [r.n, r.improved]), [[1, true], [2, true], [3, false], [4, true]]);
  assert.equal(a.rdStorySteps[0].facts.find(f => f[0] === '이어 찾기')[1], '3번');
  assert.equal(a.rdStorySteps[0].facts.find(f => f[0] === '찾은 표')[1], '4개');
  assert.equal((a.statusMessage.match(/🔁 이어 찾기/g) || []).length, 1, '이어 찾기 안내가 찾기마다 쌓이지 않는다');
  assert.equal(a.story.open, true, '다 끝난 뒤에 결과 요약');
}
//    멈추기를 누르면 그 찾기에서 끝난다
{
  store.clear();
  const { a, calls } = make([res(), res({ continued: true, improved: false, stopped: true })], (app_, n) => { if (n === 2) app_.stopRequested = true; });
  store.set(a._genPrefKey(), JSON.stringify({ quick: false, time: 'endless' }));
  await a.generate(); await sleep(5);
  for (let i = 0; i < 200 && a.generating; i++) await sleep(5);
  await sleep(20);
  assert.equal(calls.length, 2);
  assert.deepEqual(a.schedule, S1);
}
// ④ 이어 찾는 동안의 중간 결과 — 화면의 표가 어느 정도인지·찾은 표·몇 번째·처음부터 걸린 시간. 사람이 누른 '이 표에서 더 찾기'는 한 번만
{
  store.clear();
  let mid = null;
  const { a, calls } = make([res({ mip_gap_percent: 1.5 }), res({ continued: true, improved: false, mip_dual_bound: 3950 })],
    (app_, n) => { if (n === 2) { app_.generateElapsed = 30; mid = { facts: app_.rdMidFacts, status: app_.rdStatus.text, story: app_.rdStorySteps.map(s => s.title) }; } });
  store.set(a._genPrefKey(), JSON.stringify({ quick: false, time: 'endless' }));
  store.set(a._genPrefKey(), JSON.stringify({ quick: false, time: 20 }));
  await a.generate(); await done(a);
  assert.equal(calls.length, 1, '목표 안(1.5%)이면 더 찾지 않는다');
  assert.deepEqual(a.rdMidFacts, [], '찾는 중이 아니면 없다');
  a.generateFinalElapsed = 65;
  store.set(a._genPrefKey(), JSON.stringify({ quick: false, time: 'endless' }));   // 계속 찾기로 바꿔 두어도
  a.rdContinue(); await done(a);
  assert.equal(calls.length, 2, '사람이 누른 더 찾기는 한 번만');
  assert.equal(calls[1].mip_gap, 0.02);
  assert.deepEqual(mid.facts, [['지금 화면의 표', '1번 · 가능한 최고와 1.5% 차이'], ['지금까지 찾은 표', '0개'], ['이어 찾기', '1번째'], ['처음부터', '1분 35초']]);
  assert.match(mid.status, /찾는 중 \(1번째 이어 찾기\)/);
  assert.equal(mid.story[mid.story.length - 1], '지금 표는 이렇습니다');
}
// ⑤ 선택 창의 스타일 이름은 간호사 창 근무 성향 줄(.rmodal .rpref)과 겹치면 안 된다 — 겹쳐서 그 줄 셋이 창 크기(600×620)가 됐다
{
  const css = fs.readFileSync(new URL('../frontend/css/redesign-bridge.css', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
  assert.equal(/^\.rpref\s*\{/m.test(css), false, '.rpref 에 창 크기를 주지 않는다');
  assert.match(html, /data-rd="make"[^>]*>\s*<div class="rmodal rmulti"/, '만들기 마법사는 여러 개 만들기 창의 크기를 쓴다 (선택 창은 없어졌다)');
  assert.equal(/rgenpref|genPref\.|multi\.open|multi\.step/.test(html), false, '옛 창의 상태를 참조하는 곳이 남으면 안 된다');
  assert.match(html, /<div class="rpref"/, '간호사 창 근무 성향 줄은 .rpref 그대로');
}
console.log('test_gen_pref: OK');
