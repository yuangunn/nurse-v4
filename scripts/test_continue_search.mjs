// 이어 찾기 (결정 1-50) — node scripts/test_continue_search.mjs
// 시간이 다 됐는데 차이가 목표(설정 mipGap)보다 크면 지금 표를 저장해 둔 채 그 표에서 한 번 더 찾고,
// 더 좋은 표(감점 점수가 낮은 표)가 나올 때만 바꾼다. 목표 안이거나 사용자가 멈췄으면 더 찾지 않는다.
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

const S1 = { a: { '2026-11-01': 'D' } }, S2 = { a: { '2026-11-01': 'E' } };
const first = (extra = {}) => ({ success: true, schedule: S1, extended_schedule: S1, message: '근무표가 생성되었습니다.',
  mip_gap_percent: 8.7, objective: 4295, mip_dual_bound: 3920, model_fingerprint: 'f1', engine: 'HiGHS', ...extra });

async function run(results) {
  const a = app();
  a.year = 2026; a.month = 11; a.mipGap = 0.02;
  a.nurses = [{ id: 'a', name: '간호01' }];
  const calls = [];
  a.api = async (method, path, body) => {
    if (path === '/api/generate') { calls.push(body); return results.shift(); }
    return {};
  };
  a._autoSaveSchedule = async () => { a.rdSaved = true; };
  a.loadFairnessLedger = null;
  await a.generate();
  await sleep(5);
  while (a.generating) await sleep(5);
  return { a, calls };
}

// ① 차이 8.7% > 목표 2% → 그 표에서 한 번 더 — 더 좋은 표면 바꾼다
{
  const { a, calls } = await run([first(), { ...first(), schedule: S2, extended_schedule: S2, objective: 4160,
    mip_dual_bound: 4080, mip_gap_percent: 1.92 }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].warm_start, S1);
  assert.equal(calls[1].prev_bound, 3920);
  assert.equal(calls[1].prev_fingerprint, 'f1');
  assert.equal(calls[1]._cont, undefined, '내부 표지는 보내지 않는다');
  assert.deepEqual(a.schedule, S2);
  assert.equal(a.mipGapPercent, 1.92);
  assert.match(a.statusMessage, /이어 찾기로 더 좋은 표를 찾아 바꿔 저장했습니다 \(가장 좋은 답과 8\.7% → 1\.92% 차이\)/);
  assert.equal(a.continuing, false);
}
// ② 더 좋은 표가 아니면 앞 표 그대로 — 같은 모델의 하한이 올랐으면 앞 표의 차이를 줄여 보여 준다
{
  const { a, calls } = await run([first(), { ...first(), schedule: S2, extended_schedule: S2, objective: 4300,
    mip_dual_bound: 3990, mip_gap_percent: 7.21 }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(a.schedule, S1);
  assert.equal(a.mipGapPercent, 7.1);                     // (4295 − 3990) / 4295
  assert.match(a.statusMessage, /한 번 더 찾습니다/);
  assert.match(a.statusMessage, /이어 찾기에서 더 좋은 표는 없었습니다 — 지금 표 그대로 \(가장 좋은 답과 7\.1% 안쪽\)/);
}
// ③ 이어 찾기가 실패해도 앞 표 그대로
{
  const { a } = await run([first(), { success: false, message: '실패' }]);
  assert.deepEqual(a.schedule, S1);
  assert.equal(a.statusOk, true);
  assert.match(a.statusMessage, /이어 찾기를 끝내지 못해 지금 표를 그대로 둡니다/);
}
// ④ 목표 안 · 사용자가 멈춤 · 완성표 확정 → 더 찾지 않는다 (자동은 한 번뿐 — 이어 찾은 결과에서 다시 잇지 않는다)
for (const extra of [{ mip_gap_percent: 1.5 }, { stopped: true }, { pinned_confirmed: true }]) {
  const { calls } = await run([first(extra)]);
  assert.equal(calls.length, 1, JSON.stringify(extra));
}
{
  const { calls } = await run([first(), first({ objective: 4200, mip_gap_percent: 6 })]);
  assert.equal(calls.length, 2);
}
// ⑤ 이어 찾는 동안의 상태 줄 — 앞 표는 저장돼 있고, 멈추면 그 표를 쓴다
{
  const a = app();
  a.generating = true; a.continuing = true; a.mipGapPercent = 8.7; a.estimatedSeconds = 0;
  assert.match(a.rdStatus.text, /^지금 표는 저장했어요 \(가장 좋은 답과 8\.7% 차이\) · 그 표에서 더 좋은 표를 찾는 중… .* 멈추면 지금 표를 씁니다$/);
}
console.log('test_continue_search: OK');
