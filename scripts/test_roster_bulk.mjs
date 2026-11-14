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
  assert.deepEqual(a.posts.at(-1), ['/api/nurses/reorder', { ids: ['a', 'c', 'e', 'b', 'd'] }], '서버는 ids 를 읽는다');
  assert.equal(a.nurses.map((n) => n.id + n.seniority).join(' '), 'a0 c1 e2 b3 d4', '순서 = 시니어리티 — 차지 선임 규칙이 이 값을 본다');
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
// ⑥ 그룹 (2026-11-12) — 겹쳐 속하기 · 끌어 넣기 · 저장 검사 · 근무표 주의(엔진 _nurse_group_limits 와 같은 기준)
{
  const a = make();
  a.rules = { nurseGroups: [] };
  a.selectedNurseMap = { b: true, d: true };
  a.openGroupModal(null);
  assert.deepEqual(a.groupModal.data.members, ['b', 'd'], '고른 사람으로 시작');
  a.groupPaintDown('a'); a.groupPaintOver('c'); a._groupPaint = null;           // a 를 눌러 켜고 끌어 c 도
  a.groupPaintDown('d'); a._groupPaint = null;                                   // 켜진 d 를 누르면 뺀다
  a.groupModal.data.name = ' 신규 '; a.groupModal.data.same = 'alone';
  await a.saveGroupModal();
  const g = a.rules.nurseGroups[0];
  assert.deepEqual([g.name, g.members.join(''), g.maxPerShift, g.minPerShift], ['신규', 'abc', 1, null], '명부 순서 · 같이 일하지 않기 = 1');
  assert.deepEqual(a.posts.at(-1), ['/api/rules', { nurseGroups: a.rules.nurseGroups }], '그룹만 저장한다');
  assert.equal(picked(a), '', '고른 사람으로 만들면 고르기를 푼다');
  a.openGroupModal(null); a.groupModal.data.name = '신규'; await a.saveGroupModal();
  assert.equal(a.rules.nurseGroups.length, 1, '같은 이름은 저장하지 않는다');
  a.openGroupModal(null); Object.assign(a.groupModal.data, { name: 'IV', members: ['c', 'e'], same: 'max', maxN: 1 }); await a.saveGroupModal();
  assert.equal(a.rules.nurseGroups.length, 1, "'최대 n명' 은 2명 이상");
  Object.assign(a.groupModal.data, { maxN: 2, minOn: true, minN: 1 }); await a.saveGroupModal();
  assert.deepEqual(a.groupsOfNurse('c').map((x) => x.name), ['신규', 'IV'], '한 사람이 두 그룹에');
  a._dragNurseIdx = 4; a.selectedNurseMap = {};                                   // e 의 순서 칸을 신규 칩에
  a.dropOnGroup(a.rules.nurseGroups[0]); await new Promise((r) => setTimeout(r));
  assert.equal(a.rules.nurseGroups[0].members.join(''), 'abce');
  assert.equal(a._dragNurseIdx, null, '놓으면 순서 옮기기는 끝난다');

  // 근무표 주의 — 시간대(D·D1 / E·중 / N), 그 달 1일부터, '/' 트레이닝 칸·빈 칸 안 셈, 최소는 칸이 있는 그룹원 수까지만
  a.year = 2026; a.month = 12;
  a.shifts = [['D', 'day'], ['D1', 'day1'], ['E', 'evening'], ['중', 'middle'], ['N', 'night'], ['OF', 'rest']].map(([code, period]) => ({ code, period }));
  Object.defineProperty(a, 'scheduleDays', { value: [new Date(2026, 10, 30), new Date(2026, 11, 1), new Date(2026, 11, 2)] });   // 앞 칸은 지난달
  a.dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  a.rules.nurseGroups = [
    { id: 'x', name: '신규', members: ['a', 'b', 'c'], maxPerShift: 1, minPerShift: null },
    { id: 'y', name: 'IV', members: ['d', 'e'], maxPerShift: null, minPerShift: 2 },
  ];
  a.schedule = {
    a: { '2026-11-30': 'D', '2026-12-01': 'D', '2026-12-02': 'E' },
    b: { '2026-11-30': 'D', '2026-12-01': 'D1', '2026-12-02': '중' },          // 11/30 은 지난달 — 세지 않는다
    c: { '2026-12-01': '/D', '2026-12-02': 'N' },                              // '/D' = 트레이닝 날
    d: { '2026-12-01': 'D', '2026-12-02': 'D' },
    e: { '2026-12-01': 'E', '2026-12-02': 'D' },                               // 12/2 둘 다 D — E·N 은 0명
  };
  const w = a.groupWarnings();
  assert.equal(w.length, 2, JSON.stringify(w));
  assert.match(w[0].msg, /^같이 일하지 않기를 못 지킨 근무 2개 — 12\/1 D 간호01·간호02 · 12\/2 E 간호01·간호02$/);
  assert.equal(w[0].nurse, '신규 그룹');
  assert.match(w[1].msg, /^한 근무 2명 이상을 못 지킨 근무 5개 — 12\/1 D 1명 · 12\/1 E 1명 · 12\/1 N 0명 · 12\/2 E 0명 · 12\/2 N 0명$/);
  delete a.schedule.e;                                                         // 칸이 없는 날(재적 밖)은 1명까지만 바란다
  const w2 = a.groupWarnings().find((x) => x.nurse === 'IV 그룹');
  assert.match(w2.msg, /못 지킨 근무 4개 — 12\/1 E 0명 · 12\/1 N 0명 · 12\/2 E 0명 · 12\/2 N 0명$/);
  assert.ok(a.scheduleWarnings.some((x) => x.nurse === '신규 그룹'), '근무표 주의 목록에 들어간다');
}
console.log('test_roster_bulk: OK');
