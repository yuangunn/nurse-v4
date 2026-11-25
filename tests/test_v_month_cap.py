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


def test_pre_input_leave_is_outside_the_cap(build_request):
    """사전입력으로 넣은 V 는 한도와 따로 받는다 (결정 1-117) — 한도 0 이어도, 잠그지 않았어도, 완화를 켜도 그 수만큼은 자리가 있다.
    완화에서는 잠근 칸만 '사실'이라, 예전엔 한도 0 이 잠그지 않은 사전입력 V 를 풀어 버렸다."""
    nurses = _mini_nurses(6)
    req = build_request(nurses=nurses, rules=Rules(maxVPerMonth=0), days=7)
    req.prev_schedule.setdefault(nurses[0].id, {})["2026-03-03"] = "V"
    req.allow_pre_relax = True
    s = make_limited(req, days=7)
    idx = [d for d, dt in enumerate(s.all_dates) if dt.month == 3]
    assert s._v_month_cap(nurses[0].model_dump(), idx) == 1
    assert s._v_month_cap(nurses[1].model_dump(), idx) == 0          # 사전입력 V 가 없는 사람은 그대로 0


def test_tail_days_keep_one_leave_even_when_the_month_cap_is_zero(build_request):
    """표 끝에 붙은 다음 달 며칠의 연차 상한은 늘 1 — 월 한도 0 을 거기까지 걸면 그 며칠에 남는 사람이 쉴 코드가 없어 표가 나오지 않는다
    (그 며칠에는 생휴를 새로 놓지 않는다). 실제 한 달 입력에서 만들기가 바로 '인원 제약 충돌'로 끝났다 (결정 1-117)."""
    req = build_request(nurses=_mini_nurses(6), rules=Rules(maxVPerMonth=0), days=7)
    assert make_limited(req, days=7)._v_tail_base() == 1
