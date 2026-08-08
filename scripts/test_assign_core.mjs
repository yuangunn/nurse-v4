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
  // 차지 회피: a가 차지 회피면 다른 차지가능자 없어도 폴백은 유지하되,
  // b가 차지 가능하면 b가 차지
  const n2 = nurses.map(n => n.id === 'b' ? { ...n, chargeCapable: true } : n);
  r = compute(n2, sched, ['d1'], { avoid: { d1: { D: { a: ['차지'] } } } });
  assert.equal(r.byDay.d1.D.labels['차지'], 'b');
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

console.log('assign-core: 모든 검증 통과');
