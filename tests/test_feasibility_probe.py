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


def test_probe_pinned_pair_is_fact_feasible(build_request, small_nurses):
    """사전입력 E→D '양쪽 확정' 쌍은 사실-클램프로 엔진이 수용한다 — 신호등도
    같은 의미론이어야 한다 (feasible). 과거엔 거짓 빨강 (2026-08-19 수정)."""
    nurses = small_nurses(6)
    prev = {nurses[0].id: {"2026-03-02": "E", "2026-03-03": "D"}}
    res = check_feasibility(build_request(nurses=nurses, prev_schedule=prev, add_juhu=False))
    assert res["status"] == "feasible", res


def test_probe_pinned_double_of_week_feasible(build_request, small_nurses):
    """한 주에 확정 OF 2개(신청 OFF 몰림)도 엔진이 수용 → 신호등 feasible."""
    nurses = small_nurses(6)
    prev = {nurses[0].id: {"2026-03-03": "OF", "2026-03-05": "OF"}}
    res = check_feasibility(build_request(nurses=nurses, prev_schedule=prev, add_juhu=False))
    assert res["status"] == "feasible", res


def test_probe_one_side_pin_transition_infeasible(build_request, small_nurses, small_requirements):
    """확정 N 4명(월) 다음날 화 D=2 — 전날 D였던 1명 외엔 전부 N/E 뒤라 D 불가
    → infeasible. 한쪽만 확정인 전환 제약은 자유 셀에 그대로 걸린다."""
    nurses = small_nurses(6)
    req = small_requirements()
    req.tue.D = 2
    prev = {f"a{i}": {"2026-03-02": "N"} for i in range(4)}
    res = check_feasibility(build_request(
        nurses=nurses, prev_schedule=prev, requirements=req, add_juhu=False))
    assert res["status"] == "infeasible", res


def test_probe_no_nurses(build_request):
    """간호사 0명 → unknown (신호등 미확정, 오류 아님)."""
    req = build_request(add_juhu=False)
    req.nurses = []
    res = check_feasibility(req)
    assert res["status"] == "unknown"
