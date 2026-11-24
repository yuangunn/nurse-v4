"""여성 생휴 꼭 한 번 · 나이트킵 31일 달 휴가 (결정 1-102).

생휴를 보상(+1000)으로 두면 누구나 받는 점수가 총점을 키워 '최고와 2%' 오차를 넓혔다 — 배점에서 빼고 규칙으로 옮겼다.
규칙은 요청에 실려 올 때만 건다(화면 기본값은 켬). 임신 구간이 걸친 달의 임산부는 뺀다.
나이트킵 달이 31일이면 쉬는 날 하나는 휴가로 — 여자는 생휴, 남자는 연차(V).

이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

import pytest

from server.models import Rules
from server.scheduler import NurseScheduler

from .conftest import _mini_nurses, make_limited


def test_off_unless_the_request_turns_it_on():
    assert Rules().autoMenstrualLeave is False


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_every_woman_gets_one_when_on(build_request, solver):
    nurses = _mini_nurses(6)
    women = [n.id for n in nurses if n.gender == "female"]
    assert women, "여성이 있는 명부여야 검사가 된다"
    rules = Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1, autoMenstrualLeave=True)
    result = make_limited(build_request(nurses=nurses, rules=rules, days=7), days=7, solver=solver).solve()
    assert result["success"], result.get("message")
    got = {nid: sum(1 for c in result["schedule"][nid].values() if c == "생") for nid in women}
    assert all(v == 1 for v in got.values()), got


def test_it_is_a_big_penalty_not_a_hard_rule(build_request):
    """못 놓으면 표가 안 나오는 조건이 아니다 — 사람마다 '못 놓음' 변수를 두고 목적함수에서 깎는다 (결정 1-108)."""
    nurses = _mini_nurses(6)
    s = make_limited(build_request(nurses=nurses, rules=Rules(maxConsecutiveWorkDays=6, autoMenstrualLeave=True), days=7), days=7)
    r = s.solve()
    assert r["success"] and len(s._saeng_miss) == sum(n.gender == "female" for n in nurses)
    assert not r.get("priority_miss")
    assert s._priority_miss_report({n.id: {} for n in nurses}, {}) and all("생리휴가 없음" in t for t in s._priority_miss_report({n.id: {} for n in nurses}, {}))


def test_it_is_solved_before_the_shape(build_request):
    """생휴 · 1오프 한도는 모양보다 먼저 푼다 — 그 둘만 목적식으로 풀어 닿은 수준을 못 박고 그 안에서 모양을 푼다 (결정 1-108).
    감점 크기만으로는 '최고와 2% 안'에서 멈출 때 생휴 한 명 몫이 묻혔다."""
    nurses = _mini_nurses(6)
    s = make_limited(build_request(nurses=nurses, rules=Rules(maxConsecutiveWorkDays=6, autoMenstrualLeave=True), days=7), days=7)
    stages, warm = [], s._warm_highs
    s._warm_highs = lambda x, start=None, stage="score", **kw: (stages.append(stage), warm(x, start=start, stage=stage, **kw))[1]
    r = s.solve()
    assert r["success"] and stages == ["priority", "score"], stages
    off = make_limited(build_request(nurses=nurses, rules=Rules(maxConsecutiveWorkDays=6), days=7), days=7)
    stages2, warm2 = [], off._warm_highs
    off._warm_highs = lambda x, start=None, stage="score", **kw: (stages2.append(stage), warm2(x, start=start, stage=stage, **kw))[1]
    assert off.solve()["success"] and stages2 == ["score"], "규칙이 꺼져 있으면 단계를 끼우지 않는다"
    both = make_limited(build_request(nurses=nurses, rules=Rules(maxConsecutiveWorkDays=6, autoMenstrualLeave=True, maxOneOff=True, maxOneOffCount=0), days=7), days=7)
    stages3, warm3 = [], both._warm_highs
    both._warm_highs = lambda x, start=None, stage="score", **kw: (stages3.append(stage), warm3(x, start=start, stage=stage, **kw))[1]
    assert both.solve()["success"] and stages3 == ["priority", "priority", "score"], "생휴 먼저, 그다음 1오프 한도, 그다음 모양"


def test_pregnant_month_and_men_are_left_out(build_request):
    nurses = _mini_nurses(6)
    nurses[0].is_pregnant = True
    nurses[0].pregnancy = {"early": {"start": "2026-02-01", "end": "2026-04-30"}, "late": {"start": None, "end": None}}
    nurses[1].gender = "male"
    s = make_limited(build_request(nurses=nurses, rules=Rules(maxConsecutiveWorkDays=6, autoMenstrualLeave=True), days=7), days=7)
    by_id = {n["id"]: n for n in s.nurses}
    assert not s._saeng_required(by_id[nurses[0].id], 1), "임신 구간이 걸친 달"
    assert not s._saeng_required(by_id[nurses[1].id], 1), "남성"
    assert s._saeng_required(by_id[nurses[2].id], 1) and not s._saeng_required(by_id[nurses[2].id], 0)


def test_keeper_leave_only_in_a_31_day_month(build_request):
    s = make_limited(build_request(days=7), days=7)
    woman, man = {"id": "w", "gender": "female"}, {"id": "m", "gender": "male"}
    assert (s._keeper_month_leave(woman, 31, 31), s._keeper_month_leave(man, 31, 31)) == ("생", "V")
    assert s._keeper_month_leave(man, 30, 30) is None, "30일 달"
    assert s._keeper_month_leave(man, 20, 31) is None, "달 중간에 들어온 사람"
