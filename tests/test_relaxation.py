"""사전입력 완화의 '최소 침습(minimally invasive)' 검증 — HiGHS·CP-SAT 양 엔진.

완화는 충돌 해소에 꼭 필요한 만큼만 사전입력을 바꿔야 하며, '점수를 더 따려고'
다른 간호사의 사전입력(특히 휴무)을 건드려선 안 된다. 사전입력의 휴무(OFF·연차류)는
간호사 개인의 시간이므로 근무를 먼저 완화하고 휴무는 최후에.
"""
from __future__ import annotations

import pytest

from server.models import Rules

SOLVERS = ["highs", "cpsat"]


@pytest.mark.parametrize("solver", SOLVERS)
def test_relaxation_minimally_invasive(build_request, small_nurses, solve_small, solver):
    """nurse0의 금지전환(E→D)만 충돌 → 완화는 그 충돌만 풀고, 다른 간호사의
    휴무(V·OF)는 점수 때문에 바뀌지 않는다(최소 침습)."""
    nurses = small_nurses(6)
    prev = {
        nurses[0].id: {"2026-03-05": "E", "2026-03-06": "D"},  # 금지전환 → infeasible
        nurses[1].id: {"2026-03-04": "V"},                     # 휴무(연차) 보호 대상
        nurses[2].id: {"2026-03-04": "OF"},                    # 휴무(휴식) 보호 대상
    }
    req = build_request(nurses=nurses, prev_schedule=prev, add_juhu=False,
                        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1))
    req.allow_pre_relax = True
    req.solver = solver
    res = solve_small(req, days=7, solver=solver)
    assert res["success"], res["message"]
    relaxed = res.get("relaxed_cells", {})
    assert relaxed, f"[{solver}] 완화가 실제로 발동해야 함:\n{res['message']}"
    assert nurses[1].id not in relaxed, f"[{solver}] 휴무(V)가 불필요하게 완화됨: {relaxed}"
    assert nurses[2].id not in relaxed, f"[{solver}] 휴무(OF)가 점수 때문에 완화됨: {relaxed}"


@pytest.mark.parametrize("solver", SOLVERS)
def test_relaxation_relaxes_work_before_timeoff(build_request, small_nurses, solve_small, solver):
    """완화가 불가피할 때 근무를 먼저 풀고 휴무(V·OF)는 지킨다.
    nurse0 금지전환(E→D) + 근무 가능자 충분 → 근무만 조정, 휴무 보존."""
    nurses = small_nurses(6)
    prev = {
        nurses[0].id: {"2026-03-05": "E", "2026-03-06": "D"},
        nurses[1].id: {"2026-03-05": "V"},   # 휴무
        nurses[2].id: {"2026-03-05": "OF"},  # 휴무
    }
    req = build_request(nurses=nurses, prev_schedule=prev, add_juhu=False,
                        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1))
    req.allow_pre_relax = True
    req.solver = solver
    res = solve_small(req, days=7, solver=solver)
    assert res["success"], res["message"]
    relaxed = res.get("relaxed_cells", {})
    # 휴무 보유 간호사 1,2는 완화되면 안 됨 (근무 조정으로 해소 가능)
    assert nurses[1].id not in relaxed and nurses[2].id not in relaxed, \
        f"[{solver}] 근무로 해결 가능한데 휴무가 완화됨: {relaxed}"
