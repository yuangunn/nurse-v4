"""자동 연차 최소 · 이 달 야간 고르기를 모양보다 먼저 (결정 1-124 · 1-125).

감점만으로는 야간이 사람마다 벌어졌다 — 생휴 · 1오프 한도처럼 따로 풀어 닿은 수준을 못 박는다.
HiGHS 는 이 두 단계가 오래 걸려 20분 넘게 찾는 풀이에만 넣는다(검사에서는 _priority_short 로 켠다).
이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

import pytest

from server.models import Rules
from server.scheduler import NurseScheduler
from server.scheduler_cpsat import CpSatScheduler

from .conftest import _mini_nurses, make_limited

NIGHT = ("N", "NC")


def _run(build_request, solver: str, on: bool, monkeypatch):
    s = make_limited(build_request(nurses=_mini_nurses(8), rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=2), days=14), days=14, solver=solver)
    if solver == "highs":
        s._priority_short = 20 if on else None
    elif not on:
        monkeypatch.setattr(CpSatScheduler, "_priority_pass", lambda self, model, x: False)
    r = s.solve()
    assert r["success"], r.get("message")
    nights = [sum(c in NIGHT for c in r["schedule"][n["id"]].values()) for n in s._night_fairness_pool()]
    return max(nights) - min(nights), sum(c == "V" for row in r["schedule"].values() for c in row.values())


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_fewer_leave_days_and_even_nights_come_before_the_shape(build_request, monkeypatch, solver):
    spread, v = _run(build_request, solver, True, monkeypatch)
    spread0, v0 = _run(build_request, solver, False, monkeypatch)
    assert v <= v0 and spread <= spread0, (v, v0, spread, spread0)
    assert spread <= 1, "대상이 모두 같은 조건이면 이 달 야간은 한 번 차이 안에 든다"


def test_short_highs_runs_skip_the_two_slow_stages(build_request):
    s = make_limited(build_request(nurses=_mini_nurses(6), rules=Rules(maxConsecutiveWorkDays=6), days=7), days=7)
    stages, warm = [], s._warm_highs
    s._warm_highs = lambda x, start=None, stage="score", **kw: (stages.append(stage), warm(x, start=start, stage=stage, **kw))[1]
    assert s.solve()["success"] and stages == ["score"], stages
    assert isinstance(s, NurseScheduler)


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_evening_out_does_not_push_nights_onto_someone_who_avoids_them(build_request, solver):
    """대상끼리의 차이만 줄이면 대상 밖 사람(야간을 기피한다고 정한 사람)에게 야간을 몰아 차이 0 을 만든다 — 기피를 먼저 본다."""
    nurses = _mini_nurses(6)
    nurses[1].shift_prefs = {"N": {"pref": "avoid"}}
    s = make_limited(build_request(nurses=nurses, year=2026, month=3, days=7), days=7, solver=solver)
    if solver == "highs":
        s._priority_short = 20
    r = s.solve()
    assert r["success"] and sum(c in NIGHT for c in r["schedule"]["a1"].values()) == 0, r.get("message")
