"""사전입력 완화가 제한 시간 안에 못 끝나면 '시간' 이라고 말한다 — 13단계 진단을 원인으로 내놓지 않는다.

11월 실제 (2026-10-16): HiGHS 로 완화를 켜고 만들었더니 7분 뒤 '생리휴가(생) 제약 충돌' 진단이 나왔고,
그 앞에 '… 사전입력 완화를 켜 주세요' 한 줄까지 붙었다 — 완화는 이미 켜져 있었고 실제로는 시간이 모자랐다.
"""
from __future__ import annotations

from datetime import date

import pytest

from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules
from server.scheduler import NurseScheduler
from server.scheduler_cpsat import CpSatScheduler

from .test_exact_fit_characterization import PROD_SHIFTS
from .test_month_tail import CAPS, RULES, TAIL, _engine


def _request():
    """2명 · 매일 D1 — 간호02 가 12/3~12/5 DC 를 넣어 strict 로는 안 된다 (test_month_tail ⑥)."""
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=1, E=0, N=0))
    nurses = [Nurse(id=f"a{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                    capable_shifts=CAPS, seniority=i) for i in range(2)]
    return GenerateRequest(year=2026, month=11, nurses=nurses, requirements=req, rules=Rules(**RULES),
                           prev_schedule={"a1": {d: "DC" for d in TAIL[2:]}}, shifts=PROD_SHIFTS,
                           time_limit=120, allow_pre_relax=True)


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_relax_timeout_says_time_not_a_rule(engine, monkeypatch):
    cls = _engine(engine, date(2026, 11, 29), date(2026, 12, 5))
    relax = "_solve_with_relaxed_pre" if engine == "highs" else "_solve_relaxed"

    def timed_out(self):
        self._relax_timed_out = True
        return None

    monkeypatch.setattr(cls, relax, timed_out)
    r = cls(_request()).solve()
    assert not r["success"]
    assert r.get("relax_timed_out") is True
    assert "사전입력 완화로 다시 만들어 봤지만 제한 시간(2분) 안에 끝내지 못했습니다" in r["message"]
    assert "CP-SAT" in r["message"] and "레이스" in r["message"]
    assert "제약 충돌" not in r["message"] and "infeasible" not in r["message"]


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_relax_that_really_fails_still_explains(engine, monkeypatch):
    """완화로도 정말 안 되면(시간 탓이 아님) 예전처럼 원인을 설명한다."""
    cls = _engine(engine, date(2026, 11, 29), date(2026, 12, 5))
    relax = "_solve_with_relaxed_pre" if engine == "highs" else "_solve_relaxed"

    def infeasible(self):
        self._relax_timed_out = False
        return None

    monkeypatch.setattr(cls, relax, infeasible)
    r = cls(_request()).solve()
    assert not r["success"]
    assert not r.get("relax_timed_out")
    assert "제한 시간" not in r["message"].split("\n")[0]
