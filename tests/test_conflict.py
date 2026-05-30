"""conflict_analyzer (CP-SAT assumptions) 테스트 — Phase 5."""
from __future__ import annotations

from server.conflict_analyzer import analyze_conflicts


def test_detects_demand_over_supply(build_request, small_nurses):
    """2명인데 D=E=N=1(=하루 3근무 필요) → 일별 인원 제약 충돌을 짚는다."""
    nurses = small_nurses(2)
    req = build_request(nurses=nurses, add_juhu=False)  # _mini_requirements: D=E=N=1
    res = analyze_conflicts(req)
    assert res["conflicts"], f"충돌이 검출되어야 함:\n{res['message']}"
    # 충돌 라벨이 사람이 읽는 핀포인트(인원/차지)를 포함
    joined = "\n".join(res["conflicts"])
    assert ("필요 인원" in joined) or ("차지" in joined), f"라벨이 모호함:\n{joined}"


def test_feasible_returns_no_conflict(build_request, small_nurses):
    """충분한 인원(6명, D=E=N=1)이면 하드 제약만으로 실현 가능 → 충돌 없음."""
    nurses = small_nurses(6)
    req = build_request(nurses=nurses, add_juhu=False)
    res = analyze_conflicts(req)
    assert res["conflicts"] == [], f"충돌이 없어야 함:\n{res['message']}"
