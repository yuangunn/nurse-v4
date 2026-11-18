"""간호사별 근무 성향 (결정 1-70) — 시간대(D·E·N)마다 월 상한(하드)과 선호·기피(배점).

'야간은 3번까지만' · '야간을 가능한 많이'(선호 — 월 최대 야간·홀짝월 규칙이 수면오프를 막는다) · '저녁은 가능한 적게'.
두 엔진이 같은 식, 진단기는 상한을 이름으로 짚는다. 이름은 가명만 쓴다.
"""
from __future__ import annotations

import pytest

from server.conflict_analyzer import analyze_conflicts
from tests.conftest import _mini_nurses, _mini_requirements, make_limited

NIGHT, EVE = ("N", "NC"), ("E", "EC")


def _count(result, nid, codes):
    return sum(v in codes for v in result["schedule"][nid].values())


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_cap_limits_that_period_for_that_nurse(build_request, solver):
    nurses = _mini_nurses(6)
    nurses[0].shift_prefs = {"N": {"max": 0}}
    nurses[1].shift_prefs = {"N": {"max": 1}, "E": {"max": "2"}}      # 화면 입력은 글자로 올 수 있다
    req = build_request(nurses=nurses, year=2026, month=3, days=7, requirements=_mini_requirements(1, 1, 1))
    result = make_limited(req, days=7, solver=solver).solve()
    assert result["success"], result.get("message")
    assert _count(result, "a0", NIGHT) == 0
    assert _count(result, "a1", NIGHT) <= 1 and _count(result, "a1", EVE) <= 2
    assert sum(_count(result, n.id, NIGHT) for n in nurses) == 7      # 야간은 다른 사람이 채운다


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_like_takes_more_and_avoid_takes_fewer(build_request, solver):
    nurses = _mini_nurses(6)
    nurses[0].shift_prefs = {"N": {"pref": "like"}}
    nurses[1].shift_prefs = {"N": {"pref": "avoid"}}
    req = build_request(nurses=nurses, year=2026, month=3, days=7, requirements=_mini_requirements(1, 1, 1))
    result = make_limited(req, days=7, solver=solver).solve()
    assert result["success"], result.get("message")
    nights = {n.id: _count(result, n.id, NIGHT) for n in nurses}
    assert nights["a1"] == 0, nights                                  # 기피 — 다른 사람으로 채울 수 있으면 받지 않는다
    assert nights["a0"] == max(nights.values()) and nights["a0"] >= 3, nights   # 선호 — 규칙(연속 야간·야간 뒤 휴무)이 허락하는 만큼


def test_items_pool_and_keeper(build_request):
    nurses = _mini_nurses(6)
    nurses[0].shift_prefs = {"N": {"max": 3}, "D": {"pref": "like"}, "E": {"pref": "보통", "max": ""}, "X": {"max": 1}}
    nurses[1].shift_prefs = {"N": {"pref": "like", "max": -2}}        # 음수 상한은 없는 것
    nurses[2].shift_prefs = {"N": {"max": 2}}
    nurses[2].night_months = {"2026-03": True}                        # 그 달 나이트킵의 야간은 성향을 보지 않는다
    nurses[3].shift_prefs = {"E": {"pref": "avoid"}}
    sch = make_limited(build_request(nurses=nurses, year=2026, month=3, days=7), days=7)
    items = {(n["id"], key): (cap, sign) for n, key, _s, cap, sign in sch._shift_pref_items()}
    assert items == {("a0", "N"): (3, 0), ("a0", "D"): (None, 1), ("a1", "N"): (None, 1), ("a3", "E"): (None, -1)}
    # 야간 성향을 정한 사람은 야간 공정 풀에서 뺀다 — 일부러 다르게 받는 사람을 평균에 맞추지 않는다
    assert {n["id"] for n in sch._night_fairness_pool()} == {"a3", "a4", "a5"}


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_cap_yields_to_cells_a_person_entered(build_request, solver):
    """사람이 넣은 칸이 상한을 넘으면 그 수까지 — 넣은 것을 지우거나 만들 수 없게 하지 않는다 (사실-클램프)."""
    nurses = _mini_nurses(6)
    nurses[0].shift_prefs = {"N": {"max": 1}}
    prev = {"a0": {"2026-03-02": "N", "2026-03-03": "N"}}
    req = build_request(nurses=nurses, year=2026, month=3, days=7, requirements=_mini_requirements(1, 1, 1), prev_schedule=prev)
    result = make_limited(req, days=7, solver=solver).solve()
    assert result["success"], result.get("message")
    assert _count(result, "a0", NIGHT) == 2


def test_analyzer_names_the_cap(build_request):
    nurses = _mini_nurses(6)
    for n in nurses:
        n.shift_prefs = {"N": {"max": 0}}                              # 아무도 야간을 못 선다
    req = build_request(nurses=nurses, year=2026, month=3, days=7, requirements=_mini_requirements(1, 1, 1))
    res = analyze_conflicts(req)
    assert res["status"] == "infeasible"
    assert any("야간(N) 근무 월 0회까지 (간호사 설정)" in c for c in res["conflicts"]), res["conflicts"]
