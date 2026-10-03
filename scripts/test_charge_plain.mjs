// 차지 표시 검증 — node scripts/test_charge_plain.mjs
// 병동 번표에는 누가 차지인지 나오지 않는다 (2026-10-03 병동 확인).
//  · 인쇄(rdPrintCode)·엑셀(CSV)은 '차지 숨기기'와 상관없이 늘 D/E/N
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

const days = [1, 2, 3, 4].map((d) => new Date(2026, 9, d));
const dk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ctx = {
  year: 2026, month: 10,
  nurses: [{ id: 'a', name: '간호01', group: 'A' }],
  schedule: { a: { '2026-10-01': 'DC', '2026-10-02': 'EC', '2026-10-03': 'NC', '2026-10-04': '/DC' } },
  extendedSchedule: null, scheduleDays: days,
  dayKey: dk, isOverflow: () => false,
  countShifts(nid, codes) { return Object.values(this.schedule[nid] || {}).filter((v) => codes.includes(v)).length; },
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

// 엑셀(CSV) — 토글을 꺼도 D/E/N
let csv = '';
global.Blob = class { constructor(parts) { csv = parts.join(''); } };
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
global.document = { createElement: () => ({ click() {} }) };
ctx.hideCharge = false;
ctx.exportToCSV();
const row = csv.split('\n')[1].split(',');
assert.deepEqual(row.slice(2, 6), ['D', 'E', 'N', '/D'], csv);
assert.ok(!/\b(DC|EC|NC)\b/.test(csv), csv);

// 어싸인용 복사 — 차지 그대로
let copied = '';
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } } });
ctx.hideCharge = true;
ctx.copyScheduleTsv();
assert.deepEqual(copied.split('\n')[1].split('\t'), ['간호01', 'DC', 'EC', 'NC', '/DC'], copied);

console.log('charge-plain: 모든 검증 통과');
