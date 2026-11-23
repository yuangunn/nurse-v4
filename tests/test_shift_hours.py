"""근무 정의의 시간으로 근무 사이 휴식을 잰다 — 병동이 보탠 근무가 낀 전환만 (결정 1-92).

기본 근무끼리는 병동이 정한 역순 전환 9종이 답이라 건드리지 않는다(E→D1 10.5시간은 마지막 수단으로 허용, E→중 13시간은 금지).
보탠 근무가 끼면 시간대만으로는 알 수 없는 쌍이 생긴다 — 낮 시간대로 넣은 12:00~21:00 근무 다음 날 06:00 D 는 9시간 휴식이다.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from ortools.sat.python import cp_model

from server.models import GenerateRequest, Nurse, Requirements, Rules, ShiftDef
from server.scheduler_base import parse_shift_hours
from server.scheduler_cpsat import CpSatScheduler

BASE = [("DC", "day", True, "06:00~14:00"), ("D", "day", False, "06:00~14:00"), ("D1", "day1", False, "08:30~17:30"),
        ("EC", "evening", True, "14:00~22:00"), ("E", "evening", False, "14:00~22:00"), ("중", "middle", False, "11:00~19:00"),
        ("NC", "night", True, "22:00~06:00"), ("N", "night", False, "22:00~06:00"),
        ("OF", "rest", False, "-"), ("주", "rest", False, "-"), ("V", "leave", False, "-")]
ADDED = [("중3", "middle", "09:00~18:00"), ("D3", "day", "12:00~21:00"), ("E2", "evening", "16:00~24:00")]


def _shifts(added=ADDED):
    out = [ShiftDef(code=c, name=c, period=p, is_charge=ch, hours=h) for c, p, ch, h in BASE]
    return out + [ShiftDef(code=c, name=c, period=p, hours=h) for c, p, h in added]


def _sched(added=ADDED, **rules) -> CpSatScheduler:
    codes = [c for c, *_ in BASE[:8]] + [c for c, *_ in added]
    nurses = [Nurse(id="r", name="일반", group="A", gender="male", capable_shifts=codes)]
    return CpSatScheduler(GenerateRequest(year=2026, month=3, nurses=nurses, requirements=Requirements(),
                                          rules=Rules(**rules), prev_schedule={}, shifts=_shifts(added)))


def _pairs(sch) -> dict:
    return {(g1[0], g2[0]): label for label, g1, g2, soft in sch._hours_transition_rules()}


def test_parse_hours():
    assert parse_shift_hours("06:00~14:00") == (360, 840)
    assert parse_shift_hours("22:00~06:00") == (1320, 1800)        # 자정을 넘긴다
    assert parse_shift_hours("16:00~24:00") == (960, 1440)
    assert parse_shift_hours(" 9:00 - 18:00 ") == (540, 1080)
    for bad in ("", "-", None, "오전", "25:00~26:00", "09:00"):
        assert parse_shift_hours(bad) is None


def test_only_pairs_with_an_added_shift_and_short_rest():
    pairs = _pairs(_sched())
    # 12:00~21:00 다음 날 06:00 — 9시간. 시간대(낮→낮)로는 보이지 않던 쌍
    assert pairs[("D3", "D")] == "D3→D, 휴식 9시간" and ("D3", "DC") in pairs
    assert ("D3", "D1") not in pairs                                 # 21:00 → 08:30 = 11.5시간
    # 16:00~24:00 다음 날 08:30 — 8.5시간. 역순 표로는 E→D1 '마지막 수단'이지만 실제 휴식이 모자라 막는다
    assert pairs[("E2", "D1")] == "E2→D1, 휴식 8.5시간"
    # 역순 9종이 이미 하드로 막는 쌍은 겹쳐 걸지 않는다 (E→D · E→중 · N→…)
    assert ("E2", "D") not in pairs and ("E2", "중3") not in pairs and ("N", "중3") not in pairs
    # 기본 근무끼리는 하나도 없다 — E→D1 10.5시간도
    assert all(a in {"중3", "D3", "E2"} or b in {"중3", "D3", "E2"} for a, b in pairs)
    assert ("E", "D1") not in pairs


def test_no_added_shift_no_rule_and_settings():
    assert _sched(added=[])._hours_transition_rules() == []
    assert len(_sched(added=[])._transition_rules()) == 9             # 기본 병동은 그대로
    assert _sched(minRest=False)._hours_transition_rules() == []
    assert ("D3", "D") not in _pairs(_sched(minRestHours=8))          # 9시간 ≥ 8시간
    assert ("D3", "D1") in _pairs(_sched(minRestHours=12))            # 11.5시간 < 12시간
    # 시간이 없는 보탠 근무는 잴 수 없다 — 건너뛴다
    assert _pairs(_sched(added=[("D3", "day", "")])) == {}


def _feasible(pattern: dict[int, str], **rules) -> bool:
    sch = _sched(**rules)
    model = cp_model.CpModel()
    x = sch._build_vars(model)
    sch._cs_one_shift_per_day(model, x)
    sch._cs_forbidden_transitions(model, x)
    base = next(i for i, dt in enumerate(sch.all_dates) if (dt.month, dt.day) == (3, 1))
    for day, code in pattern.items():
        model.Add(x["r"][base + day - 1][code] == 1)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 20
    return solver.Solve(model) in (cp_model.OPTIMAL, cp_model.FEASIBLE)


def test_engine_blocks_short_rest_after_an_added_shift():
    assert not _feasible({10: "D3", 11: "D"})
    assert _feasible({10: "D3", 11: "D1"})
    assert not _feasible({10: "E2", 11: "D1"})                        # 마지막 수단(감점)이 아니라 금지
    assert _feasible({10: "E", 11: "D1"})                             # 기본 근무끼리는 전과 같다 (마지막 수단)
    assert _feasible({10: "D3", 11: "D"}, minRest=False)


def test_check_schedule_names_the_rest_hours(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    db.init_db()
    from server.api import CheckScheduleRequest, check_schedule
    nurses = [Nurse(id="r", name="*간호1", group="A", gender="male")]
    req = CheckScheduleRequest(year=2026, month=3, nurses=nurses, requirements=Requirements(), rules=Rules(), shifts=_shifts(),
                               schedule={"r": {"2026-03-10": "D3", "2026-03-11": "D", "2026-03-12": "OF"}})
    notes = [n for n in check_schedule(req)["notes"] if "전환" in n]
    assert len(notes) == 1 and "D3→D, 휴식 9시간" in notes[0], notes


def test_added_work_shift_needs_hours(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    db.init_db()
    from server.api import save_shift
    body = dict(code="중3", name="중간번3", period="middle", hours="")
    with pytest.raises(HTTPException) as e:
        save_shift(dict(body))
    assert e.value.status_code == 400 and "근무 시간" in e.value.detail
    save_shift({**body, "hours": "09:00~18:00"})
    assert any(s["code"] == "중3" and s["hours"] == "09:00~18:00" for s in db.list_shifts())
    save_shift(dict(code="연수", name="연수", period="leave", hours=""))      # 쉬는 코드는 시간이 없어도 된다
    save_shift(dict(code="D1", name="Day1", period="day1", hours=""))        # 기본 근무는 막지 않는다
