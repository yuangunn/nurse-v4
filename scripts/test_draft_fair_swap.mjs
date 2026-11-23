// 초안 먼저(결정 1-89) · 공평성 리포트 · 근무 바꾸기 검사(결정 1-90) — node scripts/test_draft_fair_swap.mjs
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
const SHIFTS = [['D', 'day'], ['E', 'evening'], ['N', 'night'], ['OF', 'rest'], ['주', 'rest'], ['V', 'leave']].map(([code, period]) => ({ code, period, name: code }));
const dk = (d) => `2026-12-${String(d).padStart(2, '0')}`;
const row = (codes, from = 1) => Object.fromEntries(codes.split(' ').map((c, i) => [dk(from + i), c]));
function make(onApi) {
  const a = app();
  Object.assign(a, { year: 2026, month: 12, mipGap: 0.02, generateTimeout: 20, solver: 'highs', currentProfile: 'w1', holidays: [dk(25)],
    nurses: [{ id: 'a', name: '간호01', capable_shifts: ['D', 'E', 'N'] }, { id: 'b', name: '간호02', capable_shifts: ['D', 'E'] }, { id: 'c', name: '간호03' }],
    shifts: SHIFTS, scoringRules: [], loadFairnessLedger: null });
  a.toast = () => {}; a._scrollLogs = () => {}; a.loadSavedList = async () => {}; a.rdStoryOpen = () => {};
  const calls = [];
  a.api = async (method, path, body) => { calls.push({ path, body }); return onApi ? onApi(path, body, a) : {}; };
  return { a, calls };
}
const res = (sched, gap) => ({ success: true, schedule: sched, extended_schedule: sched, message: '근무표가 생성되었습니다.', mip_gap_percent: gap, objective: 100, mip_dual_bound: 100 - gap, model_fingerprint: 'f', relaxed_cells: {} });
const SCHED = { a: row('D D N N OF OF D'), b: row('E E OF D D D OF'), c: row('N OF D E E N N') };
const pref = (a, patch) => { a._genPrefStore({ ...(a.genPrefGet() || {}), ...patch }); };
const gens = (calls) => calls.filter(c => c.path === '/api/generate').map(c => c.body);

// ① 초안 먼저 — 첫 찾기는 90초, 그 표에서 고른 시간만큼 잇고, 그래도 차이가 크면 한 번 더. 그 뒤엔 멈춘다
{
  const gaps = [26, 5, 3, 3];
  const { a, calls } = make((path) => (path === '/api/generate' ? res(SCHED, gaps.shift()) : {}));
  pref(a, {});
  assert.equal(a.genPrefGet().quick, true, '기본은 초안 먼저');
  await a.generate(); await sleep(60);
  const g = gens(calls);
  assert.deepEqual(g.map(b => b.time_limit), [90, 1200, 1200], '초안 90초 → 20분 → 차이가 남아 한 번 더');
  assert.equal(g[0].warm_start, undefined); assert.ok(g[1].warm_start && g[1].prev_fingerprint === 'f', '둘째부터는 앞 표에서 잇는다');
  assert.equal(a.generating, false); assert.equal(a.genDraftMore, false);
}
// 초안이 이미 목표 안이면 거기서 끝
{
  const { a, calls } = make((path) => (path === '/api/generate' ? res(SCHED, 1.2) : {}));
  pref(a, {}); await a.generate(); await sleep(30);
  assert.deepEqual(gens(calls).map(b => b.time_limit), [90]);
}
// 초안 시간 안에 표가 안 나오면 실패로 보이지 않고 고른 시간으로 다시 찾는다. 조건이 안 맞아 못 만든 것은 그대로 실패
{
  const out = [{ success: false, schedule: {}, extended_schedule: {}, relax_timed_out: true, message: '사전입력 완화로 다시 만들어 봤지만 제한 시간(1분) 안에 끝내지 못했습니다.' }, res(SCHED, 1.5)];
  const { a, calls } = make((path) => (path === '/api/generate' ? out.shift() : {}));
  pref(a, {}); await a.generate(); await sleep(40);
  assert.deepEqual(gens(calls).map(b => [b.time_limit, !!b.warm_start]), [[90, false], [1200, false]]);
  assert.equal(a.genFailed, false); assert.equal(Object.keys(a.schedule).length, 3);
}
{
  const { a, calls } = make((path) => (path === '/api/generate' ? { success: false, schedule: {}, extended_schedule: {}, message: '근무표를 만들 수 없습니다 — 12/9 야간 인원 부족' } : {}));
  pref(a, {}); await a.generate(); await sleep(40);
  assert.equal(gens(calls).length, 1); assert.equal(a.genFailed, true);
}
// 끄면 예전처럼 고른 시간 그대로 · 다시 만들기 같은 patch 요청은 초안을 거치지 않는다
{
  const { a, calls } = make((path) => (path === '/api/generate' ? res(SCHED, 1.2) : {}));
  pref(a, { quick: false }); assert.doesNotMatch(JSON.stringify(a.genPrefGet()), /"quick":true/);
  await a.generate(); await sleep(30);
  assert.deepEqual(gens(calls).map(b => b.time_limit), [1200]);
  pref(a, { quick: true }); await a.generate({ payloadPatch: { mip_gap: 0.05 } }); await sleep(30);
  assert.equal(gens(calls)[1].time_limit, 1200);
}

// 처음 표와 견주기 (결정 1-94) — 초안 뒤에 더 좋은 표로 바뀌면 무엇이 달라졌는지 센다. 손으로 고친 칸은 엔진의 표가 아니라 세지 않는다
{
  const S2 = { a: row('D D N N OF OF D'), b: row('E E OF D D D OF'), c: row('N OF D E E OF N') };   // c 의 6일 N → OF (1~5일은 지난달 표의 주라 견주지 않는다)
  const out = [res(SCHED, 26), { ...res(S2, 1.5), improved: true, objective: 80, mip_dual_bound: 79 }];
  const { a } = make((path) => (path === '/api/generate' ? out.shift() : {}));
  const toasts = []; a.toast = (m) => toasts.push(m);
  pref(a, {}); await a.generate(); await sleep(60);
  assert.deepEqual(a.schedule, S2); assert.deepEqual(a.genFirst.schedule, SCHED); assert.equal(a.genFirst.mip_gap_percent, 26);
  const dc = a.rdDraftCmp;
  assert.deepEqual([dc.cells, dc.who], [1, 1]);
  assert.equal(a.isDraftDiff('c', new Date(2026, 11, 6)), true); assert.equal(a.isDraftDiff('a', new Date(2026, 11, 7)), false);
  const gap = dc.rows.find(r => r.key === 'gap'); assert.deepEqual([gap.a, gap.b], [26, a.mipGapPercent]);
  assert.ok(toasts.some(m => /더 좋은 표를 찾아 바꿨습니다.*처음 표와 \d+칸 다름/.test(m)), toasts.join(' | '));
  const step = a.rdStorySteps.find(s => s.id === 'draft'); assert.ok(step, '결과 요약에 처음 표와 견주기 단계');
  assert.equal(step.facts[0][0], '달라진 칸'); assert.match(step.facts.find(f => f[0] === '최고와의 차이(%)')[1], /^26 → .* · 나아짐$/);
  // 강조 — 처음 표와 달라진 칸
  const nurseC = a.nurses.find(n => n.id === 'c'), R = a._hlRow(nurseC), M = a._hlMarks(R.row, R);
  assert.equal(M.count.draftDiff, R.df.filter(Boolean).length); assert.equal(M.count.draftDiff, dc.cells);
  // 손으로 고쳐도 견주는 것은 엔진이 낸 표끼리다
  a._originalSchedule = JSON.parse(JSON.stringify(S2)); a.schedule = { ...a.schedule, a: { ...a.schedule.a, [dk(1)]: 'E' } };
  assert.equal(a.rdDraftCmp.cells, dc.cells);
  // 새로 만들면 처음 표를 버린다 · 표가 한 번도 바뀌지 않았으면 견줄 것이 없다
  const { a: b } = make((path) => (path === '/api/generate' ? res(SCHED, 1.2) : {}));
  pref(b, {}); await b.generate(); await sleep(30);
  assert.equal(b.rdDraftCmp, null); assert.equal(b.rdStorySteps.some(s => s.id === 'draft'), false);
}

// ② 공평성 리포트 — 요약 집계 그대로 + 원티드 반영
{
  const { a } = make();
  a.schedule = JSON.parse(JSON.stringify(SCHED));
  // 1~5일은 지난달 표의 주라 원티드로 세지 않는다 — 6·7일에 둔다. b 의 6일 E 는 D 로 풀렸다
  a.prevSchedule = { a: { [dk(5)]: 'OF', [dk(6)]: 'OF', [dk(7)]: 'D' }, b: { [dk(6)]: 'E' } };
  a.relaxedCells = { b: { [dk(6)]: { from: 'E', to: 'D' } } };
  a.fairnessLedger3m = { a: { nights: 6, weekend_holiday: 4 }, b: { nights: 0, weekend_holiday: 5 } };
  const rows = a.rdFairRows, by = Object.fromEntries(rows.map(r => [r.id, r])), cols = a.rdFairCols();
  assert.equal(rows.length, 3);
  assert.equal(by.a.n, 2); assert.equal(by.c.n, 3);
  assert.deepEqual([by.a.want, by.a.kept], [2, 2]); assert.deepEqual([by.b.want, by.b.kept], [1, 0], '풀린 원티드는 반영으로 세지 않는다');
  const cell = (r, name) => cols.find(c => c[0] === name)[1](r);
  assert.equal(cell(by.a, '원티드 반영'), '2 / 2'); assert.equal(cell(by.c, '원티드 반영'), '—');
  assert.equal(cell(by.a, '지난 석 달 야간'), 6); assert.equal(String(cell(by.a, '야간 합')).replace('※ ', ''), '8');
  assert.match(a.rdFairNote, /합 = 이번 달 \+ 지난 석 달/);
}

// 주말·공휴일 근무 — D1·중간번·병동이 보탠 근무(시간대가 근무인 코드)도 센다. 이번 달 칸과 합이 같은 기준이어야 한다
{
  const { a } = make();
  a.shifts = [...SHIFTS, { code: 'D1', period: 'day1', name: 'D1' }, { code: '중3', period: 'middle', name: '중간번3' }];
  a.schedule = { a: row('OF OF OF OF D1 중3 OF') };   // 12/5 토 D1 · 12/6 일 중3
  const r = a.rdFairRows[0];
  assert.equal(r.wh, 2); assert.equal(r.totalWh, 2); assert.equal(r.weekendWork, 2);
}

// ③ 근무 바꾸기 검사 — 바꾸기 전·뒤를 서버에 묻고 차이만 보인다. 바꾸기는 되돌릴 수 있다
{
  const notesOf = (s) => { const out = []; for (const [id, r] of Object.entries(s)) for (let d = 1; d < 7; d++) if (r[dk(d)] === 'N' && r[dk(d + 1)] === 'D') out.push(`${id} ${d + 1}일 N → D`); return out; };
  const { a, calls } = make((path, body) => (path === '/api/check_schedule' ? { notes: notesOf(body.schedule) } : {}));
  a.schedule = JSON.parse(JSON.stringify(SCHED)); a.checkScheduleViolations = () => {}; a._schedPush = () => { a._pushed = (a._pushed || 0) + 1; };
  a.swapOpen('a', new Date(2026, 11, 5));
  assert.deepEqual(a.swap.days, [dk(5)]); assert.equal(a.swap.res, null);
  a.swap.b = 'b'; await a.swapCheck();
  // 5일: a OF ↔ b D → a 는 4일 N 다음 5일 D
  assert.deepEqual(a.swapPairs, [{ dk: dk(5), a: 'OF', b: 'D' }]);
  assert.deepEqual(a.swap.res.added, ['a 5일 N → D']); assert.deepEqual(a.swap.res.removed, []); assert.deepEqual(a.swap.res.capable, []);
  assert.equal(calls.filter(c => c.path === '/api/check_schedule').length, 2, '앞·뒤 한 번씩');
  assert.equal(a.schedule.a[dk(5)], 'OF', '검사만으로는 표가 바뀌지 않는다');
  // 3일로 바꿔 보면: a N ↔ b OF → b 는 야간을 못 하는 사람
  a.swapToggleDay(dk(5)); a.swapToggleDay(dk(3)); await sleep(10);
  assert.deepEqual(a.swap.days, [dk(3)]);
  assert.equal(a.swap.res.capable.length, 1); assert.match(a.swap.res.capable[0], /간호02.*N 근무를 할 수 없는/);
  // 같은 근무끼리는 바꿀 것이 없다
  a.swap.b = 'c'; a.swap.days = [dk(7)]; a.schedule.c[dk(7)] = 'D'; await a.swapCheck();
  assert.equal(a.swap.res.same, true); a.swapApply(); assert.equal(a._pushed, undefined, '같으면 바꾸지 않는다');
  // 적용 — 두 사람의 그 날만 바뀌고 되돌리기 스택에 한 번
  a.swap.b = 'b'; a.swap.days = [dk(1), dk(2)]; await a.swapCheck(); a.swapApply();
  assert.deepEqual([a.schedule.a[dk(1)], a.schedule.a[dk(2)], a.schedule.b[dk(1)], a.schedule.b[dk(2)]], ['E', 'E', 'D', 'D']);
  assert.equal(a.schedule.a[dk(3)], 'N'); assert.deepEqual(a.schedule.c, { ...SCHED.c, [dk(7)]: 'D' });
  assert.equal(a._pushed, 1); assert.equal(a.swap.open, false); assert.equal(a.rdSaved, false);
}
// 서버가 대답하지 못하면 바꾸기 단추가 열리지 않는다 (결과에 error)
{
  const { a } = make((path) => { if (path === '/api/check_schedule') throw new Error('연결 끊김'); return {}; });
  a.schedule = JSON.parse(JSON.stringify(SCHED)); a._schedPush = () => { throw new Error('바뀌면 안 된다'); };
  a.swapOpen('a', new Date(2026, 11, 5)); a.swap.b = 'b'; await a.swapCheck();
  assert.match(a.swap.res.error, /검사하지 못했습니다/); a.swapApply(); assert.equal(a.schedule.a[dk(5)], 'OF');
}
// 차지 코드 — 바탕 근무(N)를 할 수 있으면 받을 수 있고, 명부에 차지가 아니면 알리기만 한다
{
  const { a } = make((path) => (path === '/api/check_schedule' ? { notes: [] } : {}));
  a.shifts = [...SHIFTS, { code: 'NC', period: 'night', name: 'NC' }]; a.nurses[2].is_charge = true; a.nurses[2].capable_shifts = ['D', 'E', 'N'];
  a.schedule = { a: row('D D OF'), b: row('E E OF'), c: row('NC OF OF') };
  a.swapOpen('a', new Date(2026, 11, 1)); a.swap.b = 'c'; await a.swapCheck();
  assert.deepEqual(a.swap.res.capable, [], 'N 을 할 수 있는 사람은 NC 도 받을 수 있다'); assert.equal(a.swap.res.wanted.length, 1); assert.match(a.swap.res.wanted[0], /간호01.*NC\(차지\)를 받습니다/);
  a.swap.a = 'b'; await a.swapCheck(); assert.equal(a.swap.res.capable.length, 1, 'N 을 못 하는 사람은 NC 도 못 받는다');
}
// 그룹 경고는 같은 규칙끼리 개수로 견준다 — 목록 글이 달라졌다고 '새로 걸림'과 '나아짐'에 함께 나오지 않는다
{
  const { a } = make();
  const g = (n, list) => ({ 'G 그룹: 같이 일하지 않기를 못 지킨 근무 ': { n, text: `G 그룹: 같이 일하지 않기를 못 지킨 근무 ${n}개 — ${list}`, head: `G 그룹: 같이 일하지 않기를 못 지킨 근무 ${n}개` } });
  assert.deepEqual(a._swapGroupDiff(g(4, 'x'), g(3, 'y')), { added: [], removed: ['G 그룹: 같이 일하지 않기를 못 지킨 근무 3개 (지금은 4개)'] });
  assert.deepEqual(a._swapGroupDiff(g(3, 'x'), g(4, 'y')), { added: ['G 그룹: 같이 일하지 않기를 못 지킨 근무 4개 (지금은 3개) — y'], removed: [] });
  assert.deepEqual(a._swapGroupDiff(g(3, 'x'), g(3, 'y')), { added: [], removed: [] });
  assert.deepEqual(a._swapGroupDiff({}, g(1, 'y')).added.length, 1); assert.deepEqual(a._swapGroupDiff(g(2, 'x'), {}).removed, ['G 그룹: 같이 일하지 않기를 못 지킨 근무 2개 → 0개']);
}
console.log('test_draft_fair_swap: OK');
