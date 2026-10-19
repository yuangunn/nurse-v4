// 명부에서 여러 명 고르기 · 함께 옮기기 · 한 번에 고치기 (2026-10-19) — node scripts/test_roster_bulk.mjs
// 체크 칸을 끌면 지나간 줄을 첫 줄과 같은 상태로, Shift+누르기는 범위. 고른 사람을 끌면 함께 옮긴다.
// 할 수 있는 근무 칩은 모두 켜져 있으면 모두 끄고 아니면 모두 켠다. 이름은 가명.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
for (const f of ['undo-redo', 'drag-select', 'analysis', 'paste-import', 'profiles', 'dev-tools', 'nurse-manage',
  'settings-defs', 'solver', 'view-helpers', 'preinput-io', 'grid-interactions', 'schedule-features',
  'misc-features', 'redesign']) require(`../frontend/js/modules/${f}.js`);
const app = new Function(fs.readFileSync(new URL('../frontend/js/app.js', import.meta.url), 'utf8') + '\nreturn app;')();

function make() {
  const a = app();
  a.nurses = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, name: `간호0${i + 1}`, capable_shifts: ['D', 'E', 'N'] }));
  a.posts = [];
  a.api = async (method, path, body) => { a.posts.push([path, JSON.parse(JSON.stringify(body))]); return {}; };
  a.toasts = []; a.toast = (m) => a.toasts.push(m);
  return a;
}
const down = (o = {}) => ({ button: 0, shiftKey: false, preventDefault() {}, ...o });
const picked = (a) => a.nurses.filter((n) => a.selectedNurseMap[n.id]).map((n) => n.id).join('');
const order = (a) => a.nurses.map((n) => n.id).join('');

// ① 끌어 고르기 — 지나간 줄을 켜고, 되돌아오면 줄어든다. 고른 줄에서 시작하면 끄며 끈다.
{
  const a = make();
  a.rosterSelDown(0, down()); a.rosterSelOver(2);
  assert.equal(picked(a), 'abc');
  a.rosterSelOver(1);
  assert.equal(picked(a), 'ab', '되돌아오면 줄어든다');
  a._rosterPaint = null;                                     // 놓기 (app.js mouseup)
  a.rosterSelOver(4);
  assert.equal(picked(a), 'ab', '놓은 뒤에는 지나가도 그대로');
  a.rosterSelDown(3, down()); a.rosterSelOver(4); a._rosterPaint = null;
  assert.equal(picked(a), 'abde', '앞서 고른 사람은 두고 더한다');
  a.rosterSelDown(1, down()); a.rosterSelOver(0); a._rosterPaint = null;
  assert.equal(picked(a), 'de', '고른 줄에서 시작하면 끈다');
}
// ② Shift+누르기 — 앞서 누른 줄부터 여기까지 켠다 (기준은 사람으로 기억 — 순서가 바뀌어도 그 사람)
{
  const a = make();
  a.rosterSelDown(1, down()); a._rosterPaint = null;
  a.rosterSelDown(3, down({ shiftKey: true })); a._rosterPaint = null;
  assert.equal(picked(a), 'bcd');
  a.nurses.reverse();                                        // e d c b a
  a.selectedNurseMap = {};
  a.rosterSelDown(4, down({ shiftKey: true })); a._rosterPaint = null;
  assert.equal(picked(a), 'ba', '기준 b 는 이제 3번째 줄');
}
// ③ 고른 사람을 끌면 함께 — 아래로는 놓은 줄 뒤에, 위로는 앞에, 지금 순서대로. 서버에 새 순서 저장.
{
  const a = make();
  a.selectedNurseMap = { b: true, d: true };
  a.onNurseDragStart(1); a.onNurseDragOver(4, { preventDefault() {} });
  assert.equal(a.rdDropCls(4), 'drop-after');
  a.onNurseDrop(4);
  assert.equal(order(a), 'acebd');
  assert.deepEqual(a.posts.at(-1), ['/api/nurses/reorder', { order: ['a', 'c', 'e', 'b', 'd'] }]);
  assert.match(a.toasts.at(-1), /2명 순서를 함께 옮겼어요/);
  a.onNurseDragStart(4); a.onNurseDrop(0);                   // d 를 맨 위로 → b d 가 함께
  assert.equal(order(a), 'bdace');
  a.onNurseDragStart(0); a.onNurseDrop(1);                   // 고른 사람 위에 놓으면 그대로
  assert.equal(order(a), 'bdace');
  assert.equal(a._dragNurseIdx, null); assert.equal(a.rdDropCls(1), '');
}
//    끈 사람이 골라져 있지 않으면 그 사람만 (예전과 같다)
{
  const a = make();
  a.selectedNurseMap = { b: true, d: true };
  a.onNurseDragStart(0); a.onNurseDrop(2);
  assert.equal(order(a), 'bcade');
  a.onNurseDragStart(4); a.onNurseDrop(0);
  assert.equal(order(a), 'ebcad');
}
// ④ 할 수 있는 근무 — 모두 켜짐 → 모두 끔, 일부·없음 → 모두 켬. 바꿀 사람만 저장, 고른 상태는 둔다.
{
  const a = make();
  a.nurses[2].capable_shifts = ['D', 'E'];                   // c 만 N 이 없다
  a.selectedNurseMap = { b: true, c: true };
  assert.deepEqual(['D', 'N', 'NC'].map((s) => a.bulkShiftState(s)), ['', 'some', 'off']);
  await a.bulkToggleShift('N');
  assert.deepEqual(a.nurses[2].capable_shifts, ['D', 'E', 'N']);
  assert.equal(a.posts.length, 1, 'b 는 이미 켜져 있어 저장하지 않는다');
  await a.bulkToggleShift('D');
  assert.deepEqual([a.nurses[1].capable_shifts, a.nurses[2].capable_shifts], [['E', 'N'], ['E', 'N']]);
  assert.deepEqual(a.nurses[0].capable_shifts, ['D', 'E', 'N'], '고르지 않은 사람은 그대로');
  assert.equal(picked(a), 'bc');
  assert.match(a.toasts.at(-1), /2명 D 끔/);
}
console.log('test_roster_bulk: OK');
