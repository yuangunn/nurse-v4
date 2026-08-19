"""
Infeasible 진단 메시지 회귀 테스트.

진단 페이즈가 사용자에게 액션 가능한(actionable) 출력을 내놓는지 검증.
"""
from __future__ import annotations

import pytest

from server.models import DayRequirement, Requirements, Rules


def _solve(build_request, solve_small, **overrides):
    request = build_request(**overrides)
    return solve_small(request)


# ── Phase 5: 주휴/OF 부족 — 액션 제안 ────────────────────────────────────────


def test_phase5_action_suggestions(build_request, solve_small, small_nurses):
    """
    6명 × D=E=2, N=1 구성은 주휴 포함시 인원 부족 → Phase 5 진단 트리거.
    출력에 구체 수치(간호사 +N명, 일평균 -K명)가 포함되어야 한다.
    """
    nurses = small_nurses(6)
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=2, E=2, N=1))

    result = _solve(
        build_request, solve_small,
        nurses=nurses, requirements=req,
    )
    assert not result["success"], "이 구성은 infeasible 이어야 함"
    msg = result["message"]

    # Phase 5 헤더 확인
    assert "주차별 분석" in msg, f"Phase 5 진단 미발동:\n{msg}"
    # 새로 추가된 액션 제안 확인
    assert "★ 해결 (택1)" in msg, f"액션 제안 헤더 누락:\n{msg}"
    assert "간호사 +" in msg and "명 추가" in msg, f"간호사 추가 수치 누락:\n{msg}"
    assert "일평균" in msg and "목표" in msg, f"demand 감축 수치 누락:\n{msg}"


# ── Phase 4: 역순 전환 — 셀 기여도 ranking ──────────────────────────────────


def test_phase4_pinned_pair_now_succeeds_as_fact(build_request, solve_small, small_nurses):
    """사전입력 E→D 역순 전환(양쪽 확정)은 사실-클램프(2026-08-19)로 이제
    성공하고 pinned_notes가 전환을 안내한다 — 진단 대신 수용."""
    nurses = small_nurses(6)
    nid = nurses[0].id
    prev = {nid: {"2026-03-02": "E", "2026-03-03": "D"}}
    result = _solve(
        build_request, solve_small,
        nurses=nurses, prev_schedule=prev, add_juhu=False,
    )
    assert result["success"], result["message"]
    assert any("E→D" in n for n in result["pinned_notes"]), result["pinned_notes"]


def test_phase4_cell_ranking_when_relax_also_fails(small_nurses):
    """완화(allow_pre_relax)를 명시로 켜면 클램프가 꺼진다 — 완화조차 실패하는
    입력(실서비스 shifts + 주휴 없음 = 구조적 부족)이면 Phase 4 진단이
    E→D 역순 셀 기여도 ranking을 출력해야 한다."""
    from server.models import GenerateRequest
    from .conftest import make_limited, _mini_requirements
    from .test_exact_fit_characterization import PROD_SHIFTS

    nurses = small_nurses(6)
    prev = {nurses[0].id: {"2026-03-02": "E", "2026-03-03": "D"}}
    req = GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=_mini_requirements(),
        rules=Rules(maxConsecutiveWorkDays=6), prev_schedule=prev,
        shifts=PROD_SHIFTS, allow_pre_relax=True, time_limit=60,
    )
    result = make_limited(req, days=7).solve()
    assert not result["success"], "완화도 불가한 구성이어야 진단이 발동"
    msg = result["message"]
    assert "역순" in msg or "금지" in msg or "셀 기여도" in msg, (
        f"Phase 4 진단 미발동:\n{msg}"
    )
    if "셀 기여도" in msg:
        assert "동시 해소" in msg, f"기여도 라인 형식 깨짐:\n{msg}"


# ── 진단 결과는 반드시 구조화된 메시지 ──────────────────────────────────────


def test_infeasible_result_has_message(build_request, solve_small, small_nurses):
    """infeasible 시 결과 dict는 success=False + 비어있지 않은 message를 가져야 함."""
    nurses = small_nurses(6)
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=2, E=2, N=1))

    result = _solve(build_request, solve_small, nurses=nurses, requirements=req)
    assert result["success"] is False
    assert isinstance(result["message"], str)
    assert len(result["message"]) > 50, "진단 메시지가 너무 짧음 (구조화 안 됨)"
