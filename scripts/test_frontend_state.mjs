// 병동 프로필 · 사전입력 자동 보관 · 늦게 온 생성 결과 (2026-10-21) — node scripts/test_frontend_state.mjs
// 병동 바꾸기는 서버가 새 비밀번호를 확인한 뒤 앞 병동을 닫는다 (프론트는 먼저 닫지 않는다). 자동 보관은 병동마다 하나 —
// 프로필 화면에선 쓰지 않는다. 만드는 동안 달이 바뀐 결과는 화면에 넣지 않고 그 달 이름으로만 저장한다.
// 저장본 불러오기는 근무표만. 이름은 가명.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const store = new Map(), unload = [], ticks = [];
const el = () => ({ style: { setProperty() {} }, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {},
  querySelector: () => null, querySelectorAll: () => [] });
global.window = { addEventListener: (t, f) => { if (t === 'beforeunload') unload.push(f); } };
// 이 달에 어떤 표를 원하는지는 이미 골랐다고 둔다 (결정 1-77) — 묻는 동작은 test_gen_pref.mjs 가 본다
global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : String(k).startsWith('ns_genpref:') ? '{"time":20}' : null), setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k) };
global.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], createElement: el, body: el(), documentElement: el() };
global.EventSource = class { close() {} };
global.getComputedStyle = () => ({ getPropertyValue: () => '' });
global.setInterval = (f, ms) => ticks.push({ f, ms });      // 30초 자동 보관·새로고침 복구 폴링은 손으로 돌린다
global.clearInterval = () => {};
let answer = true; global.confirm = () => answer;
for (const f of ['undo-redo', 'drag-select', 'analysis', 'paste-import', 'profiles', 'dev-tools', 'nurse-manage',
  'settings-defs', 'solver', 'view-helpers', 'preinput-io', 'grid-interactions', 'schedule-features',
  'misc-features', 'redesign']) require(`../frontend/js/modules/${f}.js`);
const app = new Function(fs.readFileSync(new URL('../frontend/js/app.js', import.meta.url), 'utf8') + '\nreturn app;')();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => ticks.filter((t) => t.ms === 30000).at(-1).f();   // 마지막에 연 화면의 30초 자동 보관
const SHIFTS = [['DC', 'day'], ['D', 'day'], ['EC', 'evening'], ['E', 'evening'], ['NC', 'night'], ['N', 'night'],
  ['OF', 'rest'], ['주', 'rest'], ['V', 'leave'], ['생', 'leave'], ['법', 'leave']].map(([code, period]) => ({ code, period }));

// 병동 셋 (A·B 는 비밀번호, G 는 게스트) — 서버는 열린 병동의 명부·저장본만 보여 준다
function server() {
  const db = { A: { pw: 'pa', nurses: [{ id: 'a1', name: '간호01' }, { id: 'a2', name: '간호02' }] },
    B: { pw: 'pb', nurses: [{ id: 'b1', name: '간호11' }] }, G: { guest: true, nurses: [{ id: 'g1', name: '간호21' }] } };
  for (const p of Object.values(db)) p.saved = [];
  let cur = null, nextId = 100;
  const s = { db, calls: [], result: { status: 'idle' }, gen: null, prev: null };
  s.api = async (method, path, body) => {
    s.calls.push(`${method} ${path}`);
    const p = db[cur];
    if (path === '/api/profiles') return { profiles: Object.entries(db).map(([id, x]) => ({ id, name: id, has_password: !!x.pw, is_guest: !!x.guest })), current_profile: cur };
    if (path === '/api/profiles/open') { const x = db[body.id]; if (x.pw && body.password !== x.pw) return { ok: false, error: '비밀번호가 틀렸습니다.' }; cur = body.id; return { ok: true }; }
    if (path === '/api/profiles/close') { cur = null; return { ok: true }; }
    if (path === '/api/nurses') return JSON.parse(JSON.stringify(p.nurses));
    if (path === '/api/shifts') return SHIFTS;
    if (path === '/api/requirements') return { mon: { D: 1, E: 1, N: 1 } };
    if (path === '/api/generate/result') return s.result;
    if (path === '/api/generate') return s.gen(body);
    if (path === '/api/schedules' && method === 'POST') { p.saved.push({ ...JSON.parse(JSON.stringify(body)), id: nextId++ }); return { ok: true }; }
    if (path === '/api/schedules') return p.saved.map(({ id, name, year, month }) => ({ id, name, year, month }));
    if (path.startsWith('/api/schedules/')) {
      const id = +path.split('/').pop();
      if (method === 'DELETE') { p.saved = p.saved.filter((x) => x.id !== id); return {}; }
      const x = p.saved.find((y) => y.id === id); return { id, year: x.year, month: x.month, data: x };
    }
    if (path.startsWith('/api/prev_schedules/')) return JSON.parse(JSON.stringify(s.prev));
    if (path.startsWith('/api/fairness_ledger')) return { ledger: {} };
    if (path === '/api/scoring_rules' || path === '/api/prev_schedules') return [];
    return {};
  };
  return s;
}
// 앱을 켜서(init — 창 닫기 처리기를 건다) 프로필을 고른다
async function opened(s, id, pw = '') {
  const a = app();
  a.api = s.api; a.toasts = []; a.toast = (m) => { a.toasts.push(m); return 0; };
  a.$nextTick = (f) => (f ? f() : Promise.resolve()); a.$watch = () => {};
  await a.init();
  a.profilePasswordInput = pw;
  await a.selectProfile(a.profiles.find((p) => p.id === id));
  await sleep(0);
  return a;
}
const to = (a, id, pw) => { a.profilePasswordInput = pw; return a.switchToProfile(a.profiles.find((p) => p.id === id)); };
const fresh = () => { store.clear(); ticks.length = 0; unload.length = 0; };

// ① 병동 바꾸기 — 틀린 비밀번호면 앞 병동을 닫지 않는다 (먼저 닫으면 서버 보호를 건너뛰어 빈 DB 가 병동 데이터를 덮었다). 만드는 중엔 바꾸지 않는다
{
  fresh();
  const s = server(), a = await opened(s, 'A', 'pa');
  a.prevSchedule = { a1: { '2026-11-10': 'V' } };
  s.calls.length = 0;
  await to(a, 'B', 'WRONG');
  assert.equal(a.profileError, '비밀번호가 틀렸습니다.');
  assert.deepEqual(s.calls, ['POST /api/profiles/open'], '닫기를 먼저 보내지 않는다 — 서버가 새 비밀번호를 확인한 뒤 닫는다');
  assert.equal(a.currentProfile, 'A');
  assert.deepEqual(a.prevSchedule, { a1: { '2026-11-10': 'V' } });
  a.generating = true; s.calls.length = 0;
  await to(a, 'B', 'pb');
  assert.deepEqual(s.calls, []);
  assert.match(a.profileError, /만드는 중에는 병동을 바꿀 수 없습니다/);
  a.generating = false;
}
// ② 자동 보관은 병동마다 — B 에 A 것이 깔리지 않고, A 로 돌아오면 오늘 넣은 칸(마지막 30초 자동 보관 뒤 것까지)이 그대로
{
  fresh();
  const s = server(), a = await opened(s, 'A', 'pa');
  a.year = 2026; a.month = 11;
  a.prevSchedule = { a1: { '2026-11-03': '주' } }; a.cellNotes = { a1: { '2026-11-03': '메모' } };
  a.prevDayReqs = { '2026-11-20': { D: 3 } }; a.holidays = ['2026-11-11'];
  tick();
  a.prevSchedule.a1['2026-11-10'] = 'V';
  await to(a, 'B', 'pb');
  assert.equal(a.currentProfile, 'B');
  assert.deepEqual([a.prevSchedule, a.cellNotes, a.prevDayReqs, a.holidays], [{}, {}, {}, []], 'B 에 A 의 사전입력·메모·필요 인원·공휴일');
  a.prevSchedule = { b1: { '2026-11-05': 'OF' } }; tick();
  await to(a, 'A', 'pa');
  assert.deepEqual(a.prevSchedule, { a1: { '2026-11-03': '주', '2026-11-10': 'V' } });
  assert.deepEqual([a.cellNotes, a.prevDayReqs, a.holidays], [{ a1: { '2026-11-03': '메모' } }, { '2026-11-20': { D: 3 } }, ['2026-11-11']]);
  assert.ok(!store.has('ns_full_state') && !store.has('ns_prev_autosave'), '병동 구분 없는 키는 쓰지 않는다');
}
// ③ 다시 켜면 더 새 것 — 창 닫기 없이 꺼져도 30초 자동 보관본이 열린다 (예전엔 창 닫을 때만 쓰는 낡은 것이 먼저였다)
{
  fresh();
  const s = server();
  let a = await opened(s, 'A', 'pa');
  a.year = 2026; a.month = 11; a.prevSchedule = { a1: { '2026-11-03': '주' } };
  unload.at(-1)();
  a = await opened(s, 'A', 'pa');
  a.prevSchedule.a1['2026-11-10'] = 'V'; tick();          // 그 뒤 비정상 종료
  a = await opened(s, 'A', 'pa');
  assert.deepEqual(a.prevSchedule, { a1: { '2026-11-03': '주', '2026-11-10': 'V' } });
  assert.deepEqual([a.year, a.month], [2026, 11]);
}
// ④ 프로필 고르는 화면에서 닫거나 새로고침해도 보관본을 빈 것으로 덮지 않는다
{
  fresh();
  const s = server();
  let a = await opened(s, 'A', 'pa');
  a.year = 2026; a.month = 11; a.prevSchedule = { a1: { '2026-11-10': 'V' } }; a.cellNotes = { a1: { '2026-11-10': '결혼식' } };
  unload.at(-1)();
  const b = app(); Object.assign(b, { api: s.api, toast: () => 0, $watch: () => {} });
  await b.init();
  assert.equal(b.profileScreen, true);
  unload.at(-1)();
  a = await opened(s, 'A', 'pa');
  assert.deepEqual([a.prevSchedule, a.cellNotes], [{ a1: { '2026-11-10': 'V' } }, { a1: { '2026-11-10': '결혼식' } }]);
}
// ⑤ 예전 판의 병동 구분 없는 키 — 그 사전입력의 사람이 명부에 있는 병동이 더 새 것을 한 번 이어받고 지운다.
//    게스트('종료 시 데이터 삭제')는 보관하지 않고, 지운 병동의 보관본도 지운다 (같은 ID 로 다시 만들면 깔렸다)
{
  fresh();
  const old = { y: 2026, m: 11, ps: { a1: { '2026-11-10': 'V' } }, t: Date.now() - 60000 };
  store.set('ns_prev_autosave', JSON.stringify(old));
  store.set('ns_full_state', JSON.stringify({ ...old, ps: { a1: { '2026-11-03': '주' } }, t: Date.now() - 3600000 }));
  const s = server();
  const b = await opened(s, 'B', 'pb');
  assert.deepEqual(b.prevSchedule, {}, 'B 명부엔 a1 이 없다');
  assert.ok(store.has('ns_prev_autosave'));
  const a = await opened(s, 'A', 'pa');
  assert.deepEqual(a.prevSchedule, { a1: { '2026-11-10': 'V' } }, '둘 중 더 새 것');
  assert.ok(!store.has('ns_prev_autosave') && !store.has('ns_full_state'));
  unload.at(-1)();
  assert.ok(store.has('ns_full_state:A'));
  const g = await opened(s, 'G');
  g.prevSchedule = { g1: { '2026-11-02': 'OF' } }; tick(); unload.at(-1)();
  assert.ok(![...store.keys()].some((k) => k.endsWith(':G')));
  await g.confirmDeleteProfile('A');
  assert.ok(!store.has('ns_full_state:A'));
}
// ⑥ 새로고침·창 닫기 — 만드는 중이면 프로필을 닫지 않는다 (서버 풀이가 끝나며 닫힌 프로필 자리에 빈 DB 를 만들었다)
{
  fresh();
  const s = server(), a = await opened(s, 'A', 'pa');
  a.generating = true; s.calls.length = 0;
  unload.at(-1)();
  assert.ok(!s.calls.includes('POST /api/profiles/close'));
  a.generating = false; unload.at(-1)();
  assert.ok(s.calls.includes('POST /api/profiles/close'));
}
// ⑦ 병동을 바꾸면 생성·진단·분석 결과와 고른 사람도 비운다 — B 서랍에 A 의 이름·메모, '수정안 모두 적용'이 A 의 처방을 B 에 걸었다
{
  fresh();
  const s = server(), a = await opened(s, 'A', 'pa');
  a.year = 2026; a.month = 11;
  a.statusMessage = '📌 원티드 미반영 1건\n  간호01 11/10: V → D  📝 결혼식'; a.statusOk = false;
  a.offTeukgeun = [{ name: '간호02' }]; a.managerCheck = [{ name: '간호01' }]; a.vReport = { total: 1 }; a.wishReport = { total_granted: 1 };
  a.diagResult = { anchored: [] }; a.fixResult = { removals: [], shortfalls: [{ kind: 'staff', date: '2026-11-20', code: 'D', amount: 2 }] };
  a.analysisResult = { days: [] }; a.juhuRecommendation = { assignments: { a1: [{ dk: '2026-11-03', existing: false }] } };
  a.selectedNurseMap = { a1: true }; a.multi.results = [{ label: '앞 병동의 표' }]; a.mk.open = true; a.genFirst = { schedule: {} }; a.readjustChanged = { a1: { '2026-11-02': true } };
  await to(a, 'B', 'pb');
  assert.deepEqual([a.statusMessage, a.offTeukgeun, a.managerCheck, a.vReport, a.wishReport, a.diagResult, a.fixResult, a.analysisResult,
    a.juhuRecommendation, a.selectedNurseMap, a.multi.results, a.readjustChanged], ['', [], [], null, null, null, null, null, null, {}, [], {}]);
  assert.equal(a.mk.open, false); assert.equal(a.genFirst, null, '처음 표(초안)도 앞 병동의 것');
  a.applyFix(); a.applyRecommendedJuhu();
  assert.deepEqual([a.prevDayReqs, a.prevSchedule], [{}, {}]);
}
// ⑧ 만드는 동안 달을 바꾸면 — 그 화면엔 넣지 않고 만든 달 이름으로만 저장 (12월 자동저장본을 지우고 11월 표를 12월로 저장했다)
{
  fresh();
  const s = server(), a = await opened(s, 'A', 'pa');
  a.year = 2026; a.month = 11;
  s.db.A.saved.push({ id: 7, name: '자동저장 2026-12', year: 2026, month: 12, schedule: { a1: { '2026-12-01': 'N' } } });
  let release; s.gen = () => new Promise((r) => { release = r; });
  const run = a.generate();
  await sleep(0); a.nextMonth();
  const S = { a1: { '2026-11-02': 'D' } };
  release({ success: true, schedule: S, extended_schedule: S, message: '근무표가 생성되었습니다.', mip_gap_percent: 1, relaxed_cells: {} });
  assert.equal(await run, false);
  await sleep(5);
  assert.deepEqual(a.schedule, {}, '12월 화면에 11월 표');
  assert.deepEqual(s.db.A.saved.map((x) => [x.name, x.year, x.month]), [['자동저장 2026-12', 2026, 12], ['자동저장 2026-11', 2026, 11]]);
  assert.deepEqual(s.db.A.saved[1].schedule, S);
  assert.match(a.toasts.join('\n'), /2026년 11월 근무표.*화면에 넣지 않고/);
  assert.equal(a.rdSaved, false);
}
// ⑨ 새로고침 복구 — 다른 달·다른 병동의 마지막 결과는 깔지 않는다 (서버가 결과에 year·month·profile_id 를 싣는다).
//    만드는 중에 새로고침했고 끝난 결과가 다른 달이면 그 달 이름으로만 저장
{
  fresh();
  const s = server(), S = { a1: { '2026-11-02': 'D' } };
  const done = (extra) => ({ status: 'done', result: { success: true, schedule: S, extended_schedule: S, message: '생성', year: 2026, month: 11, profile_id: 'A', ...extra } });
  let a = await opened(s, 'A', 'pa');
  a.year = 2026; a.month = 12;
  s.result = done(); await a._checkPendingGenerate();
  assert.deepEqual(a.schedule, {}, '12월 화면에 11월 결과');
  a.month = 11; s.result = done({ profile_id: 'B' }); await a._checkPendingGenerate();
  assert.deepEqual(a.schedule, {}, '다른 병동 결과');
  s.result = done(); await a._checkPendingGenerate();
  assert.deepEqual(a.schedule, S);
  s.result = { status: 'idle' };
  a = await opened(s, 'A', 'pa');
  a.year = 2026; a.month = 12;
  s.result = { status: 'running' }; await a._checkPendingGenerate();
  s.result = done(); await ticks.filter((t) => t.ms === 2000).at(-1).f(); await sleep(5);
  assert.deepEqual(a.schedule, {});
  assert.equal(a.generating, false);
  assert.deepEqual(s.db.A.saved.map((x) => x.name), ['자동저장 2026-11']);
}
// ⑩ 저장본 불러오기는 근무표만 — 명부·규칙·사전입력(모든 달)·메모·필요 인원은 지금 것 그대로 (9월 표를 보면 11월 사전입력이 사라지고 9월 명부로 생성됐다)
{
  fresh();
  const s = server(), a = await opened(s, 'A', 'pa');
  a.year = 2026; a.month = 11; a.nurses[0].is_pregnant = true;
  a.prevSchedule = { a1: { '2026-11-02': '주', '2026-11-03': 'V' } }; a.cellNotes = { a1: { '2026-11-03': '결혼식' } };
  a.prevDayReqs = { '2026-11-20': { D: 3 } }; a.rules.maxNightPerMonthCount = 6;
  const RX = { a1: { '2026-09-07': { original: '주', assigned: 'D' } } };
  s.db.A.saved.push({ id: 9, name: '9월', year: 2026, month: 9, schedule: { a1: { '2026-09-07': 'D' }, a9: { '2026-09-07': 'N' } },
    nurses: [{ id: 'a1', name: '간호01' }, { id: 'a9', name: '간호09' }], prev_schedule: { a1: { '2026-09-07': '주' } }, cell_notes: {},
    prev_day_reqs: {}, rules: { maxNightPerMonthCount: 9 }, relaxed_cells: RX, solver_log: '첫 줄\n둘째 줄\n셋째 줄' });
  a._logSeq = 1; a._scrollLogs = () => {};                 // 만드는 중이라 기록 줄이 들어오고 있었다
  await a.loadSaved(9);
  a._pushLog('그 뒤에 온 줄');                              // 저장본의 줄 번호 뒤를 잇는다 — 같은 번호면 목록의 키가 겹쳐 화면이 깨졌다
  assert.equal(new Set(a.solverLogs.map((l) => l.id)).size, a.solverLogs.length);
  assert.deepEqual([a.year, a.month, a.schedule.a1], [2026, 9, { '2026-09-07': 'D' }]);
  assert.deepEqual([a.nurses.map((n) => n.id), a.nurses[0].is_pregnant], [['a1', 'a2'], true]);
  assert.deepEqual(a.prevSchedule, { a1: { '2026-11-02': '주', '2026-11-03': 'V' } });
  assert.deepEqual([a.cellNotes, a.prevDayReqs, a.rules.maxNightPerMonthCount], [{ a1: { '2026-11-03': '결혼식' } }, { '2026-11-20': { D: 3 } }, 6]);
  assert.deepEqual(a.relaxedCells, RX);
  assert.match(a.toasts.at(-1), /1명은 지금 명부에 없어/);
  // 불러왔음을 알린다 — 이름이 든 알림 + 목록에서 그 줄을 가리킬 id (결정 1-88)
  assert.ok(a.toasts.some((m) => /‘9월’를 불러왔습니다/.test(m)), a.toasts.join(' | ')); assert.equal(a.loadedSavedId, 9);
}
// ⑪ 주휴 채우기 — 1일 앞 지난달 칸(기록)은 두고, '매주 같은 요일'은 다른 값(V 등)을 덮기 전에 묻는다
{
  const a = app(); a.toast = () => 0;
  a.year = 2026; a.month = 11; a.shifts = SHIFTS; a.holidays = []; a.nurses = [{ id: 'a1', name: '간호01' }];
  a.prevSchedule = { a1: { '2026-10-27': 'N', '2026-11-10': 'V' } };
  const day = new Date(2026, 10, 3);                          // 11/3(화) — 11월 화면은 10/25 부터
  answer = false; a.autoFillJuhuFixed(a.nurses[0], day);
  assert.deepEqual(a.prevSchedule.a1, { '2026-10-27': 'N', '2026-11-10': 'V' });
  answer = true; a.autoFillJuhuFixed(a.nurses[0], day);
  assert.equal(a.prevSchedule.a1['2026-10-27'], 'N', '지난달 기록 칸');
  assert.deepEqual(['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01'].map((k) => a.prevSchedule.a1[k]), ['주', '주', '주', '주', '주']);
  a.prevSchedule = { a1: { '2026-10-27': 'N' } };
  let asked = ''; global.confirm = (m) => { asked = m; return true; };
  a.autoFillJuhu(a.nurses[0], day);
  global.confirm = () => answer;
  assert.deepEqual(Object.keys(a.prevSchedule.a1).filter((k) => k < '2026-11-01'), ['2026-10-27']);
  assert.equal(a.prevSchedule.a1['2026-10-27'], 'N');
  assert.match(asked, /11\/3\(화\)/); assert.doesNotMatch(asked, /: 10\//);
}
// ⑫ 사전입력 보관본 불러오기 — 모든 달을 바꾸므로 Ctrl+Z 로 불러오기 바로 앞 상태가 돌아온다
{
  fresh();
  const s = server(), a = await opened(s, 'A', 'pa');
  a.year = 2026; a.month = 12;
  a.prevSchedule = { a1: { '2026-12-15': 'V', '2026-12-16': 'V' } }; a.cellNotes = { a1: { '2026-12-16': '가족 행사' } };
  s.prev = { year: 2026, month: 11, data: { schedule: { a1: { '2026-11-03': '주' } }, cell_notes: {} } };
  await a.loadPrevFromServer(1);
  assert.deepEqual(a.prevSchedule, { a1: { '2026-11-03': '주' } });
  a.undo();
  assert.deepEqual([a.prevSchedule, a.cellNotes], [{ a1: { '2026-12-15': 'V', '2026-12-16': 'V' } }, { a1: { '2026-12-16': '가족 행사' } }]);
}
// ⑬ 사전입력을 한꺼번에 바꾸면 신호등·인원 경고를 다시 판정한다 (예전엔 다음 편집 전까지 '만들 수 있어요'가 남았다)
{
  fresh();
  const s = server(), a = await opened(s, 'A', 'pa');
  a.year = 2026; a.month = 11;
  s.prev = { year: 2026, month: 11, data: { schedule: { a1: { '2026-11-05': 'OF' } } } };
  s.db.A.saved.push({ id: 31, name: '10월', year: 2026, month: 10, schedule: { a1: { '2026-10-30': 'N' } } });
  let n = 0; a._checkViolations = () => { n++; };
  const nurse = a.nurses[0], day = new Date(2026, 10, 3);
  for (const [name, f] of Object.entries({
    fillJuhuSingle: () => a.fillJuhuSingle(nurse, day), autoFillJuhuFixed: () => a.autoFillJuhuFixed(nurse, day),
    autoFillJuhu: () => a.autoFillJuhu(nurse, day), markHoliday: () => a.markHoliday(day),
    applyRecommendedJuhu: () => { a.juhuRecommendation = { assignments: { a2: [{ dk: '2026-11-04', existing: false }] } }; a.applyRecommendedJuhu(); },
    loadPrevFromServer: () => a.loadPrevFromServer(1), loadPrevMonthSchedule: () => a.loadPrevMonthSchedule(),
    clearPrevSchedule: () => a.clearPrevSchedule(true),
  })) { n = 0; await f(); assert.ok(n > 0, name); }
}
// ⑭ 고친 대로 다시 맞추기 — 따라 고친 칸은 '원티드 미반영'이 아니다. 사람이 넣은 원티드를 못 지킨 칸만, 원래 값도 원티드로
//    ('되돌려서 잠금'이 솔버 값을 잠긴 원티드로 넣었다)
{
  fresh();
  const s = server(), a = await opened(s, 'A', 'pa');
  a.year = 2026; a.month = 11;
  a.prevSchedule = { a1: { '2026-11-10': 'V' } };
  a.schedule = { a1: { '2026-11-02': 'D', '2026-11-10': 'V' }, a2: { '2026-11-02': 'E', '2026-11-10': 'D' } };
  a.trackEdits(); a.schedule.a1['2026-11-02'] = 'E';          // 한 칸 고침
  s.gen = () => ({ success: true, message: '생성', schedule: { a1: { '2026-11-02': 'E', '2026-11-10': 'D' }, a2: { '2026-11-02': 'D', '2026-11-10': 'V' } },
    extended_schedule: {}, relaxed_cells: { a1: { '2026-11-10': { original: 'V', assigned: 'D' } },
      a2: { '2026-11-02': { original: 'E', assigned: 'D' }, '2026-11-10': { original: 'D', assigned: 'V' } } } });
  await a.readjustSchedule(); await sleep(5);
  assert.deepEqual(a.relaxedCells, { a1: { '2026-11-10': { original: 'V', assigned: 'D' } } });
  assert.match(a.statusMessage, /원티드 미반영 1건/);
  assert.deepEqual(s.db.A.saved.at(-1).relaxed_cells, a.relaxedCells);
  // 다시 맞춘 표는 그 달 자동저장본(만든 표)을 덮지 않고 따로 저장하고, 누르기 직전의 표로 되돌릴 수 있다 — 고친 칸 표시도 돌아온다 (결정 1-119)
  assert.equal(s.db.A.saved.at(-1).name, '자동저장 2026-11 · 다시 맞춘 표');
  assert.equal(a.schedule.a2['2026-11-10'], 'V'); assert.ok(a.readjustUndo);
  // 표 기록에 번호로 남는다 (결정 1-120) — 고치기 전 · 손으로 고친 표 · 다시 맞춘 표. 앞 번호를 열면 그 표가 나온다
  assert.deepEqual(a.verLog.map(v => [v.n, v.kind]), [[1, 'base'], [2, 'edit'], [3, 'readjust']]); assert.equal(a.verCur, 3);
  assert.deepEqual(a.verLog.map(v => a.verChipName(v)), ['1번 · 고치기 전', '2번 · 손으로 고침', '3번 · 다시 맞춤 · 최신']);
  assert.equal(a.verLog[0].result.schedule.a1['2026-11-02'], 'D'); assert.equal(a.verLog[1].result.schedule.a1['2026-11-02'], 'E');
  a.readjustRevert(); assert.equal(a.verCur, 2);
  assert.deepEqual(a.schedule, { a1: { '2026-11-02': 'E', '2026-11-10': 'V' }, a2: { '2026-11-02': 'E', '2026-11-10': 'D' } });
  assert.equal(a.getManualEditCount(), 1); assert.equal(a.readjustUndo, null); assert.equal(a.readjustSummary, '');
  // 엔진이 맞추는 표를 찾지 못해 보낸 표를 그대로 확정해 돌려주면(pinned_confirmed) '재조정 완료'가 아니다 — 못 맞췄다고 알리고 요약을 남기지 않는다 (결정 1-118)
  a.trackEdits(); a.schedule.a1['2026-11-02'] = 'D';
  s.gen = () => ({ success: true, pinned_confirmed: true, message: '그대로 확정', schedule: JSON.parse(JSON.stringify(a.schedule)), extended_schedule: {}, relaxed_cells: {} });
  await a.readjustSchedule(); await sleep(5);
  assert.equal(a.readjustSummary, ''); assert.equal(a.statusOk, false); assert.match(a.statusMessage, /다시 맞추지 못했습니다/);
}
// 왜 안 되는지 창 — 따로 풀어야 하는 막힌 곳마다 한 묶음, 줄마다 갈 칸. 묶음이 없으면 충돌 목록 하나로
{
  const a = app();
  a.diagResult = { muses: [['가 V 한도'], ['12/18 N 필요 인원 3명', '나 N→E 금지']], conflicts: ['가 V 한도', '12/18 N 필요 인원 3명', '나 N→E 금지'],
    anchored: [{ label: '가 V 한도', nurse_id: 'a1', date: null }, { label: '12/18 N 필요 인원 3명', nurse_id: null, date: '2026-12-18' }] };
  assert.deepEqual(a.diagGroups().map((g) => g.map((x) => [x.label, x.nurse_id, x.date])),
    [[['가 V 한도', 'a1', null]], [['12/18 N 필요 인원 3명', null, '2026-12-18'], ['나 N→E 금지', null, null]]]);
  a.diagResult = { conflicts: ['x', 'y'] }; assert.deepEqual(a.diagGroups().map((g) => g.map((x) => x.label)), [['x', 'y']]);
  a.diagResult = { conflicts: [], message: '충돌 없음' }; assert.deepEqual(a.diagGroups(), []);
  a.diagResult = null; assert.deepEqual(a.diagGroups(), []);
}
// 병동이 닫혔다 — 연 병동을 머리줄(X-Profile)로 보내고, 서버가 profile_closed 로 거절하면 화면을 막는다 (서버가 다시 시작되면
// 병동이 닫히는데, 모르고 기본 DB 의 다른 명부를 받아 사전입력·근무표가 빈 것처럼 보였다)
{
  const a = app(); const calls = [];
  Object.assign(a, { currentProfile: '병동 A', profileScreen: false, toast: () => 0 });
  let reply = { ok: true, status: 200, json: async () => ({ v: 1 }), text: async () => '' };
  const keep = global.fetch; global.fetch = async (url, opts) => { calls.push([url, opts.headers['X-Profile']]); return reply; };
  assert.deepEqual(await a.api('GET', '/api/nurses'), { v: 1 });
  assert.deepEqual(calls.at(-1), ['/api/nurses', encodeURIComponent('병동 A')]);
  await a.api('GET', '/api/profiles'); assert.equal(calls.at(-1)[1], undefined);                 // 병동 고르기 요청에는 붙이지 않는다
  a.profileScreen = true; await a.api('GET', '/api/nurses'); assert.equal(calls.at(-1)[1], undefined); a.profileScreen = false;
  reply = { ok: false, status: 409, text: async () => '{"code":"profile_closed","detail":"닫혀 있습니다"}' };
  await assert.rejects(a.api('GET', '/api/nurses'), /병동\(프로필\)이 닫혀 있습니다/);
  assert.equal(a.profileLost, true);
  a.profileLost = false; reply = { ok: false, status: 409, text: async () => '{"detail":"이미 생성 중"}' };   // 다른 409 는 그대로
  await assert.rejects(a.api('POST', '/api/generate', {}), /이미 생성 중/);
  assert.equal(a.profileLost, false);
  // 다시 열기 — 비밀번호가 없으면 그 자리에서 열고 막힘을 푼다
  a.profileLost = true; a.hasMasterPassword = false; const sent = [];
  a._loadProfiles = async () => { a.profiles = [{ id: '병동 A', has_password: false }]; a.currentProfile = null; };   // 서버는 닫혀 있어 null 을 준다
  a.api = async (m, u, body) => { sent.push([m, u, body]); return u === '/api/profiles/open' ? { ok: true } : []; };
  await a.reopenProfile();
  assert.deepEqual(sent[0], ['POST', '/api/profiles/open', { id: '병동 A', password: '' }]);
  assert.deepEqual([a.profileLost, a.currentProfile], [false, '병동 A']);
  global.fetch = keep;
}
// 완화에서 못 바꾸는 칸 — 잠근 칸 · 주휴(주휴 이동을 안 켰으면) · 지난달 칸. 완화 실패의 진단·인원 셈이 이 칸만 본다
{
  const a = app();
  Object.assign(a, { year: 2026, month: 12, allowJuhuRelax: false, lockedCells: { a1: { '2026-12-18': true } },
    prevSchedule: { a1: { '2026-11-30': 'N', '2026-12-07': '주', '2026-12-18': 'N제외', '2026-12-31': 'OF' }, a2: { '2026-12-31': 'V' } } });
  assert.deepEqual(a._relaxHardPrev(), { a1: { '2026-11-30': 'N', '2026-12-07': '주', '2026-12-18': 'N제외' } });
  a.allowJuhuRelax = true;
  assert.deepEqual(a._relaxHardPrev(), { a1: { '2026-11-30': 'N', '2026-12-18': 'N제외' } });
  // 인원 여유 — 완화 기준이면 잠그지 않은 쉬는 칸은 '나올 수 있는 사람'
  Object.assign(a, { allowJuhuRelax: false, shifts: [{ code: 'OF', period: 'rest' }, { code: 'V', period: 'leave' }, { code: '주', period: 'rest' }, { code: 'D', period: 'day' }],
    nurses: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], requirements: { thu: { D: 1, E: 1, N: 1 } }, prevDayReqs: {},
    isTraineeInTraining: () => false,
    prevSchedule: { a1: { '2026-12-31': 'OF' }, a2: { '2026-12-31': 'V' } }, lockedCells: { a2: { '2026-12-31': true } } });
  const at = (r) => r.find((x) => x.dk === '2026-12-31');       // 목요일만 필요 인원을 줬다 — 다른 날은 건너뛴다
  assert.deepEqual(at(a._staffingSlack(false).short), { dk: '2026-12-31', needed: 3, avail: 1 });
  assert.deepEqual(at(a._staffingSlack(true).short), { dk: '2026-12-31', needed: 3, avail: 2 });   // 잠근 V 만 못 나온다
  a.lockedCells = {};
  assert.equal(at(a._staffingSlack(true).short), undefined);
  assert.deepEqual(at(a._staffingSlack(true).tight), { dk: '2026-12-31', needed: 3, avail: 3 });
}
// 근무 성향 (결정 1-70) — 간호사 창에서 시간대마다 선호·기피·한 달 최대. 보통·제한 없음은 저장하지 않는다
{
  const a = app();
  a.nurses = [];
  a.openNurseModal({ id: 'a1', name: '간호01', capable_shifts: ['D', 'E', 'N'] });          // 옛 간호사 — shift_prefs 없음
  assert.deepEqual(a.nurseModal.data.shift_prefs, {});
  a.setNursePref('N', 'like'); a.setNursePrefMax('N', '3'); a.setNursePref('E', 'avoid'); a.setNursePrefMax('D', '40');
  assert.deepEqual(a.nurseModal.data.shift_prefs, { N: { pref: 'like', max: 3 }, E: { pref: 'avoid' }, D: { max: 31 } });
  assert.deepEqual([a.nursePref('N').pref, a.nursePref('N').max, a.nursePref('X').max], ['like', 3, undefined]);
  a.setNursePref('N', ''); a.setNursePrefMax('N', ''); a.setNursePref('E', ''); a.setNursePrefMax('D', 'abc');
  assert.deepEqual(a.nurseModal.data.shift_prefs, {});
  a.setNursePrefMax('N', '0'); assert.deepEqual(a.nurseModal.data.shift_prefs, { N: { max: 0 } });   // 0 은 '한 번도'
}
// 처음 시작 안내 (결정 1-71) — 예시 명부가 든 새 병동에서만 저절로 뜨고, 끝낸 단계는 자료로 판정한다
{
  fresh();
  const a = app();
  Object.assign(a, { currentProfile: 'w1', profileScreen: false, year: 2026, month: 12, savedSchedules: [], prevSchedule: {},
    nurses: [{ id: 'g1', name: '간호01' }] });
  assert.equal(a.onbCheck(), false);                               // 쓰던 병동(예시 명부 없음)에는 띄우지 않는다
  assert.equal(a.rdOnbActive, false);
  a.nurses = [{ id: 'a0', name: '*예시01' }, { id: 'a1', name: '*예시02' }];
  assert.equal(a.onbCheck(), true);
  assert.deepEqual([a.onb.open, a.rdOnbActive], [true, true]);
  assert.deepEqual(a.rdOnbSteps.map((s) => [s.id, s.done]), [['seed', false], ['last', false], ['pre', false], ['roster', false], ['req', false], ['make', false]]);
  assert.equal(a.rdOnbSteps[1].title, '11월 근무표 붙여넣기');
  assert.equal(a.rdOnbNext, 0);
  // 예시 명부 지우기 — 서버에서 지우고 명부를 다시 읽는다
  const gone = [];
  a.api = async (m, u) => { gone.push(`${m} ${u}`); return {}; };
  a.loadNurses = async () => { a.nurses = []; };
  await a.rdOnbDo('seed');
  assert.deepEqual(gone, ['DELETE /api/nurses/a0', 'DELETE /api/nurses/a1']);
  assert.deepEqual(a.rdOnbSteps.slice(0, 2).map((s) => [s.id, s.done]), [['seed', true], ['last', false]]);
  // 붙여넣기 단계 — 창을 닫고 붙여넣기 창을 연다, 붙여넣기 창이 닫히면 안내로 돌아온다
  a.openPastePrev = (target) => { a.pastePrev = { open: true, target: target || 'prev' }; };
  await a.rdOnbDo('last');
  assert.deepEqual([a.onb.open, a.onb.wait, a.pastePrev.target, a.activeTab], [false, 'last', 'saved', 'schedule']);
  a.rdOnbBack(); assert.equal(a.onb.open, false);                  // 아직 붙여넣기 창이 열려 있다
  a.pastePrev.open = false; a.savedSchedules = [{ id: 1, year: 2026, month: 11 }];
  a.rdOnbBack(); assert.deepEqual([a.onb.open, a.onb.wait], [true, '']);
  assert.equal(a.rdOnbSteps[1].done, true);
  // 건너뛰기·확인했어요는 병동마다 적어 둔다 — 자료가 생기면 건너뜀 표시는 사라진다
  a.onbSet('pre', 'skip'); assert.deepEqual([a.rdOnbSteps[2].done, a.rdOnbSteps[2].skipped], [true, true]);
  a.nurses = [{ id: 'g1', name: '간호01' }]; a.prevSchedule = { g1: { '2026-12-10': 'OF' } };
  assert.deepEqual([a.rdOnbSteps[2].done, a.rdOnbSteps[2].skipped], [true, false]);
  a.onbSet('roster', 1); a.onbSet('req', 1);
  assert.equal(a.rdOnbSteps[a.rdOnbNext].id, 'make');
  assert.equal(JSON.parse(store.get('ns_onb:w1')).roster, 1);
  a.currentProfile = 'w2'; assert.equal(a.rdOnbActive, false);    // 다른 병동은 따로
  a.currentProfile = 'w1'; a.onbSet('done', 1); assert.equal(a.rdOnbActive, false);
  assert.equal(a.onbCheck(), false);
  a.onbStart(); assert.deepEqual([a.rdOnbActive, a.onb.open], [true, true]);   // 도움말에서 다시 열기
}
console.log('test_frontend_state: OK');
process.exit(0);
