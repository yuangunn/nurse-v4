"""달이 4주 블록 중간에서 시작하면 그 블록의 주휴 요일은 지난달 것 그대로 (결정 1-37, 2026-10-15).

원근: "주휴를 옮기는 건 4주기 → 1주기로 진행할 때 1주기 쪽에서만 옮기는 걸로 되어 있지?" — 블록 잠금은 이번 달
날짜만 봐서, 달이 3·4주기에서 시작하면 지난달 1·2주기 요일을 몰라 그 블록의 이번 달 주만 다른 요일로 옮길 수 있었다.
카드에서 '지난달 요일 이어받기'를 골랐다. 출처: 사전입력의 지난달 칸(전달 이월) > 지난달 저장본(서버가 주입).
"""
from __future__ import annotations

import pytest

from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules
from server.scheduler import NurseScheduler

from .conftest import make_limited
from .test_exact_fit_characterization import PROD_SHIFTS

CAPS = ["DC", "D", "EC", "E", "NC", "N"]
ISO = dict(noNOD=False, restAfterNight=False, maxConsecutiveNight=False,
           maxNightPerMonth=False, maxConsecutiveWorkDays=5)
# 2026-11-01(일)은 블록 8(10/11~11/7)의 4주기 — 1~3주기는 10월
TUESDAYS = ["2026-10-13", "2026-10-20", "2026-10-27"]


def _nov_request(prev_juhu=None, pre_extra=None, lock=True, year=2026, month=11):
    """11/1~11/7 · 두 명 · 낮 근무만 · a0 은 이번 주 주휴를 목(11/5)에 넣었다.
    a1 의 11/2 E 원티드(그날 E 0명)로 strict 가 실패해 완화(주휴 이동 허용)로 간다."""
    days = [f"{year}-{month:02d}-0{i}" for i in range(1, 8)]
    per_day = {dk: {"D": n, "E": 0, "N": 0} for dk, n in zip(days, [1, 2, 1, 2, 1, 2, 1])}
    pre = {"a0": {days[4]: "주"}, "a1": {days[1]: "E", days[6]: "주"}}
    for nid, cells in (pre_extra or {}).items():
        pre.setdefault(nid, {}).update(cells)
    req = Requirements()
    for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, k, DayRequirement(D=0, E=0, N=0))
    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="male",
                    capable_shifts=CAPS, seniority=i) for i in range(2)]
    r = GenerateRequest(year=year, month=month, nurses=nurses, requirements=req, rules=Rules(**ISO),
                        prev_schedule=pre, shifts=PROD_SHIFTS, per_day_requirements=per_day,
                        time_limit=60, prev_juhu_dates=prev_juhu)
    r.allow_pre_relax = True
    r.allow_juhu_relax = True
    r.juhu_block_lock = lock
    return r


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_block_started_last_month_keeps_last_months_weekday(solver):
    """10월 1~3주기 주휴가 화요일이면, 주휴를 옮길 때 11월 첫 주(4주기)도 화요일(11/3)."""
    r = make_limited(_nov_request({"a0": TUESDAYS}), days=7, solver=solver).solve()
    assert r["success"], r["message"]
    a0 = [r["schedule"]["a0"][f"2026-11-0{i}"] for i in range(1, 8)]
    assert a0[2] == "주" and a0.count("주") == 1, a0


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_anchor_weekday_taken_keeps_juhu_on_its_day(solver):
    """지난달 요일(화 11/3)에 자리가 없으면(잠근 D) 주휴를 없애지 않고 넣은 날(목 11/5)에 둔다 — 요일 어기기는 감점일 뿐,
    주휴는 오프특근 때도 지키는 최소한의 휴무다 (제1원칙 3). 하드로 묶던 때는 그 주 주휴가 사라졌다."""
    req = _nov_request({"a0": TUESDAYS}, pre_extra={"a0": {"2026-11-03": "D"}})
    req.locked_cells = {"a0": {"2026-11-03": True}}
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    a0 = [r["schedule"]["a0"][f"2026-11-0{i}"] for i in range(1, 8)]
    assert a0[2] in ("D", "DC") and a0[4] == "주" and a0.count("주") == 1, a0   # 잠근 D 는 차지로 오를 수 있다


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
@pytest.mark.parametrize("case", ["no_saved", "unlocked"])
def test_no_anchor_without_last_month_or_lock(solver, case):
    """지난달 저장본이 없거나 '주휴 이동 제한 풀기'면 지금처럼 — 넣은 목요일 주휴를 옮길 까닭이 없다."""
    req = _nov_request(None if case == "no_saved" else {"a0": TUESDAYS}, lock=(case != "unlocked"))
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    assert r["schedule"]["a0"]["2026-11-05"] == "주", r["schedule"]["a0"]


def test_anchor_source_and_month_start_on_block_boundary():
    """사전입력의 지난달 칸이 저장본보다 먼저 · 그 블록에서 가장 늦은 주휴 · 달이 블록 첫날에 시작하면 없음."""
    s = NurseScheduler(_nov_request({"a0": TUESDAYS}))
    a0 = next(n for n in s.nurses if n["id"] == "a0")
    assert s._juhu_anchor(a0) == (8, 1)                       # 블록 8, 화요일
    # 전달 이월로 10/27(화) 칸이 D 로 들어와 있고 10/29(목)가 주 → 사람이 넣은 칸이 저장본보다 먼저
    s = NurseScheduler(_nov_request({"a0": TUESDAYS},
                                    pre_extra={"a0": {"2026-10-27": "D", "2026-10-29": "주"}}))
    a0 = next(n for n in s.nurses if n["id"] == "a0")
    assert s._juhu_anchor(a0) == (8, 3)                       # 목요일
    # 블록 밖(10/4, 블록 7)의 주휴는 세지 않는다
    s = NurseScheduler(_nov_request({"a0": ["2026-10-04"]}))
    assert s._juhu_anchor(next(n for n in s.nurses if n["id"] == "a0")) is None
    # 지난달(10월) 나이트킵의 주휴는 잇지 않는다 — 블록 잠금도 나이트킵의 날을 뺀다 (결정 1-36 후속 2)
    req = _nov_request({"a0": TUESDAYS})
    req.nurses[0].night_months = {"2026-10": True}
    s = NurseScheduler(req)
    assert s._juhu_anchor(next(n for n in s.nurses if n["id"] == "a0")) is None
    # 2026-03-01 은 블록 첫날 — 지난달에 시작한 블록이 없다
    s = NurseScheduler(_nov_request({"a0": ["2026-02-24"]}, year=2026, month=3))
    assert s._juhu_anchor(next(n for n in s.nurses if n["id"] == "a0")) is None


def test_prev_month_juhu_from_latest_saved(tmp_path, monkeypatch):
    """지난달 최신 저장본의 주휴 날짜만 (지난달 날짜 · 날짜순) — 서버가 생성 요청에 넣는다."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    from server.api import _attach_prev_juhu
    db.init_db()
    db.save_schedule(year=2026, month=10, name="10월 확정", data={"schedule": {
        "a0": {"2026-10-27": "주", "2026-10-13": "주", "2026-11-03": "주", "2026-10-14": "D"},
        "a1": {"2026-10-14": "OF"}}})
    assert db.compute_prev_month_juhu(2026, 11) == {"a0": ["2026-10-13", "2026-10-27"]}
    req = _nov_request()
    _attach_prev_juhu(req)
    assert req.prev_juhu_dates == {"a0": ["2026-10-13", "2026-10-27"]}
    req = _nov_request(lock=False)
    _attach_prev_juhu(req)
    assert req.prev_juhu_dates is None                        # 블록 잠금을 풀면 쓰지 않는다


def _ladder_request(prev_juhu):
    """11/1~11/14 · a1 은 11/3·11/5 말고 다 잠갔다 — a0 의 주휴를 지난달 요일(화 11/3)로 옮기면
    a1 이 11/4~11/9 6일 연속(주말 이틀)이 된다. 2026-10-16 검토에서 나온 재현."""
    days = [f"2026-11-{i:02d}" for i in range(1, 15)]
    per_day = {dk: {"D": n, "E": 0, "N": 0}
               for dk, n in zip(days, [1, 2, 1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 2, 1])}
    a1 = {dk: "D" for dk in days}
    a1.update({"2026-11-01": "DC", "2026-11-02": "E", "2026-11-08": "주", "2026-11-11": "OF",
               "2026-11-10": "DC", "2026-11-14": "DC"})   # 11/2 E 는 못 지키는 원티드 — strict 가 실패해 완화로 간다
    del a1["2026-11-03"], a1["2026-11-05"]
    pre = {"a0": {"2026-11-01": "OF", "2026-11-05": "주", "2026-11-10": "주", "2026-11-14": "OF"}, "a1": a1}
    req = Requirements()
    for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, k, DayRequirement(D=0, E=0, N=0))
    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="male",
                    capable_shifts=CAPS, seniority=i) for i in range(2)]
    r = GenerateRequest(year=2026, month=11, nurses=nurses, requirements=req, rules=Rules(**ISO),
                        prev_schedule=pre, shifts=PROD_SHIFTS, per_day_requirements=per_day,
                        time_limit=60, prev_juhu_dates=prev_juhu,
                        locked_cells={"a1": {dk: True for dk in a1 if dk != "2026-11-02"}})
    r.allow_pre_relax = True
    r.allow_juhu_relax = True
    r.juhu_block_lock = True
    return r


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_anchor_never_buys_a_last_resort(solver):
    """지난달 요일 감점은 파트장 확인 마지막 수단(6일 연속·E→D1·중→D)보다 작다 — 지난달 요일을 지키려고
    6일 연속을 만들지 않는다 (제1원칙 13). 감점 2500 이던 때는 주말 이틀 낀 6일 연속(2000)을 골랐다."""
    r = make_limited(_ladder_request({"a0": TUESDAYS}), days=14, solver=solver).solve()
    assert r["success"], r["message"]
    assert not r.get("manager_check"), r.get("manager_check")
    assert r["schedule"]["a0"]["2026-11-05"] == "주", r["schedule"]["a0"]


def test_anchor_penalty_sits_between_moves_and_last_resorts():
    """블록의 이번 달 주휴를 다 옮겨도(많아야 넷 × 300) 감점보다 싸고, 감점은 마지막 수단·OF 원티드·휴가 원티드보다 작다."""
    from server.scheduler_base import _LONG_RUN_MIN_PENALTY, _RARE_TRANSITION_PENALTY
    s = NurseScheduler(_nov_request({"a0": TUESDAYS}))
    pen = s._juhu_anchor_pen(3000, 5000)
    assert pen == 1400
    assert 4 * 300 < pen < min(_LONG_RUN_MIN_PENALTY, _RARE_TRANSITION_PENALTY)
    assert s._juhu_anchor_pen(1000, 5000) == 900          # OF 원티드 보너스를 낮추면 그 아래로
    assert s._juhu_anchor_pen(0, 0) == 1400               # 0 인 보너스(지키지 않는 원티드)는 세지 않는다


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_no_anchor_term_when_weekday_unavailable(solver):
    """지난달 요일에 옮길 칸이 없으면(잠근 D) 잇지 않는다 — 어느 요일이든 같은 감점이면 주휴 대신 V 를 고를 수 있다."""
    req = _nov_request({"a0": TUESDAYS}, pre_extra={"a0": {"2026-11-03": "D"}})
    req.locked_cells = {"a0": {"2026-11-03": True}}
    sch = make_limited(req, days=7, solver=solver)
    assert sch.solve()["success"]
    assert sch._juhu_anchor_dev == []
    sch = make_limited(_nov_request({"a0": TUESDAYS}), days=7, solver=solver)
    assert sch.solve()["success"]
    assert sch._juhu_anchor_dev                              # 화요일이 비어 있으면 잇는다
