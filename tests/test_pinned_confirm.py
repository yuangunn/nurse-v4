"""완전 확정 표 폴백 (2026-08-19 사용자 지시) — "완성된 번표를 빈칸 없이 넣고
생성을 누르면 생성이 되어야 한다."

빈칸 없는 사전입력은 검증 대상이 아니라 주어진 사실: 솔버가 infeasible이어도
표를 그대로 확정하고(pinned_confirmed) 규칙 차이는 pinned_notes로만 알린다.
완화(allow_pre_relax)를 명시로 켰을 때만 완화가 폴백보다 우선한다.
"""
from __future__ import annotations

from datetime import date, timedelta

from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules
from server.scheduler import NurseScheduler

from .conftest import LimitedScheduler, _juhu_prev, _mini_nurses, _mini_requirements
from .test_exact_fit_characterization import PROD_SHIFTS


def _norm(code: str) -> str:
    return {"DC": "D", "EC": "E", "NC": "N"}.get(code, code)


def test_solver_output_roundtrips_as_full_preinput():
    """라운드트립: 솔버가 만든 표를 그대로 사전입력에 넣고 다시 생성하면
    성공하고, 차지 승격(D↔DC)을 제외하면 같은 표가 나온다."""
    nurses = _mini_nurses(6)
    req = GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=_mini_requirements(),
        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1),
        prev_schedule=_juhu_prev(nurses, 2026, 3, 7), shifts=PROD_SHIFTS,
    )
    r1 = LimitedScheduler(req, max_days=7).solve()
    assert r1["success"], r1["message"]

    req2 = GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=_mini_requirements(),
        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1),
        prev_schedule=r1["schedule"], shifts=PROD_SHIFTS,
    )
    r2 = LimitedScheduler(req2, max_days=7).solve()
    assert r2["success"], r2["message"]
    for nid, days in r1["schedule"].items():
        for dk, code in days.items():
            assert _norm(r2["schedule"][nid][dk]) == _norm(code), (nid, dk)


def test_night_dedicated_15_nights_pinned_table_confirmed():
    """야간전담이 15일 야간을 선 15일(규정 14일)인 완성표 — 과거엔 infeasible,
    이제는 그대로 확정 + '15일' 안내. (사용자 시나리오: 지나간 달의 실제 번표)"""
    nurses = [
        Nurse(id="a0", name="*야간", group="A", gender="female",
              capable_shifts=["NC", "N"], is_night_shift=True),
        Nurse(id="a1", name="*정규", group="A", gender="female",
              capable_shifts=["DC", "D", "EC", "E", "NC", "N"]),
    ]
    req_small = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req_small, day, DayRequirement(D=1, E=0, N=1))

    # 2026-03 주기 전체(2/22~4/4)를 빈칸 없이 채운다 — 야간전담 N 15일
    prev = {"a0": {}, "a1": {}}
    first = date(2026, 2, 22)
    n_days = 0
    for i in range(42):
        d = first + timedelta(days=i)
        dk = d.strftime("%Y-%m-%d")
        in_march = (d.month == 3)
        if in_march and n_days < 15 and d.day % 2 == 1:
            prev["a0"][dk] = "N"
            n_days += 1
        else:
            prev["a0"][dk] = "OF"
        prev["a1"][dk] = "D" if d.day % 7 else "주"
    assert n_days == 15

    req = GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=req_small,
        rules=Rules(), prev_schedule=prev, shifts=PROD_SHIFTS, time_limit=60,
    )
    r = NurseScheduler(req).solve()
    assert r["success"], r["message"]
    assert r.get("pinned_confirmed") is True
    assert any("15일" in n and "야간" in n for n in r["pinned_notes"]), r["pinned_notes"]
    # 표는 변형되지 않는다
    assert sum(1 for c in r["schedule"]["a0"].values() if c in ("N", "NC")) == 15
