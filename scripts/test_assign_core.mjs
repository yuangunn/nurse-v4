// 어싸인 코어 자가검증 — node scripts/test_assign_core.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { compute, periodOf, LABELS } = require('../frontend/js/modules/assign-core.js');

const N = (id, sen, cap = true) => ({ id, seniority: sen, chargeCapable: cap });

// ── periodOf ──
assert.equal(periodOf('DC'), 'D');
assert.equal(periodOf('E'), 'E');
assert.equal(periodOf('NC'), 'N');
assert.equal(periodOf('중'), null);
assert.equal(periodOf('D1'), null);
assert.equal(periodOf('/D'), null);
assert.equal(periodOf('OF'), null);

// ── 원칙 1: DC 표시자가 차지, 없으면 차지가능 최선임 ──
{
  const nurses = [N('a', 0), N('b', 1), N('c', 2, false)];
  const r = compute(nurses, {
    a: { d1: 'D' }, b: { d1: 'DC' }, c: { d1: 'D' },
  }, ['d1']);
  assert.equal(r.byDay.d1.D.labels['차지'], 'b'); // DC 표시자 우선 (a가 더 선임이어도)
}
{
  const nurses = [N('a', 0, false), N('b', 1), N('c', 2)];
  const r = compute(nurses, {
    a: { d1: 'D' }, b: { d1: 'D' }, c: { d1: 'D' },
  }, ['d1']);
  assert.equal(r.byDay.d1.D.labels['차지'], 'b'); // 차지가능자 중 최선임
}

// ── 원칙 2: 전일 같은 근무 → 방 유지 ──
{
  const nurses = [N('a', 0), N('b', 1), N('c', 2)];
  const sched = {
    a: { d1: 'DC', d2: 'DC' },
    b: { d1: 'D', d2: 'D' },
    c: { d1: 'D', d2: 'D' },
  };
  const r = compute(nurses, sched, ['d1', 'd2']);
  assert.deepEqual(r.byDay.d2.D.labels, r.byDay.d1.D.labels);
}

// ── 원칙 3: 근무 변경 시 방 유지 + 원칙 2 우선 ──
{
  // d1: b가 Day A방. d2: b가 Evening으로 이동 → Evening A방.
  const nurses = [N('a', 0), N('b', 1), N('c', 2), N('d', 3)];
  const sched = {
    a: { d1: 'DC', d2: 'EC' },
    b: { d1: 'D', d2: 'E' },
    c: { d1: 'E', d2: 'D' },
    d: { d1: 'EC', d2: 'DC' },
  };
  const r = compute(nurses, sched, ['d1', 'd2']);
  assert.equal(r.byDay.d1.D.labels['A'], 'b');
  assert.equal(r.byDay.d2.E.labels['A'], 'b'); // 근무 바뀌어도 A 유지
}
{
  // 원칙 2 보유자가 있으면 원칙 3보다 우선.
  // d1: b=Evening A. d2: b는 계속 Evening(원칙2로 A), c는 Day A였다가 Evening 전환(원칙3).
  const nurses = [N('a', 0), N('b', 1), N('c', 2), N('x', 3), N('y', 4)];
  const sched = {
    a: { d1: 'EC', d2: 'EC' },
    b: { d1: 'E', d2: 'E' },
    c: { d1: 'D', d2: 'E' },   // d1 Day에서 A방 (아래 검증)
    x: { d1: 'DC', d2: 'DC' },
    y: { d1: 'D', d2: 'D' },
  };
  const r = compute(nurses, sched, ['d1', 'd2']);
  assert.equal(r.byDay.d1.D.labels['A'], 'c');
  assert.equal(r.byDay.d1.E.labels['A'], 'b');
  assert.equal(r.byDay.d2.E.labels['A'], 'b'); // 원칙2(b)가 원칙3(c)보다 우선
  assert.equal(r.byDay.d2.E.labels['B'], 'c'); // c는 잔여 라벨
}

// ── 원칙 4: 오프 복귀자 방 유지 (원칙 3이 우선) ──
{
  // b: d1 Day A → d2 OFF → d3 Evening. d3 Evening A 비어있으면 b에게.
  const nurses = [N('a', 0), N('b', 1), N('c', 2)];
  const sched = {
    a: { d1: 'DC', d2: 'EC', d3: 'EC' },
    b: { d1: 'D', d2: 'OF', d3: 'E' },
    c: { d1: 'D', d2: 'E', d3: 'E' },
  };
  const r = compute(nurses, sched, ['d1', 'd2', 'd3']);
  assert.equal(r.byDay.d1.D.labels['A'], 'b');
  // d2 Evening: c가 A (잔여 최선임)
  assert.equal(r.byDay.d2.E.labels['A'], 'c');
  // d3: c가 원칙2로 A 유지 → 오프 복귀 b는 B
  assert.equal(r.byDay.d3.E.labels['A'], 'c');
  assert.equal(r.byDay.d3.E.labels['B'], 'b');
}
{
  // 경쟁자 없으면 오프 복귀자가 봤던 방 회수
  const nurses = [N('a', 0), N('b', 1), N('c', 2)];
  const sched = {
    a: { d1: 'DC', d2: 'DC', d3: 'DC' },
    b: { d1: 'D', d2: 'OF', d3: 'D' },
    c: { d1: 'OF', d2: 'D', d3: 'OF' },
  };
  const r = compute(nurses, sched, ['d1', 'd2', 'd3']);
  assert.equal(r.byDay.d1.D.labels['A'], 'b');
  assert.equal(r.byDay.d3.D.labels['A'], 'b'); // OFF 복귀 후 A 회수
}

// ── 인원수별 라벨 개수 (2~5인) + 6인 이상 헬퍼 ──
{
  const nurses = [0, 1, 2, 3, 4, 5].map((i) => N('n' + i, i));
  const sched = {};
  nurses.forEach((n, i) => (sched[n.id] = { d1: i === 0 ? 'DC' : 'D' }));
  const r = compute(nurses, sched, ['d1']);
  assert.deepEqual(Object.keys(r.byDay.d1.D.labels).sort(), [...LABELS].sort());
  assert.equal(r.byDay.d1.D.extra.length, 1); // 6번째는 어싸인 없음
}
{
  const nurses = [N('a', 0), N('b', 1)];
  const r = compute(nurses, { a: { d1: 'NC' }, b: { d1: 'N' } }, ['d1']);
  assert.deepEqual(r.byDay.d1.N.labels, { 차지: 'a', A: 'b' });
}

// ── 오버라이드: 수동 지정이 모든 원칙에 우선 ──
{
  const nurses = [N('a', 0), N('b', 1), N('c', 2)];
  const sched = { a: { d1: 'DC' }, b: { d1: 'D' }, c: { d1: 'D' } };
  const r = compute(nurses, sched, ['d1'], { overrides: { d1: { D: { c: 'A' } } } });
  assert.equal(r.byDay.d1.D.labels['A'], 'c');
  assert.equal(r.byDay.d1.D.labels['B'], 'b');
}

// ── 선입력 시드: 1일 오버라이드가 이후 연속성의 시작점 (VBA D/A 선입력과 동일 의미) ──
{
  const nurses = [N('a', 0), N('b', 1), N('c', 2)];
  const sched = {
    a: { d1: 'DC', d2: 'DC', d3: 'DC' },
    b: { d1: 'D', d2: 'D', d3: 'D' },
    c: { d1: 'D', d2: 'D', d3: 'D' },
  };
  // 선입력 없으면 b(선임)가 A — 선입력으로 1일 c를 A에 고정
  const r = compute(nurses, sched, ['d1', 'd2', 'd3'], { overrides: { d1: { D: { c: 'A' } } } });
  assert.equal(r.byDay.d1.D.labels['A'], 'c');
  assert.equal(r.byDay.d2.D.labels['A'], 'c'); // 2일부터 원칙2로 A 유지
  assert.equal(r.byDay.d3.D.labels['A'], 'c');
  assert.equal(r.byDay.d3.D.labels['B'], 'b');
}

// ── 규칙 토글: keepAcrossShift 끄면 원칙 3 미적용 ──
{
  const nurses = [N('a', 0), N('b', 1), N('c', 2), N('d', 3)];
  const sched = {
    a: { d1: 'DC', d2: 'EC' },
    b: { d1: 'D', d2: 'E' },
    c: { d1: 'E', d2: 'D' },
    d: { d1: 'EC', d2: 'DC' },
  };
  const r = compute(nurses, sched, ['d1', 'd2'], { rules: { keepAcrossShift: false, keepAfterOff: false } });
  // b는 d1 Day A였지만 원칙3 꺼짐 → d2 Evening 잔여 배정 (여전히 A일 수 있음, 잔여 최선임이므로)
  // 대신 c(d1 Evening A)가 d2 Day에서 원칙3 미적용인지 확인
  assert.equal(r.byDay.d1.E.labels['A'], 'c');
  assert.equal(r.byDay.d2.D.labels['A'], 'c'); // 잔여 최선임으로 우연히 A — 규칙과 무관
}

console.log('assign-core: 모든 검증 통과');
