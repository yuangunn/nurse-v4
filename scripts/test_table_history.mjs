// 표 기록 (결정 1-95) — node scripts/test_table_history.mjs
// 나온 표에 번호를 붙여 남긴다 · 번호를 눌러 본다 · 지난 번호를 보는 중이면 새 표가 나와도 화면은 그대로 · 두 번호를 달력에 겹쳐 견준다 ·
// 손으로 고친 것은 그 번호에 붙여 둔다 · 따로 저장 · 새로고침 뒤 자동저장본을 열면 되살아난다
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
const SHIFTS = [['D', 'day'], ['DC', 'day'], ['E', 'evening'], ['N', 'night'], ['OF', 'rest'], ['주', 'rest'], ['V', 'leave']].map(([code, period]) => ({ code, period, name: code }));
const dk = (d) => `2026-12-${String(d).padStart(2, '0')}`;
const day = (d) => new Date(2026, 11, d);
const row = (codes, from = 6) => Object.fromEntries(codes.split(' ').map((c, i) => [dk(from + i), c]));   // 6일부터 — 1~5일은 지난달 표의 주
const S1 = { a: row('D D N N OF OF D'), b: row('E E OF D D D OF'), c: row('N OF D E E N N') };
const S2 = { a: row('D D N N OF OF D'), b: row('E OF OF D D D OF'), c: row('N OF D E E OF N') };   // b 7일 E→OF(쉬게 됨) · c 11일 N→OF(쉬게 됨)
const S3 = { a: row('D E N N OF OF D'), b: row('E OF OF D D D E'), c: row('N OF D E E OF N') };    // a 7일 D→E(다른 근무로) · b 12일 OF→E(근무하게 됨)
function make(onApi) {
  const a = app();
  Object.assign(a, { year: 2026, month: 12, mipGap: 0.02, generateTimeout: 20, solver: 'highs', currentProfile: 'w1', holidays: [],
    nurses: [{ id: 'a', name: '간호01', capable_shifts: ['D', 'E', 'N'] }, { id: 'b', name: '간호02', capable_shifts: ['D', 'E'] }, { id: 'c', name: '간호03' }],
    shifts: SHIFTS, scoringRules: [], loadFairnessLedger: null });
  a.toast = () => {}; a._scrollLogs = () => {}; a.loadSavedList = async () => {}; a.rdStoryOpen = () => {}; a.checkScheduleViolations = () => {};
  const calls = [];
  a.api = async (method, path, body) => { calls.push({ method, path, body }); return onApi ? onApi(path, body, a, method) : {}; };
  return { a, calls };
}
const res = (sched, gap, extra = {}) => ({ success: true, schedule: JSON.parse(JSON.stringify(sched)), extended_schedule: {}, message: '근무표가 생성되었습니다.', mip_gap_percent: gap, objective: 100 - (30 - gap), mip_dual_bound: 60, model_fingerprint: 'f', relaxed_cells: {}, ...extra });
const gens = (calls) => calls.filter(c => c.path === '/api/generate');

// ① 나온 표마다 번호 — 초안 1번, 더 찾아 바뀐 표 2번. 번호를 누르면 그 표가 화면에 오고, 최신으로 돌아갈 수 있다
{
  store.clear();
  const out = [res(S1, 26), res(S2, 1.5, { improved: true })];
  const { a } = make((path) => (path === '/api/generate' ? out.shift() : {}));
  a._genPrefStore({}); await a.generate(); await sleep(60);
  assert.deepEqual([a.verLog.map(v => v.n), a.verCur, a.verLast, a.verPinned], [[1, 2], 2, 2, false]);
  assert.deepEqual(a.schedule, S2); assert.deepEqual(a.verLog[0].result.schedule, S1);
  assert.equal(a.verChipSub({ sec: 17, gap: 606.89 }), '17초 · 최고와 차이 큼');
  assert.equal(a.verChipName(a.verLog[0]), '1번 · 초안'); assert.equal(a.verChipName(a.verLog[1]), '2번 · 최신'); assert.match(a.verChipSub(a.verLog[0]), /최고와 26% 차이/);
  a.verShow(1);
  assert.deepEqual(a.schedule, S1); assert.deepEqual([a.verCur, a.verPinned, a.mipGapPercent, a.rdSaved], [1, true, 26, false]);
  a.verShow(2); assert.deepEqual(a.schedule, S2); assert.deepEqual([a.verCur, a.verPinned, a.rdSaved], [2, false, true]);

  // ② 견주기 — 2번(화면) ← 1번. 칸마다 종류, 사람·날짜·전체 수, 종류 거르기, 두 줄 보기
  a.verCmpToggle(); assert.deepEqual([a.verCmp.on, a.verCmp.a], [true, 1]);
  const [nA, nB, nC] = a.nurses;
  assert.equal(a.rdCmpKind(nB, day(7)), 'rest'); assert.equal(a.rdCmpKind(nC, day(11)), 'rest'); assert.equal(a.rdCmpKind(nA, day(7)), 'same');
  assert.equal(a.rdCmpKind(nA, day(3)), '', '지난달 표의 주는 견주지 않는다');
  assert.equal(a.rdCmpOld(nB, day(7)), 'E'); assert.equal(a.rdCmpOld(nA, day(7)), '', '겹쳐 보기는 바뀐 칸에만 앞 근무를 적는다');
  assert.equal(a.rdCellCmp(nB, day(7)), 'vd vd-rest'); assert.equal(a.rdCellCmp(nA, day(7)), 'vd-same');
  assert.deepEqual([a.rdCmpRowCount(nA), a.rdCmpRowCount(nB), a.rdCmpRowCount(nC), a.rdCmpDayCount(day(7))], [0, 1, 1, 1]);
  assert.deepEqual(a.rdCmpTotal, { cells: 2, who: 2, rest: 2, work: 0, swap: 0 });
  a.verCmp.kinds.rest = false; assert.equal(a.rdCmpTotal.cells, 0); assert.equal(a.rdCellCmp(nB, day(7)), 'vd-same'); a.verCmp.kinds.rest = true;
  a.verCmp.color = false; assert.equal(a.rdCellCmp(nB, day(7)), 'vd vd-one'); a.verCmp.color = true;
  a.verCmp.dim = false; assert.equal(a.rdCellCmp(nA, day(7)), ''); a.verCmp.dim = true;
  a.verCmp.mode = 'rows'; assert.equal(a.rdCmpOld(nA, day(7)), 'D', '두 줄 보기는 모든 칸에 앞 표의 근무'); assert.equal(a.rdCellCmp(nB, day(7)), 'vd vd-rest vd2'); a.verCmp.mode = 'overlay';
  // 초안을 보러 가면 견줄 앞 표가 없어 견주기가 꺼진다. 초안에서 견주기를 켜면 다음 번호로 가서 초안과 견준다
  a.verShow(1); assert.equal(a.verCmp.on, false);
  a.verCmpToggle(); assert.deepEqual([a.verCur, a.verCmp.on, a.verCmp.a], [2, true, 1]);
  // 번호마다 숫자
  const rows = a.verNumRows(); assert.equal(rows[rows.length - 1].label, '앞 번호와 달라진 칸'); assert.deepEqual(rows[rows.length - 1].cells.map(c => c.text), ['—', '2칸']);
  assert.equal(rows.find(r => r.label === '최고와의 차이(%)').cells[1].best, true);
}

// ③ 지난 번호를 보는 중이면 새 표가 나와도 화면은 그대로 — 새 표는 다음 번호로 남고, 알림의 '보기'로 연다. 그 달의 자동저장본은 새 표
{
  store.clear();
  let n = 0;
  const { a, calls } = make((path, body, app) => { if (path !== '/api/generate') return {}; n++;
    if (n === 1) return res(S1, 26);
    if (n === 2) return res(S2, 12, { improved: true });
    app.verShow(1);                                       // 셋째 찾기가 도는 동안 초안을 보러 간다
    return res(S3, 1.2, { improved: true }); });
  const saves = []; a._autoSaveSchedule = (o) => saves.push(o || 'screen'); let opened = 0; a.rdStoryOpen = () => { opened++; };
  a._genPrefStore({}); await a.generate(); await sleep(80);
  assert.equal(gens(calls).length, 3);
  assert.deepEqual([a.verLog.map(v => v.n), a.verCur, a.verPinned, a.verFresh], [[1, 2, 3], 1, true, [3]]);
  assert.deepEqual(a.schedule, S1, '보던 표 그대로'); assert.equal(a.mipGapPercent, 26, '화면의 표의 차이도 그대로');
  assert.match(a.statusMessage, /표 기록 3번으로 남겼습니다 — 보던 표는 그대로/);
  assert.deepEqual(saves.filter(s => s !== 'screen').map(s => s.schedule), [S3], '가장 좋은 표가 자동저장본');
  assert.equal(opened, 0, '화면에 넣지 않은 새 표로 끝나면 결과 요약 창을 띄우지 않는다 — 알림의 보기를 가린다');
  assert.equal(a.rdToast.act, '보기'); a.rdToast.fn();
  assert.deepEqual([a.verCur, a.verSeen, a.verPinned, a.rdToast], [3, 3, false, null]); assert.deepEqual(a.schedule, S3);
  // 3번 ← 2번: a 7일 D→E(다른 근무로) · b 12일 OF→E(근무하게 됨)
  a.verCmpPick(2); assert.deepEqual(a.rdCmpTotal, { cells: 2, who: 2, rest: 0, work: 1, swap: 1 });
  a.verCmpPick(1, 2); assert.deepEqual([a.verCur, a.verCmp.a], [2, 1]);
}

// ④ 손으로 고친 것은 그 번호에 붙여 둔다 — 다른 번호를 보고 와도 고친 채로, 고친 칸 표시도 그대로. 따로 저장도 고친 표로
{
  store.clear();
  const out = [res(S1, 26), res(S2, 1.5, { improved: true })];
  const { a, calls } = make((path, body, app, method) => (path === '/api/generate' ? out.shift() : (method === 'GET' && path === '/api/schedules' ? [] : {})));
  a._genPrefStore({}); await a.generate(); await sleep(60);
  a.schedule = { ...a.schedule, a: { ...a.schedule.a, [dk(6)]: 'E' } };
  assert.equal(a.getManualEditCount(), 1);
  a.verShow(1); assert.equal(a.schedule.a[dk(6)], 'D'); assert.equal(a.getManualEditCount(), 0);
  a.verShow(2); assert.equal(a.schedule.a[dk(6)], 'E'); assert.equal(a.getManualEditCount(), 1); assert.equal(a.rdSaved, false);
  await a.verSave(2);
  const named = () => calls.filter(c => c.method === 'POST' && c.path === '/api/schedules' && !String(c.body.name).startsWith('자동저장'));
  assert.equal(named()[0].body.name, '12월 · 2번 표'); assert.equal(named()[0].body.schedule.a[dk(6)], 'E');
  await a.verSave(1); assert.equal(named()[1].body.name, '12월 · 1번 표(초안)'); assert.equal(named()[1].body.schedule.a[dk(6)], 'D');

  // ⑤ 보관 — 새로고침 뒤(새 화면) 그 달 자동저장본(= 어느 번호와 같은 표)을 열면 기록이 되살아난다. 다른 표를 열면 지운다
  const { a: b } = make();
  b.schedule = JSON.parse(JSON.stringify(S1)); b.verAfterLoad();
  assert.deepEqual([b.verLog.map(v => v.n), b.verCur, b.verPinned], [[1, 2], 1, true]);
  b.verShow(2); assert.equal(b.schedule.a[dk(6)], 'E', '고친 채로 되살아난다');
  // 저장본에 함께 넣는 기록 (결정 1-112) — 저장하는 표가 기록의 한 번호와 같을 때만 묶고, 그 번호를 보는 번호로 적는다.
  // 이 브라우저에 보관해 둔 것이 없어도, 저장본에 든 기록으로 되살아난다
  const pack = b._verPackFor(b.schedule);
  assert.deepEqual([pack.cur, pack.list.map(v => v.n), 'solver_log' in pack.list[0].result && pack.list[0].result.solver_log], [2, [1, 2], undefined]);
  assert.equal(b._verPackFor({ a: row('OF OF OF OF OF OF OF') }), null, '기록과 상관없는 표에는 넣지 않는다');
  const { a: c } = make();
  c.schedule = { a: row('OF OF OF OF OF OF OF') }; c.verAfterLoad();
  assert.deepEqual([c.verLog.length, c.verCur, store.has(c._verKey())], [0, null, false]);
  const { a: d } = make();
  d.schedule = JSON.parse(JSON.stringify(b.schedule)); d.verAfterLoad(JSON.parse(JSON.stringify(pack)));
  assert.deepEqual([d.verLog.map(v => v.n), d.verCur, store.has(d._verKey())], [[1, 2], 2, true]);
}

// ⑥ 새로 만들면 기록은 새 표들로 바뀐다 · 한 장뿐이면 지난 번호가 없다 · 병동을 바꾸면 화면에서만 지운다
{
  store.clear();
  const out = [res(S1, 26), res(S2, 1.5, { improved: true }), res(S3, 1.0)];
  const { a } = make((path) => (path === '/api/generate' ? out.shift() : {}));
  a._genPrefStore({}); await a.generate(); await sleep(60); assert.equal(a.verLog.length, 2);
  await a.generate(); await sleep(40);
  assert.deepEqual([a.verLog.map(v => v.n), a.verCur, a.verPinned], [[1], 1, false]); assert.deepEqual(a.verLog[0].result.schedule, S3);
  a.verCmpToggle(); assert.equal(a.verCmp.on, false, '견줄 표가 없다');
  const key = a._verKey(); a.verReset(); assert.deepEqual([a.verLog.length, store.has(key)], [0, true]);
}
// ⑦ 저장한 근무표와 견주기 — 표 기록이 없어도(저장본을 연 화면) 이 달에 저장한 표를 앞 표로 놓고 같은 달력 겹쳐 보기로 본다
{
  store.clear();
  const saved = { 31: { name: '12월 손으로 수정', year: 2026, month: 12, data: { year: 2026, month: 12, schedule: S1 } }, 9: { name: '11월 확정', year: 2026, month: 11, data: { year: 2026, month: 11, schedule: S1 } } };
  const { a } = make((path) => { const m = /^\/api\/schedules\/(\d+)$/.exec(path); return m ? saved[m[1]] : {}; });
  a.savedSchedules = [{ id: 31, name: '12월 손으로 수정', year: 2026, month: 12 }, { id: 9, name: '11월 확정', year: 2026, month: 11 }];
  a.schedule = JSON.parse(JSON.stringify(S3)); a._originalSchedule = JSON.parse(JSON.stringify(S3));
  assert.deepEqual(a.rdSavedOfMonth.map(s => s.id), [31], '이 달 것만');
  await a.verCmpSaved(31);
  assert.deepEqual([a.verCmp.on, a.verCmp.a, a.verCmpAVal, a.verCmpName], [true, null, 's31', '‘12월 손으로 수정’']);
  // S1 → S3: b 7일 E→OF · c 11일 N→OF(쉬게 됨 2) · a 7일 D→E(다른 근무로 1) · b 12일 OF→E(근무하게 됨 1)
  assert.deepEqual(a.rdCmpTotal, { cells: 4, who: 3, rest: 2, work: 1, swap: 1 });
  assert.equal(a.rdCmpOld(a.nurses[1], day(7)), 'E'); assert.equal(a.rdCellCmp(a.nurses[1], day(12)), 'vd vd-work');
  assert.ok(a.rdCmpFacts.every(f => f.a !== f.b), '숫자는 달라진 것만'); assert.equal(typeof a.verCmp.saved.stats.one, 'number');
  await a.verCmpSaved(9); assert.equal(a.verCmpAVal, 's31', '다른 달의 표와는 견주지 않는다');
  a.verCmpOff(); assert.deepEqual([a.verCmp.on, a.verCmp.saved, a.rdCellCmp(a.nurses[1], day(7))], [false, null, '']);
  // 표 기록이 있을 때 — 앞 표를 저장한 표로 바꿨다가 번호로 되돌린다. 번호를 바꿔 봐도 저장한 표와의 견주기는 그대로
  const out = [res(S1, 26), res(S2, 1.5, { improved: true })];
  const { a: b } = make((path) => { if (path === '/api/generate') return out.shift(); const m = /^\/api\/schedules\/(\d+)$/.exec(path); return m ? { name: '12월 다른 표', year: 2026, month: 12, data: { year: 2026, month: 12, schedule: S3 } } : {}; });
  b._genPrefStore({}); await b.generate(); await sleep(60);
  b.verCmpToggle(); assert.equal(b.verCmpAVal, 'v1');
  await b.verCmpPickA('s40'); assert.deepEqual([b.verCmpAVal, b.verCmp.on], ['s40', true]);
  b.verShow(1); assert.deepEqual([b.verCur, b.verCmp.on, b.verCmpAVal], [1, true, 's40']);
  await b.verCmpPickA('v1'); assert.deepEqual([b.verCur, b.verCmp.saved, b.verCmp.on], [1, null, false]);   // 1번을 보는 중엔 1번이 앞 표가 될 수 없다(번호는 화면보다 앞이어야 한다) — 견주기가 꺼진다
  b.verShow(2); b.verCmpToggle(); assert.deepEqual([b.verCmp.on, b.verCmpAVal], [true, 'v1']);
}
// ⑧ 찾는 도중의 표 (결정 1-97) — 서버가 보낸 표에 번호를 붙여 남기고 화면이 따라간다. 같은 표는 번호를 늘리지 않고, 끝난 표가 같으면 내용만 바꾼다
{
  store.clear();
  let fire = null;
  const part = (sched, extra = {}) => ({ success: true, partial: true, stage: 'score', schedule: JSON.parse(JSON.stringify(sched)), extended_schedule: {}, relaxed_cells: {}, nurse_scores: {}, nurse_score_details: {}, mip_gap_percent: 30, message: '찾는 도중에 나온 표입니다.', ...extra });
  const { a } = make(async (path) => { if (path !== '/api/generate') return {};
    fire(part(S1, { stage: 'keep', mip_gap_percent: null })); fire(part(S1, { stage: 'keep', mip_gap_percent: null })); await sleep(5);   // 같은 표가 또 오면 무시
    assert.deepEqual([a.verLog.map(v => v.n), a.verCur, a.generating, a.rdSolveCompact], [[1], 1, true, true]); assert.deepEqual(a.schedule, S1);
    assert.equal(a.rdMidFacts[0][1], '1번', '차이를 모르는 표는 번호만'); assert.equal(a.rdMidFacts.some(f => f[0] === '이어 찾기'), false, '첫 찾기');
    fire(part(S2)); await sleep(5);
    assert.deepEqual([a.verLog.map(v => v.n), a.verCur], [[1, 2], 2]); assert.deepEqual(a.schedule, S2);
    fire(part(S1, { stage: 'keep' })); await sleep(5); assert.equal(a.verLog.length, 2, '점수 단계의 표가 나온 뒤에는 사전입력 지키기 단계의 표를 받지 않는다');
    return res(S2, 1.5); });                                                                 // 끝난 표 = 2번과 같은 표
  a.EventSource = null; global.EventSource = class { constructor() { fire = (t) => this.onmessage({ data: JSON.stringify({ type: 'table', table: t }) }); } close() {} };
  let opened = 0; a.rdStoryOpen = () => { opened++; };
  a._genPrefStore({ quick: false }); await a.generate(); await sleep(40);
  assert.deepEqual([a.verLog.map(v => v.n), a.verCur, a.verLog[1].gap, !!a.verLog[1].result.partial], [[1, 2], 2, 1.5, false], '끝난 표가 같으면 번호는 그대로, 내용만 끝난 것으로');
  assert.equal(opened, 1); assert.equal(a.generating, false);

  // 찾는 도중의 표를 손으로 고쳤으면 다음 표가 와도 화면은 그대로 — 끝난 표도 번호로만 남고 고친 표로 돌아온다
  let n = 0;
  const { a: b } = make(async (path) => { if (path !== '/api/generate') return {};
    fire(part(S1)); await sleep(5); b.schedule = { ...b.schedule, a: { ...b.schedule.a, [dk(6)]: 'E' } };
    fire(part(S2)); await sleep(5);
    assert.deepEqual([b.verLog.map(v => v.n), b.verCur, b.schedule.a[dk(6)], b.rdToast && b.rdToast.act], [[1, 2], 1, 'E', '보기']);
    return res(S3, 1.2); });
  let opened2 = 0; b.rdStoryOpen = () => { opened2++; };
  b._genPrefStore({ quick: false }); await b.generate(); await sleep(40);
  assert.deepEqual([b.verLog.map(v => v.n), b.verCur, b.schedule.a[dk(6)], b.verFresh, opened2], [[1, 2, 3], 1, 'E', [3], 0]);
  assert.equal(b.getManualEditCount(), 1); assert.match(b.rdToast.msg, /3번 표가 나왔습니다/);
  // 다시 맞추기(고친 대로)·여러 개 만들기 중에는 받지 않는다
  b.generating = true; b.multi.running = true; b._verPartial(part(S2), { year: 2026, month: 12 }, false); assert.equal(b.verLog.length, 3); b.multi.running = false; b.generating = false;
  b._verPartial(part(S2), { year: 2026, month: 12 }, false); assert.equal(b.verLog.length, 3, '만드는 중이 아니면 무시');
}
console.log('test_table_history: OK');
