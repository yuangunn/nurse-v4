// 앱 어싸인 탭 전월 이월 글루(_assignSaveState/_assignSeed) 자가검증
// node scripts/test_assign_app_seed.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const store = new Map();
global.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
};
global.window = {};
require('../frontend/js/modules/assign.js');
const M = global.window.AssignModule();

// ── 7월 상태 저장: 마지막 라벨 날짜(8/1 이월일 포함)를 고른다 ──
const julCtx = {
  ...M, currentProfile: 'p1', year: 2026, month: 7,
  assignData: { byNurse: {
    a: { '2026-07-30': { period: 'D', label: 'A' }, '2026-07-31': { period: 'D', label: 'B' } },
    b: { '2026-07-28': { period: 'N', label: '차지' } },          // 월말 오프
    c: { '2026-08-01': { period: 'E', label: 'A' } },             // 7월 계산의 이월일
    d: { '2026-07-15': { period: 'D', label: null } },            // 헬퍼만 — 상태 제외
  } },
};
julCtx._assignSaveState();
const saved = JSON.parse(store.get('ns_assign_state_p1_2026-7'));
assert.equal(saved.nurses.a.label, 'B');
assert.equal(saved.nurses.a.iso, '2026-07-31');
assert.equal(saved.nurses.b.period, 'N');
assert.equal(saved.nurses.c.iso, '2026-08-01');
assert.ok(!('d' in saved.nurses));

// ── 8월 시드: 8월 주기(7/26 시작) 기준 상대 idx ──
const augCtx = { ...M, currentProfile: 'p1', year: 2026, month: 8, assignSeedInfo: '' };
const seed = augCtx._assignSeed('2026-07-26');
assert.equal(seed.a.idx, 5);                    // 7/31 = 7/26+5 (이월 겹침 — 양수)
assert.equal(seed.a.label, 'B');
assert.equal(seed.b.idx, 2);                    // 7/28
assert.ok(!('c' in seed), '당월(8월) 날짜 상태는 시드에서 제외');
assert.match(augCtx.assignSeedInfo, /2026-7.*2명/);

// ── 빈 결과는 기존 상태를 덮어쓰지 않음 ──
julCtx.assignData = { byNurse: {} };
julCtx._assignSaveState();
assert.equal(JSON.parse(store.get('ns_assign_state_p1_2026-7')).nurses.a.label, 'B');

// ── 1월 → 전년 12월 조회 ──
store.set('ns_assign_state_p1_2025-12', JSON.stringify({ nurses: { z: { label: 'C', period: 'D', iso: '2025-12-31' } } }));
const janCtx = { ...M, currentProfile: 'p1', year: 2026, month: 1, assignSeedInfo: '' };
const s2 = janCtx._assignSeed('2026-01-01');
assert.equal(s2.z.idx, -1);

// ── 전월 상태 없음 → null + 안내 없음 ──
const nov = { ...M, currentProfile: 'p1', year: 2026, month: 11, assignSeedInfo: 'x' };
assert.equal(nov._assignSeed('2026-11-01'), null);
assert.equal(nov.assignSeedInfo, '');

console.log('assign-app-seed: 모든 검증 통과');
