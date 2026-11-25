// 차지 표시 검증 — node scripts/test_charge_plain.mjs
// 병동 번표에는 누가 차지인지 나오지 않는다 (2026-10-03 병동 확인).
//  · 인쇄(rdPrintCode)·엑셀(_xlsxBody)은 '차지 숨기기'와 상관없이 늘 D/E/N
//  · 엑셀은 그 달 1일부터 화면 끝까지 (11월 → 11/1~12/5, 12월 → 12/1~1/2), 화면·인쇄의 '이달' 계는 그 달 칸만
//  · 1일이 일요일이 아니고 앞 달 저장본이 있으면 앞 달 시트 본문(prev)이 함께 간다
//  · 엑셀 본문에 팀 색·칸 표식(원티드 w · 풀린 칸 r · 나이트킵 k)·차지 가능 근무·메모가 함께 간다
//  · 화면은 '차지 숨기기' 토글을 따른다 (Ctrl+P 로 바로 찍을 때는 _printPlain)
//  · 어싸인용 복사는 DC/EC/NC 그대로 — 배정표가 이것으로 차지를 안다
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
global.localStorage = { getItem: () => null, setItem() {} };
require('../frontend/js/modules/settings-defs.js');
require('../frontend/js/modules/schedule-features.js');
require('../frontend/js/modules/redesign.js');
require('../frontend/js/modules/view-helpers.js');

const days = [1, 2, 3, 4].map((d) => new Date(2026, 10, d));   // 11/1 = 일요일
const dk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ctx = {
  year: 2026, month: 11,
  nurses: [{ id: 'a', name: '간호01', group: 'A' }],
  schedule: { a: { '2026-11-01': 'DC', '2026-11-02': 'EC', '2026-11-03': 'NC', '2026-11-04': '/DC' } },
  extendedSchedule: null, scheduleDays: days,
  dayKey: dk, isOverflow: () => false,
  // 다른 모듈(app.js · analysis.js · grid-interactions.js · preinput-io.js)의 한 줄짜리 — 엑셀 본문이 부른다
  rules: {}, relaxedCells: {}, cellNotes: {}, prevSchedule: {}, _originalSchedule: null, keepers: [],
  isRelaxed(id, d) { return !!this.relaxedCells[id]?.[dk(d)]; },
  getNote(id, d) { return this.cellNotes[id]?.[dk(d)] || ''; },
  getPrevShift(id, d) { return this.prevSchedule[id]?.[dk(d)] || ''; },
  isKeeperDay(n) { return this.keepers.includes(n.id); },
  toast() {},
};
for (const mod of [window.SettingsDefsModule(), window.ScheduleFeaturesModule(), window.RedesignModule()])
  Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(mod));

// plainShift
assert.equal(ctx.plainShift('DC'), 'D');
assert.equal(ctx.plainShift('EC'), 'E');
assert.equal(ctx.plainShift('NC'), 'N');
assert.equal(ctx.plainShift('/DC'), '/D');
assert.equal(ctx.plainShift('경가'), '경가');
assert.equal(ctx.plainShift(''), '');

// 인쇄 — 토글을 꺼도 D/E/N
const nurse = ctx.nurses[0];
for (const hide of [true, false]) {
  ctx.hideCharge = hide;
  assert.deepEqual(days.map((d) => ctx.rdPrintCode(nurse, d)), ['D', 'E', 'N', '/D'], `hideCharge=${hide}`);
}

// 화면 — 토글을 따르되, 인쇄 중(_printPlain)엔 D/E/N
ctx.hideCharge = false;
assert.equal(ctx.displayShift('a', days[0]), 'DC');
ctx._printPlain = true;
assert.equal(ctx.displayShift('a', days[0]), 'D');
ctx._printPlain = false;
ctx.hideCharge = true;
assert.equal(ctx.displayShift('a', days[0]), 'D');

// 엑셀(_xlsxBody) — 토글을 꺼도 D/E/N
ctx.hideCharge = false;
let body = ctx._xlsxBody();
assert.deepEqual(body.rows[0], ['간호01', 'D', 'E', 'N', '/D'], JSON.stringify(body));
assert.deepEqual(body.days, days.map(dk));
assert.ok(!/\b(DC|EC|NC)\b/.test(JSON.stringify(body.rows)), JSON.stringify(body.rows));
// 추가 정보가 없는 표 — 팀 색은 자동(첫 팀 = 번표 색 첫 번째), 표식·차지·메모는 빈 값
assert.deepEqual([body.teams, body.team_colors, body.marks, body.charge, body.notes], [['A'], { A: '#DDEBF7' }, ['    '], [''], []]);

// 어싸인용 복사 — 차지 그대로
let copied = '';
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } } });
ctx.hideCharge = true;
ctx.copyScheduleTsv();
assert.deepEqual(copied.split('\n')[1].split('\t'), ['간호01', 'DC', 'EC', 'NC', '/DC'], copied);

// 엑셀 날짜 = 그 달 1일부터 화면 끝까지. 11월은 엔진이 앞에 붙인 10/25~10/31 을 빼고 12/1~12/5 꼬리는 남긴다.
// 전입 전 칸은 근무가 있어도 빈칸.
const range = (a, b) => { const o = []; for (const d = new Date(...a); d <= new Date(...b); d.setDate(d.getDate() + 1)) o.push(new Date(d)); return o; };
Object.assign(ctx, {
  year: 2026, month: 11, scheduleDays: range([2026, 9, 25], [2026, 11, 5]), holidays: ['2026-11-03'],
  isOverflow(d) { return d.getMonth() !== this.month - 1 || d.getFullYear() !== this.year; },
  nurses: [{ id: 'a', name: '간호01', group: 'B', capable_shifts: ['D', 'DC', 'E', 'N', 'NC'] },
    { id: 'b', name: '간호02', group: 'A', start_date: '2026-11-03' }, { id: 'c', name: '간호03', group: 'B' }, { id: 'd', name: '간호04' }],
  schedule: { a: { '2026-10-31': 'NC', '2026-11-01': 'DC', '2026-11-02': 'OF', '2026-11-03': 'D', '2026-11-04': 'OF', '2026-12-05': 'EC' }, b: { '2026-11-02': 'D', '2026-11-03': 'D' } },
  // 11/2 원티드 그대로 · 11/3 원티드가 풀림 · 11/4 원티드를 손으로 고침(원래 E) · 12/5 는 끝에 붙은 다음 달 날
  prevSchedule: { a: { '2026-11-02': 'OF', '2026-11-03': 'OF', '2026-11-04': 'E', '2026-12-05': 'EC' }, b: { '2026-11-02': 'D' } },
  _originalSchedule: { a: { '2026-10-31': 'NC', '2026-11-01': 'DC', '2026-11-02': 'OF', '2026-11-03': 'D', '2026-11-04': 'E', '2026-12-05': 'EC' }, b: { '2026-11-02': 'D', '2026-11-03': 'D' } },
  relaxedCells: { a: { '2026-11-03': 1 } }, cellNotes: { a: { '2026-11-02': '개인 사정' }, b: { '2026-10-30': '표 밖' } },
  keepers: ['c'], rules: { teamColors: { A: '#123456' } },
});
body = ctx._xlsxBody();
assert.equal(body.days[0], '2026-10-25');                            // 화면과 똑같이 — 1일이 일요일인 달은 지난달 마지막 한 주도 (결정 1-114)
assert.equal(body.days.length, 42);
assert.equal(body.days.at(-1), '2026-12-05');
assert.deepEqual([body.rows[0][7], body.rows[0][8], body.rows[0][42]], ['N', 'D', 'E']);   // 10/31 NC · 11/1 DC · 12/5 EC
assert.deepEqual([body.rows[1][0], ...body.rows[1].slice(8, 11)], ['간호02', '', '', 'D']);  // 11/2 는 전입 전
assert.deepEqual(body.holidays, ['2026-11-03']);
// 팀 색 — 고른 색(A)이 먼저, 나머지는 명부에 처음 나오는 순서로. 팀이 없으면 색도 없다
assert.deepEqual(body.teams, ['B', 'A', 'B', '']);
assert.deepEqual(body.team_colors, { B: '#DDEBF7', A: '#123456' });
assert.equal(ctx.rdTeamStyle(ctx.nurses[1]), '--team-bg:#123456;--team-fg:#FFFFFF');
assert.equal(ctx.rdTeamStyle(ctx.nurses[0]), '--team-bg:#DDEBF7;--team-fg:#1A1A1A');
assert.equal(ctx.rdTeamStyle(ctx.nurses[3]), '');
// 표식 — 화면과 같다: 원티드 그대로 w(끝에 붙은 다음 달 날도 — 결정 1-75) · 풀린 칸 r · 손으로 고친 칸·전입 전은 빈 표식 · 나이트킵 줄은 k
assert.equal(body.marks[0].slice(7, 12), ' wr  ');
assert.equal(body.marks[0].slice(0, 7), ' '.repeat(7));              // 앞에 붙은 지난달 한 주는 원티드 색을 칠하지 않는다
assert.equal(body.marks[0][41], 'w');
assert.equal(body.marks[1].slice(7, 10), '   ');
assert.equal(body.marks[2], 'k'.repeat(42));
assert.equal(body.marks[3], ' '.repeat(42));
assert.deepEqual(body.charge, ['DN', '', '', '']);
assert.deepEqual(body.notes, [[0, 8, '개인 사정'], [1, 5, '표 밖']]);  // 10/30 의 메모도 이제 표 안이다
Object.assign(ctx, { month: 12, scheduleDays: range([2026, 10, 29], [2027, 0, 2]) });
body = ctx._xlsxBody();
assert.equal(body.days[0], '2026-11-29');                            // 12월은 1일이 든 주의 일요일부터 — 앞에 붙은 11/29·11/30 도 함께 (결정 1-114)
assert.equal(body.days.length, 35);
assert.equal(body.rows[0][7], 'E');                                  // 12/5 EC — 화면 값
assert.equal(body.days.at(-1), '2027-01-02');
assert.equal(body.marks[0].slice(0, 2), '  ');                       // 앞에 붙은 지난달 며칠은 원티드 색을 칠하지 않는다

// 앞 달 시트 본문(_xlsxPrev) — 11/29~12/5 는 11월 표에도 있어, 11월 저장본이 있으면 그 표가 앞 시트로 같이 나간다. 없으면 시트 하나
assert.equal(await ctx._xlsxPrev(), null);
// 저장본이 있으면 그 표를 연 것처럼 — 근무표·풀린 칸은 저장본(가장 최근 것), 명부·사전입력·메모는 지금 것. 10/25~12/5 (11월 화면 그대로)
Object.defineProperty(ctx, 'scheduleDays', { configurable: true, get() { return this.month === 11 ? range([2026, 9, 25], [2026, 11, 5]) : range([2026, 10, 29], [2027, 0, 2]); } });
let asked, prev;
Object.assign(ctx, { savedSchedules: [{ id: 7, year: 2026, month: 11 }, { id: 3, year: 2026, month: 11 }, { id: 9, year: 2025, month: 11 }],
  api: async (m, url) => { asked = `${m} ${url}`; return { data: { schedule: { a: { '2026-11-02': 'NC', '2026-12-01': 'N' } }, relaxed_cells: { a: { '2026-11-02': 1 } } } }; } });
prev = await ctx._xlsxPrev();
assert.equal(asked, 'GET /api/schedules/7');
assert.deepEqual([prev.year, prev.month, prev.days[0], prev.days.at(-1), prev.days.length], [2026, 11, '2026-10-25', '2026-12-05', 42]);
assert.deepEqual([prev.rows[0][8], prev.rows[0][9], prev.rows[0][38], prev.rows[0][42]], ['', 'N', 'N', '']);   // 화면의 11/1 DC·12/5 EC 는 섞이지 않는다
assert.equal(prev.marks[0].slice(7, 12), ' rww ');                   // 풀린 칸은 저장본 것, 손으로 고친 칸 표시는 이 달 것이라 쓰지 않는다
assert.deepEqual(prev.notes, [[0, 8, '개인 사정'], [1, 5, '표 밖']]);
assert.deepEqual([ctx.year, ctx.month, Object.keys(ctx.schedule.a).length, Object.keys(ctx.relaxedCells.a)], [2026, 12, 6, ['2026-11-03']]);   // 화면 상태는 그대로

// 엑셀 내려받기 — 서버에 POST 하고 '근무표_2026년12월.xlsx' 로 저장
let sent, saved;
global.fetch = async (url, opts) => { sent = { url, ...opts }; return { ok: true, blob: async () => 'xlsx' }; };
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
global.document = { createElement: () => ({ click() { saved = this.download; } }), body: { appendChild() {}, removeChild() {} } };
await ctx.exportToXlsx();
assert.equal(sent.url, '/api/schedules/export.xlsx');
assert.equal(sent.method, 'POST');
assert.deepEqual(JSON.parse(sent.body), { ...body, prev });
assert.equal(saved, '근무표_2026년12월.xlsx');
// 1일이 일요일인 달도 지난달 마지막 한 주(10/25~10/31)가 앞 달 표에 있다 — 그 달 저장본이 없으면 시트 하나
ctx.month = 11;
assert.equal(await ctx._xlsxPrev(), null);                           // 10월 저장본 없음
await ctx.exportToXlsx();
assert.equal(JSON.parse(sent.body).prev, null);
assert.equal(JSON.parse(sent.body).days[0], '2026-10-25');
ctx.month = 12;

// 표를 만든 뒤 사전입력이 바뀌었는가(rdPreChanged) — 새 표가 설 때(trackEdits)의 사전입력과 견준다. 되돌리면 꺼지고, 기준을 모르면 알리지 않는다
{
  const f = Object.create(ctx, { checkScheduleViolations: { value() {} }, countPrevEntries: { value: () => 1 }, generating: { value: false, writable: true } });
  Object.assign(f, { prevSchedule: { a: { '2026-12-10': 'OF' } }, schedule: { a: { '2026-12-10': 'OF', '2026-12-11': 'D' } } });
  assert.equal(f.rdPreChanged, false);                               // 기준 없음
  f.trackEdits();
  assert.equal(f.rdPreChanged, false);
  f.prevSchedule.a['2026-12-12'] = 'D';
  assert.equal(f.rdPreChanged, true);
  assert.equal(f.rdStatus.changed, true);
  assert.equal(f.rdStep.s3, '사전입력 바뀜 · 다시 만들어야 반영');
  f.generating = true; assert.equal(f.rdPreChanged, false); f.generating = false;
  delete f.prevSchedule.a['2026-12-12'];
  assert.equal(f.rdPreChanged, false);
  f.prevSchedule.a['2026-10-01'] = 'D';                              // 화면 밖 날짜는 보지 않는다
  assert.equal(f.rdPreChanged, false);
}

// 화면·인쇄의 '이달' 계 — 생성 결과에 든 앞뒤 주기 칸은 세지 않는다
const vh = window.ViewHelpersModule();
const sc = { year: 2026, month: 11, schedule: { a: { '2026-10-31': 'D', '2026-11-01': 'D', '2026-11-30': 'DC', '2026-12-01': 'D' } } };
assert.equal(vh.countShifts.call(sc, 'a', ['DC', 'D']), 2);
assert.equal(vh.countShifts.call(sc, 'x', ['D']), 0);

console.log('charge-plain: 모든 검증 통과');
