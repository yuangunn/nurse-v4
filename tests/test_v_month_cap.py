"""연차(V) 월 최대 — 0 은 '자동으로 넣지 않는다' (결정 1-115).

예전엔 0 을 '상한 없음'으로 읽었다. 설정에서 0 으로 낮추면 연차가 줄기는커녕 마음껏 들어갔다.
한도를 없애는 것은 '연차(V) 무제한'이 따로 맡는다. 사전입력으로 정해진 V 는 0 이어도 그대로 받는다.

이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

import pytest

from server.models import Rules

from .conftest import _mini_nurses, make_limited


def _v_count(result):
    return sum(c == "V" for row in result["schedule"].values() for c in row.values())


def test_cap_values(build_request):
    nurses = _mini_nurses(6)
    idx = list(range(7))

    def cap(v, unlimited=False):
        req = build_request(nurses=nurses, rules=Rules(maxVPerMonth=v), days=7)
        req.unlimited_v = unlimited
        return make_limited(req, days=7)._v_month_cap(nurses[0].model_dump(), idx)

    assert (cap(0), cap(2), cap(0, unlimited=True)) == (0, 2, None)


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_zero_means_no_automatic_leave(build_request, solver):
    """V 에 큰 보상을 걸어도 0 이면 한 칸도 넣지 않는다. 같은 보상에서 한도가 1 이면 들어간다(대조 — 0 이 막고 있다는 뜻)."""
    from server.models import ScoringRule
    nurses = _mini_nurses(6)
    bait = [ScoringRule(name="V 보상", rule_type="specific_shift", params={"shift_code": "V", "condition": "all"}, score=500, enabled=True, sort_order=1)]

    def run(v):
        req = build_request(nurses=nurses, rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=v), days=7)
        req.scoring_rules = bait
        return make_limited(req, days=7, solver=solver).solve()

    zero = run(0)
    assert zero["success"], zero.get("message")
    assert _v_count(zero) == 0
    if solver == "highs":                                   # 대조는 HiGHS 로만 — CP-SAT 의 '가능한 답'은 기계마다 다르다
        assert _v_count(run(1)) > 0
