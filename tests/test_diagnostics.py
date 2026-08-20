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


def test_short_rest_supply_yields_off_teukgeun(build_request, solve_small, small_nurses):
    """휴무 자리가 모자란 구성(6명 × D=E=2,N=1 = 하루 5명 근무)은 이제 실패하지 않는다.

    제1원칙 3(2026-08-20): 결원으로 휴무가 몰리면 남은 사람이 오프를 반납하고
    근무를 뛴다(오프특근). 최소 보장은 주휴 — 그건 지켜진다.
    대신 **누가 반납했는지**를 결과가 알려줘야 한다.
    """
    nurses = small_nurses(6)
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=2, E=2, N=1))

    result = _solve(
        build_request, solve_small,
        nurses=nurses, requirements=req,
    )
    assert result["success"], result["message"]
    rows = result.get("off_teukgeun") or []
    assert rows, "오프특근이 발생했는데 보고되지 않았다"
    assert "오프특근" in result["message"]
    # 주휴(최소 보장)는 전원 유지
    for nid, days in result["schedule"].items():
        assert sum(1 for c in days.values() if c == "주") >= 1, (nid, days)


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
    """infeasible 시 결과 dict는 success=False + 비어있지 않은 message를 가져야 함.

    (요구 인원 > 재적 인원 — 오프특근으로도 메울 수 없는 진짜 불가능 구성)"""
    nurses = small_nurses(6)
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=3, E=3, N=2))

    result = _solve(build_request, solve_small, nurses=nurses, requirements=req)
    assert result["success"] is False
    assert isinstance(result["message"], str)
    assert len(result["message"]) > 50, "진단 메시지가 너무 짧음 (구조화 안 됨)"
