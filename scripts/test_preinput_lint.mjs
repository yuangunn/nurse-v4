// 사전입력 라인트(_checkViolations) 자가검증 — node scripts/test_preinput_lint.mjs
// 솔버 하드 제약과 1:1 의미 대응을 검증한다 (오탐 방지 케이스 포함).
//
// v4.9.0: 확정 셀만으로 결정되는 항목은 '위반(prevViolations)'이 아니라
// '참고(prevPinNotes)'다 — 엔진이 사실-클램프로 수용하기 때문(결정 1-15).
// 진짜 생성을 막는 건 알 수 없는 코드뿐이다.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
require('../frontend/js/modules/grid-interactions.js');
const mod = global.window.GridInteractionsModule();

const SHIFTS = [
  { code: 'DC', period: 'day' }, { code: 'D', period: 'day' }, { code: 'D1', period: 'day1' },
  { code: 'EC', period: 'evening' }, { code: 'E', period: 'evening' }, { code: '중', period: 'middle' },
  { code: 'NC', period: 'night' }, { code: 'N', period: 'night' },
  { code: 'OF', period: 'rest' }, { code: '주', period: 'rest' }, { code: 'P1', period: 'rest' },
  { code: 'V', period: 'leave' }, { code: '생', period: 'leave' }, { code: '특', period: 'leave' },
  { code: '공', period: 'leave' }, { code: '법', period: 'leave' }, { code: '병', period: 'leave' },
];

function makeCtx({ nurses, prev = {}, rules = {}, holidays = [], dayReqs = {}, prevMonthNights = {} } = {}) {
  const days = [];
  for (let i = 1; i <= 28; i++) days.push(new Date(2026, 2, i)); // 2026-03-01(일)~28, 4주기
  const wide = { D: 9, E: 9, N: 9 }; // 기본 넉넉 — 일별 초과 테스트에서만 dayReqs로 좁힘
  return {
    year: 2026, month: 3, shifts: SHIFTS, nurses, prevSchedule: prev,
    rules: {
      weeklyOff: true, noNOD: true, maxConsecutiveWork: true, maxConsecutiveWorkDays: 5,
      maxConsecutiveNight: true, maxConsecutiveNightDays: 3, maxVPerMonth: 1,
      maxNightPerMonth: true, maxNightPerMonthCount: 6,
      maxNightTwoMonth: false, maxNightTwoMonthCount: 11, ...rules,
    },
    holidays, prevDayReqs: dayReqs, prevMonthNights,
    requirements: { mon: wide, tue: wide, wed: wide, thu: wide, fri: wide, sat: wide, sun: wide },
    scheduleDays: days,
    dayKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
    isOverflow(d) { return d.getMonth() !== 2; },
    isHoliday(d) { return holidays.includes(this.dayKey(d)); },
    isNurseInactive() { return false; },
    ...mod,
  };
}
const nurse = (id, extra = {}) => ({ id, name: id, gender: 'female', capable_shifts: ['DC', 'D', 'EC', 'E', 'NC', 'N'], ...extra });
// v = 생성 불가(위반), n = 확정으로 수용되는 참고
const run = (o) => {
  const c = makeCtx(o); c._checkViolations();
  return { v: c.prevViolations.map(x => x.msg), n: c.prevPinNotes.map(x => x.msg) };
};
const has = (m, s) => m.some(x => x.includes(s));

// 1. V 월한도 초과
let m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'V', '2026-03-10': 'V' } } });
assert.ok(has(m.n, 'V 2회'), m.n.join('\n'));

// 2. 연속 근무 6일 (최대 5)
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'D', '2026-03-03': 'D', '2026-03-04': 'D', '2026-03-05': 'D', '2026-03-06': 'D', '2026-03-07': 'D' } } });
assert.ok(has(m.n, '연속 근무 6일'), m.n.join('\n'));

// 3. 연속 야간 4일 (최대 3)
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'N', '2026-03-03': 'N', '2026-03-04': 'N', '2026-03-05': 'N' } } });
assert.ok(has(m.n, '연속 야간 4일'), m.n.join('\n'));

// 4. N→휴무→D 패턴 (noNOD)
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'N', '2026-03-03': 'OF', '2026-03-04': 'D' } } });
assert.ok(has(m.n, 'N→휴무→D'), m.n.join('\n'));

// 5. 공휴일 OF — 위반이 아니라 '무시됨' 경고 (솔버 _effective_pre 대응)
m = run({ nurses: [nurse('a')], holidays: ['2026-03-05'], prev: { a: { '2026-03-05': 'OF' } } });
assert.ok(has(m.n, '공휴일 OF'), m.n.join('\n'));

// 6. 일별 사전배정 초과 (요구 정확히 일치)
m = run({ nurses: [nurse('a'), nurse('b')], dayReqs: { '2026-03-03': { D: 1 } }, prev: { a: { '2026-03-03': 'D' }, b: { '2026-03-03': 'DC' } } });
assert.ok(has(m.n, '사전배정 2명'), m.n.join('\n'));

// 7. 자격 미달 — 단 PRE_FLEX(E↔EC) 반영해 오탐 방지
m = run({ nurses: [nurse('a', { capable_shifts: ['D', 'DC'] })], prev: { a: { '2026-03-02': 'E' } } });
assert.ok(has(m.n, '자격 미달'), m.n.join('\n'));
m = run({ nurses: [nurse('a', { capable_shifts: ['EC'] })], prev: { a: { '2026-03-02': 'E' } } });
assert.ok(!has(m.n, '자격 미달'), m.n.join('\n'));

// 8. 야간전담의 주간 근무
m = run({ nurses: [nurse('a', { is_night_shift: true })], prev: { a: { '2026-03-02': 'D' } } });
assert.ok(has(m.n, '야간전담'), m.n.join('\n'));

// 9. 같은 주 OF 2회
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'OF', '2026-03-04': 'OF' } } });
assert.ok(has(m.n, 'OF 2회'), m.n.join('\n'));

// 10. 알 수 없는 코드 검출 + 트레이니(/D) 코드는 무시
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'X', '2026-03-03': '/D' } } });
assert.ok(has(m.v, '알 수 없는'), m.v.join('\n'));   // 유일한 '생성 불가'
assert.ok(![...m.v, ...m.n].some(x => x.includes('/D')), m.v.concat(m.n).join('\n'));

// 11. 기존 금지 전환(E→D) 여전히 동작
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-09': 'E', '2026-03-10': 'D' } } });
assert.ok(has(m.n, 'E→D'), m.n.join('\n'));

// 12. 임산부 임신 구간 야간 — '무시됨' 경고
m = run({ nurses: [nurse('a', { is_pregnant: true, pregnancy: { early: { start: '2026-03-01', end: '2026-03-31' } } })], prev: { a: { '2026-03-02': 'N' } } });
assert.ok(has(m.n, '임신 구간 야간'), m.n.join('\n'));

// 13. 정상 입력 → 위반 0 (오탐 없음)
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'D', '2026-03-03': 'D', '2026-03-04': 'E', '2026-03-05': 'OF' } } });
assert.equal(m.v.length, 0, m.v.join('\n'));
assert.equal(m.n.length, 0, m.n.join('\n'));

// 14. 오프특근(제1원칙 3) — OF 0회는 경고하지 않는다.
//     결원으로 휴무가 몰리면 남은 사람이 오프를 반납하고 근무를 메꾼다.
//     최소 보장은 주휴이고, OF 0회는 규칙 위반이 아니라 그 결과다.
const week1 = ['2026-03-01','2026-03-02','2026-03-03','2026-03-04','2026-03-05','2026-03-06','2026-03-07'];
const fill = (codes) => Object.fromEntries(week1.map((d, i) => [d, codes[i]]));
m = run({ nurses: [nurse('a')], prev: { a: fill(['D','D','D','D','D','주','D']) } });
assert.ok(!has(m.n, 'OF 0회'), m.n.join('\n'));
//  · 반대로 주 2회는 여전히 참고 (하드 상한 ≤1)
m = run({ nurses: [nurse('a')], prev: { a: fill(['OF','D','OF','D','D','주','D']) } });
assert.ok(has(m.n, 'OF 2회'), m.n.join('\n'));

// 15. 생성 불가는 알 수 없는 코드뿐 — 나머지는 전부 참고로 분류된다
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'E', '2026-03-03': 'D', '2026-03-09': 'V', '2026-03-10': 'V' } } });
assert.equal(m.v.length, 0, m.v.join('\n'));
assert.ok(m.n.length >= 2, m.n.join('\n'));

console.log('preinput-lint: 모든 검증 통과');
