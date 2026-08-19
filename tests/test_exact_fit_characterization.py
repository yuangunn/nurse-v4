"""'사전입력 인원 정확 일치인데 infeasible' 근본 원인 — 특성화(characterization) 테스트.

2026-08-18 조사(M4)에서 확인한 현재 동작을 고정한다. 진단/정책 개선 시 이 파일이
기대 기준선이다. 핵심 사실:

  ① 일별 인원수는 필요조건일 뿐 — 진짜 병목은 간호사별 주간 구조 제약.
     솔버가 놓을 수 있는 휴무는 OF(주당 '정확히' 1회)·V(월1)·생(월1·여)뿐이고
     주(주휴)·특·공·병·D1·중은 사전입력 전용이라, 잉여 인력·빈 칸이 주당 2칸
     이상이면 채울 코드가 없어 구조적으로 infeasible.
     → 주휴 사전입력 없이는 '주 5일 근무' 구조 자체가 성립 불가 (EXP2).
  ② 확정된 부분은 '검증 대상'이 아니라 '주어진 사실'이다 (사실-클램프, 2026-08-19).
     확정만으로 결정되는 제약(일 전체·쌍·윈도우·주 전체 확정)은 걸지 않고,
     확정+자유 혼합 카운트 제약은 확정분만큼 상한을 올린다. 완전 확정 표는
     솔버가 직접 성공하며 규칙 차이는 pinned_notes 안내로만 남는다.
     (과거엔 표 속 1칸의 위반이 곧 전체 infeasible이었다.)
  ③ 진단 품질: 전환·V·OF몰림은 정확히 짚는다. ①의 구조적 휴무 부족은 부분
     입력에서 여전히 마지막 상한 단계(생리휴가)에서 터지지만, 안내문이 '쉴 코드
     공급 부족'을 설명하도록 개선됐다.
  ④ allow_pre_relax(완화)는 폴백보다 우선한다 — 사용자가 명시로 켰다면 표를
     최소 변형해서라도 규칙에 맞추는 쪽을 원한 것 (EXP7).

주의: 테스트 폴백 shifts는 auto_assign이 전부 True가 돼 주·특·공까지 솔버가
배정한다(실서비스와 다름!). 실서비스 재현에는 반드시 PROD_SHIFTS를 넘길 것.
"""
from __future__ import annotations

import pytest

from server.models import GenerateRequest, Rules, ShiftDef

from .conftest import LimitedScheduler, _mini_nurses, _mini_requirements, _juhu_prev

YEAR, MONTH = 2026, 3  # 2026-03-01(일) = 주기 경계
DATES_W1 = [f"2026-03-0{i}" for i in range(1, 8)]
DATES_W2 = [f"2026-03-{i:02d}" for i in range(8, 15)]

# 실서비스(DB 시드)와 동일한 auto_assign — CLAUDE.md 근무 17종 표 기준
PROD_SHIFTS = [
    ShiftDef(code="DC", name="Day Charge", period="day", is_charge=True),
    ShiftDef(code="D", name="Day", period="day"),
    ShiftDef(code="D1", name="Day1", period="day1", auto_assign=False),
    ShiftDef(code="EC", name="Evening Charge", period="evening", is_charge=True),
    ShiftDef(code="E", name="Evening", period="evening"),
    ShiftDef(code="중", name="중간번", period="middle", auto_assign=False),
    ShiftDef(code="NC", name="Night Charge", period="night", is_charge=True),
    ShiftDef(code="N", name="Night", period="night"),
    ShiftDef(code="OF", name="Off", period="rest"),
    ShiftDef(code="주", name="주휴", period="rest", auto_assign=False),
    ShiftDef(code="P1", name="임부휴무", period="rest"),
    ShiftDef(code="V", name="연차", period="leave"),
    ShiftDef(code="생", name="생리휴가", period="leave"),
    ShiftDef(code="특", name="특별휴가", period="leave", auto_assign=False),
    ShiftDef(code="공", name="공적업무", period="leave", auto_assign=False),
    ShiftDef(code="법", name="법정공휴일", period="leave"),
    ShiftDef(code="병", name="병가", period="leave", auto_assign=False),
]

# 원인 격리용 규칙 (전부 사용자 설정 가능한 토글) — weeklyOff·전환금지·V한도는 유지
ISO_RULES = dict(noNOD=False, restAfterNight=False, maxConsecutiveNight=False,
                 maxNightPerMonth=False, maxConsecutiveWorkDays=6)

# 손으로 짠 '인원 정확 일치' 기준표 (D=E=N=1, 4명, 일~토)
# a0=D라인, a1=E라인, a2=N라인, a3=플로트(쉬는 사람 몫 대체)
BASE7 = {
    "a0": ["OF", "D", "D", "D", "주", "D", "D"],
    "a1": ["E", "OF", "E", "E", "E", "주", "E"],
    "a2": ["N", "N", "OF", "N", "N", "N", "주"],
    "a3": ["D", "E", "N", "OF", "D", "E", "N"],
}
BASE_W2 = {
    "a0": ["D", "OF", "D", "D", "D", "주", "D"],
    "a1": ["E", "E", "OF", "E", "E", "E", "주"],
    "a2": ["N", "N", "N", "OF", "N", "N", "N"],
    "a3": ["OF", "D", "E", "N", "주", "D", "E"],
}


def to_prev(table, dates):
    return {nid: {d: s for d, s in zip(dates, row)} for nid, row in table.items()}


def solve(nurses_n, prev, days, rules_kw=None, **kw):
    req = GenerateRequest(
        year=YEAR, month=MONTH,
        nurses=_mini_nurses(nurses_n),
        requirements=_mini_requirements(),
        rules=Rules(**(rules_kw or ISO_RULES)),
        prev_schedule=prev, shifts=PROD_SHIFTS, **kw,
    )
    return LimitedScheduler(req, max_days=days).solve()


def test_juhu_preinput_makes_free_solve_feasible():
    """주휴 사전입력이 있으면 6명·일 3명 수요 자유 생성 성공 (기준선)."""
    prev = _juhu_prev(_mini_nurses(6), YEAR, MONTH, 7)
    r = solve(6, prev, 7, rules_kw=dict(maxConsecutiveWorkDays=6))
    assert r["success"], r["message"]


def test_no_juhu_structural_infeasible_with_supply_hint():
    """①·③: 주휴 없이는 잉여 인력이 쉴 코드가 없어 infeasible (부분 입력이라
    폴백 없음). 주간 휴무 수요 21칸 > 공급 최대 16칸 (OF 6 + V 6 + 생 4).
    진단이 '쉴 코드 공급 부족'을 설명해야 한다 (2026-08-19 개선)."""
    r = solve(6, {}, 7, rules_kw=dict(maxConsecutiveWorkDays=6))
    assert not r["success"]
    assert "공급 부족" in r["message"] and "주휴" in r["message"]


def test_exact_fit_table_conforming_succeeds():
    """규칙에 맞게 설계된 정확-일치 표는 그대로 생성된다 (1주·2주)."""
    r = solve(4, to_prev(BASE7, DATES_W1), 7)
    assert r["success"], r["message"]
    prev14 = to_prev(BASE7, DATES_W1)
    for nid, days in to_prev(BASE_W2, DATES_W2).items():
        prev14[nid].update(days)
    r = solve(4, prev14, 14)
    assert r["success"], r["message"]


def test_of_pileup_fully_pinned_confirmed_with_note():
    """②: OF 2회/0회 주가 있어도 완전 확정 표는 그대로 확정된다.
    규칙 차이는 pinned_notes로만 안내 (OF 횟수 언급)."""
    t = {k: v[:] for k, v in BASE7.items()}
    t["a2"][2], t["a3"][2] = "N", "OF"
    r = solve(4, to_prev(t, DATES_W1), 7)
    assert r["success"], r["message"]
    # 사실-클램프로 솔버가 직접 성공 (폴백 불필요) — 규칙 차이는 notes로만
    assert any("OF 2회" in n for n in r["pinned_notes"]), r["pinned_notes"]
    assert any("OF 0회" in n for n in r["pinned_notes"]), r["pinned_notes"]
    # 표가 변형되지 않았는지 — 스왑한 셀 그대로
    assert r["schedule"]["a3"]["2026-03-03"] == "OF"
    assert r["schedule"]["a2"]["2026-03-03"] == "N"


def test_backward_transition_fully_pinned_confirmed_with_note():
    """②: E→D 역방향 전환이 있어도 완전 확정 표는 그대로 확정 + 전환 안내."""
    t = {k: v[:] for k, v in BASE7.items()}
    t["a0"][3], t["a1"][3] = "E", "D"
    r = solve(4, to_prev(t, DATES_W1), 7)
    assert r["success"], r["message"]
    assert any("E→D" in n for n in r["pinned_notes"]), r["pinned_notes"]


def test_v_over_monthly_cap_fully_pinned_confirmed_with_note():
    """②: V 월 2회가 있어도 완전 확정 표는 그대로 확정 + V 횟수 안내."""
    prev14 = to_prev(BASE7, DATES_W1)
    for nid, days in to_prev(BASE_W2, DATES_W2).items():
        prev14[nid].update(days)
    prev14["a0"]["2026-03-05"] = "V"
    prev14["a0"]["2026-03-13"] = "V"
    r = solve(4, prev14, 14)
    assert r["success"], r["message"]
    assert any("V 2회" in n for n in r["pinned_notes"]), r["pinned_notes"]


def test_pre_relax_recovers_of_pileup():
    """④: 같은 OF 몰림 표도 allow_pre_relax면 최소 변형으로 성공 (탈출구)."""
    t = {k: v[:] for k, v in BASE7.items()}
    t["a2"][2], t["a3"][2] = "N", "OF"
    r = solve(4, to_prev(t, DATES_W1), 7, allow_pre_relax=True)
    assert r["success"], r["message"]
    assert r.get("relaxed_cells"), "완화된 셀이 표시돼야 함"
