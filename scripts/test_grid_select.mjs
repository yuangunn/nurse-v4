// 표 칸 선택 · 엑셀과 칸 묶음 주고받기 (2026-10-19) — node scripts/test_grid_select.mjs
// 사전입력·근무표 공용: 끌면 네모 범위, 이름 칸을 끌면 여러 사람 줄, 근무 키·Del·Ctrl+C/X/V·Ctrl+Z.
// 근무표 칸은 비울 수 없다(팝업에도 지우기가 없다). 근무표 되돌리기는 사전입력 스택과 따로. 이름은 가명.
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

const SHIFTS = [['DC', 'day'], ['D', 'day'], ['EC', 'evening'], ['E', 'evening'], ['NC', 'night'], ['N', 'night'],
  ['OF', 'rest'], ['주', 'rest'], ['V', 'leave'], ['생', 'leave'], ['법', 'leave']].map(([code, period]) => ({ code, period }));
const dk = (d) => `2026-03-${String(d).padStart(2, '0')}`;
function make() {
  const a = app();
  a.year = 2026; a.month = 3; a.shifts = SHIFTS; a.holidays = [];
  a.nurses = [{ id: 'a', name: '간호01' }, { id: 'b', name: '간호02' }, { id: 'c', name: '간호03', end_date: dk(5) }];
  a.prevSchedule = {}; a.schedule = {}; a.toasts = [];
  a.toast = (m) => a.toasts.push(m);
  a.$nextTick = (f) => f && f();
  a.activeTab = 'preinput';
  return a;
}
const key = (k, o = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, ...o });
const days0 = (a) => a.scheduleDays.findIndex((d) => a.dayKey(d) === dk(1));   // 3/1 의 열 번호 (앞에 지난달 칸이 있을 수 있다)

// ① 엑셀 칸 묶음 해석 — 탭·줄바꿈, 끝 줄바꿈, 따옴표
{
  const a = make();
  assert.deepEqual(a._parseTsv('D\tE\r\nN\t\n'), [['D', 'E'], ['N', '']]);
  assert.deepEqual(a._parseTsv('"주"\tOF'), [['주', 'OF']]);
  assert.deepEqual(a._parseTsv(''), []);
}
// ② 붙여넣기 — 고른 칸 왼쪽 위부터, 모르는 표기는 건너뛰고, 빈칸은 비우고, 전출 뒤 칸은 건너뜀
{
  const a = make(); const c0 = days0(a);
  a.prevSchedule = { b: { [dk(2)]: 'V' } };
  a._setSel('preinput', 0, c0);
  const r = a.gridPasteText('D\tE\tXX\nN\t\toff\n주\t주\t주\t주\t주\t주');
  assert.deepEqual(a.prevSchedule.a, { [dk(1)]: 'D', [dk(2)]: 'E' });
  assert.deepEqual(a.prevSchedule.b, { [dk(1)]: 'N', [dk(3)]: 'OF' }, '빈칸은 비움 (V 지워짐) · off → OF');
  assert.deepEqual(Object.keys(a.prevSchedule.c).sort(), [dk(1), dk(2), dk(3), dk(4), dk(5)], '간호03 은 3/5 전출 — 3/6 은 건너뜀');
  assert.deepEqual(r.unknown, ['XX']);
  assert.equal(r.cleared, 1); assert.equal(r.skipped, 1);
  assert.deepEqual(a._sel, { tab: 'preinput', r0: 0, c0, r1: 2, c1: c0 + 5 }, '넣은 범위를 고른다');
  assert.match(a.toasts.at(-1), /칸 넣었어요 · 1칸 비움 · 모르는 표기 XX 건너뜀 · 전입 전·전출 뒤 1칸 건너뜀/);
  a.undo();                                                  // 한 번에 되돌린다
  assert.deepEqual(a.prevSchedule, { b: { [dk(2)]: 'V' } });
}
// ③ 한 칸을 복사해 여러 칸을 고르고 붙이면 모두 채운다 (엑셀처럼)
{
  const a = make(); const c0 = days0(a);
  a._sel = { tab: 'preinput', r0: 0, c0, r1: 1, c1: c0 + 2 };
  a.gridPasteText('주');
  assert.equal(Object.values(a.prevSchedule.a).filter((v) => v === '주').length + Object.values(a.prevSchedule.b).filter((v) => v === '주').length, 6);
}
// ④ 복사 — 고른 칸을 엑셀 칸 묶음으로 (빈칸은 빈 문자열)
{
  const a = make(); const c0 = days0(a);
  a.prevSchedule = { a: { [dk(1)]: 'D', [dk(3)]: 'N' }, b: { [dk(2)]: 'OF' } };
  assert.equal(a._gridTsv({ tab: 'preinput', rA: 0, rB: 1, cA: c0, cB: c0 + 2 }), 'D\t\tN\n\tOF\t');
}
// ⑤ 키보드 — 근무 키는 고른 칸 모두, Shift+방향키로 넓히기, Del 로 비우기, Esc 로 풀기
{
  const a = make(); const c0 = days0(a);
  a._setSel('preinput', 0, c0);
  a.gridKey(key('ArrowRight', { shiftKey: true })); a.gridKey(key('ArrowDown', { shiftKey: true }));
  assert.deepEqual(a._selRect(), { tab: 'preinput', rA: 0, rB: 1, cA: c0, cB: c0 + 1 });
  a.gridKey(key('n'));
  assert.deepEqual([a.prevSchedule.a[dk(1)], a.prevSchedule.a[dk(2)], a.prevSchedule.b[dk(1)], a.prevSchedule.b[dk(2)]], ['N', 'N', 'N', 'N']);
  a.gridKey(key('ㅈ'));                                      // 한글 자판 ㅈ = 주
  assert.equal(a.prevSchedule.b[dk(2)], '주');
  a.gridKey(key('Delete'));
  assert.deepEqual([a.prevSchedule.a[dk(1)], a.prevSchedule.b[dk(2)]], [undefined, undefined]);
  a.gridKey(key('ArrowRight'));                              // 방향키만 = 한 칸으로 접고 이동
  assert.deepEqual(a._sel, { tab: 'preinput', r0: 1, c0: c0 + 2, r1: 1, c1: c0 + 2 });
  a.gridKey(key('Escape'));
  assert.equal(a._sel, null);
}
// ⑥ 근무표 — 근무 키·붙여넣기는 근무표 되돌리기 스택으로, 칸은 비우지 않는다, 원티드 표기는 받지 않는다
{
  const a = make(); a.activeTab = 'schedule'; const c0 = days0(a);
  a.schedule = { a: { [dk(1)]: 'D', [dk(2)]: 'E' }, b: { [dk(1)]: 'N', [dk(2)]: 'OF' } };
  a.trackEdits = schedule => {}; a._originalSchedule = JSON.parse(JSON.stringify(a.schedule));
  a._setSel('schedule', 0, c0, 1, c0 + 1);
  a.gridKey(key('Delete'));
  assert.deepEqual(a.schedule.a, { [dk(1)]: 'D', [dk(2)]: 'E' }, '근무표 칸은 비우지 않는다');
  assert.match(a.toasts.at(-1), /근무표 칸은 비울 수 없어요/);
  a.gridPasteText('E\t\nD/E\tN');
  assert.deepEqual(a.schedule.a, { [dk(1)]: 'E', [dk(2)]: 'E' }, '빈칸은 건너뜀');
  assert.deepEqual(a.schedule.b, { [dk(1)]: 'N', [dk(2)]: 'N' }, '원티드 D/E 는 근무표 칸이 아니다');
  assert.equal(a._undoStack.length, 0, '사전입력 되돌리기 스택은 그대로');
  a.gridKey(key('z', { ctrlKey: true }));
  assert.deepEqual(a.schedule.b, { [dk(1)]: 'N', [dk(2)]: 'OF' });
  a.gridKey(key('z', { ctrlKey: true, shiftKey: true }));
  assert.deepEqual(a.schedule.b, { [dk(1)]: 'N', [dk(2)]: 'N' });
  assert.equal(a.rdSaved, false, '고친 표는 아직 저장 전');
}
// ⑦ 마우스 — 끌면 네모 범위 → 여러 칸 팝업, 이름 칸을 끌면 줄 통째로(팝업 없이 한 번 알림), 끌지 않은 클릭만 칸 팝업
{
  const a = make(); const c0 = days0(a); const ev = { button: 0, shiftKey: false, target: { closest: () => null }, preventDefault() {} };
  a.gridDown('preinput', 0, c0, ev); a.gridOver('preinput', 1, c0 + 2); a.gridUp();
  assert.equal(a.shiftEdit.open, true); assert.equal(a.shiftEdit.mode, 'prev_multi'); assert.equal(a._dragCells.length, 6);
  a.applyMultiShiftEdit('V');
  assert.equal(a.prevSchedule.b[dk(3)], 'V'); assert.equal(a.shiftEdit.open, false);
  assert.equal(a.gridClick({ shiftKey: false }), false, '끈 뒤의 클릭은 팝업을 열지 않는다');
  a.gridDownRow('preinput', 0, ev); a.gridOverRow('preinput', 2); a.gridUp();
  assert.deepEqual(a._selRect(), { tab: 'preinput', rA: 0, rB: 2, cA: 0, cB: a.scheduleDays.length - 1 });
  assert.match(a.toasts.at(-1), /3명 줄을 골랐어요/);
  a.gridDown('preinput', 1, c0, ev); a.gridUp();
  assert.equal(a.gridClick({ shiftKey: false }), true);
  assert.equal(a.gridClick({ shiftKey: true }), false, 'Shift+클릭은 범위 넓히기');
  a.activeTab = 'schedule'; a.schedule = { a: {}, b: {} }; a.trackEdits = () => {};
  a.gridDown('schedule', 0, c0, ev); a.gridOver('schedule', 1, c0 + 1); a.gridUp();
  assert.equal(a.shiftEdit.mode, 'sched_multi');
  a.applyShiftEditWithUndo('N');
  assert.deepEqual(a.schedule.b, { [dk(1)]: 'N', [dk(2)]: 'N' });
}
// ⑧ 복사·붙여넣기 이벤트 — 입력 칸·팝업이 아닐 때만, 글자를 고른 채 복사면 그 글자
{
  const a = make(); const c0 = days0(a);
  a.prevSchedule = { a: { [dk(1)]: 'D' } };
  a._setSel('preinput', 0, c0);
  let got = null;
  const ev = (target) => ({ target, clipboardData: { setData: (t, v) => { got = v; }, getData: () => 'E' }, preventDefault() {} });
  window.getSelection = () => '';
  a.gridCopy(ev({ tagName: 'TD' }));
  assert.equal(got, 'D');
  got = null; a.gridCopy(ev({ tagName: 'INPUT' }));
  assert.equal(got, null, '입력 칸에서는 보통 복사');
  a.shiftEdit.open = true; a.gridPaste(ev({ tagName: 'TD' }));
  assert.equal(a.prevSchedule.a[dk(1)], 'D', '팝업이 열려 있으면 표에 붙이지 않는다');
  a.shiftEdit.open = false; a.gridPaste(ev({ tagName: 'TD' }));
  assert.equal(a.prevSchedule.a[dk(1)], 'E');
  a.gridCopy(ev({ tagName: 'TD' }), true);                   // 잘라내기 = 복사 + 비우기
  assert.equal(got, 'E'); assert.equal(a.prevSchedule.a[dk(1)], undefined);
}
console.log('test_grid_select: OK');
