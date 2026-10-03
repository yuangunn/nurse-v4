// 병원 휴일 (매년) 검증 — node scripts/test_hospital_holidays.mjs
// 101병동 (2026-10-03): 5/1 근로자의 날 · 5/9 의료원 설립일 · 7/17 제헌절 · 7/21 노조 설립일.
// 법정공휴일 계산(_computeKRHolidays, KASI 골든셋)과 따로 두고 '공휴일 채우기'에서만 합친다.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
global.localStorage = { getItem: () => null, setItem() {} };
require('../frontend/js/modules/misc-features.js');
require('../frontend/js/modules/settings-defs.js');

const ctx = { rules: {} };
for (const mod of [window.MiscFeaturesModule(), window.SettingsDefsModule()])
  Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(mod));

// 1. 기본값 — rules 에 목록이 없으면 넷
assert.deepEqual(ctx._hospitalHolidays(2026), ['2026-05-01', '2026-05-09', '2026-07-17', '2026-07-21']);
// 2. 법정공휴일 계산에는 섞이지 않는다 (골든셋 보호)
assert.ok(!ctx._computeKRHolidays(2026).includes('2026-05-09'));
// 3. 병동이 고친 목록 — 빈 목록이면 없음, 잘못된 날짜는 건너뜀
ctx.rules.hospitalHolidays = [];
assert.deepEqual(ctx._hospitalHolidays(2026), []);
ctx.rules.hospitalHolidays = [{ md: '02-29', name: '윤일' }, { md: '13-01' }, { md: '' }, { md: '06-15', name: '개원' }];
assert.deepEqual(ctx._hospitalHolidays(2026), ['2026-06-15']);
assert.deepEqual(ctx._hospitalHolidays(2028), ['2028-02-29', '2028-06-15']);
delete ctx.rules.hospitalHolidays;

// 4. 공휴일 채우기 — 2026년 5월 주기에 법정공휴일과 병원 휴일이 함께 들어간다
const days = [];
for (let d = new Date(2026, 3, 26); d <= new Date(2026, 5, 6); d.setDate(d.getDate() + 1)) days.push(new Date(d));
let toast = '';
Object.assign(ctx, {
  scheduleDays: days, holidays: [],
  dayKey: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  toast: (m) => { toast = m; }, _pushUndo() {},
});
ctx.autoFillHolidays();
for (const h of ['2026-05-01', '2026-05-05', '2026-05-09', '2026-05-25', '2026-06-03'])
  assert.ok(ctx.holidays.includes(h), `${h} 빠짐: ${ctx.holidays}`);
assert.ok(toast.includes('병원 휴일 2일 포함'), toast);

// 5. 설정 화면 — 날짜 입력 정리
assert.equal(ctx._normMD('5/1'), '05-01');
assert.equal(ctx._normMD('5-9'), '05-09');
assert.equal(ctx._normMD('7월 17일'), '07-17');
assert.equal(ctx._normMD('0721'), '07-21');
assert.equal(ctx._normMD('2/30'), null);
assert.equal(ctx._normMD('abc'), null);
ctx.rules = {};
ctx.addHospitalHoliday();
assert.equal(ctx.rules.hospitalHolidays.length, 5);   // 기본 넷을 복사한 뒤 한 줄 더함
ctx.setHospitalHoliday(4, 'md', '6/15');
assert.equal(ctx.rules.hospitalHolidays[4].md, '06-15');
ctx.removeHospitalHoliday(0);
assert.deepEqual(ctx.hospitalHolidayList.map((h) => h.md), ['05-09', '07-17', '07-21', '06-15']);

console.log('hospital-holidays: 모든 검증 통과');
