"""파트장 확인 하에 쓰는 마지막 수단 — 제1원칙 13 (2026-10-03, 101병동 실제 번표 확인).

"연속근무 6일은 가급적 만들어지면 안 되지만 파트장 컨펌 하 제한적으로 가능 — 주말이
 껴 있으면 업무 로딩이 준다" · "번표가 정 안 나오면 E→D1·중→D 로도 근무한다".
→ 하드 금지 대신 큰 감점. 한도+1 이 상한이고, 쓴 곳은 결과 manager_check 로 알린다.
"""
from __future__ import annotations

import pytest

from server.conflict_analyzer import analyze_conflicts
from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules

from .conftest import _juhu_prev, make_limited
from .test_exact_fit_characterization import PROD_SHIFTS

CAPS = ["DC", "D", "EC", "E", "NC", "N"]
# 원인 격리 — 야간 규칙은 이 검사와 무관하다
ISO = dict(noNOD=False, restAfterNight=False, maxConsecutiveNight=False,
           maxNightPerMonth=False, maxConsecutiveWorkDays=5)


def _req(d=0, e=0, n=0):
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=d, E=e, N=n))
    return req


def _request(nurse_n, pre, per_day=None, req=None, holidays=None, **rules_kw):
    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="male",
                    capable_shifts=CAPS, seniority=i) for i in range(nurse_n)]
    return GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=req or _req(),
        rules=Rules(**{**ISO, **rules_kw}), prev_schedule=pre, shifts=PROD_SHIFTS,
        holidays=holidays or [], per_day_requirements=per_day or {}, time_limit=60,
    )


def _six_run_request(**rules_kw):
    """간호사 1명 · 3/1(일) 주휴 · 3/2~3/7 매일 D=1 → 6일 연속이 아니면 근무표가 없다."""
    per_day = {f"2026-03-0{i}": {"D": 1, "E": 0, "N": 0} for i in range(2, 8)}
    return _request(1, {"a0": {"2026-03-01": "주"}}, per_day=per_day, **rules_kw)


# ── 6일 연속 ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_long_run_last_resort_allows_one_extra_day(solver):
    r = make_limited(_six_run_request(), days=7, solver=solver).solve()
    assert r["success"], r["message"]
    assert [r["schedule"]["a0"][f"2026-03-0{i}"] for i in range(2, 8)] == ["DC"] * 6
    rows = r.get("manager_check") or []
    assert len(rows) == 1, rows
    row = rows[0]
    assert (row["kind"], row["start"], row["end"], row["days"]) == ("run", "2026-03-02", "2026-03-07", 6)
    assert row["weekend_days"] == 1                     # 3/7 토
    assert "파트장 확인 필요" in r["message"]


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_long_run_toggle_off_keeps_hard_limit(solver):
    r = make_limited(_six_run_request(longRunLastResort=False), days=7, solver=solver).solve()
    assert not r["success"]


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_long_run_cap_is_limit_plus_one(solver):
    """한도+1 까지만 — 7일 연속은 마지막 수단으로도 안 된다."""
    per_day = {f"2026-03-0{i}": {"D": 1, "E": 0, "N": 0} for i in range(1, 8)}
    r = make_limited(_request(1, {}, per_day=per_day), days=7, solver=solver).solve()
    assert not r["success"]


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_long_run_not_used_when_avoidable(solver):
    """7명·일 D=5(휴무 = 주휴 7 + OF 7 딱 맞음)·한도 4일 — OF 자리를 골라 끊을 수 있으면
    6일 연속도 5일 연속도 만들지 않는다."""
    nurses_pre = _juhu_prev([Nurse(id=f"a{i}", name="", capable_shifts=CAPS) for i in range(7)],
                            2026, 3, 7)
    r = make_limited(_request(7, nurses_pre, req=_req(d=5), maxConsecutiveWorkDays=4),
                     days=7, solver=solver).solve()
    assert r["success"], r["message"]
    assert not r.get("manager_check"), r.get("manager_check")
    work = {"DC", "D", "EC", "E", "NC", "N"}
    for nid, days in r["schedule"].items():
        run = best = 0
        for dk in sorted(days):
            run = run + 1 if days[dk] in work else 0
            best = max(best, run)
        assert best <= 4, (nid, days)


def test_long_run_penalty_lighter_with_weekend():
    """주말·공휴일이 끼면 덜 깎는다 (3000 − 500×k, 최소 1500)."""
    req = _request(1, {}, holidays=["2026-03-03", "2026-03-04"])
    s = make_limited(req, days=7, solver="highs")
    assert s._long_run_penalty(range(1, 6)) == 2000     # 3/2~3/6: 공휴일 2일
    assert s._long_run_penalty(range(1, 7)) == 1500     # + 3/7 토 → 3일
    assert s._long_run_penalty(range(0, 7)) == 1500     # 최소 1500
    plain = make_limited(_request(1, {}), days=7, solver="highs")
    assert plain._long_run_penalty(range(1, 6)) == 3000  # 평일만


# ── E→D1 · 중→D ──────────────────────────────────────────────────────────────


def _e_to_d1_request(**rules_kw):
    """3/2 저녁 1명 필요 · 3/3 D1(교육) 확정 → E→D1 이 아니면 근무표가 없다."""
    return _request(1, {"a0": {"2026-03-01": "주", "2026-03-03": "D1"}},
                    per_day={"2026-03-02": {"D": 0, "E": 1, "N": 0}}, **rules_kw)


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_e_to_d1_last_resort(solver):
    r = make_limited(_e_to_d1_request(), days=4, solver=solver).solve()
    assert r["success"], r["message"]
    a0 = r["schedule"]["a0"]
    assert (a0["2026-03-02"], a0["2026-03-03"]) == ("EC", "D1")
    rows = r.get("manager_check") or []
    assert [(x["kind"], x["rule"], x["start"]) for x in rows] == [("transition", "E→D1", "2026-03-02")]


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_e_to_d1_toggle_off_is_hard(solver):
    r = make_limited(_e_to_d1_request(rareTransitionLastResort=False), days=4, solver=solver).solve()
    assert not r["success"]


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_middle_to_d_last_resort(solver):
    req = _request(1, {"a0": {"2026-03-01": "주", "2026-03-02": "중"}},
                   per_day={"2026-03-03": {"D": 1, "E": 0, "N": 0}})
    r = make_limited(req, days=4, solver=solver).solve()
    assert r["success"], r["message"]
    assert r["schedule"]["a0"]["2026-03-03"] == "DC"
    assert [x["rule"] for x in r.get("manager_check") or []] == ["중→D"]


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_other_transitions_stay_hard(solver):
    """E→D 는 그대로 금지 — 3/2 저녁 · 3/3 낮이 같은 한 사람이면 근무표가 없다."""
    req = _request(1, {"a0": {"2026-03-01": "주"}},
                   per_day={"2026-03-02": {"D": 0, "E": 1, "N": 0},
                            "2026-03-03": {"D": 1, "E": 0, "N": 0}})
    r = make_limited(req, days=4, solver=solver).solve()
    assert not r["success"]


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_pinned_rare_transition_is_fact_not_manager_check(solver):
    """둘 다 사전입력이면 사용자 사실 — 파트장 확인 목록이 아니라 pinned_notes 로만 알린다."""
    req = _request(1, {"a0": {"2026-03-01": "주", "2026-03-02": "E", "2026-03-03": "D1"}},
                   per_day={"2026-03-02": {"D": 0, "E": 1, "N": 0}})
    r = make_limited(req, days=4, solver=solver).solve()
    assert r["success"], r["message"]
    assert not r.get("manager_check")
    assert any("E→D1" in n for n in r.get("pinned_notes") or []), r.get("pinned_notes")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_relax_does_not_buy_work_wish_with_last_resort(solver):
    """완화 1단계도 같은 감점을 본다 — 근무 원티드(500) 하나를 지키려고 E→D1(2000)을
    만들지 않는다. a1 의 3/4 OF 확정은 낮 2명 필요와 부딪혀 strict 를 실패시키는 장치다."""
    pre = {"a0": {"2026-03-02": "E", "2026-03-03": "D1"},
           "a1": {"2026-03-04": "OF"}}
    req = _request(2, pre, per_day={"2026-03-02": {"D": 0, "E": 1, "N": 0},
                                    "2026-03-04": {"D": 2, "E": 0, "N": 0}})
    req.allow_pre_relax = True
    req.locked_cells = {"a0": {"2026-03-03": True}}     # D1(교육)은 못 옮긴다
    r = make_limited(req, days=4, solver=solver).solve()
    assert r["success"], r["message"]
    a0, a1 = r["schedule"]["a0"], r["schedule"]["a1"]
    assert a0["2026-03-03"] == "D1"
    assert a0["2026-03-02"] not in ("E", "EC"), a0     # 근무 원티드를 내려놓는다
    assert a1["2026-03-02"] == "EC"
    assert not r.get("manager_check"), r.get("manager_check")


# ── 충돌 분석 (신호등·원인 설명) ───────────────────────────────────────────────


def test_conflict_analyzer_treats_soft_pairs_as_allowed(build_request, small_nurses):
    nurses = small_nurses(6)
    prev = {nurses[0].id: {"2026-03-02": "E", "2026-03-03": "D1"}}
    res = analyze_conflicts(build_request(nurses=nurses, prev_schedule=prev, add_juhu=False))
    assert not any("E→D1" in c for c in res["conflicts"]), res["message"]

    rules = Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1, rareTransitionLastResort=False)
    res = analyze_conflicts(build_request(nurses=nurses, prev_schedule=prev, add_juhu=False,
                                          rules=rules))
    assert any("E→D1" in c for c in res["conflicts"]), res["message"]
