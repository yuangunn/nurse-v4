// 사전입력 라인트(_checkViolations) 자가검증 — node scripts/test_preinput_lint.mjs
// 솔버 하드 제약과 1:1 의미 대응을 검증한다 (오탐 방지 케이스 포함).
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
    isNurseInactive() { return false; },
    ...mod,
  };
}
const nurse = (id, extra = {}) => ({ id, name: id, gender: 'female', capable_shifts: ['DC', 'D', 'EC', 'E', 'NC', 'N'], ...extra });
const run = (o) => { const c = makeCtx(o); c._checkViolations(); return c.prevViolations.map(x => x.msg); };
const has = (m, s) => m.some(x => x.includes(s));

// 1. V 월한도 초과
let m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'V', '2026-03-10': 'V' } } });
assert.ok(has(m, 'V 2회'), m.join('\n'));

// 2. 연속 근무 6일 (최대 5)
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'D', '2026-03-03': 'D', '2026-03-04': 'D', '2026-03-05': 'D', '2026-03-06': 'D', '2026-03-07': 'D' } } });
assert.ok(has(m, '연속 근무 6일'), m.join('\n'));

// 3. 연속 야간 4일 (최대 3)
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'N', '2026-03-03': 'N', '2026-03-04': 'N', '2026-03-05': 'N' } } });
assert.ok(has(m, '연속 야간 4일'), m.join('\n'));

// 4. N→휴무→D 패턴 (noNOD)
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'N', '2026-03-03': 'OF', '2026-03-04': 'D' } } });
assert.ok(has(m, 'N→휴무→D'), m.join('\n'));

// 5. 공휴일 OF — 위반이 아니라 '무시됨' 경고 (솔버 _effective_pre 대응)
m = run({ nurses: [nurse('a')], holidays: ['2026-03-05'], prev: { a: { '2026-03-05': 'OF' } } });
assert.ok(has(m, '공휴일 OF'), m.join('\n'));

// 6. 일별 사전배정 초과 (요구 정확히 일치)
m = run({ nurses: [nurse('a'), nurse('b')], dayReqs: { '2026-03-03': { D: 1 } }, prev: { a: { '2026-03-03': 'D' }, b: { '2026-03-03': 'DC' } } });
assert.ok(has(m, '사전배정 2명'), m.join('\n'));

// 7. 자격 미달 — 단 PRE_FLEX(E↔EC) 반영해 오탐 방지
m = run({ nurses: [nurse('a', { capable_shifts: ['D', 'DC'] })], prev: { a: { '2026-03-02': 'E' } } });
assert.ok(has(m, '자격 미달'), m.join('\n'));
m = run({ nurses: [nurse('a', { capable_shifts: ['EC'] })], prev: { a: { '2026-03-02': 'E' } } });
assert.ok(!has(m, '자격 미달'), m.join('\n'));

// 8. 야간전담의 주간 근무
m = run({ nurses: [nurse('a', { is_night_shift: true })], prev: { a: { '2026-03-02': 'D' } } });
assert.ok(has(m, '야간전담'), m.join('\n'));

// 9. 같은 주 OF 2회
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'OF', '2026-03-04': 'OF' } } });
assert.ok(has(m, 'OF 2회'), m.join('\n'));

// 10. 알 수 없는 코드 검출 + 트레이니(/D) 코드는 무시
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'X', '2026-03-03': '/D' } } });
assert.ok(has(m, '알 수 없는'), m.join('\n'));
assert.ok(!m.some(x => x.includes('/D')), m.join('\n'));

// 11. 기존 금지 전환(E→D) 여전히 동작
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-09': 'E', '2026-03-10': 'D' } } });
assert.ok(has(m, '금지'), m.join('\n'));

// 12. 임산부 임신 구간 야간 — '무시됨' 경고
m = run({ nurses: [nurse('a', { is_pregnant: true, pregnancy: { early: { start: '2026-03-01', end: '2026-03-31' } } })], prev: { a: { '2026-03-02': 'N' } } });
assert.ok(has(m, '임신 구간 야간'), m.join('\n'));

// 13. 정상 입력 → 위반 0 (오탐 없음)
m = run({ nurses: [nurse('a')], prev: { a: { '2026-03-02': 'D', '2026-03-03': 'D', '2026-03-04': 'E', '2026-03-05': 'OF' } } });
assert.equal(m.length, 0, m.join('\n'));

console.log('preinput-lint: 모든 검증 통과');
