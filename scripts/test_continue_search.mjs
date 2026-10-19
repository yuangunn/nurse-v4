// 이어 찾기 (결정 1-50) — node scripts/test_continue_search.mjs
// 시간이 다 됐는데 차이가 목표(설정 mipGap)보다 크면 지금 표를 저장해 둔 채 그 표에서 한 번 더 찾고,
// 서버가 '같은 모델에서 감점이 더 낮다(improved)'고 한 표만 바꾼다. 목표 안이거나 사용자가 멈췄으면 더 찾지 않는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
global.EventSource = class { close() {} };
for (const f of ['undo-redo', 'drag-select', 'analysis', 'paste-import', 'profiles', 'dev-tools', 'nurse-manage',
  'settings-defs', 'solver', 'view-helpers', 'preinput-io', 'grid-interactions', 'schedule-features',
  'misc-features', 'redesign']) require(`../frontend/js/modules/${f}.js`);
const app = new Function(fs.readFileSync(new URL('../frontend/js/app.js', import.meta.url), 'utf8') + '\nreturn app;')();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S1 = { a: { '2026-11-01': 'D', '2026-11-02': 'E' } }, S2 = { a: { '2026-11-01': 'E', '2026-11-02': 'E' } };
const first = (extra = {}) => ({ success: true, schedule: S1, extended_schedule: S1, message: '근무표가 생성되었습니다.',
  mip_gap_percent: 8.7, objective: 4295, mip_dual_bound: 3920, model_fingerprint: 'f1', engine: 'HiGHS', ...extra });
const cont = (extra = {}) => ({ ...first(), schedule: S2, extended_schedule: S2, continued: true, ...extra });

function make() {
  const a = app();
  a.year = 2026; a.month = 11; a.mipGap = 0.02; a.generateTimeout = 20; a.solver = 'highs';
  a.nurses = [{ id: 'a', name: '간호01' }];
  a._autoSaveSchedule = async () => { a.rdSaved = true; };
  a.loadFairnessLedger = null;
  return a;
}
async function run(results, { during } = {}) {
  const a = make();
  const calls = [];
  a.api = async (method, path, body) => {
    if (path !== '/api/generate') return {};
    calls.push(body);
    if (during && calls.length === 2) during(a);       // 이어 찾는 동안 사용자가 한 일
    return results.shift();
  };
  await a.generate();
  await sleep(5);
  while (a.generating) await sleep(5);
  return { a, calls };
}

// ① 차이 8.7% > 목표 2% → 첫 요청 그대로 + 앞 표를 시작해로 한 번 더 — improved 면 바꾼다
{
  const { a, calls } = await run([first(), cont({ objective: 4160, mip_dual_bound: 4080, mip_gap_percent: 1.92, improved: true })]);
  assert.equal(calls.length, 2);
  const { warm_start, prev_bound, prev_fingerprint, prev_objective, ...rest } = calls[1];
  assert.deepEqual(rest, calls[0], '첫 요청 그대로');
  assert.deepEqual(warm_start, S1);
  assert.deepEqual([prev_bound, prev_fingerprint, prev_objective], [3920, 'f1', 4295]);
  assert.equal(calls[1]._cont, undefined, '내부 표지는 보내지 않는다');
  assert.deepEqual(a.schedule, S2);
  assert.equal(a.mipGapPercent, 1.92);
  assert.match(a.statusMessage, /이어 찾기로 더 좋은 표를 찾아 바꿔 저장했습니다 \(가장 좋은 답과 8\.7% → 1\.92% 차이\)/);
  assert.equal(a.continuing, false);
}
// ② improved 가 아니면 앞 표 그대로 — 같은 모델의 하한이 올랐으면 앞 표의 차이를 줄여 보여 준다
{
  const { a } = await run([first(), cont({ objective: 4300, mip_dual_bound: 3990, mip_gap_percent: 7.21, improved: false })]);
  assert.deepEqual(a.schedule, S1);
  assert.equal(a.mipGapPercent, 7.1);                     // (4295 − 3990) / 4295
  assert.match(a.statusMessage, /한 번 더 찾습니다/);
  assert.match(a.statusMessage, /이어 찾기에서 더 좋은 표는 없었습니다 — 지금 표 그대로 \(가장 좋은 답과 7\.1% 안쪽\)/);
}
//    다른 모델(지문)이면 앞 표의 차이도 그대로
{
  const { a } = await run([first(), cont({ objective: 4300, mip_dual_bound: 4200, model_fingerprint: 'f2', improved: false })]);
  assert.deepEqual(a.schedule, S1);
  assert.equal(a.mipGapPercent, 8.7);
}
// ③ 이어 찾기가 실패하거나 서버가 죽어도 앞 표 그대로
{
  const { a } = await run([first(), { success: false, message: '실패', continued: true, improved: false }]);
  assert.deepEqual(a.schedule, S1);
  assert.equal(a.statusOk, true);
  assert.match(a.statusMessage, /이어 찾기를 끝내지 못해 지금 표를 그대로 둡니다/);
}
// ④ 이어 찾는 동안 손으로 고친 칸이 있으면 더 좋은 표가 와도 고친 표를 둔다 (리뷰 2026-10-19: 고친 칸이 사라졌다)
{
  const { a } = await run([first(), cont({ objective: 4160, improved: true })],
    { during: (x) => { x.schedule = { a: { ...x.schedule.a, '2026-11-02': 'N' } }; } });
  assert.equal(a.schedule.a['2026-11-02'], 'N');
  assert.match(a.statusMessage, /손으로 고친 칸이 있어 고친 표를 그대로 둡니다 \(이어 찾기에서 나온 표는 쓰지 않았습니다\)/);
}
// ⑤ 첫 실행 중에 달·설정을 바꿔도 이어 찾기는 첫 요청 그대로 (리뷰: 12월 · 60분 · CP-SAT 에 11월 표를 썼다)
{
  const { calls } = await run([first(), cont({ improved: false })],
    { during: (x) => { x.month = 12; x.generateTimeout = 60; x.solver = 'cpsat'; } });
  assert.deepEqual([calls[1].month, calls[1].time_limit, calls[1].solver], [11, 1200, 'highs']);
}
// ⑥ 레이스는 이긴 엔진으로 잇는다 — 엔진마다 목적식이 달라 견줄 수 없다
{
  const a = make(); a.solver = 'race';
  const calls = [];
  const results = [first({ engine: 'CP-SAT', race_winner: 'CP-SAT' }), cont({ engine: 'CP-SAT', improved: false })];
  a.api = async (m, path, body) => { if (path === '/api/generate') { calls.push(body); return results.shift(); } return {}; };
  await a.generate(); await sleep(5); while (a.generating) await sleep(5);
  assert.deepEqual([calls[0].solver, calls[1].solver], ['race', 'cpsat']);
}
// ⑦ 목표 안 · 사용자가 멈춤 · 완성표 확정 → 더 찾지 않는다 (자동은 한 번뿐 — 이어 찾은 결과에서 다시 잇지 않는다)
for (const extra of [{ mip_gap_percent: 1.5 }, { stopped: true }, { pinned_confirmed: true }]) {
  const { calls } = await run([first(extra)]);
  assert.equal(calls.length, 1, JSON.stringify(extra));
}
{
  const { calls } = await run([first(), cont({ objective: 4200, mip_gap_percent: 6, improved: true })]);
  assert.equal(calls.length, 2);
}
// ⑧ 이어 찾는 동안의 상태 줄 — 앞 표는 저장돼 있고, 멈추면 그 표를 쓴다
{
  const a = app();
  a.generating = true; a.continuing = true; a.mipGapPercent = 8.7; a.estimatedSeconds = 0;
  assert.match(a.rdStatus.text, /^지금 표는 저장했어요 \(가장 좋은 답과 8\.7% 차이\) · 그 표에서 더 좋은 표를 찾는 중… .* 멈추면 지금 표를 씁니다$/);
}
// ⑨ 새로고침 복구 — 이어 찾기 결과가 improved 가 아니면 적용·자동저장하지 않는다 (리뷰: 앞 표 자동저장본을 지웠다)
{
  const a = make(); a.schedule = S1; let saved = 0;
  a._autoSaveSchedule = async () => { saved++; };
  a.api = async (m, path) => (path === '/api/generate/result' ? { status: 'done', result: cont({ objective: 4400, improved: false }) } : {});
  await a._checkPendingGenerate();
  assert.deepEqual(a.schedule, S1);
  assert.equal(saved, 0);
  assert.match(a.statusMessage, /이어 찾기에서 더 좋은 표가 없어 저장된 표를 그대로 둡니다/);
  a.api = async (m, path) => (path === '/api/generate/result' ? { status: 'done', result: cont({ objective: 4100, improved: true }) } : {});
  await a._checkPendingGenerate();
  assert.deepEqual(a.schedule, S2);
}
// ⑩ 자동저장 본문은 기다리기 전에 — 그 사이 이어 찾기가 계산 기록을 비워도 첫 표의 기록이 저장된다
{
  const a = app();
  a.year = 2026; a.month = 11; a.schedule = S1; a.solverLogs = [{ id: 1, msg: '첫 실행 기록' }];
  let posted = null;
  a.api = async (m, path, body) => {
    if (m === 'GET') { a.solverLogs = []; return []; }      // 기다리는 사이 이어 찾기가 시작됐다
    if (m === 'POST') posted = body;
    return {};
  };
  a.toast = () => {}; a.loadSavedList = () => {};
  await a._autoSaveSchedule();
  assert.equal(posted.solver_log, '첫 실행 기록');
}
console.log('test_continue_search: OK');
