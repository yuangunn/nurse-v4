// 차지 표시 검증 — node scripts/test_charge_plain.mjs
// 병동 번표에는 누가 차지인지 나오지 않는다 (2026-10-03 병동 확인).
//  · 인쇄(rdPrintCode)·엑셀(_xlsxBody)은 '차지 숨기기'와 상관없이 늘 D/E/N
//  · 엑셀은 그 달에 걸친 주 전부 (11월 → 11/1~12/5), 화면·인쇄의 '이달' 계는 그 달 칸만
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

const days = [1, 2, 3, 4].map((d) => new Date(2026, 9, d));
const dk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ctx = {
  year: 2026, month: 10,
  nurses: [{ id: 'a', name: '간호01', group: 'A' }],
  schedule: { a: { '2026-10-01': 'DC', '2026-10-02': 'EC', '2026-10-03': 'NC', '2026-10-04': '/DC' } },
  extendedSchedule: null, scheduleDays: days,
  dayKey: dk, isOverflow: () => false,
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

// 어싸인용 복사 — 차지 그대로
let copied = '';
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } } });
ctx.hideCharge = true;
ctx.copyScheduleTsv();
assert.deepEqual(copied.split('\n')[1].split('\t'), ['간호01', 'DC', 'EC', 'NC', '/DC'], copied);

// 엑셀 날짜 = 1일이 든 주의 일요일부터 화면 끝까지 (병동 번표). 11월은 1일이 일요일이라 엔진이 앞에 붙인
// 10/25~10/31 은 빼고 12/1~12/5 꼬리는 남긴다. 전입 전 칸은 근무가 있어도 빈칸.
const range = (a, b) => { const o = []; for (const d = new Date(...a); d <= new Date(...b); d.setDate(d.getDate() + 1)) o.push(new Date(d)); return o; };
Object.assign(ctx, {
  year: 2026, month: 11, scheduleDays: range([2026, 9, 25], [2026, 11, 5]), holidays: ['2026-11-03'],
  nurses: [{ id: 'a', name: '간호01' }, { id: 'b', name: '간호02', start_date: '2026-11-03' }],
  schedule: { a: { '2026-10-31': 'NC', '2026-11-01': 'DC', '2026-12-05': 'EC' }, b: { '2026-11-02': 'D', '2026-11-03': 'D' } },
});
body = ctx._xlsxBody();
assert.equal(body.days[0], '2026-11-01');
assert.equal(body.days.length, 35);
assert.equal(body.days.at(-1), '2026-12-05');
assert.deepEqual([body.rows[0][1], body.rows[0][35]], ['D', 'E']);   // 11/1 DC · 12/5 EC
assert.deepEqual(body.rows[1].slice(0, 4), ['간호02', '', '', 'D']);  // 11/2 는 전입 전
assert.deepEqual(body.holidays, ['2026-11-03']);
Object.assign(ctx, { month: 12, scheduleDays: range([2026, 10, 29], [2027, 0, 2]) });
body = ctx._xlsxBody();
assert.equal(body.days[0], '2026-11-29');
assert.equal(body.days.length, 35);

// 엑셀 내려받기 — 서버에 POST 하고 '근무표_2026년12월.xlsx' 로 저장
let sent, saved;
global.fetch = async (url, opts) => { sent = { url, ...opts }; return { ok: true, blob: async () => 'xlsx' }; };
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
global.document = { createElement: () => ({ click() { saved = this.download; } }), body: { appendChild() {}, removeChild() {} } };
await ctx.exportToXlsx();
assert.equal(sent.url, '/api/schedules/export.xlsx');
assert.equal(sent.method, 'POST');
assert.deepEqual(JSON.parse(sent.body), body);
assert.equal(saved, '근무표_2026년12월.xlsx');

// 화면·인쇄의 '이달' 계 — 생성 결과에 든 앞뒤 주기 칸은 세지 않는다
const vh = window.ViewHelpersModule();
const sc = { year: 2026, month: 11, schedule: { a: { '2026-10-31': 'D', '2026-11-01': 'D', '2026-11-30': 'DC', '2026-12-01': 'D' } } };
assert.equal(vh.countShifts.call(sc, 'a', ['DC', 'D']), 2);
assert.equal(vh.countShifts.call(sc, 'x', ['D']), 0);

console.log('charge-plain: 모든 검증 통과');
