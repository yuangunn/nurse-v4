"""사전입력 완화의 '최소 침습(minimally invasive)' 검증.

완화는 충돌 해소에 꼭 필요한 만큼만 사전입력을 바꿔야 하며, '점수를 더 따려고'
다른 간호사의 사전입력(특히 휴가)을 건드려선 안 된다. 사전입력은 간호사 개인의
인생 스케줄이므로 휴가는 최후의 수단.
"""
from __future__ import annotations

from server.models import Rules


def test_relaxation_minimally_invasive(build_request, small_nurses, solve_small):
    """nurse0의 금지전환(E→D)만 충돌 → 완화는 그 충돌만 풀고, 다른 간호사의
    휴가(V)·휴식(OF)은 점수 때문에 바뀌지 않는다."""
    nurses = small_nurses(6)
    prev = {
        nurses[0].id: {"2026-03-05": "E", "2026-03-06": "D"},  # 금지전환 → infeasible
        nurses[1].id: {"2026-03-04": "V"},                     # 휴가 (보호 대상)
        nurses[2].id: {"2026-03-04": "OF"},                    # 휴식 (점수 유혹 대상)
    }
    req = build_request(nurses=nurses, prev_schedule=prev, add_juhu=False,
                        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1))
    req.allow_pre_relax = True
    res = solve_small(req, days=7, solver="highs")
    assert res["success"], res["message"]
    relaxed = res.get("relaxed_cells", {})
    # 충돌과 무관한 간호사들의 사전입력은 절대 완화되면 안 됨
    assert nurses[1].id not in relaxed, f"휴가가 불필요하게 완화됨: {relaxed}"
    assert nurses[2].id not in relaxed, f"휴식이 점수 때문에 완화됨(최소 침습 위반): {relaxed}"


def test_relaxation_drops_rest_before_leave(build_request, small_nurses, solve_small):
    """완화가 불가피할 때도 휴식(OF)을 먼저 풀고 휴가(V)는 지킨다.
    같은 날 5명(V 2 + OF 3) 고정으로 충원 부족 → OF부터 완화."""
    nurses = small_nurses(6)
    day = "2026-03-03"
    # 0,1 = V(휴가) / 2,3,4 = OF(휴식) / 5 = 자유 → 그날 6명 중 5명 고정, 3명 필요
    prev = {
        nurses[0].id: {day: "V"}, nurses[1].id: {day: "V"},
        nurses[2].id: {day: "OF"}, nurses[3].id: {day: "OF"}, nurses[4].id: {day: "OF"},
    }
    req = build_request(nurses=nurses, prev_schedule=prev, add_juhu=False,
                        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1))
    req.allow_pre_relax = True
    res = solve_small(req, days=7, solver="highs")
    assert res["success"], res["message"]
    relaxed = res.get("relaxed_cells", {})
    # 휴가(V) 보유 간호사 0,1은 완화되면 안 됨 — 휴식(OF)으로 충원 가능하므로
    assert nurses[0].id not in relaxed and nurses[1].id not in relaxed, \
        f"휴식으로 해결 가능한데 휴가가 완화됨: {relaxed}"
