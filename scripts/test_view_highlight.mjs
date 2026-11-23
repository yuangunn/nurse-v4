// 강조해서 보기 (결정 1-87) — node scripts/test_view_highlight.mjs
// 한 줄(W 근무 · N 야간 근무 · R 쉬는 날 · - 빈칸)에서 날마다 걸리는 표시와 건수
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
require('../frontend/js/modules/settings-defs.js');
const mod = window.SettingsDefsModule();
const cells = (s) => s.split(' ').map(c => (c === '-' ? '' : c));
const marks = (s, x) => mod._hlMarks(cells(s), x);
const at = (r, i) => r.out[i].slice().sort().join(',');
const where = (r, k) => r.out.map((m, i) => (m.includes(k) ? i : -1)).filter(i => i >= 0);

assert.deepEqual(mod.rdHlDefs().map(h => h[0]), ['singleN', 'night3', 'run6', 'weekendWork', 'oneOff', 'longOff', 'nightRest1', 'juhuAlone', 'longRest', 'pongdang', 'edited', 'draftDiff']);
assert.deepEqual(mod.rdHlGroups().map(g => [g.name, g.items.length]), [['근무', 4], ['휴무', 5], ['그 밖에', 3]]);

// 단독 야간 — 앞뒤가 야간이 아닌 하루. 이틀 이어지면 아니다. 줄의 맨 앞·맨 끝과 빈칸 옆은 앞뒤를 몰라 세지 않는다
{
  const r = marks('W N W N N R N - N W');
  assert.deepEqual([where(r, 'singleN'), r.count.singleN], [[1], 1]);
}
// 3일 이상 연속 야간 — 이틀은 아니다
{
  const r = marks('W N N R N N N R N N N N');
  assert.deepEqual([where(r, 'night3'), r.count.night3], [[4, 5, 6, 8, 9, 10, 11], 2]);
}
// 1오프 — 앞뒤가 근무인 하루 휴무. 이틀 쉬면 아니다
{
  const r = marks('W R W R R W N R W');
  assert.deepEqual([where(r, 'oneOff'), r.count.oneOff], [[1, 7], 2]);
}
// 긴 근무 사이 1오프 — 앞뒤 근무를 합쳐 8일 이상이면 그 근무까지 통째로. 4-1-3 은 아니다. 이어지는 묶음(5-1-5-1-4)은 1오프마다 한 건
{
  const r = marks('R W W W W R W W W W R R W W W W R W W W R');
  assert.deepEqual([where(r, 'longOff'), r.count.longOff], [[1, 2, 3, 4, 5, 6, 7, 8, 9], 1]);
  assert.equal(at(r, 16), 'oneOff', '4-1-3 은 1오프일 뿐');
  const c = marks('R W W W W W R W W W W W R W W W W R');
  assert.equal(c.count.longOff, 2); assert.equal(c.out[8].filter(k => k === 'longOff').length, 1);
}
// 6일 이상 연속 근무 — 야간도 근무. 5일은 아니다
{
  const r = marks('R W W N N W W R W W W W W R');
  assert.deepEqual([where(r, 'run6'), r.count.run6], [[1, 2, 3, 4, 5, 6], 1]);
}
// 야간 뒤 하루만 쉬고 근무 — 그 쉬는 날. 이틀 쉬면 아니다
{
  const r = marks('N R W N R R W W R W');
  assert.deepEqual([where(r, 'nightRest1'), r.count.nightRest1], [[1], 1]);
}
// 혼자인 주휴 — 앞뒤에 쉬는 날이 없는 주휴. 옆에 OFF 가 붙으면 아니다
{
  const row = 'W R W W R R W R W', juhu = [0, 1, 0, 0, 1, 0, 0, 0, 0].map(Boolean);
  const r = marks(row, { juhu });
  assert.deepEqual([where(r, 'juhuAlone'), r.count.juhuAlone], [[1], 1]);
  assert.equal(at(r, 1), 'juhuAlone,oneOff', '한 칸에 둘이 함께 걸린다');
}
// 3일 이상 휴무
{
  const r = marks('W R R W R R R W R R R R');
  assert.deepEqual([where(r, 'longRest'), r.count.longRest], [[4, 5, 6, 8, 9, 10, 11], 2]);
}
// 주말·공휴일 근무 — 일하는 칸만
{
  const r = marks('W R N W', { wk: [true, true, true, false] });
  assert.deepEqual([where(r, 'weekendWork'), r.count.weekendWork], [[0, 2], 2]);
}
// 퐁당퐁당 — 하루 근무·하루 휴무가 번갈아 나흘 이상. 사흘(W R W)이나 이틀짜리가 낀 것은 아니다
{
  const r = marks('W W R W R W R R W R W W');
  assert.deepEqual([where(r, 'pongdang'), r.count.pongdang], [[2, 3, 4, 5], 1]);
  assert.equal(marks('W W R W R R').count.pongdang, 0);
  assert.equal(marks('R W R W - R W R').count.pongdang, 1, '빈칸에서 끊긴다');
}
// 손으로 고친 칸
{
  const r = marks('W R W', { ed: [false, true, true] });
  assert.deepEqual([where(r, 'edited'), r.count.edited], [[1, 2], 2]);
}
// 칸의 클래스 — 켠 표시만. 아무것도 켜지 않으면 손대지 않고, 켰는데 해당 없으면 흐리게
{
  const row = cells('W R W W W W W W R');
  const ctx = { ...mod, viewHl: {}, _hlRow: () => ({ row, juhu: [], wk: [], ed: [] }) };
  Object.defineProperty(ctx, 'rdHlOn', { get() { return Object.values(this.viewHl).some(Boolean); } });
  assert.equal(ctx.rdCellHl({}, 1), '');
  ctx.viewHl = { oneOff: true };
  assert.equal(ctx.rdCellHl({}, 1), 'hl hl-oneOff'); assert.equal(ctx.rdCellHl({}, 3), 'hl-dim');
  ctx.viewHl = { oneOff: true, run6: true };
  assert.equal(ctx.rdCellHl({}, 3), 'hl hl-run6'); assert.equal(ctx.rdCellHl({}, 0), 'hl-dim');
  ctx.rdHlClear(); assert.equal(ctx.rdCellHl({}, 1), '');
}
console.log('test_view_highlight: OK');
