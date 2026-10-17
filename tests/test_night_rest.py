"""야간 뒤 휴무 — '야간 2연속 뒤 휴무 2일', 나이트킵도 같다 (2026-10-17, 사용자 "2 night 이후 2 휴무 보장").

예전엔 둘째 휴무일에 N 을 허용해 N N OF N 이 통과했고, 나이트킵은 이 규칙에서 빠진 채
'5일 중 야간 3일 이하'가 대신했다 — 병동이 준 적 없는 규칙이라 실제 번표의 N OF N N N(5일 중 4일)을 막았고,
11월 생성이 원인 없이 막혔다. 일별 수요 없이 야간 규칙만 건 CP-SAT 서브모델로 본다.
"""
from __future__ import annotations

import pytest
from ortools.sat.python import cp_model

from server.models import GenerateRequest, Nurse, Requirements, Rules
from server.scheduler_cpsat import CpSatScheduler


def _req() -> GenerateRequest:
    nurses = [
        Nurse(id="k", name="나이트킵", group="A", gender="male",
              capable_shifts=["NC", "N", "DC", "D", "EC", "E"], is_night_shift=True),
        Nurse(id="r", name="일반", group="A", gender="male",
              capable_shifts=["DC", "D", "EC", "E", "NC", "N"]),
    ]
    return GenerateRequest(year=2026, month=3, nurses=nurses, requirements=Requirements(),
                           rules=Rules(), prev_schedule={})


def _feasible(nid: str, pattern: dict[int, str]) -> bool:
    """3월 1일부터 pattern(일 → 코드, '-' 는 근무 아님)을 강제했을 때 야간 규칙으로 풀리나."""
    sch = CpSatScheduler(_req())
    model = cp_model.CpModel()
    x = sch._build_vars(model)
    sch._cs_one_shift_per_day(model, x)
    sch._cs_night_shift_nurses(model, x)
    sch._cs_max_consecutive_night(model, x, sch.rules.maxConsecutiveNightDays)
    sch._cs_rest_after_night(model, x)
    sch._cs_nod_pattern(model, x)
    base = next(i for i, dt in enumerate(sch.all_dates) if (dt.month, dt.day) == (3, 1))
    for day, code in pattern.items():
        cell = x[nid][base + day - 1]
        if code == "-":
            for s in sch.WORK_SHIFTS:
                v = cell.get(s)
                if v is not None and not isinstance(v, int):
                    model.Add(v == 0)
        else:
            model.Add(cell[code] == 1)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 20
    return solver.Solve(model) in (cp_model.OPTIMAL, cp_model.FEASIBLE)


def test_keeper_four_nights_in_five_days_is_allowed():
    # 실제 번표의 나이트킵 N OF N N N — 예전 '5일 중 3일'이 막던 것
    assert _feasible("k", {2: "N", 3: "-", 4: "N", 5: "N", 6: "N"})


@pytest.mark.parametrize("nid", ["k", "r"])
def test_two_nights_then_two_full_rest_days(nid):
    assert not _feasible(nid, {2: "N", 3: "N", 4: "-", 5: "N"})        # N N 쉼 N — 이틀을 쉰 게 아니다
    assert _feasible(nid, {2: "N", 3: "N", 4: "N", 5: "-", 6: "-", 7: "N"})   # N N N 쉼 쉼 N


@pytest.mark.parametrize("mid", ["OF", "V"])
def test_night_offday_then_day_is_forbidden_with_leave_too(mid):
    # N → 쉼 → D 금지 — 쉼이 V(휴가)여도 (2026-10-17, 사용자 "N > V > D 도 금지")
    assert not _feasible("r", {2: "N", 3: mid, 4: "D"})
    assert _feasible("r", {2: "N", 3: mid, 4: "E"})
