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


def test_phase4_cell_ranking(build_request, solve_small, small_nurses):
    """
    사전입력에 E→D 역순 전환 포함 → Phase 4 트리거.
    셀 기여도 ranking 라인이 출력되어야 함.
    """
    nurses = small_nurses(6)
    nid = nurses[0].id
    # day 2 = E, day 3 = D → E→D 금지
    prev = {nid: {"2026-03-02": "E", "2026-03-03": "D"}}
    result = _solve(
        build_request, solve_small,
        nurses=nurses, prev_schedule=prev, add_juhu=False,
    )
    assert not result["success"], "사전입력 위반은 infeasible 이어야 함"
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
