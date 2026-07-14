"""check_feasibility (실시간 신호등 프로브) 테스트 — 하드 제약 1회 풀이."""
from __future__ import annotations

from server.conflict_analyzer import check_feasibility


def test_probe_feasible(build_request, small_nurses):
    """충분한 인원(6명, D=E=N=1) → feasible + 예상시간 동봉."""
    res = check_feasibility(build_request(nurses=small_nurses(6), add_juhu=False))
    assert res["status"] == "feasible", res
    assert res["conflicts"] == []
    assert res["estimated_seconds"] >= 5


def test_probe_infeasible_supply(build_request, small_nurses):
    """2명인데 하루 3근무 필요 → infeasible + 대략적 원인 라벨."""
    res = check_feasibility(build_request(nurses=small_nurses(2), add_juhu=False))
    assert res["status"] == "infeasible", res
    assert res["conflicts"], "원인 라벨이 있어야 함"
    assert "estimated_seconds" in res


def test_probe_infeasible_preinput_transition(build_request, small_nurses):
    """사전입력 E→D 금지전환 → infeasible (사전입력 실시간 감지 시나리오)."""
    nurses = small_nurses(6)
    prev = {nurses[0].id: {"2026-03-02": "E", "2026-03-03": "D"}}
    res = check_feasibility(build_request(nurses=nurses, prev_schedule=prev, add_juhu=False))
    assert res["status"] == "infeasible", res


def test_probe_no_nurses(build_request):
    """간호사 0명 → unknown (신호등 미확정, 오류 아님)."""
    req = build_request(add_juhu=False)
    req.nurses = []
    res = check_feasibility(req)
    assert res["status"] == "unknown"
