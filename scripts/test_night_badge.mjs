// 야간전담 뱃지 라벨 검증 — node scripts/test_night_badge.mjs
// 명부에서 "이 사람이 어느 달 나이트킵인지"가 보여야 한다 (당월 on/off 표시만으로는 모름).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
require('../frontend/js/modules/nurse-manage.js');
const mod = global.window.NurseManageModule();

const ctx = (year, month) => ({ year, month, ...mod });
const badge = (nurse, year = 2026, month = 9) => ctx(year, month).nightMonthsBadge(nurse);
const nm = (...keys) => Object.fromEntries(keys.map(k => [k, true]));

// 1. 당월만
let b = badge({ night_months: nm('2026-09') });
assert.equal(b.text, '9월 야간전담'); assert.equal(b.on, true);

// 2. 당월 + 다른 달 — 오름차순, 쉼표 구분
b = badge({ night_months: nm('2026-10', '2026-09') });
assert.equal(b.text, '9,10월 야간전담'); assert.equal(b.on, true);

// 3. 다른 달만 — 표시는 하되 '당월 아님'
b = badge({ night_months: nm('2026-11') });
assert.equal(b.text, '11월 야간전담');
assert.equal(b.on, false); assert.equal(b.any, true);

// 4. 달이 많으면 요약 — 당월 포함 여부는 남긴다
b = badge({ night_months: nm('2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07') });
assert.equal(b.text, '7개월 야간전담'); assert.equal(b.on, false);
b = badge({ night_months: nm('2026-09','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07') });
assert.equal(b.text, '9월 외 7개월 야간전담'); assert.equal(b.on, true);

// 5. 다른 해가 섞이면 연도까지
b = badge({ night_months: nm('2026-09', '2027-01') });
assert.equal(b.text, '9월 · 2027년 1월 야간전담');

// 6. 레거시 상시 야간전담 (night_months 미사용)
b = badge({ night_months: {}, is_night_shift: true });
assert.equal(b.text, '상시 야간전담'); assert.equal(b.on, true);

// 7. 야간전담 아님
b = badge({ night_months: {}, is_night_shift: false });
assert.equal(b.text, '—'); assert.equal(b.any, false);

// 8. false 값은 켜진 것이 아니다
b = badge({ night_months: { '2026-09': false, '2026-10': true } });
assert.equal(b.text, '10월 야간전담'); assert.equal(b.on, false);

// 9. 툴팁에는 전체 목록이 그대로
b = badge({ night_months: nm('2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07') });
assert.ok(b.title.includes('2026년 1월') && b.title.includes('2026년 7월'), b.title);

console.log('night-badge: 모든 검증 통과');
