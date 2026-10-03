"""나이트킵은 달력 달로 맡는다 — 생성 범위 끝에 붙은 다음 달 며칠도 그 달 기준 (2026-10-03).

101병동 실제 번표: 9월 나이트킵은 10/1~10/3 에 D·E, 10월 나이트킵은 같은 사흘에 N·OF·주.
앱은 생성 달 판정만 써서 다음 달 나이트킵에게 그 며칠 D·E 를 줬다
("나이트킵은 N, V, 생, OF 밖에 줄 수 없어" — 제1원칙 10), 이번 달 나이트킵은 다음 달에도
공휴일 OF·법 금지를 나이트킵 기준으로 받았다.
"""
from __future__ import annotations

from datetime import date

import pytest

from server.api import _validate_locked_conflicts
from server.models import (DayRequirement, GenerateRequest, Nurse, Requirements, Rules,
                           ScoringRule)
from server.scheduler import NurseScheduler
from server.scheduler_cpsat import CpSatScheduler

from .test_exact_fit_characterization import PROD_SHIFTS

CAPS = ["DC", "D", "EC", "E", "NC", "N"]
ISO = dict(noNOD=False, restAfterNight=False, maxConsecutiveNight=False,
           maxNightPerMonth=False, weeklyOff=False)
REST_OR_NIGHT = {"N", "NC", "OF", "V", "생", "주"}


class _LastWeek:
    """9월 생성의 마지막 주(9/27~10/3)만 — 9/27~9/30 은 9월, 10/1~10/3 은 다음 달 며칠."""

    def _build_date_range(self):
        super()._build_date_range()
        self.all_dates = [d for d in self.all_dates if d >= date(2026, 9, 27)]
        self.T = len(self.all_dates)
        self.date_to_idx = {d: i for i, d in enumerate(self.all_dates)}
        self.weeks = [(0, 6)] if self.T == 7 else []


class _HighsWeek(_LastWeek, NurseScheduler):
    pass


class _CpSatWeek(_LastWeek, CpSatScheduler):
    pass


def _request(night_months, wishes=None, holidays=None, locked=None, prev=None):
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=2, E=0, N=1))
    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="male",
                    capable_shifts=CAPS, seniority=i,
                    night_months=night_months if i == 3 else {},
                    wishes=(wishes or {}) if i == 3 else {})
              for i in range(5)]
    return GenerateRequest(
        year=2026, month=9, nurses=nurses, requirements=req, rules=Rules(**ISO),
        prev_schedule=prev or {}, shifts=PROD_SHIFTS, holidays=holidays or [],
        locked_cells=locked or {}, time_limit=60,
        scoring_rules=[ScoringRule(name="희망", rule_type="wish", score=50)],
    )


@pytest.mark.parametrize("engine", [_HighsWeek, _CpSatWeek])
def test_next_month_keeper_gets_no_day_work_after_month_end(engine):
    """10월 나이트킵(a3)이 9/30~10/3 에 D 를 원해도 10/1~10/3 엔 N·쉬는 것만. 9/30 은 아직 일반."""
    wish = {f"2026-{d}": "D" for d in ("09-30", "10-01", "10-02", "10-03")}
    r = engine(_request({"2026-10": True}, wishes=wish)).solve()
    assert r["success"], r["message"]
    a3 = r["schedule"]["a3"]
    assert a3["2026-09-30"] in ("D", "DC"), a3                 # 9월엔 일반 간호사 — 원하는 D
    for d in ("2026-10-01", "2026-10-02", "2026-10-03"):
        assert a3[d] in REST_OR_NIGHT, (d, a3)


def test_keeper_status_follows_the_dates_month():
    s = NurseScheduler(_request({"2026-09": True}))
    n = next(x for x in s.nurses if x["id"] == "a3")
    assert s._keeper_on(n, date(2026, 9, 30))
    assert not s._keeper_on(n, date(2026, 10, 3))
    # 9월 나이트킵도 10월엔 일반 — 10/3(개천절)은 OF 대신 법, 9/25(추석)는 OF
    assert s._holiday_of_banned(n, True, date(2026, 10, 3))
    assert not s._holiday_of_banned(n, True, date(2026, 9, 25))
    assert not s._keeper_forbids(n, date(2026, 10, 1), "D")    # 다음 달엔 나이트킵 아님

    s = NurseScheduler(_request({"2026-10": True}))
    n = next(x for x in s.nurses if x["id"] == "a3")
    assert not s._keeper_on(n, date(2026, 9, 30))
    assert s._keeper_on(n, date(2026, 10, 1))
    assert s._keeper_forbids(n, date(2026, 10, 1), "D")
    assert s._keeper_forbids(n, date(2026, 10, 1), "E")
    assert not s._keeper_forbids(n, date(2026, 10, 1), "N")
    assert not s._keeper_forbids(n, date(2026, 10, 1), "OF")
    assert not s._keeper_forbids(n, date(2026, 10, 1), "D", pre="D")   # 사전입력은 사실
    assert not s._keeper_forbids(n, date(2026, 9, 30), "D")            # 생성 달은 달 규칙이 맡는다
    assert not s._holiday_of_banned(n, True, date(2026, 10, 3))        # 10월 나이트킵은 공휴일 OF


def test_pinned_day_work_of_next_month_keeper_is_kept():
    """사전입력은 사실 — 다음 달 나이트킵에게 사람이 넣은 10/1 D 는 그대로 둔다 (strict)."""
    r = _HighsWeek(_request({"2026-10": True}, prev={"a3": {"2026-10-01": "D"}})).solve()
    assert r["success"], r["message"]
    assert r["schedule"]["a3"]["2026-10-01"] in ("D", "DC")


def test_locked_holiday_of_check_uses_the_cells_month():
    """사전검증: 10월 나이트킵의 10/3 OF 잠금은 정상, 9월 나이트킵의 10/3 OF 잠금은 경고."""
    locked = {"a3": {"2026-10-03": True}}
    prev = {"a3": {"2026-10-03": "OF"}}
    ok = _request({"2026-10": True}, holidays=["2026-10-03"], locked=locked, prev=prev)
    assert _validate_locked_conflicts(ok) is None
    bad = _request({"2026-09": True}, holidays=["2026-10-03"], locked=locked, prev=prev)
    assert "2026-10-03" in (_validate_locked_conflicts(bad) or "")
