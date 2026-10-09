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
  assert.deepEqual(Object.keys(r.byDay.d1.D.labels).sort(), LABELS.slice(0, 5).sort());   // 기본 자리 5
  assert.equal(r.byDay.d1.D.extra.length, 1); // 6번째는 어싸인 없음
}
// ── 자리 6개 (2026-09-27 — 122 양식 D 6칸, 대체간호사가 오는 날) ──
{
  assert.deepEqual(LABELS, ['차지', 'A', 'B', 'C', 'D', 'E']);
  const nurses = [0, 1, 2, 3, 4, 5, 6].map((i) => N('n' + i, i));
  const six = {}; nurses.slice(0, 6).forEach((n, i) => (six[n.id] = { d1: i === 0 ? 'DC' : 'D' }));
  let r = compute(nurses, six, ['d1'], { maxSeats: 6 });
  assert.deepEqual(Object.keys(r.byDay.d1.D.labels).sort(), [...LABELS].sort());
  assert.equal(r.byDay.d1.D.extra.length, 0);                 // 6명이 6자리에 다 앉는다
  assert.equal(r.byDay.d1.D.labels['E'], 'n5');               // 막내가 마지막 자리
  const seven = {}; nurses.forEach((n, i) => (seven[n.id] = { d1: i === 0 ? 'DC' : 'D' }));
  r = compute(nurses, seven, ['d1'], { maxSeats: 6 });
  assert.deepEqual(r.byDay.d1.D.extra, ['n6']);               // 자리보다 많으면 헬퍼
  // 근무마다 자리 수가 다를 수 있다 (122: D 6 · E 5 · N 3줄 → 6/5/5)
  const both = {}; nurses.slice(0, 6).forEach((n, i) => (both[n.id] = { d1: i === 0 ? 'DC' : 'D', d2: i === 0 ? 'EC' : 'E' }));
  r = compute(nurses, both, ['d1', 'd2'], { maxSeats: (P) => (P === 'D' ? 6 : 5) });
  assert.equal(Object.keys(r.byDay.d1.D.labels).length, 6);
  assert.equal(Object.keys(r.byDay.d2.E.labels).length, 5);
  assert.equal(r.byDay.d2.E.extra.length, 1);
  // 잘못된 값은 기본 5 · 7 이상은 6으로
  r = compute(nurses, six, ['d1'], { maxSeats: 'x' });
  assert.equal(Object.keys(r.byDay.d1.D.labels).length, 5);
  r = compute(nurses, seven, ['d1'], { maxSeats: 9 });
  assert.equal(Object.keys(r.byDay.d1.D.labels).length, 6);
}
// ── 자리 6개 + 방 기준 연속성: 5인→6인(대체 한 명이 온 날)에도 정규 간호사는 보던 방을 잇는다 ──
{
  // 5인 방 구성 → 6인 방 구성 (6번째 E 는 가벼운 방)
  const R5 = { 차지: ['12', '13', '14'], A: ['1', '2'], B: ['3', '4'], C: ['5', '10', '11'], D: ['6', '7', '8', '9'] };
  const R6 = { 차지: ['12', '13', '14'], A: ['1', '2'], B: ['3', '4'], C: ['5', '10'], D: ['6', '7', '8'], E: ['9', '11'] };
  const roomsFor = (P, cnt, label) => ((cnt >= 6 ? R6 : R5)[label] || []);
  const nurses = ['a', 'b', 'c', 'd', 'e'].map((id, i) => N(id, i)).concat([N('relief', 9, false)]);
  // d1: 5명 — 선임 순으로 차지·A·B·C·D. d2: 대체 한 명이 와서 6명
  const sched = { a: { d1: 'DC', d2: 'DC' }, b: { d1: 'D', d2: 'D' }, c: { d1: 'D', d2: 'D' }, d: { d1: 'D', d2: 'D' }, e: { d1: 'D', d2: 'D' }, relief: { d2: 'D' } };
  // 첫날 자리를 못 박는다: e 가 C(5,10,11), d 가 D(6~9)
  const ovr = { d1: { D: { b: 'A', c: 'B', e: 'C', d: 'D' } } };
  const r = compute(nurses, sched, ['d1', 'd2'], { roomsFor, overrides: ovr, maxSeats: 6 });
  const L2 = r.byDay.d2.D.labels;
  assert.equal(L2['A'], 'b'); assert.equal(L2['B'], 'c');
  assert.equal(L2['C'], 'e');        // 5·10 을 이어 본다 (11 은 E 로 넘어감)
  assert.equal(L2['D'], 'd');        // 6~8 을 이어 본다 (9 는 E 로 넘어감)
  assert.equal(L2['E'], 'relief');   // 대체는 남는 자리(가벼운 방)
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

// ── 원칙4: 오프 복귀자 튕기기 (VBA 검증 시나리오와 동일) ──
{
  // d1: a=차지, b=A, c=B / d2: b 오프 (c는 B 유지, f가 A) / d3: b 복귀 + 신규 e
  const nurses = [N('a', 0), N('b', 1), N('c', 2), N('e', 4), N('f', 5)];
  const sched = {
    a: { d1: 'DC', d2: 'DC', d3: 'DC' },
    b: { d1: 'D', d3: 'D' },
    c: { d1: 'D', d2: 'D', d3: 'D' },
    e: { d3: 'D' },
    f: { d2: 'D' },
  };
  const days = ['d1', 'd2', 'd3'];
  // 원칙3(유지): 복귀자 b가 이전 방 A 유지
  let r = compute(nurses, sched, days, { rules: { keepAfterOff: true, bounceAfterOff: false } });
  assert.equal(r.byNurse.b.d3.label, 'A');
  // 원칙4(튕기기): b는 A 회피 → C, A는 신규 e에게
  r = compute(nurses, sched, days, { rules: { keepAfterOff: false, bounceAfterOff: true } });
  assert.equal(r.byNurse.b.d3.label, 'C');
  assert.equal(r.byNurse.e.d3.label, 'A');
  // 동시 켜짐(금지 조합): 원칙3만 적용 — 튕기기 무시
  r = compute(nurses, sched, days, { rules: { keepAfterOff: true, bounceAfterOff: true } });
  assert.equal(r.byNurse.b.d3.label, 'A');
}

// ── 전월 연속성 시드 (opts.seed) — VBA 자동 이월과 동일 의미 ──
{
  const nurses = [N('a', 0), N('b', 1), N('c', 2)];
  const sched = { a: { d1: 'DC' }, b: { d1: 'D' }, c: { d1: 'D' } };
  // 시드 없음: b(선임)가 A
  let r = compute(nurses, sched, ['d1']);
  assert.equal(r.byDay.d1.D.labels['A'], 'b');
  // 전월 말일 c=A 시드(idx=-1) → 원칙1로 c가 A 유지, b는 B
  r = compute(nurses, sched, ['d1'], { seed: { c: { label: 'A', period: 'D', idx: -1 } } });
  assert.equal(r.byDay.d1.D.labels['A'], 'c');
  assert.equal(r.byDay.d1.D.labels['B'], 'b');
  // 전월 중순 c=A(idx=-4, 월말 오프) → 원칙3(오프 복귀)로도 A 유지
  r = compute(nurses, sched, ['d1'], { seed: { c: { label: 'A', period: 'D', idx: -4 } } });
  assert.equal(r.byDay.d1.D.labels['A'], 'c');
  // 같은 시드 + 원칙3 끄고 원칙4(튕기기) → c는 A 회피
  r = compute(nurses, sched, ['d1'], {
    rules: { keepAfterOff: false, bounceAfterOff: true },
    seed: { c: { label: 'A', period: 'D', idx: -4 } },
  });
  assert.notEqual(r.byNurse.c.d1.label, 'A');
  // 이월(오버플로) 겹침: dateKeys가 전월 말일(d1)을 포함하고 그날 데이터가 없을 때,
  // 시드 idx=0(d1 위치) → d2에서 원칙1(전일 인접)로 작동 — 앱 어싸인 탭 시나리오
  const sched2 = { a: { d2: 'D' }, b: { d2: 'D' }, c: { d2: 'D' } };
  r = compute(nurses, sched2, ['d1', 'd2'], { seed: { c: { label: 'A', period: 'D', idx: 0 } } });
  assert.equal(r.byDay.d2.D.labels['A'], 'c');
  // 범위 밖 시드(idx ≥ dateKeys.length)는 무시
  r = compute(nurses, sched2, ['d1', 'd2'], { seed: { c: { label: 'A', period: 'D', idx: 2 } } });
  assert.equal(r.byDay.d2.D.labels['A'], 'b');
}

// ── 시간대별 차지 자격 (chargeCapable: {D,E,N}) ──
{
  // a: D차지만 가능(선임), b: N차지만 가능 — N 근무에서 차지는 b여야 함
  const nurses = [
    { id: 'a', seniority: 0, chargeCapable: { D: true, E: false, N: false } },
    { id: 'b', seniority: 1, chargeCapable: { D: false, E: false, N: true } },
    { id: 'c', seniority: 2, chargeCapable: false },
  ];
  const sched = { a: { d1: 'N' }, b: { d1: 'N' }, c: { d1: 'N' } };
  const r = compute(nurses, sched, ['d1']);
  assert.equal(r.byDay.d1.N.labels['차지'], 'b');   // a가 선임이어도 N차지 자격 없음
  // 아무도 자격 없으면 최선임 폴백 (기존 동작 유지)
  const r2 = compute(nurses.map(n => ({ ...n, chargeCapable: false })), sched, ['d1']);
  assert.equal(r2.byDay.d1.N.labels['차지'], 'a');
  // boolean 하위호환
  const r3 = compute(nurses.map(n => ({ ...n, chargeCapable: true })), sched, ['d1']);
  assert.equal(r3.byDay.d1.N.labels['차지'], 'a');
}

// ── 회피 라벨 (opts.avoid — 금지 방) ──
{
  const nurses = [
    { id: 'a', seniority: 0, chargeCapable: true },
    { id: 'b', seniority: 1, chargeCapable: false },
    { id: 'c', seniority: 2, chargeCapable: false },
  ];
  const sched = { a: { d1: 'D' }, b: { d1: 'D' }, c: { d1: 'D' } };
  // b는 A 라벨 회피 → 잔여 배정에서 c가 A, b가 B
  let r = compute(nurses, sched, ['d1'], { avoid: { d1: { D: { b: ['A'] } } } });
  assert.equal(r.byDay.d1.D.labels['A'], 'c');
  assert.equal(r.byDay.d1.D.labels['B'], 'b');
  // 소프트: 전원이 회피 대상이면 그래도 채운다 (미충원 방지)
  r = compute(nurses, sched, ['d1'], { avoid: { d1: { D: { a: ['차지'], b: ['A', 'B'], c: ['A', 'B'] } } } });
  assert.ok(r.byDay.d1.D.labels['A'] && r.byDay.d1.D.labels['B']);
  // 차지 방에 주지 않을 방이 걸려도 차지는 시니어리티 — b가 차지 가능해도 a가 차지 (2026-10-01).
  // 예전엔 a를 말없이 차지에서 빼, 인원이 바뀌어 차지 방이 달라지는 날마다 차지가 a↔b 로 오갔다. 경고는 화면이 낸다
  const n2 = nurses.map(n => n.id === 'b' ? { ...n, chargeCapable: true } : n);
  r = compute(n2, sched, ['d1'], { avoid: { d1: { D: { a: ['차지'] } } } });
  assert.equal(r.byDay.d1.D.labels['차지'], 'a');
  assert.equal(r.byDay.d1.D.charge, 'a');
  // 원칙1(전일 유지)보다 회피 우선: b가 어제 A를 봤어도 A 회피면 유지 안 함
  const sched3 = { a: { d1: 'D', d2: 'D' }, b: { d1: 'D', d2: 'D' }, c: { d1: 'D', d2: 'D' } };
  r = compute(nurses, sched3, ['d1', 'd2'], { avoid: { d2: { D: { b: ['A'] } } } });
  const bd1 = r.byNurse.b.d1.label;
  if (bd1 === 'A') assert.notEqual(r.byNurse.b.d2.label, 'A');
  // avoid 없는 날은 기존 동작 그대로 (연속성 유지)
  r = compute(nurses, sched3, ['d1', 'd2']);
  assert.equal(r.byNurse.b.d2.label, r.byNurse.b.d1.label);
}

// ── 방(병실) 기준 연속성 (opts.roomsFor) ──
{
  // 실제 기본 방 구성 — 인원수가 바뀌면 라벨의 방이 통째로 달라진다
  const SCHEMES = {
    5: { 차지: ['1012','1014'], A: ['1001','1002'], B: ['1003','1004'],
         C: ['1005','1010','1011'], D: ['1006','1007','1008','1009'] },
    4: { 차지: ['1001','1014'], A: ['1002','1003','1012'], B: ['1004','1005','1011'],
         C: ['1006','1007','1008','1009','1010'] },
    3: { 차지: ['1001','1012','1014'], A: ['1002','1003','1004','1011'],
         B: ['1005','1006','1007','1008','1009','1010'] },
    2: { 차지: [], A: [] },
  };
  const roomsFor = (P, cnt, label) => (SCHEMES[Math.min(Math.max(cnt, 2), 5)] || {})[label] || [];
  const nurses = ['a','b','c','d','e'].map((id, i) => ({ id, seniority: i, chargeCapable: true }));
  // d1: 5명 전원 D → 차지=a, A=b, B=c, C=d, D=e (선임 순)
  // d2: b가 오프 → 4명. 방 구성이 바뀌므로 '전날 본 병실'을 따라가야 한다.
  const sched = {
    a: { d1: 'D', d2: 'D' }, b: { d1: 'D', d2: 'OF' },
    c: { d1: 'D', d2: 'D' }, d: { d1: 'D', d2: 'D' }, e: { d1: 'D', d2: 'D' },
  };
  const r = compute(nurses, sched, ['d1', 'd2'], { roomsFor });
  assert.equal(r.byDay.d1.D.labels['D'], 'e');          // 전날 e = 1006~1009
  // 오늘 C = 1006~1010 → 1006~1009를 보던 e가 이어받아야 한다 (기존엔 d가 라벨 C를 물고 늘어져 e가 밀려남)
  assert.equal(r.byDay.d2.D.labels['C'], 'e');
  assert.equal(r.byDay.d2.D.labels['B'], 'd');          // 1005,1010,1011 → 1004,1005,1011 (겹침 2)
  assert.equal(r.byDay.d2.D.labels['A'], 'c');          // 1003,1004 → 1002,1003,1012 (겹침 1)
  // 회귀 대조: roomsFor 없으면 예전(라벨 기준) 동작 — d가 C를 유지하고 e가 밀려난다
  const old = compute(nurses, sched, ['d1', 'd2']);
  assert.equal(old.byDay.d2.D.labels['C'], 'd');
  assert.notEqual(old.byDay.d2.D.labels['C'], 'e');

  // 인원이 그대로면 방도 그대로 → 전원 같은 라벨 유지 (방 기준이어도 동일 결과)
  const sched2 = {}; for (const n of nurses) sched2[n.id] = { d1: 'D', d2: 'D' };
  const same = compute(nurses, sched2, ['d1', 'd2'], { roomsFor });
  for (const l of ['차지','A','B','C','D'])
    assert.equal(same.byDay.d2.D.labels[l], same.byDay.d1.D.labels[l]);

  // 방이 없는 구성(2인)은 라벨 폴백 — 방 정보가 없다고 연속성이 깨지면 안 된다
  const two = { a: { d1: 'D', d2: 'D' }, b: { d1: 'D', d2: 'D' } };
  const t2 = compute(nurses.slice(0, 2), two, ['d1', 'd2'], { roomsFor });
  assert.equal(t2.byDay.d2.D.labels['A'], t2.byDay.d1.D.labels['A']);

  // 전일 근무자가 두 자리에 무차별하면(양쪽 겹침 동일) 오프 복귀자가 원래 방을 되찾는다
  {
    const sched3 = {
      a: { d1: 'D', d2: 'D', d3: 'D' },   // 차지
      b: { d1: 'D', d2: 'OF', d3: 'D' },  // 오프 복귀 — d1에 1001,1002를 봄
      c: { d1: 'D', d2: 'D', d3: 'D' },
      d: { d1: 'D', d2: 'D', d3: 'D' },
      e: { d1: 'D', d2: 'D', d3: 'D' },
    };
    const r3 = compute(nurses, sched3, ['d1','d2','d3'], { roomsFor });
    const bRooms = SCHEMES[5][r3.byNurse.b.d3.label];
    assert.ok(bRooms.includes('1001') && bRooms.includes('1002'),
      '오프 복귀자가 보던 방(1001,1002)을 되찾아야 함 — 받은 방: ' + bRooms);
    // 원칙1(전일 근무자)이 손해 보면 안 된다 — 전원 겹침이 유지되는지 확인
    for (const id of ['c','d','e']) {
      const prev = SCHEMES[4][r3.byNurse[id].d2.label];
      const now = SCHEMES[5][r3.byNurse[id].d3.label];
      assert.ok(prev.some(x => now.includes(x)), id + ': 전일 근무자의 방 연속성 손실');
    }
  }

  // 원칙4(튕기기)도 방 기준 — 오프 복귀자는 '보던 병실'을 피한다
  const back = {
    a: { d1: 'D', d2: 'D', d3: 'D' }, b: { d1: 'D', d2: 'D', d3: 'D' },
    c: { d1: 'D', d2: 'D', d3: 'D' }, d: { d1: 'D', d2: 'D', d3: 'D' },
    e: { d1: 'D', d2: 'OF', d3: 'D' },
  };
  const bd = compute(nurses, back, ['d1','d2','d3'],
    { roomsFor, rules: { keepAfterOff: false, bounceAfterOff: true } });
  const prevRooms = SCHEMES[5][bd.byNurse.e.d1.label];
  const nowRooms = SCHEMES[5][bd.byNurse.e.d3.label];
  assert.ok(!prevRooms.some(x => nowRooms.includes(x)), '튕기기: 보던 병실을 피해야 함');
}

// ── 원칙 등급은 방 선택에서도 앞선다 (2026-09-16) ──
// 예전엔 겹침을 등급 없이 합쳐서, 근무 변경자·오프 복귀자가 4칸 겹치는 방을 잡으려고
// 전일 근무자(원칙1)를 2칸짜리 방으로 밀어냈다 — 5~10 보던 사람이 6~9 대신 5,10,11.
{
  const S = { 5: { 차지: ['12','14'], A: ['1','2'], B: ['3','4'], C: ['5','10','11'], D: ['6','7','8','9'] },
              4: { 차지: ['1','14'], A: ['2','3','12'], B: ['4','5','11'], C: ['6','7','8','9','10'] },
              3: { 차지: ['1','12','14'], A: ['2','3','4','11'], B: ['5','6','7','8','9','10'] },
              2: { 차지: [], A: [] } };
  const roomsFor = (P, cnt, l) => (S[Math.min(Math.max(cnt, 2), 5)] || {})[l] || [];
  const NN = ['C1','A1','X','E1','E2','E3','W','Q'].map((id, i) =>
    ({ id, seniority: i, chargeCapable: { D: i === 0, E: i === 3, N: false } }));
  // W 어제 E(4인 C=6~10) → 오늘 D (원칙2 근무 변경). X 어제 D 3인 B(5~10) → 오늘 D (원칙1)
  const r1 = compute(NN, {
    C1: { d1: 'DC', d2: 'DC' }, A1: { d1: 'D', d2: 'D' }, X: { d1: 'D', d2: 'D' },
    E1: { d1: 'EC', d2: 'E' }, E2: { d1: 'E', d2: 'E' }, E3: { d1: 'E', d2: 'E' },
    W: { d1: 'E', d2: 'D' }, Q: { d1: 'OF', d2: 'D' },
  }, ['d1', 'd2'], { roomsFor });
  assert.equal(r1.byDay.d1.E.labels.C, 'W');
  assert.equal(r1.byDay.d1.D.labels.B, 'X');
  assert.equal(r1.byDay.d2.D.labels.D, 'X', '원칙1(X, 5~10)이 6~9를 이어봐야 한다');
  assert.equal(r1.byDay.d2.D.labels.C, 'W', '근무 변경자(W)는 남은 5,10,11');
  // W 이틀 전 D 4인 C(6~10), 어제 OF → 오늘 D (원칙3 오프 복귀)
  const r2 = compute(NN, {
    C1: { d0: 'DC', d1: 'DC', d2: 'DC' }, A1: { d0: 'D', d1: 'D', d2: 'D' },
    E1: { d0: 'D', d1: 'E', d2: 'E' }, W: { d0: 'D', d1: 'OF', d2: 'D' },
    X: { d0: 'OF', d1: 'D', d2: 'D' }, Q: { d0: 'OF', d1: 'OF', d2: 'D' },
  }, ['d0', 'd1', 'd2'], { roomsFor });
  assert.equal(r2.byDay.d0.D.labels.C, 'W');
  assert.equal(r2.byDay.d1.D.labels.B, 'X');
  assert.equal(r2.byDay.d2.D.labels.D, 'X', '오프 복귀자가 전일 근무자의 방을 빼앗으면 안 된다');
  assert.equal(r2.byDay.d2.D.labels.C, 'W');
  // 전일 근무자가 두 자리에 무차별하면 여전히 낮은 등급이 원래 방을 되찾는다 (등급 안에서만 합산)
  const r4 = compute(NN, {
    C1: { d0: 'DC', d1: 'DC', d2: 'DC' }, A1: { d0: 'D', d1: 'D', d2: 'D' },
    E1: { d0: 'D', d1: 'OF', d2: 'D' }, X: { d0: 'OF', d1: 'D', d2: 'D' },
  }, ['d0', 'd1', 'd2'], { roomsFor });
  assert.equal(r4.byDay.d0.D.labels.B, 'E1');       // 이틀 전 4,5,11
  assert.equal(r4.byDay.d2.D.labels.B, 'E1', '오프 복귀자가 보던 4,5(3인 A=2,3,4,11 겹침)을 되찾는다');

  // 병상수 기준(opts.bedsOf): 5·10호가 5인실, 6~9호가 1인실이면 X에게는
  // 5,10,11(겹침 10병상)이 6~9(4병상)보다 같이 보던 환자가 더 많다
  const beds = { 5: 5, 10: 5, 11: 2, 6: 1, 7: 1, 8: 1, 9: 1 };
  const solo = { C1: { d1: 'DC', d2: 'DC' }, A1: { d1: 'D', d2: 'D' }, X: { d1: 'D', d2: 'D' },
                 Q: { d1: 'OF', d2: 'D' }, W: { d1: 'OF', d2: 'D' } };
  assert.equal(compute(NN, solo, ['d1', 'd2'], { roomsFor }).byDay.d2.D.labels.D, 'X');           // 방 개수: 4 > 2
  assert.equal(compute(NN, solo, ['d1', 'd2'], { roomsFor, bedsOf: t => beds[t] || 1 }).byDay.d2.D.labels.C, 'X'); // 병상수: 10 > 4
}

/* ── 병상 단위 토큰 (2026-09-18) — 한 병실을 둘이 나눠 볼 때 ────────────────
 * 코어는 방 토큰을 문자열로만 다루므로 '1001:1' 같은 병상 키를 그대로 넣을 수 있다.
 * standalone 은 코어에 넘기기 전 늘 병상 키로 펼친다(방 표기와 섞이면 같은 환자인데
 * 문자열이 달라 겹침이 0이 되기 때문). 여기서는 그 입력 형태로 이어짐을 확인한다. */
{
  const NN = ['C1','A1','B1','X','W'].map((id, i) => ({ id, seniority: i, chargeCapable: { D: i === 0 } }));
  // 5인 근무: 1호(5병상)를 A(1~3)·B(4,5)가 나눠 본다. 4인이 되면 1호를 A 가 통째로 본다.
  const rooms5 = { 차지: ['12:1','13:1','14:1'], A: ['1:1','1:2','1:3','2:1'], B: ['1:4','1:5','3:1'],
                   C: ['5:1','10:1','11:1'], D: ['6:1','7:1','8:1','9:1'] };
  const rooms4 = { 차지: ['12:1','13:1','14:1'], A: ['1:1','1:2','1:3','1:4','1:5','2:1'],
                   B: ['3:1','5:1','11:1'], C: ['6:1','7:1','8:1','9:1','10:1'] };
  const roomsFor = (P, cnt, label) => ((cnt >= 5 ? rooms5 : rooms4)[label] || []).slice();

  // 이틀 연속 5인 — 나눠 본 사람이 같은 병상을 이어받는다
  const r5 = compute(NN, {
    C1: { d1: 'DC', d2: 'DC' }, A1: { d1: 'D', d2: 'D' }, B1: { d1: 'D', d2: 'D' },
    X: { d1: 'D', d2: 'D' }, W: { d1: 'D', d2: 'D' },
  }, ['d1', 'd2'], { roomsFor });
  for (const n of ['A1','B1','X','W'])
    assert.equal(r5.byDay.d2.D.labels[
      Object.keys(r5.byDay.d2.D.labels).find(l => r5.byDay.d2.D.labels[l] === n)],
      n, '5인 이틀 — 자리가 유지돼야 한다');
  const seat1 = Object.keys(r5.byDay.d1.D.labels).find(l => r5.byDay.d1.D.labels[l] === 'X');
  assert.equal(r5.byDay.d2.D.labels[seat1], 'X', '나눠 본 병상을 그대로 이어받는다');

  // 5인 → 4인: 전날 1호 1~3번 병상(A)을 보던 사람이 1호 전체를 보는 A 를 가져간다
  const r54 = compute(NN, {
    C1: { d1: 'DC', d2: 'DC' }, A1: { d1: 'D', d2: 'D' }, B1: { d1: 'D', d2: 'D' },
    X: { d1: 'D', d2: 'D' }, W: { d1: 'D', d2: 'OF' },
  }, ['d1', 'd2'], { roomsFor });
  const aDay1 = r54.byDay.d1.D.labels.A, bDay1 = r54.byDay.d1.D.labels.B;
  assert.equal(r54.byDay.d2.D.labels.A, aDay1, '1:1~3 을 보던 사람이 1호 전체(A)를 이어받는다');
  assert.notEqual(r54.byDay.d2.D.labels.A, bDay1, '1:4~5 만 보던 사람이 A 를 가져가면 안 된다');

  // 병상 키는 하나가 환자 한 명 — bedsOf 없이도 겹침이 곧 환자 수
  const r5b = compute(NN, {
    C1: { d1: 'DC', d2: 'DC' }, A1: { d1: 'D', d2: 'D' }, B1: { d1: 'D', d2: 'D' },
    X: { d1: 'D', d2: 'D' }, W: { d1: 'D', d2: 'D' },
  }, ['d1', 'd2'], { roomsFor, bedsOf: () => 1 });
  assert.deepEqual(r5b.byDay.d2.D.labels, r5.byDay.d2.D.labels, 'bedsOf=1 과 같은 결과여야 한다');
}

/* ── 방이 고정이 아닌 차지 (opts.chargeSeats, 102 병동 CRN — 2026-10-01) ──
 * 102 는 CRN 이 어느 방이든 본다(standalone crnSeats = 종이의 자리 전부). 차지를 첫 자리에 못 박으면 CRN 이
 * 바뀌는 날마다 새 CRN 이 첫 자리로 끌려가고 그 자리 사람이 밀려 뒤가 하나도 이어지지 않았다. 여기서는 자리 넷
 * (차지·A·B·C = 종이의 A·B·C·D), 자리마다 병실이 고정. 코어의 '허락 밖 자리' 처리도 보려고 대부분은 허락 자리를
 * 앞 세 자리로 준다 — 102 실제처럼 넷 다 주는 경우는 바로 아래 묶음. */
{
  const R4 = { 차지: ['1', '2', '3'], A: ['4', '5', '6'], B: ['7', '8', '9'], C: ['10', '11', '12'] };
  const base = { maxSeats: 4, roomsFor: (P, cnt, l) => (R4[l] || []).slice(), chargeSeats: () => ['차지', 'A', 'B'] };
  const seatOf = (r, dk, id) => Object.keys(r.byDay[dk].D.labels).find(l => r.byDay[dk].D.labels[l] === id);

  // CRN 이 바뀌어도 아무도 자리를 옮기지 않는다 — 새 CRN(Y)은 어제 보던 A 를 그대로, 빈 첫 자리에는 복귀자
  {
    const NS = ['X', 'Y', 'Z', 'W', 'V'].map((id, i) => N(id, i));
    const sch = { X: { d1: 'D', d2: 'OF', d3: 'D' }, Y: { d1: 'D', d2: 'D', d3: 'D' }, Z: { d1: 'D', d2: 'D', d3: 'D' },
                  W: { d1: 'D', d2: 'D', d3: 'D' }, V: { d1: 'OF', d2: 'D', d3: 'OF' } };
    const r = compute(NS, sch, ['d1', 'd2', 'd3'], base);
    assert.deepEqual(r.byDay.d1.D.labels, { 차지: 'X', A: 'Y', B: 'Z', C: 'W' });
    assert.equal(r.byDay.d1.D.charge, 'X');
    assert.deepEqual(r.byDay.d2.D.labels, { 차지: 'V', A: 'Y', B: 'Z', C: 'W' }, 'CRN 이 Y 로 바뀌어도 Y 는 A 에 그대로');
    assert.equal(r.byDay.d2.D.charge, 'Y');
    assert.equal(r.byNurse.Y.d2.charge, true);
    assert.ok(!r.byNurse.V.d2.charge, '첫 자리에 앉았다고 차지가 되지 않는다');
    assert.deepEqual(r.byDay.d3.D.labels, { 차지: 'X', A: 'Y', B: 'Z', C: 'W' }, 'X 가 돌아와 CRN — 제 자리로, 나머지 그대로');
    assert.equal(r.byDay.d3.D.charge, 'X');
    // 자리가 고정이던 때(차지 = 첫 자리)는 d2 에 Y 가 첫 자리로 끌려갔다 — 그게 이 버그
    const old = compute(NS, sch, ['d1', 'd2', 'd3'], { maxSeats: 4, roomsFor: base.roomsFor });
    assert.equal(old.byDay.d2.D.labels['차지'], 'Y');
  }

  // 102 실제 — CRN 은 넷째 자리(종이의 D)도 본다. 어제 D 를 본 사람이 오늘 CRN 이면 D 그대로, 아무도 안 밀린다
  {
    const all4 = Object.assign({}, base, { chargeSeats: () => ['차지', 'A', 'B', 'C'] });
    const NS = ['X', 'W', 'Y', 'Z', 'V'].map((id, i) => N(id, i));
    const sch = { X: { d1: 'D', d2: 'OF', d3: 'OF' }, W: { d1: 'D', d2: 'D', d3: 'D' }, Y: { d1: 'D', d2: 'D', d3: 'D' },
                  Z: { d1: 'D', d2: 'D', d3: 'D' }, V: { d1: 'OF', d2: 'D', d3: 'D' } };
    const ov = { d1: { D: { Y: 'A', Z: 'B', W: 'C' } } };
    const r = compute(NS, sch, ['d1', 'd2', 'd3'], Object.assign({ overrides: ov }, all4));
    assert.deepEqual(r.byDay.d2.D.labels, { 차지: 'V', A: 'Y', B: 'Z', C: 'W' }, 'CRN W 는 어제 본 넷째 자리 그대로');
    assert.equal(r.byDay.d2.D.charge, 'W');
    assert.deepEqual(r.byDay.d3.D.labels, r.byDay.d2.D.labels, '다음 날도 그대로');
    assert.equal(r.byDay.d3.D.charge, 'W');
    // 허락 자리가 앞 셋뿐이던 때는 W 가 넷째 자리를 떠나 첫 자리로 갔다 — 이번 고침
    const r3 = compute(NS, sch, ['d1', 'd2'], Object.assign({ overrides: ov }, base));
    assert.equal(seatOf(r3, 'd2', 'W'), '차지');
  }

  // 손으로 CRN 을 B 로 옮긴 다음 날 — CRN 은 B, 첫 자리 사람은 첫 자리 그대로 (예전엔 둘이 다시 뒤바뀜)
  {
    const NS = ['X', 'Y', 'Z', 'W'].map((id, i) => N(id, i));
    const sch = { X: { d1: 'D', d2: 'D' }, Y: { d1: 'D', d2: 'D' }, Z: { d1: 'D', d2: 'D' }, W: { d1: 'D', d2: 'D' } };
    const ov = { d1: { D: { X: 'A', Y: '차지' } } };
    const r = compute(NS, sch, ['d1', 'd2'], Object.assign({ overrides: ov }, base));
    assert.equal(r.byDay.d1.D.charge, 'X', '자리를 바꿔도 CRN 은 X');
    assert.equal(seatOf(r, 'd2', 'X'), 'A', 'CRN 이 어제 본 B 방(A 자리)을 이어 본다');
    assert.equal(seatOf(r, 'd2', 'Y'), '차지');
    assert.equal(r.byDay.d2.D.charge, 'X');
  }

  // 어제 넷째 자리(차지 못 앉는 자리)를 본 사람이 오늘 CRN — 아무도 밀리지 않는 빈 자리로
  {
    const NS = ['X', 'W', 'Y', 'Z', 'V'].map((id, i) => N(id, i));
    const sch = { X: { d1: 'D', d2: 'OF' }, W: { d1: 'D', d2: 'D' }, Y: { d1: 'D', d2: 'D' },
                  Z: { d1: 'D', d2: 'D' }, V: { d1: 'OF', d2: 'D' } };
    const ov = { d1: { D: { Y: 'A', Z: 'B', W: 'C' } } };
    const r = compute(NS, sch, ['d1', 'd2'], Object.assign({ overrides: ov }, base));
    assert.deepEqual(r.byDay.d2.D.labels, { 차지: 'W', A: 'Y', B: 'Z', C: 'V' });
    assert.equal(r.byDay.d2.D.charge, 'W');
  }

  // 빈 자리가 없으면 CRN 은 그래도 앞 세 자리 — 밀리는 사람은 한 명, 넷째 자리로
  {
    const NS = ['W', 'X', 'Y', 'Z'].map((id, i) => N(id, i));
    const sch = { W: { d1: 'D', d2: 'D' }, X: { d1: 'D', d2: 'D' }, Y: { d1: 'D', d2: 'D' }, Z: { d1: 'D', d2: 'D' } };
    const ov = { d1: { D: { X: '차지', Y: 'A', Z: 'B', W: 'C' } } };
    const r = compute(NS, sch, ['d1', 'd2'], Object.assign({ overrides: ov }, base));
    assert.equal(r.byDay.d2.D.charge, 'W');
    assert.ok(['차지', 'A', 'B'].includes(seatOf(r, 'd2', 'W')), 'CRN 은 넷째 자리에 남지 않는다');
    assert.equal(Object.values(r.byDay.d2.D.labels).filter(id => seatOf(r, 'd1', id) !== seatOf(r, 'd2', id)).length, 2,
      'CRN 과 밀린 한 사람만 자리가 바뀐다');
  }

  // DC 표시자 — 표시된 사람이 CRN, 자리는 제 자리 그대로
  {
    const NS = ['X', 'Y', 'Z', 'W'].map((id, i) => N(id, i));
    const sch = { X: { d1: 'D', d2: 'D' }, Y: { d1: 'D', d2: 'D' }, Z: { d1: 'D', d2: 'DC' }, W: { d1: 'D', d2: 'D' } };
    const r = compute(NS, sch, ['d1', 'd2'], base);
    assert.equal(r.byDay.d2.D.charge, 'Z');
    assert.deepEqual(r.byDay.d2.D.labels, r.byDay.d1.D.labels, '표시자가 바뀌어도 자리는 그대로');
  }

  // 병실 정보가 없을 때(방 구성 비어 있음) — 자리 이름으로 이어진다
  {
    const NS = ['X', 'Y', 'Z', 'W', 'V'].map((id, i) => N(id, i));
    const sch = { X: { d1: 'D', d2: 'OF' }, Y: { d1: 'D', d2: 'D' }, Z: { d1: 'D', d2: 'D' },
                  W: { d1: 'D', d2: 'D' }, V: { d1: 'OF', d2: 'D' } };
    const r = compute(NS, sch, ['d1', 'd2'], { maxSeats: 4, chargeSeats: () => ['차지', 'A', 'B'] });
    assert.deepEqual(r.byDay.d2.D.labels, { 차지: 'V', A: 'Y', B: 'Z', C: 'W' });
    assert.equal(r.byDay.d2.D.charge, 'Y');
  }

  // 자리가 고정인 서식(chargeSeats 없음)도 누가 차지인지 준다 — 늘 첫 자리 사람
  {
    const NS = ['X', 'Y', 'Z'].map((id, i) => N(id, i));
    const r = compute(NS, { X: { d1: 'D' }, Y: { d1: 'DC' }, Z: { d1: 'D' } }, ['d1']);
    assert.equal(r.byDay.d1.D.charge, r.byDay.d1.D.labels['차지']);
    assert.equal(r.byNurse.Y.d1.charge, true);
  }

  // 교차 검토 (2026-10-01) ① — 자리 이름만 같고 방이 옮겨 간 자리는 연속성이 아니다.
  // 어제 같은 근무 A(4~7호)를 본 박은 오늘 차지 자리(1~7호)에 앉아야 방을 이어 본다. 오프 복귀 CRN 김이 1~3호를 보던
  // 사람이라도 원칙 1 인 박이 앞선다. 예전엔 박에게 'A 그대로'를 원칙1 점수로 쳐 줘 김이 1~7호를 가져갔다.
  {
    const R = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(String(i)); return o; };
    const lay = { 차지: R(1, 7), A: R(8, 14) };
    const NS = [{ id: '김', seniority: 0, chargeCapable: true }, { id: '박', seniority: 2, chargeCapable: false }];
    const seed = { 김: { label: '차지', period: 'N', idx: -3, rooms: R(1, 3) }, 박: { label: 'A', period: 'N', idx: -1, rooms: R(4, 7) } };
    const r = compute(NS, { 김: { d: 'N' }, 박: { d: 'N' } }, ['d'],
      { roomsFor: (P, cnt, l) => (lay[l] || []).slice(), seed, chargeSeats: () => ['차지', 'A'] });
    assert.deepEqual(r.byDay.d.N.labels, { 차지: '박', A: '김' }, '박이 보던 4~7호를 이어 본다');
    assert.equal(r.byDay.d.N.charge, '김');
  }

  // 교차 검토 ② — 원칙4(오프 복귀 튕기기)는 CRN 에게도. 남을 밀어내지 않을 때만 전에 보던 방을 피한다
  {
    const R = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(String(i)); return o; };
    const lay = { 차지: R(1, 3), A: R(4, 7), B: R(8, 11), C: R(12, 14) };
    const NS = ['김', '이', '박', '최'].map((id, i) => ({ id, seniority: i, chargeCapable: i < 2 }));
    const sch = {}; for (const n of NS) sch[n.id] = { d: 'D' };
    const rules = { keepSameShift: true, keepAcrossShift: true, keepAfterOff: false, bounceAfterOff: true };
    const o = { roomsFor: (P, cnt, l) => (lay[l] || []).slice(), rules, chargeSeats: () => ['차지', 'A', 'B', 'C'] };
    const r1 = compute(NS, sch, ['d'], Object.assign({ seed: { 김: { label: '차지', period: 'D', idx: -3, rooms: R(1, 3) } } }, o));
    assert.notEqual(Object.keys(r1.byDay.d.D.labels).find(l => r1.byDay.d.D.labels[l] === '김'), '차지', 'CRN 도 쉬고 오면 1~3호를 피한다');
    const r2 = compute(NS, sch, ['d'], Object.assign({ seed: {
      김: { label: '차지', period: 'D', idx: -3, rooms: R(1, 3) }, 이: { label: 'A', period: 'D', idx: -1, rooms: R(4, 7) },
      박: { label: 'B', period: 'D', idx: -1, rooms: R(8, 11) }, 최: { label: 'C', period: 'D', idx: -1, rooms: R(12, 14) } } }, o));
    assert.deepEqual(r2.byDay.d.D.labels, { 차지: '김', A: '이', B: '박', C: '최' }, '어제 근무자를 밀어내면서까지 튕기지는 않는다');
  }

  // 방이 다 바뀌어 아무도 이어 보지 못하는 날 — CRN 은 어제 자리 이름 그대로 (이유 없이 첫 자리로 가지 않는다)
  {
    const NS = ['X', 'Y', 'Z'].map((id, i) => N(id, i));
    const seed = { X: { label: 'B', period: 'D', idx: -1, rooms: ['90'] }, Y: { label: '차지', period: 'D', idx: -1, rooms: ['91'] },
                   Z: { label: 'A', period: 'D', idx: -1, rooms: ['92'] } };
    const r = compute(NS, { X: { d: 'D' }, Y: { d: 'D' }, Z: { d: 'D' } }, ['d'],
      { maxSeats: 3, seed, roomsFor: (P, cnt, l) => ({ 차지: ['1'], A: ['2'], B: ['3'] }[l] || []), chargeSeats: () => ['차지', 'A', 'B'] });
    assert.equal(r.byDay.d.D.charge, 'X');
    assert.equal(seatOf(r, 'd', 'X'), 'B');
  }

  // 머지 뒤 교차 검토 (2026-10-01) ① — CRN 자리는 나머지 배정을 실제로 돌려 보고 고른다.
  // 지난 어싸인 직접 입력(자리 이름만, 방 없음)으로 시작한 둘째 날: CRN 김이 B 에 앉으면 원칙1 이(어제 8~9호)가
  // 4~7호로 밀리고 박(오프 복귀, 어제 A)도 A 를 못 받는다. 예전 점수는 박이 A 를 받는다고 셌지만 실제로는 이가 먼저 가져갔다.
  {
    const R = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(String(1000 + i)); return o; };
    const preset = { mon: { 차지: R(1, 3), A: R(8, 9), B: R(10, 11), C: R(4, 7).concat(R(12, 14)) },
                     tue: { 차지: R(1, 3), A: R(4, 7), B: R(8, 11), C: R(12, 14) } };
    const NS = ['kim', 'lee', 'park', 'choi', 'jung', 'yoon'].map((id, i) => ({ id, seniority: i, chargeCapable: i === 0 }));
    const sch = { kim: { mon: 'D', tue: 'D' }, lee: { mon: 'D', tue: 'D' }, park: { mon: 'OF', tue: 'D' },
                  choi: { mon: 'OF', tue: 'D' }, jung: { mon: 'D', tue: 'OF' }, yoon: { mon: 'D', tue: 'OF' } };
    const seed = { kim: { label: 'B', period: 'D', idx: -1 }, lee: { label: 'A', period: 'D', idx: -1 }, park: { label: 'A', period: 'D', idx: -1 } };
    const r = compute(NS, sch, ['mon', 'tue'], { roomsFor: (P, cnt, l, dk) => (preset[dk][l] || []).slice(), seed, chargeSeats: () => ['차지', 'A', 'B', 'C'] });
    // 박은 어느 쪽이든 A 를 받는다(다듬기가 놓친 것을 잡는다). B(8~11호)는 김(어제 10~11호)과 이(어제 8~9호)가 겹침이 같아
    // 둘 중 하나만 잇는다 — 같으면 선임(보통 간호사끼리와 같은 규칙). 예전엔 김이 B 에 앉으면 박이 A 를 못 받아 김이 차지 자리로 갔다
    assert.deepEqual(r.byDay.tue.D.labels, { 차지: 'lee', A: 'park', B: 'kim', C: 'choi' }, '김은 10~11호를 잇고 박은 A 를 받는다');
    assert.equal(r.byDay.tue.D.charge, 'kim');
  }

  // 교차 검토 ② — 주지 않을 방이 먼저다. 점수가 같다고 CRN 이 첫 자리에 앉아 금지 방을 남에게 떠넘기지 않는다
  // (회피 복구는 CRN 을 옮기지 않으므로, 자리를 고를 때 이미 피해야 한다)
  {
    const R = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(String(1000 + i)); return o; };
    const pre = { 2: { 차지: R(1, 7), A: R(8, 14) }, 3: { 차지: R(1, 5), A: R(6, 9), B: R(10, 14) } };
    const NS = ['kim', 'lee', 'park'].map((id, i) => ({ id, seniority: i, chargeCapable: i === 0 }));
    const o = { roomsFor: (P, cnt, l) => (pre[cnt][l] || []).slice(), chargeSeats: () => ['차지', 'A', 'B'] };
    const r2 = compute(NS, { kim: { d: 'N' }, lee: { d: 'N' }, park: { d: 'OF' } }, ['d'], Object.assign({ avoid: { d: { N: { lee: ['A'] } } } }, o));
    assert.deepEqual(r2.byDay.d.N.labels, { 차지: 'lee', A: 'kim' }, '둘 근무 — 이는 금지 방이 있는 A 를 피한다');
    assert.equal(r2.byDay.d.N.charge, 'kim');
    const r3 = compute(NS, { kim: { d: 'N' }, lee: { d: 'N' }, park: { d: 'N' } }, ['d'], Object.assign({ avoid: { d: { N: { lee: ['A', 'B'] } } } }, o));
    assert.equal(r3.byDay.d.N.labels['차지'], 'lee', '셋 근무 — 이에게 남는 자리는 차지 자리뿐');
    // 원칙1 인 사람도 지킨다 — 박이 B·C 를 못 받으면 CRN 이 B 나 C 로 가서 이가 1~3호를 그대로 본다
    const today = { 차지: R(1, 3), A: R(4, 7), B: R(8, 11), C: R(12, 14) };
    const N4 = ['kim', 'lee', 'park', 'choi'].map((id, i) => ({ id, seniority: i, chargeCapable: i === 0 }));
    const s4 = {}; for (const n of N4) s4[n.id] = { d: 'D' };
    const r4 = compute(N4, s4, ['d'], { roomsFor: (P, cnt, l) => (today[l] || []).slice(), maxSeats: 4,
      seed: { lee: { label: '차지', period: 'D', idx: -1, rooms: R(1, 3) } }, avoid: { d: { D: { park: ['B', 'C'] } } },
      chargeSeats: () => ['차지', 'A', 'B', 'C'] });
    const d4 = r4.byDay.d.D.labels;
    assert.equal(d4['차지'], 'lee', '이는 1~3호 그대로');
    assert.equal(d4.A, 'park', '박은 금지 방이 없는 A');
    assert.ok(['B', 'C'].includes(seatOf(r4, 'd', 'kim')));
  }

  // 교차 검토 ③ — 이어 볼 것이 없으면 CRN 은 차지가 아닐 때 앉았을 자리. 첫날 막내에게 CRN 을 맡겨도 아무도 밀리지 않는다
  // (예전엔 점수가 같으면 첫 자리로 가 모두가 한 칸씩 밀렸고, 다음 날까지 이어졌다)
  {
    const lay = { 차지: ['1', '2'], A: ['3', '4'], B: ['5', '6'], C: ['7', '8'] };
    const NS = ['ga', 'na', 'da', 'ra'].map((id, i) => ({ id, seniority: i, chargeCapable: true }));
    const o = { roomsFor: (P, cnt, l) => (lay[l] || []).slice(), maxSeats: 4, chargeSeats: () => ['차지', 'A', 'B', 'C'] };
    const base0 = compute(NS, { ga: { d: 'D' }, na: { d: 'D' }, da: { d: 'D' }, ra: { d: 'D' } }, ['d'], o);
    assert.deepEqual(base0.byDay.d.D.labels, { 차지: 'ga', A: 'na', B: 'da', C: 'ra' });
    for (const who of ['na', 'da', 'ra']) {
      const sch = { ga: { d: 'D' }, na: { d: 'D' }, da: { d: 'D' }, ra: { d: 'D' } }; sch[who] = { d: 'DC' };
      const r = compute(NS, sch, ['d'], o);
      assert.equal(r.byDay.d.D.charge, who);
      assert.deepEqual(r.byDay.d.D.labels, base0.byDay.d.D.labels, who + ' 에게 CRN — 자리는 그대로');
    }
    // 이어 보던 사람이 있어도 — 새 CRN 이 이어 볼 방이 없으면(어제 방은 원칙1 인 사람이 지킨다) 차지가 아닐 때 자리
    const seed = { na: { label: 'A', period: 'D', idx: -1, rooms: ['3', '4'] }, da: { label: 'B', period: 'D', idx: -1, rooms: ['5', '6'] } };
    const s1 = { ga: { d: 'D' }, na: { d: 'D' }, da: { d: 'D' }, ra: { d: 'D' } };
    const reg = compute(NS, s1, ['d'], Object.assign({ seed }, o));
    s1.ra = { d: 'DC' };
    const r = compute(NS, s1, ['d'], Object.assign({ seed }, o));
    assert.equal(r.byDay.d.D.charge, 'ra');
    assert.deepEqual(r.byDay.d.D.labels, reg.byDay.d.D.labels, '막내 ra 에게 CRN — 아무도 안 밀린다');
  }

  // 여러 날 무작위 — CRN 은 늘 앞 세 자리, 모두 한 번씩만 앉고, 자리는 비지 않는다
  {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const NS = ids.map((id, i) => N(id, i, i < 4));
    const days = Array.from({ length: 30 }, (_, i) => 'k' + String(i).padStart(2, '0'));
    const sch = {};
    for (const id of ids) { sch[id] = {}; for (const dk of days) sch[id][dk] = rnd() < 0.6 ? 'D' : 'OF'; }
    const r = compute(NS, sch, days, base);
    let checked = 0;
    for (const dk of days) {
      const day = r.byDay[dk] && r.byDay[dk].D; if (!day) continue;
      const seated = Object.values(day.labels), on = ids.filter(id => sch[id][dk] === 'D');
      assert.equal(seated.length + day.extra.length, on.length, dk + ' 모두 한 번씩');
      assert.equal(new Set(seated).size, seated.length);
      const cs = Object.keys(day.labels).find(l => day.labels[l] === day.charge);
      assert.ok(['차지', 'A', 'B'].includes(cs), dk + ' CRN 자리 ' + cs);
      checked++;
    }
    assert.ok(checked > 20);
  }
}

// ── 원칙·차지 검증 (2026-10-01) — 다듬기는 움직일 수 있는 자리 전부를 따져 본다 ──
{
  const R = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(String(1000 + i)); return o; };
  const S5 = { 차지: R(1, 2), A: R(3, 5), B: R(6, 8), C: R(9, 11), D: R(12, 14) };
  const S4 = { 차지: R(1, 3), A: R(4, 7), B: R(8, 11), C: R(12, 14) };
  const rf = (P, cnt, l) => ((cnt >= 5 ? S5 : S4)[l] || []).slice();
  const seat = (r, dk, id, P = 'D') => Object.keys(r.byDay[dk][P].labels).find(l => r.byDay[dk][P].labels[l] === id) || null;
  const ON4 = { keepSameShift: true, keepAcrossShift: true, keepAfterOff: false, bounceAfterOff: true };
  const NS = ['가', '나', '다', '라', '마', '바', '사'].map((id, i) => N(id, i));

  // 주지 않을 방을 피하려고 맞바꿀 때 원칙1 을 깨지 않는다 — 어제 같은 근무였던 나·마는 제자리, 새로 온 둘이 B·C 를 나눈다.
  // (예전엔 금지 방에 앉은 사를 '처음 만난' 상대 — 이어 보던 마 — 와 맞바꿨다)
  {
    const sch = { 가: { d1: 'DC', d2: 'DC' }, 나: { d1: 'D', d2: 'D' }, 다: { d1: 'D', d2: 'OF' }, 라: { d1: 'D', d2: 'OF' },
      마: { d1: 'D', d2: 'D' }, 바: { d1: 'OF', d2: 'D' }, 사: { d1: 'OF', d2: 'D' } };
    const r = compute(NS, sch, ['d1', 'd2'], { roomsFor: rf, avoid: { d2: { D: { 사: ['C'] } } } });
    assert.equal(seat(r, 'd2', '나'), seat(r, 'd1', '나'), '나 원칙1');
    assert.equal(seat(r, 'd2', '마'), seat(r, 'd1', '마'), '마 원칙1');
    assert.notEqual(seat(r, 'd2', '사'), 'C', '사는 금지 방을 피한다');
  }
  // 셋이 돌아가며 바꿔야 풀리는 금지 방 — 둘씩 맞바꾸기로는 못 풀었다('대안이 없습니다'가 거짓이었다)
  {
    const N5 = ['가', '나', '다', '라', '마'].map((id, i) => N(id, i, i === 0));
    const sch = {}; for (const n of N5) sch[n.id] = { d: 'D' };
    const av = { 나: ['C', 'D'], 다: ['B', 'C', 'D'] };
    const r = compute(N5, sch, ['d'], { avoid: { d: { D: av } } });
    const lab = r.byDay.d.D.labels;
    assert.deepEqual(Object.entries(lab).filter(([l, id]) => (av[id] || []).includes(l)), [], '금지 방 0');
    assert.equal(lab['차지'], '가');
  }
  // 원칙4 — 자리 고정(101·122): 어제 차지였던 가는 오늘 이어 볼 것이 없다. 쉬고 온 다가 전에 보던 방(B)으로 돌아가지 않는다
  {
    const sch = { 가: { d1: 'DC', d2: 'DC', d3: 'D' }, 나: { d1: 'D', d2: 'D', d3: 'DC' }, 다: { d1: 'D', d2: 'OF', d3: 'D' },
      라: { d1: 'D', d2: 'D', d3: 'D' }, 마: { d1: 'D', d2: 'D', d3: 'D' }, 바: { d1: 'OF', d2: 'D', d3: 'OF' } };
    const r = compute(NS.slice(0, 6), sch, ['d1', 'd2', 'd3'], { rules: ON4, roomsFor: rf });
    assert.notEqual(seat(r, 'd3', '다'), seat(r, 'd1', '다'), '다는 튕긴다');
    for (const id of ['라', '마']) assert.equal(seat(r, 'd3', id), seat(r, 'd2', id), id + ' 원칙1');
    // 원칙4 를 끄면(원칙3 도 끈 채) 아무 차이 없음이 아니라 — 원칙3 을 켜면 다는 B 로 돌아간다
    const r3 = compute(NS.slice(0, 6), sch, ['d1', 'd2', 'd3'], { roomsFor: rf });
    assert.equal(seat(r3, 'd3', '다'), seat(r3, 'd1', '다'), '원칙3: 다는 B 그대로');
  }
  // 원칙4 — 자리가 고정이 아닌 CRN(102): CRN 자리를 고를 때 다른 사람의 튕김도 센다
  {
    const sch = { 가: { d1: 'OF', d2: 'OF', d3: 'DC' }, 나: { d1: 'DC', d2: 'DC', d3: 'OF' }, 다: { d1: 'D', d2: 'OF', d3: 'D' },
      라: { d1: 'D', d2: 'D', d3: 'D' }, 마: { d1: 'D', d2: 'D', d3: 'D' }, 바: { d1: 'OF', d2: 'D', d3: 'OF' } };
    const r = compute(NS.slice(0, 6), sch, ['d1', 'd2', 'd3'],
      { rules: ON4, roomsFor: (P, cnt, l) => (S4[l] || []).slice(), maxSeats: 4, chargeSeats: () => ['차지', 'A', 'B', 'C'] });
    const b = seat(r, 'd1', '다'), a = seat(r, 'd3', '다');
    assert.equal(S4[b].filter(x => S4[a].includes(x)).length, 0, '다는 전에 보던 방을 피한다');
    assert.equal(r.byDay.d3.D.charge, '가');
  }
  // 원칙4 는 헬퍼를 정하지 않는다 — 자리보다 사람이 많은 날 헬퍼는 늘 막내
  {
    const sch = { 가: { d1: 'DC', d2: 'DC', d3: 'DC' }, 나: { d1: 'D', d2: 'D', d3: 'D' }, 다: { d1: 'D', d2: 'OF', d3: 'D' },
      라: { d1: 'D', d2: 'D', d3: 'D' }, 마: { d1: 'D', d2: 'D', d3: 'D' }, 바: { d1: 'OF', d2: 'OF', d3: 'D' } };
    const r4 = compute(NS.slice(0, 6), sch, ['d1', 'd2', 'd3'], { rules: ON4, roomsFor: rf });
    assert.deepEqual(r4.byDay.d3.D.extra, ['바']);
  }
  // 원칙3·4 를 둘 다 꺼 두면 쉬고 온 사람의 지난 기록은 결과를 바꾸지 않는다
  {
    const sch = {}; for (const n of NS.slice(0, 5)) sch[n.id] = { d: 'D' };
    const off = { keepSameShift: true, keepAcrossShift: true, keepAfterOff: false, bounceAfterOff: false };
    const seed = { 나: { label: 'A', period: 'D', idx: -1, rooms: S5.A }, 다: { label: 'B', period: 'D', idx: -3, rooms: S5.B } };
    const a = compute(NS.slice(0, 5), sch, ['d'], { rules: off, roomsFor: rf, seed });
    const b = compute(NS.slice(0, 5), sch, ['d'], { rules: off, roomsFor: rf, seed: { 나: seed.나 } });
    assert.deepEqual(a.byDay.d, b.byDay.d);
  }
  // 차지 표시가 둘이면 명부 배열 순서가 아니라 선임
  {
    const N3 = [N('다', 2), N('나', 1), N('가', 0)];
    for (const cs of [null, () => ['차지', 'A', 'B']]) {
      const r = compute(N3, { 가: { d: 'D' }, 나: { d: 'DC' }, 다: { d: 'DC' } }, ['d'], cs ? { chargeSeats: cs } : {});
      assert.equal(r.byDay.d.D.charge, '나');
    }
  }
}

/* ── 같은 그룹끼리 인계 피하기 (opts.handoverGroups — 2026-10-09) ────────────────
 * 갓 독립한 신규끼리 D→E, E→N, N→D 로 같은 환자를 주고받지 않게 한다. 앞 근무(D ← 전날 N, E ← D, N ← E)는
 * 이미 정해진 것으로 보고 뒤 근무가 피한다. 잣대는 넘겨받는 병상 수(bedsOf). 사전식으로
 * 주지 않을 방 > 같은 그룹 인계 > 원칙 1~3 > 헬퍼는 후임 > … — 누가 차지인지는 바꾸지 않고 손으로 고정한 자리도 그대로.
 * 피하지 못한 인계는 byDay[dk][P].handover = [{from, to, rooms}]. */
{
  const R = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(String(i)); return o; };
  // 셋 근무 방 구성 — 모든 근무가 같다: 차지 1~4 · A 5~9 · B 10~14
  const L3 = { 차지: R(1, 4), A: R(5, 9), B: R(10, 14) };
  const rf3 = (P, cnt, l) => (L3[l] || []).slice();
  const seatOf = (r, dk, P, id) => Object.keys(r.byDay[dk][P].labels).find(l => r.byDay[dk][P].labels[l] === id) || null;
  const NEW = { 신1: ['신규'], 신2: ['신규'] };
  // 가·나·다·라 = 차지 가능한 선배, 신1·신2 = 갓 독립한 신규(가장 후임)
  const NS = [N('가', 0), N('나', 1), N('다', 2), N('라', 3), N('신1', 8, false), N('신2', 9, false)];
  const every = (days, rows) => {
    const s = {};
    for (const [id, code] of rows) { s[id] = {}; for (const dk of days) s[id][dk] = code; }
    return s;
  };
  const sortHv = (hv) => (hv || []).map(h => ({ from: h.from, to: h.to, rooms: h.rooms.slice().sort((a, b) => a - b) }))
    .sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));

  // ① D→E — 신1(D)과 신2(E)가 어제까지 둘 다 B(10~14)를 봤다: 매일 신1 이 신2 에게 같은 환자를 넘기던 자리.
  //   그룹을 켜면 신2 가 첫날 한 번 A 로 옮기고, 그 뒤로는 이어 보기(원칙 1)가 둘을 떼어 둔다. 앞 근무 신1 은 그대로.
  const days4 = ['d1', 'd2', 'd3', 'd4'];
  const sch1 = every(days4, [['가', 'DC'], ['나', 'D'], ['신1', 'D'], ['다', 'EC'], ['라', 'E'], ['신2', 'E']]);
  const seed1 = {
    가: { label: '차지', period: 'D', idx: -1, rooms: L3.차지 }, 나: { label: 'A', period: 'D', idx: -1, rooms: L3.A },
    신1: { label: 'B', period: 'D', idx: -1, rooms: L3.B },
    다: { label: '차지', period: 'E', idx: -1, rooms: L3.차지 }, 라: { label: 'A', period: 'E', idx: -1, rooms: L3.A },
    신2: { label: 'B', period: 'E', idx: -1, rooms: L3.B },
  };
  const o1 = { roomsFor: rf3, seed: seed1 };
  {
    const off = compute(NS, sch1, days4, o1);
    assert.deepEqual(days4.map(dk => seatOf(off, dk, 'E', '신2')), ['B', 'B', 'B', 'B'], '그룹 없이는 오늘과 같다 — 신2 는 매일 B');
    for (const dk of days4) assert.equal(off.byDay[dk].E.handover, undefined, '그룹이 없으면 인계 보고도 없다');

    const on = compute(NS, sch1, days4, Object.assign({ handoverGroups: NEW }, o1));
    for (const dk of days4) assert.deepEqual(on.byDay[dk].D, off.byDay[dk].D, dk + ' 앞 근무(D)는 그룹과 상관없이 그대로');
    assert.deepEqual(days4.map(dk => seatOf(on, dk, 'E', '신2')), ['A', 'A', 'A', 'A'], '신2 는 첫날 한 번 옮기고 그 뒤로 A 를 이어 본다');
    assert.deepEqual(days4.map(dk => seatOf(on, dk, 'E', '라')), ['B', 'B', 'B', 'B'], '라가 B 를 맡아 이어 본다');
    for (const dk of days4) {
      assert.equal(on.byDay[dk].E.handover, undefined, dk + ' 신규끼리 넘기는 병상 없음');
      assert.equal(on.byDay[dk].E.charge, '다');
    }

    // 그룹을 켜도 짝이 없거나(한 사람뿐), 빈 그룹이거나, 방 정보(roomsFor)가 없으면 오늘과 똑같다
    assert.deepEqual(compute(NS, sch1, days4, Object.assign({ handoverGroups: { 신1: ['신규'] } }, o1)), off, '그룹에 한 사람뿐');
    assert.deepEqual(compute(NS, sch1, days4, Object.assign({ handoverGroups: { 신1: [], 신2: [''] } }, o1)), off, '빈 그룹');
    assert.deepEqual(compute(NS, sch1, days4, Object.assign({ handoverGroups: {} }, o1)), off, '그룹 목록이 비었다');
    assert.deepEqual(compute(NS, sch1, days4, { seed: seed1, handoverGroups: NEW }), compute(NS, sch1, days4, { seed: seed1 }),
      '방 정보가 없으면 아무 일도 하지 않는다');
  }

  // ② 주지 않을 방 > 같은 그룹 인계 > 원칙 1 — ① 의 첫날 신2 에게 A 가 주지 않을 방이면 신2 는 B 에 남고 인계를 알린다.
  //   주지 않을 방이 풀린 다음 날 신2 가 옮긴다 (어제 B 를 이어 보는 원칙 1 보다 인계 피하기가 먼저).
  {
    const r = compute(NS, sch1, days4, Object.assign({ handoverGroups: NEW, avoid: { d1: { E: { 신2: ['A'] } } } }, o1));
    assert.equal(seatOf(r, 'd1', 'E', '신2'), 'B', '주지 않을 방이 먼저');
    assert.deepEqual(r.byDay.d1.E.handover, [{ from: '신1', to: '신2', rooms: R(10, 14) }], '피하지 못한 인계는 알린다');
    assert.equal(seatOf(r, 'd2', 'E', '신2'), 'A', '다음 날 원칙 1(B 이어 보기)을 버리고 옮긴다');
    assert.equal(seatOf(r, 'd2', 'E', '라'), 'B', '라도 원칙 1(A)을 버리고 B 로');
    assert.equal(r.byDay.d2.E.handover, undefined);
    // 다른 사람의 주지 않을 방도 먼저다 — 라가 B 를 못 받으면 신2 는 B 에 남는다
    const r2 = compute(NS, sch1, days4, Object.assign({ handoverGroups: NEW, avoid: { d1: { E: { 라: ['B'] } } } }, o1));
    assert.equal(seatOf(r2, 'd1', 'E', '라'), 'A');
    assert.equal(seatOf(r2, 'd1', 'E', '신2'), 'B');
    assert.deepEqual(r2.byDay.d1.E.handover, [{ from: '신1', to: '신2', rooms: R(10, 14) }]);
  }

  // ③ 손으로 고정한 자리는 그대로 — 신2 를 d1 E 의 B 에 못 박으면 B 그대로, 인계를 알린다. 다음 날은 옮긴다
  {
    const r = compute(NS, sch1, days4, Object.assign({ handoverGroups: NEW, overrides: { d1: { E: { 신2: 'B' } } } }, o1));
    assert.equal(seatOf(r, 'd1', 'E', '신2'), 'B');
    assert.deepEqual(r.byDay.d1.E.handover, [{ from: '신1', to: '신2', rooms: R(10, 14) }]);
    assert.equal(seatOf(r, 'd2', 'E', '신2'), 'A');
    // 앞 근무 신1 을 손으로 A 에 고정하면 신2 는 B 를 이어 볼 수 있다 — 피할 것은 신1 이 실제로 본 병상
    const r2 = compute(NS, sch1, ['d1'], Object.assign({ handoverGroups: NEW, overrides: { d1: { D: { 신1: 'A' } } } }, o1));
    assert.equal(seatOf(r2, 'd1', 'D', '신1'), 'A');
    assert.equal(seatOf(r2, 'd1', 'E', '신2'), 'B', '신1 이 안 본 B 는 그대로 이어 본다');
    assert.equal(r2.byDay.d1.E.handover, undefined);
  }

  // ④ E→N (같은 날) · N→D (전날 밤 → 오늘 아침)
  {
    // E→N: 신1 이 E 의 B 를 본 날, N 의 신2 는 B 대신 A — 그룹 밖의 나는 B 를 넘겨받아도 된다
    const en = { 다: { d1: 'EC' }, 라: { d1: 'E' }, 신1: { d1: 'E' }, 가: { d1: 'NC' }, 나: { d1: 'N' }, 신2: { d1: 'N' } };
    const off = compute(NS, en, ['d1'], { roomsFor: rf3 });
    assert.equal(seatOf(off, 'd1', 'E', '신1'), 'B');
    assert.equal(seatOf(off, 'd1', 'N', '신2'), 'B', '그룹 없이는 신2 가 신1 의 B 를 받는다');
    const on = compute(NS, en, ['d1'], { roomsFor: rf3, handoverGroups: NEW });
    assert.deepEqual(on.byDay.d1.E, off.byDay.d1.E);
    assert.deepEqual(on.byDay.d1.N.labels, { 차지: '가', A: '신2', B: '나' });
    assert.equal(on.byDay.d1.N.handover, undefined, '그룹 밖 사람(나)이 받는 것은 인계로 치지 않는다');

    // N→D: d1 밤 신1 이 B — d2 낮 신2 는 B 를 피한다. 같은 날(d2) 의 E·N 은 D 보다 뒤라 상관없다
    const nd = { 가: { d1: 'NC', d2: 'NC' }, 나: { d1: 'N', d2: 'N' }, 신1: { d1: 'N', d2: 'N' },
                 다: { d2: 'DC' }, 라: { d2: 'D' }, 신2: { d2: 'D' } };
    const off2 = compute(NS, nd, ['d1', 'd2'], { roomsFor: rf3 });
    assert.equal(seatOf(off2, 'd2', 'D', '신2'), 'B');
    const on2 = compute(NS, nd, ['d1', 'd2'], { roomsFor: rf3, handoverGroups: NEW });
    assert.equal(seatOf(on2, 'd1', 'N', '신1'), 'B');
    assert.deepEqual(on2.byDay.d2.D.labels, { 차지: '다', A: '신2', B: '라' }, '전날 밤 신1 의 병상을 피한다');
    assert.equal(seatOf(on2, 'd2', 'N', '신1'), 'B', '신1 은 밤에 B 를 이어 본다 (d2 E 가 비어 N 의 앞 근무가 없다)');
  }

  // ⑤ 그룹 맞추기 — 그룹이 여럿이면 하나라도 같을 때만 같은 그룹. 다른 그룹끼리·그룹 없는 사람은 피하지 않는다
  {
    const en = { 다: { d1: 'EC' }, 라: { d1: 'E' }, 신1: { d1: 'E' }, 가: { d1: 'NC' }, 나: { d1: 'N' }, 신2: { d1: 'N' } };
    const o = { roomsFor: rf3 };
    const base = compute(NS, en, ['d1'], o);
    const n2 = (g) => seatOf(compute(NS, en, ['d1'], Object.assign({ handoverGroups: g }, o)), 'd1', 'N', '신2');
    assert.equal(n2({ 신1: ['신규', '2025입사'], 신2: ['2025입사'] }), 'A', '겹치는 그룹(2025입사)이 하나라도 있으면 피한다');
    assert.equal(n2({ 신1: ['신규', '2025입사'], 신2: ['2025입사', '야간'] }), 'A');
    assert.equal(n2({ 신1: ['신규'], 신2: ['2025입사'] }), 'B', '다른 그룹끼리는 피하지 않는다');
    assert.equal(n2({ 신1: ['신규'] }), 'B', '그룹 없는 사람(신2)은 피하지 않는다');
    assert.equal(n2({ 신2: ['신규'] }), 'B', '넘기는 사람(신1)이 그룹 밖이면 피하지 않는다');
    assert.deepEqual(compute(NS, en, ['d1'], Object.assign({ handoverGroups: { 신1: ['가조'], 신2: ['나조'] } }, o)), base,
      '겹치는 그룹이 없으면 결과가 오늘과 같다');
  }

  // ⑥ 앞 근무에 아무도 없으면 인계도 없다 · 헬퍼는 병상을 넘기지 않는다
  {
    // d1 E 가 비었다 — D(신1, B) 다음 N(신2) 은 인계가 아니다 (16시간 뒤)
    const dn = { 가: { d1: 'DC' }, 나: { d1: 'D' }, 신1: { d1: 'D' }, 다: { d1: 'NC' }, 라: { d1: 'N' }, 신2: { d1: 'N' } };
    const r = compute(NS, dn, ['d1'], { roomsFor: rf3, handoverGroups: NEW });
    assert.equal(seatOf(r, 'd1', 'D', '신1'), 'B');
    assert.equal(seatOf(r, 'd1', 'N', '신2'), 'B', 'E 가 빈 날 N 은 D 를 피하지 않는다');
    assert.equal(r.byDay.d1.N.handover, undefined);
    // d1 N 이 비었다 — d1 E(신1, B) 다음 d2 D(신2) 는 인계가 아니다
    const ed = { 가: { d1: 'EC' }, 나: { d1: 'E' }, 신1: { d1: 'E' }, 다: { d2: 'DC' }, 라: { d2: 'D' }, 신2: { d2: 'D' } };
    const r2 = compute(NS, ed, ['d1', 'd2'], { roomsFor: rf3, handoverGroups: NEW });
    assert.equal(seatOf(r2, 'd1', 'E', '신1'), 'B');
    assert.equal(seatOf(r2, 'd2', 'D', '신2'), 'B', '밤 근무가 빈 다음 날 D 는 전날 E 를 피하지 않는다');
    // 하루가 통째로 빈 다음 날도 — 전날 밤이 없으면 그 전 밤을 보지 않는다
    const gap = { 가: { d1: 'NC' }, 나: { d1: 'N' }, 신1: { d1: 'N' }, 다: { d3: 'DC' }, 라: { d3: 'D' }, 신2: { d3: 'D' } };
    const r3 = compute(NS, gap, ['d1', 'd2', 'd3'], { roomsFor: rf3, handoverGroups: NEW });
    assert.equal(seatOf(r3, 'd3', 'D', '신2'), 'B', '이틀 전 밤은 인계가 아니다');

    // 헬퍼: D 6명 · 자리 5 — 막내 신1 은 헬퍼라 넘길 병상이 없다 → E 의 신2 는 그대로 B
    const L5 = { 차지: R(1, 2), A: R(3, 5), B: R(6, 8), C: R(9, 11), D: R(12, 14) };
    const L6 = { 차지: R(1, 2), A: R(3, 4), B: R(5, 7), C: R(8, 10), D: R(11, 12), E: R(13, 14) };
    const rf = (P, cnt, l) => ((P === 'D' ? (cnt >= 6 ? L6 : L5) : L3)[l] || []).slice();
    const N8 = ['가', '나', '다', '라', '마', '바', '사'].map((id, i) => N(id, i)).concat([N('신1', 8, false), N('신2', 9, false)]);
    const sh = { 가: { d1: 'DC' }, 나: { d1: 'D' }, 다: { d1: 'D' }, 라: { d1: 'D' }, 마: { d1: 'D' }, 신1: { d1: 'D' },
                 바: { d1: 'EC' }, 사: { d1: 'E' }, 신2: { d1: 'E' } };
    const h5 = compute(N8, sh, ['d1'], { roomsFor: rf, handoverGroups: NEW });
    assert.deepEqual(h5.byDay.d1.D.extra, ['신1'], '신1 은 헬퍼');
    assert.equal(seatOf(h5, 'd1', 'E', '신2'), 'B', '헬퍼는 병상을 보지 않으니 피할 것이 없다');
    assert.equal(h5.byDay.d1.E.handover, undefined);
    // 대조 — 자리가 6개라 신1 이 E(13·14호)에 앉으면 신2 는 그 병상이 든 B 를 피한다
    const h6 = compute(N8, sh, ['d1'], { roomsFor: rf, maxSeats: 6, handoverGroups: NEW });
    assert.equal(seatOf(h6, 'd1', 'D', '신1'), 'E');
    assert.equal(seatOf(h6, 'd1', 'E', '신2'), 'A');
  }

  // ⑦ 병상 수로 잰다 — 어느 자리든 조금씩 넘겨받을 때 넘겨받는 병상이 적은 자리
  {
    // D 의 B(신1) = 6·7·11~14호. 오늘 E 의 A 는 그중 6호 하나, B 는 7·11~14호 다섯 방과 겹친다
    const LD = { 차지: R(1, 4), A: ['5', '8', '9', '10'], B: ['6', '7', '11', '12', '13', '14'] };
    const LE = { 차지: R(1, 4), A: ['5', '6', '8', '9'], B: ['7', '10', '11', '12', '13', '14'] };
    const rf = (P, cnt, l) => ((P === 'D' ? LD : LE)[l] || []).slice();
    const sh = { 가: { d1: 'DC' }, 나: { d1: 'D' }, 신1: { d1: 'D' }, 다: { d1: 'EC' }, 라: { d1: 'E' }, 신2: { d1: 'E' } };
    const off = compute(NS, sh, ['d1'], { roomsFor: rf });
    assert.equal(seatOf(off, 'd1', 'D', '신1'), 'B');
    assert.equal(seatOf(off, 'd1', 'E', '신2'), 'B');
    // 방 개수로는(병상수 모름) A 가 1, B 가 5 → A
    const byRoom = compute(NS, sh, ['d1'], { roomsFor: rf, handoverGroups: NEW });
    assert.equal(seatOf(byRoom, 'd1', 'E', '신2'), 'A');
    assert.deepEqual(byRoom.byDay.d1.E.handover, [{ from: '신1', to: '신2', rooms: ['6'] }], '피하지 못한 1병상을 알린다');
    // 6호가 6인실이면 A 는 6병상, B 는 5병상 → B
    const big6 = compute(NS, sh, ['d1'], { roomsFor: rf, handoverGroups: NEW, bedsOf: t => (t === '6' ? 6 : 1) });
    assert.equal(seatOf(big6, 'd1', 'E', '신2'), 'B', '넘겨받는 병상이 적은 자리');
    assert.deepEqual(big6.byDay.d1.E.handover, [{ from: '신1', to: '신2', rooms: ['7', '11', '12', '13', '14'] }]);
    // 6호가 4인실이면 A 4병상 < B 5병상 → A
    const four6 = compute(NS, sh, ['d1'], { roomsFor: rf, handoverGroups: NEW, bedsOf: t => (t === '6' ? 4 : 1) });
    assert.equal(seatOf(four6, 'd1', 'E', '신2'), 'A');

    // 같은 병상을 같은 그룹 둘이 봤어도(방 구성에서 두 자리가 10호를 겹쳐 가짐) 한 번만 센다
    const LD2 = { 차지: R(1, 4), A: R(5, 10), B: R(10, 14) };
    const LE2 = { 차지: R(1, 4).concat(['14']), A: R(5, 9), B: R(10, 13) };
    const rf2 = (P, cnt, l) => ((P === 'D' ? LD2 : LE2)[l] || []).slice();
    const N3 = NS.concat([N('신3', 7, false)]);
    const sh2 = { 가: { d1: 'DC' }, 신3: { d1: 'D' }, 신1: { d1: 'D' }, 다: { d1: 'EC' }, 라: { d1: 'E' }, 신2: { d1: 'E' } };
    // 신2 는 어제 E 의 A(5~9)를 봤다 — A 는 신3 의 5병상, B 는 10호(신3·신1) + 11~13호(신1) = 4병상
    const seed = { 신2: { label: 'A', period: 'E', idx: -1, rooms: R(5, 9) } };
    const r = compute(N3, sh2, ['d1'], { roomsFor: rf2, seed, handoverGroups: { 신1: ['신규'], 신2: ['신규'], 신3: ['신규'] } });
    assert.equal(seatOf(r, 'd1', 'D', '신3'), 'A');
    assert.equal(seatOf(r, 'd1', 'D', '신1'), 'B');
    assert.equal(seatOf(r, 'd1', 'E', '신2'), 'B', '4병상 < 5병상 (10호를 두 번 세면 5 = 5 라 어제 A 를 이어 봤을 것)');
    assert.deepEqual(sortHv(r.byDay.d1.E.handover),
      sortHv([{ from: '신3', to: '신2', rooms: ['10'] }, { from: '신1', to: '신2', rooms: ['10', '11', '12', '13'] }]),
      '받은 사람·준 사람마다 병상을 알린다');
  }

  // ⑧ 누가 차지인지는 그룹이 바꾸지 않는다
  {
    // 자리가 고정인 차지(101·122) — E 차지 다는 신1 과 같은 그룹. 차지 방(1~4호)이 신1 의 D 병상이어도
    // 차지 가능한 라에게 차지를 넘기지 않는다. 피하지 못한 인계로 알린다
    const LD = { 차지: R(10, 14), A: R(5, 9), B: R(1, 4) };
    const rf = (P, cnt, l) => ((P === 'D' ? LD : L3)[l] || []).slice();
    const sh = { 가: { d1: 'DC' }, 나: { d1: 'D' }, 신1: { d1: 'D' }, 다: { d1: 'E' }, 라: { d1: 'E' }, 신2: { d1: 'E' } };
    const g = { 신1: ['g'], 다: ['g'] };
    const off = compute(NS, sh, ['d1'], { roomsFor: rf });
    const on = compute(NS, sh, ['d1'], { roomsFor: rf, handoverGroups: g });
    assert.equal(seatOf(on, 'd1', 'D', '신1'), 'B');
    assert.equal(on.byDay.d1.E.charge, '다');
    assert.equal(on.byDay.d1.E.labels['차지'], '다');
    assert.deepEqual(on.byDay.d1.E, Object.assign({}, off.byDay.d1.E, { handover: [{ from: '신1', to: '다', rooms: R(1, 4) }] }));
    // EC 표시자도 그대로
    const sh2 = Object.assign({}, sh, { 다: { d1: 'EC' } });
    assert.equal(compute(NS, sh2, ['d1'], { roomsFor: rf, handoverGroups: g }).byDay.d1.E.labels['차지'], '다');

    // 방이 고정이 아닌 차지(102 CRN) — CRN 은 자리를 옮겨 피하지만 CRN 은 그대로
    const L4 = { 차지: R(1, 3), A: R(4, 7), B: R(8, 11), C: R(12, 14) };
    const rf4 = (P, cnt, l) => (L4[l] || []).slice();
    const N4 = ['가', '나', '다', '라', '마', '바', '사'].map((id, i) => N(id, i)).concat([N('신1', 8, false), N('신2', 9, false)]);
    const sh4 = { 가: { d1: 'DC' }, 나: { d1: 'D' }, 다: { d1: 'D' }, 신1: { d1: 'D' },
                  라: { d1: 'EC' }, 마: { d1: 'E' }, 바: { d1: 'E' }, 사: { d1: 'E' } };
    const crn = { roomsFor: rf4, maxSeats: 4, chargeSeats: () => ['차지', 'A', 'B', 'C'],
                  overrides: { d1: { D: { 신1: 'B' } } }, seed: { 라: { label: 'B', period: 'E', idx: -1, rooms: L4.B } } };
    const offC = compute(N4, sh4, ['d1'], crn);
    assert.equal(seatOf(offC, 'd1', 'E', '라'), 'B', '그룹 없이는 CRN 라가 어제 B 를 이어 본다');
    const onC = compute(N4, sh4, ['d1'], Object.assign({ handoverGroups: { 신1: ['g'], 라: ['g'] } }, crn));
    assert.notEqual(seatOf(onC, 'd1', 'E', '라'), 'B', 'CRN 도 같은 그룹이면 신1 의 병상을 피한다');
    assert.equal(onC.byDay.d1.E.charge, '라', 'CRN 은 그대로');
    assert.equal(onC.byDay.d1.E.handover, undefined);
    // CRN 을 손으로 B 에 고정하면 B 그대로, 인계를 알린다
    const pinC = compute(N4, sh4, ['d1'], Object.assign({}, crn, {
      handoverGroups: { 신1: ['g'], 라: ['g'] }, overrides: { d1: { D: { 신1: 'B' }, E: { 라: 'B' } } } }));
    assert.equal(seatOf(pinC, 'd1', 'E', '라'), 'B');
    assert.equal(pinC.byDay.d1.E.charge, '라');
    assert.deepEqual(pinC.byDay.d1.E.handover, [{ from: '신1', to: '라', rooms: L4.B }]);

    // CRN 자리를 고를 때 다른 사람의 인계도 센다 — CRN 라는 어제 'B' 자리 이름(그때 방 구성은 12~14호)이라
    // 그룹 없이는 B 에 앉는다. 신1 이 D 에서 1·4·12호를 봤으면 신2 가 받을 수 있는 자리는 B 뿐 → CRN 은 B 를 비킨다
    const LDx = { 차지: ['2', '3'], A: ['5', '6', '7'], B: ['1', '4', '12'], C: R(8, 11).concat(['13', '14']) };
    const rfx = (P, cnt, l) => ((P === 'D' ? LDx : L4)[l] || []).slice();
    const shx = { 가: { d1: 'DC' }, 나: { d1: 'D' }, 다: { d1: 'D' }, 신1: { d1: 'D' },
                  라: { d1: 'EC' }, 마: { d1: 'E' }, 바: { d1: 'E' }, 신2: { d1: 'E' } };
    const ox = { roomsFor: rfx, maxSeats: 4, chargeSeats: () => ['차지', 'A', 'B'], overrides: { d1: { D: { 신1: 'B' } } },
                 seed: { 라: { label: 'B', period: 'E', idx: -1, rooms: R(12, 14) } } };
    const offX = compute(N4, shx, ['d1'], ox);
    assert.equal(seatOf(offX, 'd1', 'E', '라'), 'B', '그룹 없이는 어제 자리 이름 B');
    assert.equal(offX.byDay.d1.E.charge, '라');
    const onX = compute(N4, shx, ['d1'], Object.assign({ handoverGroups: NEW }, ox));
    assert.equal(seatOf(onX, 'd1', 'E', '신2'), 'B', '신2 는 신1 의 병상이 없는 B');
    assert.ok(['차지', 'A'].includes(seatOf(onX, 'd1', 'E', '라')), 'CRN 은 허락된 다른 자리로');
    assert.equal(onX.byDay.d1.E.charge, '라');
    assert.equal(onX.byDay.d1.E.handover, undefined);
  }
}

// ── 같은 그룹 인계 — 무작위 대조: 손으로 고정한 자리·차지 말고 앉힐 수 있는 배치를 **전부** 따져 본 최소와 같은가 ──
//  (주지 않을 방에 앉는 사람 수, 넘겨받는 병상 수) 가 사전식 최소 · 차지와 손 고정은 그룹이 없을 때와 같다 ·
//  handover 보고는 결과 배치에서 다시 센 것과 같다 · 겹치는 그룹이 하나도 없으면 결과가 그룹 없을 때와 똑같다
{
  let sd = 20261009;
  const rnd = () => (sd = (sd * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ri = (n) => Math.floor(rnd() * n);
  const PREV = { D: 'N', E: 'D', N: 'E' };
  const ids = Array.from({ length: 12 }, (_, i) => 'n' + i);
  let shifts = 0, withHolders = 0, moved = 0, reported = 0;
  for (let trial = 0; trial < 80; trial++) {
    const NS = ids.map((id, i) => N(id, i, i < 5 || rnd() < 0.2));
    const days = ['k0', 'k1', 'k2', 'k3', 'k4'];
    const sch = {};
    for (const id of ids) {
      sch[id] = {};
      for (const dk of days) {
        const c = ['D', 'D', 'E', 'E', 'N', 'OF', 'OF'][ri(7)];
        sch[id][dk] = c !== 'OF' && rnd() < 0.08 ? c + 'C' : c;
      }
    }
    // 그룹: 없음 · g1 · g2 · 둘 다 — 신규가 많은 병동처럼 절반쯤
    const groups = {};
    for (const id of ids) { const k = ri(5); if (k === 1 || k === 2) groups[id] = ['g1']; else if (k === 3) groups[id] = ['g2']; else if (k === 4) groups[id] = ['g1', 'g2']; }
    // 방 구성: 근무·인원·날마다 1~14호를 자리 수만큼 자른다 (자리 경계가 근무마다 달라 조금씩 겹친다)
    const lay = {};
    const roomsFor = (P, cnt, l, dk) => {
      const key = P + cnt + dk;
      if (!lay[key]) {
        const ns = Math.min(cnt, 5), cuts = new Set();
        while (cuts.size < ns - 1) cuts.add(1 + ri(13));
        const cs = [0].concat([...cuts].sort((a, b) => a - b), [14]), m = {};
        LABELS.slice(0, ns).forEach((lb, i) => { m[lb] = []; for (let x = cs[i] + 1; x <= cs[i + 1]; x++) m[lb].push(String(x)); });
        lay[key] = m;
      }
      return (lay[key][l] || []).slice();
    };
    const beds = {}; for (let x = 1; x <= 14; x++) beds[String(x)] = 1 + ri(4);
    const bedsOf = (t) => beds[t];
    const avoid = {}, overrides = {};
    for (const dk of days) for (const P of ['D', 'E', 'N']) {
      if (rnd() < 0.25) ((avoid[dk] = avoid[dk] || {})[P] = {})[ids[ri(12)]] = [LABELS[ri(5)]];
      if (rnd() < 0.15) ((overrides[dk] = overrides[dk] || {})[P] = {})[ids[ri(12)]] = LABELS[ri(5)];
    }
    const floating = trial % 2 ? (trial % 4 === 1 ? () => ['차지', 'A', 'B', 'C', 'D'] : () => ['차지', 'A', 'B']) : null;
    const base = { roomsFor, bedsOf, avoid, overrides, seed: {} };
    if (floating) base.chargeSeats = floating;
    const off = compute(NS, sch, days, base);
    const r = compute(NS, sch, days, Object.assign({ handoverGroups: groups }, base));
    const solo = {}; ids.forEach(id => (solo[id] = ['혼자' + id]));
    assert.deepEqual(compute(NS, sch, days, Object.assign({ handoverGroups: solo }, base)), off, '겹치는 그룹이 없으면 그대로');
    const same = (a, b) => a !== b && groups[a] && groups[b] && groups[a].some(g => groups[b].includes(g));

    days.forEach((dk, di) => {
      for (const P of ['D', 'E', 'N']) {
        const staff = NS.filter(n => periodOf(sch[n.id][dk]) === P);
        if (!staff.length) continue;
        shifts++;
        const day = r.byDay[dk][P], cnt = staff.length;
        const labels = LABELS.slice(0, Math.min(cnt, 5));
        assert.deepEqual(Object.values(day.labels).concat(day.extra).sort(), staff.map(n => n.id).sort(), dk + P + ' 모두 한 번씩');
        assert.equal(day.charge, off.byDay[dk][P].charge, dk + P + ' 그룹은 차지를 바꾸지 않는다');
        if (!floating) assert.equal(day.labels['차지'], day.charge);
        // 손으로 고정한 자리
        const ov = (overrides[dk] || {})[P] || {}, pin = {}, pinId = {};
        for (const nid in ov) if (staff.some(n => n.id === nid) && labels.includes(ov[nid]) && !pin[ov[nid]]) { pin[ov[nid]] = nid; pinId[nid] = 1; }
        for (const l in pin) assert.equal(day.labels[l], pin[l], dk + P + ' 손 고정 그대로');
        // 앞 근무에서 병상마다 본 사람 — 엔진 결과에서 다시 만든다 (자리에 앉은 사람만)
        const pdk = P === 'D' ? days[di - 1] : dk, pP = PREV[P];
        const prev = pdk && r.byDay[pdk] && r.byDay[pdk][pP];
        const hold = {};
        if (prev) {
          const pc = NS.filter(n => periodOf(sch[n.id][pdk]) === pP).length;
          for (const l in prev.labels) for (const t of roomsFor(pP, pc, l, pdk)) (hold[t] = hold[t] || []).push(prev.labels[l]);
          withHolders++;
        }
        const hw = (id, l) => roomsFor(P, cnt, l, dk).reduce((s, t) => s + ((hold[t] || []).some(h => same(h, id)) ? bedsOf(t) : 0), 0);
        const av = (avoid[dk] || {})[P] || {};
        const cost = (asg) => {   // asg: {label: id}
          let v = 0, g = 0;
          for (const l in asg) { if (!pinId[asg[l]] && (av[asg[l]] || []).includes(l)) v++; g += hw(asg[l], l); }
          return [v, g];
        };
        // 앉힐 수 있는 배치 전부 — 손 고정 자리 · (자리가 고정인 차지는 차지 자리) · (방이 고정이 아닌 차지는 허락된 자리 중 하나)
        const fixed = Object.assign({}, pin);
        let chargeAt = null;
        if (!floating) fixed['차지'] = day.charge;
        else if (!pinId[day.charge]) {
          const ok = floating().filter(l => labels.includes(l) && !pin[l]);
          if (ok.length) chargeAt = ok;
        }
        const seats = labels.filter(l => !fixed[l]);
        const ppl = staff.map(n => n.id).filter(id => !Object.values(fixed).includes(id));
        let best = null;
        const walk = (i, asg, used) => {
          if (i === seats.length) {
            if (chargeAt && !chargeAt.some(l => asg[l] === day.charge)) return;
            const c = cost(Object.assign({}, fixed, asg));
            if (!best || c[0] < best[0] || (c[0] === best[0] && c[1] < best[1])) best = c;
            return;
          }
          for (const id of ppl) if (!used[id]) { used[id] = 1; asg[seats[i]] = id; walk(i + 1, asg, used); used[id] = 0; }
          delete asg[seats[i]];
        };
        walk(0, {}, {});
        assert.deepEqual(cost(day.labels), best, dk + P + ' (주지 않을 방, 인계 병상) 가 가장 작은 배치 — trial ' + trial);
        if (JSON.stringify(day.labels) !== JSON.stringify(off.byDay[dk][P].labels)) moved++;
        // 보고 — 결과 배치에서 다시 센다
        const want = [];
        for (const l in day.labels) {
          const to = day.labels[l], by = {};
          for (const t of roomsFor(P, cnt, l, dk)) for (const h of hold[t] || []) if (same(h, to)) (by[h] = by[h] || []).push(t);
          for (const h in by) want.push({ from: h, to, rooms: by[h] });
        }
        const key = (x) => x.from + '>' + x.to;
        assert.deepEqual((day.handover || []).slice().sort((a, b) => key(a).localeCompare(key(b))),
          want.sort((a, b) => key(a).localeCompare(key(b))), dk + P + ' handover 보고');
        if (day.handover) reported++;
      }
    });
  }
  assert.ok(shifts > 900 && withHolders > 600, '충분히 돌았다 ' + shifts + '/' + withHolders);
  assert.ok(moved > 30 && reported > 30, '그룹이 실제로 자리를 바꾸고 · 피하지 못한 인계도 나온다 ' + moved + '/' + reported);
}

console.log('assign-core: 모든 검증 통과');
