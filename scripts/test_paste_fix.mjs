// 가져오기 창 — 이름 맞추기 · 모르는 근무 표기 읽는 법 기억 · 칸 미리보기 (2026-10-19) — node scripts/test_paste_fix.mjs
// 이름은 앞 '*'·띄어쓰기를 보지 않고 맞추고, 못 찾은 이름은 명부의 누구인지 고른다. 모르는 표기는 읽는 법을 고르면
// 이 컴퓨터에 기억해 다음 붙여넣기와 표에 바로 붙이기(Ctrl+V)에도 쓴다. 미리보기는 사람 × 날짜 칸. 이름은 가명.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const store = {};
global.window = {};
global.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
global.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
for (const f of ['undo-redo', 'drag-select', 'analysis', 'paste-import', 'profiles', 'dev-tools', 'nurse-manage',
  'settings-defs', 'solver', 'view-helpers', 'preinput-io', 'grid-interactions', 'schedule-features',
  'misc-features', 'redesign']) require(`../frontend/js/modules/${f}.js`);
const app = new Function(fs.readFileSync(new URL('../frontend/js/app.js', import.meta.url), 'utf8') + '\nreturn app;')();

const SHIFTS = [['D', 'day'], ['E', 'evening'], ['N', 'night'], ['OF', 'rest'], ['주', 'rest'], ['V', 'leave']]
  .map(([code, period]) => ({ code, period }));
const dk = (d) => `2026-03-${String(d).padStart(2, '0')}`;
function make() {
  const a = app();
  a.year = 2026; a.month = 3; a.shifts = SHIFTS; a.holidays = [];
  a.nurses = [{ id: 'a', name: '간호01' }, { id: 'b', name: '간호02' }, { id: 'c', name: '간호 03' }];
  a.prevSchedule = { a: { [dk(2)]: 'E', [dk(3)]: 'N' } };
  a.toasts = []; a.toast = (m) => a.toasts.push(m);
  a.$nextTick = (f) => f && f();
  a.openPastePrev('prev');
  return a;
}
const paste = (a, rows) => { a.pastePrev.rawText = rows.map((r) => r.join('\t')).join('\n'); a.onPasteTextChange(); };
const sets = (a) => a.pastePrev.diff.will_set.map((x) => `${x.nid}${+x.dk.slice(8)}${x.newShift}`).join(' ');

// ① 앞 '*'·띄어쓰기는 보지 않는다 — '*간호01' = 간호01, '간호03' = 명부의 '간호 03'
{
  const a = make();
  paste(a, [['', '1', '2'], ['*간호01', 'D', 'D'], ['간호03', 'N', 'N']]);
  assert.equal(sets(a), 'a1D a2D c1N c2N');
  assert.deepEqual(a.pastePrev.diff.unmatchedNames, []);
}
// ② 못 찾은 이름은 누구인지 고른다 — 비슷한 이름을 먼저, 다른 줄이 맞춘 사람은 빼고. 고른 줄은 남아 바꾸거나 풀 수 있다
{
  const a = make();
  paste(a, [['', '1'], ['간호01', 'D'], ['간호02A', 'E'], ['간호9', 'N']]);
  assert.deepEqual(a.pastePrev.diff.unmatchedNames, ['간호02A', '간호9']);
  assert.deepEqual(a.pasteNameChoices('간호02A').map((n) => n.id), ['b', 'c'], '간호01 은 첫 줄이 맞췄다');
  a.setPasteName('간호02A', 'b');
  assert.equal(sets(a), 'a1D b1E');
  assert.deepEqual(a.pasteNameRows.map((x) => x.name), ['간호02A', '간호9'], '고른 줄도 남는다');
  assert.deepEqual(a.pasteNameChoices('간호9').map((n) => n.id), ['c'], '간호02 는 간호02A 가 맞췄다');
  a.setPasteName('간호02A', '');
  assert.equal(sets(a), 'a1D');
}
// ③ 모르는 표기 — 읽는 법을 고르면 기억(이 컴퓨터), 새 창·표에 바로 붙이기에도. 근무 정의에 없는 코드는 쓰지 않는다. 잊기.
{
  const a = make();
  paste(a, [['', '1', '2', '3'], ['간호02', 'OFF*', '반차', 'D']]);
  assert.deepEqual(a.pastePrev.diff.unrecognized, ['OFF*', '반차']);
  assert.deepEqual(a.pastePrev.diff.unknown_cells.map((x) => x.dk), [dk(1), dk(2)]);
  a.setPasteAlias('OFF*', 'OF');
  assert.equal(sets(a), 'b1OF b3D');
  assert.deepEqual(a.pastePrev.diff.unrecognized, ['반차']);
  assert.deepEqual(a.pasteAliasUsed, [{ raw: 'off*', code: 'OF' }]);
  assert.deepEqual(JSON.parse(store.ns_paste_alias), { 'off*': 'OF' });
  const b = make();                                          // 다음에 연 앱도 읽는다
  assert.equal(b._normalizeShiftCode('Off*'), 'OF');
  b.activeTab = 'preinput';
  b._setSel('preinput', 0, b.scheduleDays.findIndex((d) => b.dayKey(d) === dk(5)));
  b.gridPasteText('OFF*');
  assert.equal(b.prevSchedule.a[dk(5)], 'OF');
  b.shifts = SHIFTS.filter((s) => s.code !== 'OF');
  assert.equal(b._normalizeShiftCode('OFF*'), undefined, '근무 정의에 없으면 모르는 표기');
  a.setPasteAlias('off*', '');
  assert.deepEqual(a.pastePrev.diff.unrecognized, ['OFF*', '반차']);
  assert.deepEqual(JSON.parse(store.ns_paste_alias), {});
}
// ④ 미리보기 — 사람 × 날짜. 바뀌는 칸 · 이미 같은 칸 · 비우는 칸 · 모르는 표기, 명부 순서, 달이 바뀌면 '월/일'
{
  const a = make();
  paste(a, [['', '3/1', '3/2', '3/3', '3/31', '4/1'], ['간호02', 'D', '', '', 'N', '?!'], ['간호01', 'D', 'E', '-', '', '']]);
  const p = a.pastePreview;
  assert.deepEqual(p.rows.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(p.days.map((d) => d.label), ['3/1', '2', '3', '31', '4/1']);
  assert.deepEqual(p.rows[0].cells, { [dk(1)]: { code: 'D', old: '', st: 'set' }, [dk(2)]: { code: 'E', st: 'same' }, [dk(3)]: { old: 'N', st: 'clear' } });
  assert.deepEqual(p.rows[1].cells['2026-04-01'], { raw: '?!', st: 'unknown' });
  assert.match(a.pasteCellTip('간호01', dk(3), p.rows[0].cells[dk(3)]), /N → 비움/);
  a.pastePrev.target = 'saved'; a._matchPasteGrid();
  assert.equal(a.pastePreview.rows[0].cells[dk(2)].st, 'set', '완성 근무표는 모두 넣을 칸');
}
console.log('test_paste_fix: OK');
