// 원티드 색을 칠할 칸 · 세부 원티드 단추 검증 — node scripts/test_wanted_cells.mjs
// 사전입력 값이 있는 칸만 칠한다. 주휴(주)·달 밖 날짜·지난달과 겹친 첫 주기는 뺀다
// (첫 주기의 이달 날짜는 지난달 근무표에서 이어온 칸이다).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
global.localStorage = { getItem: () => null, setItem() {} };
require('../frontend/js/modules/redesign.js');
const mod = window.RedesignModule();
const dk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ctx = (year, month, start, pre) => ({
  year, month, scheduleDays: [start],
  isOverflow(d) { return d.getMonth() !== month - 1 || d.getFullYear() !== year; },
  getPrevShift: (_, d) => pre[dk(d)] || '',
  isWanted: mod.isWanted,
});
// 2026-12: 표는 11/29(일)부터 — 첫 주기 11/29~12/5 가 지난달과 겹친다
let c = ctx(2026, 12, new Date(2026, 10, 29), { '2026-11-30': 'D', '2026-12-05': 'OF', '2026-12-06': 'OF', '2026-12-07': '주', '2026-12-31': 'N제외', '2027-01-01': 'OF' });
const w = (y, m, d) => c.isWanted('a', new Date(y, m - 1, d));
assert.equal(w(2026, 11, 30), false, '달 밖 날짜');
assert.equal(w(2026, 12, 5), false, '지난달과 겹친 첫 주기의 이달 날짜');
assert.equal(w(2026, 12, 6), true, '둘째 주기부터 칠한다');
assert.equal(w(2026, 12, 7), false, '주휴');
assert.equal(w(2026, 12, 8), false, '빈칸');
assert.equal(w(2026, 12, 31), true, '다음 달과 겹친 마지막 주기의 이달 날짜는 칠한다');
assert.equal(w(2027, 1, 1), false, '다음 달 날짜');
// 표가 1일에 시작하면(지난달과 겹치지 않으면) 첫 주기도 칠한다
c = ctx(2026, 12, new Date(2026, 11, 1), { '2026-12-01': 'V' });
assert.equal(c.isWanted('a', new Date(2026, 11, 1)), true);

// 세부 원티드 — 그날 가능한 것(D·E·N·휴무)을 켜고 끈 묶음이 칸 코드가 된다 (엔진 _FLEX_ONE_OF·_FLEX_NOT 과 같은 표)
{
  const K = '2026-12-10', K2 = '2026-12-11';
  const periods = { D: 'day', DC: 'day', E: 'evening', N: 'night', OF: 'rest', V: 'leave', D1: 'day1' };
  const f = Object.defineProperties({}, Object.getOwnPropertyDescriptors(mod));
  Object.assign(f, { prevSchedule: { a: {} }, dayKey: dk, _dragCells: [], year: 2026, month: 12, holidays: ['2026-11-30', '2026-12-25'],
    nurses: [{ id: 'a' }, { id: 'k' }], isKeeperDay: n => n.id === 'k',
    shiftEdit: { mode: 'prev', nurse: { id: 'a', capable_shifts: ['D', 'E'] }, day: new Date(2026, 11, 10) },
    shiftMap: new Map(Object.entries(periods).map(([code, period]) => [code, { period }])),
    _gridWrite(tab, items) { for (const x of items) x.code === '__CLEAR__' ? delete this.prevSchedule[x.nid][x.dk] : (this.prevSchedule[x.nid][x.dk] = x.code); } });
  const seq = (start, keys) => { start ? (f.prevSchedule.a[K] = start) : delete f.prevSchedule.a[K];
    return keys.map(k => { f.rdFineToggle(k); return f.prevSchedule.a[K] || ''; }); };
  // 빈칸(넷 다 켬)에서 N 끔 → 휴무 끔 → E 끔 → 마지막 D 는 안 꺼진다 → 다시 켜 나가면 빈칸으로 돌아온다
  assert.deepEqual(seq('', ['N', 'R', 'E', 'D', 'E', 'R', 'N']), ['N제외', 'D/E', 'D', 'D', 'D/E', 'N제외', '']);
  assert.deepEqual(seq('', ['R']), ['D/E/N'], '휴무만 끄면 쉬지만 않으면');
  assert.deepEqual(seq('', ['E', 'N', 'D']), ['E제외', 'D/OF', 'OF']);
  assert.deepEqual(seq('V', ['D']), ['D/OF'], '휴가 코드는 휴무 하나 켠 것으로 읽는다');
  assert.deepEqual(seq('DC', ['E']), ['D/E'], '차지는 그 시간대로 읽는다');
  assert.deepEqual(seq('D1', ['N']), ['N'], 'D·E·N·휴무 밖 코드는 켜진 것 없음');
  assert.deepEqual(['D', 'E', 'N', 'R'].map(k => f.rdFineCan(k)), [true, true, false, true], '명부에 야간이 없는 간호사');
  // 여러 칸 — 값이 섞였으면 빈칸에서 시작해 모두 같은 코드로
  f.prevSchedule.a = { [K]: 'D', [K2]: 'V' }; f.shiftEdit.mode = 'prev_multi'; f._dragCells = [{ nid: 'a', dk: K }, { nid: 'a', dk: K2 }];
  f.rdFineToggle('N');
  assert.deepEqual(f.prevSchedule.a, { [K]: 'N제외', [K2]: 'N제외' });
  // 이번 달 법정공휴일에 '휴무'만 켜면 법 (공휴일 OF 는 엔진이 버린다) — 다시 읽으면 휴무 하나, 나이트킵·지난달 칸은 OF 그대로
  const H = '2026-12-25', P = '2026-11-30';
  f.prevSchedule = { a: {}, k: {} }; f.shiftEdit.mode = 'prev_multi';
  f._dragCells = [{ nid: 'a', dk: H }, { nid: 'a', dk: K }, { nid: 'a', dk: P }, { nid: 'k', dk: H }];
  for (const k of ['D', 'E', 'N']) f.rdFineToggle(k);
  assert.deepEqual(f.prevSchedule, { a: { [H]: '법', [K]: 'OF', [P]: 'OF' }, k: { [H]: 'OF' } });
  assert.equal(f.rdFineOn, 'R', '법과 OF 가 섞여도 휴무 하나로 읽는다');
  f.rdFineToggle('D');
  assert.deepEqual(f.prevSchedule.a, { [H]: 'D/OF', [K]: 'D/OF', [P]: 'D/OF' });
}
console.log('wanted-cells: 모든 검증 통과');
