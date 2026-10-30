"""파트장 확인 하에 쓰는 마지막 수단 — 제1원칙 13 (2026-10-03, 101병동 실제 번표 확인).

"연속근무 6일은 가급적 만들어지면 안 되지만 파트장 컨펌 하 제한적으로 가능 — 주말이
 껴 있으면 업무 로딩이 준다" · "번표가 정 안 나오면 E→D1·중→D 로도 근무한다".
→ 하드 금지 대신 큰 감점. 한도+1 이 상한이고, 쓴 곳은 결과 manager_check 로 알린다.
"""
from __future__ import annotations

from datetime import date

import pytest

from server.conflict_analyzer import analyze_conflicts
from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules
from server.scheduler import NurseScheduler

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


def _teukgeun_vs_run_request(relax: bool):
    """2명 · 3/1~3/14 · 낮만. a0 은 3/3~3/8 6일 연속이 아니면 a1 이 오프특근을 해야 한다.
    relax=True 면 a1 의 3/8 OF 원티드(낮 2명 필요한 날)가 strict 를 실패시킨다."""
    d = [1, 1, 2, 1, 2, 1, 2, 2, 0, 2, 1, 2, 2, 1]
    per_day = {f"2026-03-{i + 1:02d}": {"D": n, "E": 0, "N": 0} for i, n in enumerate(d)}
    pre = {"a0": {"2026-03-01": "주", "2026-03-14": "주", "2026-03-10": "D"},
           "a1": {"2026-03-04": "주", "2026-03-11": "주", "2026-03-02": "DC"}}
    if relax:
        pre["a1"]["2026-03-08"] = "OF"
    req = _request(2, pre, per_day=per_day)
    req.locked_cells = {"a1": {"2026-03-02": True}}
    req.allow_pre_relax = relax
    return req


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
@pytest.mark.parametrize("relax", [False, True])
def test_relax_prefers_last_resort_over_off_teukgeun(solver, relax):
    """2차 집중 검토: 완화 1단계에 오프특근이 없어, 원티드를 풀어야 하는 달엔 6일 연속 대신
    오프특근 + V 를 골랐다(strict 는 반대). 두 경로 모두 6일 연속(파트장 확인)이 먼저다."""
    r = make_limited(_teukgeun_vs_run_request(relax), days=14, solver=solver).solve()
    assert r["success"], r["message"]
    assert not r.get("off_teukgeun"), r.get("off_teukgeun")
    assert [c["kind"] for c in r.get("manager_check") or []] == ["run"], r.get("manager_check")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_relax_moves_leave_wish_before_off_teukgeun(solver):
    """오프특근은 가장 나중 (2026-10-03) — 원티드를 풀어야 하는 달엔 휴가 원티드까지
    먼저 푼다. 3/1~3/7 · 2명 · 낮만. a1 의 3/3 V 원티드를 지키면 누군가 그 주 OF 를 반납해야
    한다(오프특근). a1 의 3/6 OF 원티드(낮 2명 필요한 날)가 strict 를 실패시키는 장치다."""
    d = [1, 2, 1, 1, 2, 2, 1]
    per_day = {f"2026-03-0{i + 1}": {"D": n, "E": 0, "N": 0} for i, n in enumerate(d)}
    pre = {"a0": {"2026-03-04": "주"},
           "a1": {"2026-03-01": "주", "2026-03-03": "V", "2026-03-06": "OF"}}
    req = _request(2, pre, per_day=per_day, longRunLastResort=False)
    req.allow_pre_relax = True
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    assert not r.get("off_teukgeun"), r.get("off_teukgeun")
    assert r["schedule"]["a1"]["2026-03-03"] != "V", r["schedule"]["a1"]


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
@pytest.mark.parametrize("code", ["공", "특"])
def test_relax_keeps_fixed_date_leave_over_off_teukgeun(solver, code):
    """날이 정해진 휴가는 오프특근보다 먼저 지킨다 (2026-10-03, 결정 1-35) —
    "경가·조가 등으로 휴무가 갑자기 많아지면 남은 근무자들이 오프를 줄여가며 근무를 뛴다"(제1원칙 3).
    위 V 시험과 같은 표에서 V 자리만 공·특으로 바꾸면, 휴가는 그대로 두고 a1 이 그 주 OF 를 반납한다."""
    d = [1, 2, 1, 1, 2, 2, 1]
    per_day = {f"2026-03-0{i + 1}": {"D": n, "E": 0, "N": 0} for i, n in enumerate(d)}
    pre = {"a0": {"2026-03-04": "주"},
           "a1": {"2026-03-01": "주", "2026-03-03": code, "2026-03-06": "OF"}}
    req = _request(2, pre, per_day=per_day, longRunLastResort=False)
    req.allow_pre_relax = True
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    assert r["schedule"]["a1"]["2026-03-03"] == code, r["schedule"]["a1"]
    assert len(r.get("off_teukgeun") or []) == 1, r.get("off_teukgeun")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
@pytest.mark.parametrize("block_lock", [True, False])
def test_juhu_relax_never_drops_juhu_to_avoid_off_teukgeun(solver, block_lock):
    """주휴 이동 허용(주휴 무시)을 켜도 오프특근을 피하려고 주휴를 없애지 않는다 — 주휴는 오프특근 때도
    깎이지 않는 최소 휴무다(제1원칙 3). 오프특근 감점(1단계)이 주휴 유지 보너스(300)보다 커지자, 위 표에서
    a1 의 3/1 주휴가 DC 로 바뀌고 오프특근이 사라졌다(v4.14.0 릴리스 전 점검). v4.13.1 은 주휴를 지켰다."""
    d = [1, 2, 1, 1, 2, 2, 1]
    per_day = {f"2026-03-0{i + 1}": {"D": n, "E": 0, "N": 0} for i, n in enumerate(d)}
    pre = {"a0": {"2026-03-04": "주"},
           "a1": {"2026-03-01": "주", "2026-03-03": "공", "2026-03-06": "OF"}}
    req = _request(2, pre, per_day=per_day, longRunLastResort=False)
    req.allow_pre_relax = True
    req.allow_juhu_relax = True
    req.juhu_block_lock = block_lock
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    for nid in ("a0", "a1"):
        week = [r["schedule"][nid][f"2026-03-0{i}"] for i in range(1, 8)]
        assert week.count("주") == 1, (nid, week)
    assert r["schedule"]["a1"]["2026-03-03"] == "공", r["schedule"]["a1"]
    assert len(r.get("off_teukgeun") or []) == 1, r.get("off_teukgeun")


def _juhu_relax_request(nurse_n, pre, d, **nurse_kw):
    per_day = {f"2026-03-0{i + 1}": {"D": n, "E": 0, "N": 0} for i, n in enumerate(d)}
    req = _request(nurse_n, pre, per_day=per_day)
    for nid, kw in nurse_kw.items():
        for k, v in kw.items():
            setattr(req.nurses[int(nid[1:])], k, v)
    req.allow_pre_relax = True
    req.allow_juhu_relax = True
    return req


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
@pytest.mark.parametrize("stay, stale", [({"end_date": "2026-03-04"}, "2026-03-06"),
                                         ({"start_date": "2026-03-04"}, "2026-03-02")])
def test_juhu_floor_ignores_juhu_outside_stay(solver, stay, stale):
    """전입 전·전출 뒤 칸에 남은 주(주휴 추천을 적용한 뒤 전출일을 넣은 경우)는 없는 칸 — 그 주에 주휴를
    지키라는 바닥을 만들지 않는다. 바닥이 걸리면 그 사람 근무일에 없던 주휴를 지어내고 남에게 오프특근을 떠넘겼다."""
    pre = {"a0": {"2026-03-02": "주"}, "a1": {stale: "주"}, "a2": {"2026-03-03": "주", "2026-03-07": "E"}}
    if "start_date" in stay:
        pre = {"a0": {"2026-03-05": "주"}, "a1": {stale: "주"}, "a2": {"2026-03-06": "주", "2026-03-01": "E"}}
    r = make_limited(_juhu_relax_request(3, pre, [2] * 7, a1=stay), days=7, solver=solver).solve()
    assert r["success"], r["message"]
    assert "주" not in r["schedule"]["a1"].values(), r["schedule"]["a1"]
    assert not r.get("off_teukgeun"), r.get("off_teukgeun")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
@pytest.mark.parametrize("code", ["병", "공"])
@pytest.mark.parametrize("side_wish", [False, True])
def test_juhu_floor_yields_to_fixed_date_leave(solver, code, side_wish):
    """한 주에 하루만 쉴 수 있는데 주휴와 날이 정해진 휴가가 다 있으면 그 휴가를 지킨다 —
    그날 쉬는 것은 같고, 휴가는 날을 옮길 수 없다 (결정 1-35·1-36: 오프특근 < 주휴 없애기 < 날이 정해진 휴가).
    side_wish: a2 의 3/1 D 원티드 하나가 휴가를 지키는 쪽에만 더 든다. 휴가 보너스가 주휴 없애기와
    100 차이이던 때는 이 원티드(500) 하나에 병·공이 근무로 바뀌었다 (v4.14.0 뒤 재점검)."""
    a1 = ["D", "D", "OF", "D", "D", "주", "D"]
    pre = {"a0": {"2026-03-01": "주", "2026-03-04": code},
           "a1": {f"2026-03-0{i + 1}": v for i, v in enumerate(a1)}}
    if side_wish:
        pre["a2"] = {"2026-03-01": "D"}
    req = _juhu_relax_request(3, pre, [2, 3, 2, 2, 3, 2, 3])
    req.locked_cells = {"a1": {f"2026-03-0{i}": True for i in range(1, 8)}}
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    assert r["schedule"]["a0"]["2026-03-04"] == code, r["schedule"]["a0"]


class _NovLastWeek:
    """11월 생성의 마지막 주(11/29~12/5)만 — 11/29·30 은 11월, 12/1~12/5 는 다음 달 며칠."""

    def _build_date_range(self):
        super()._build_date_range()
        self.all_dates = [d for d in self.all_dates
                          if date(2026, 11, 29) <= d <= date(2026, 12, 5)]
        self.T = len(self.all_dates)
        self.date_to_idx = {d: i for i, d in enumerate(self.all_dates)}
        self.weeks = [(0, 6)]


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
@pytest.mark.parametrize("block_lock", [True, False])
def test_juhu_floor_covers_this_months_keeper_on_next_month_days(solver, block_lock):
    """11월만 나이트킵인 a0 은 12/1~12/5 엔 일반 간호사다 (결정 1-33). 그 며칠에 미리 넣은 주휴도
    오프특근을 피하려고 없애지 않는다 — 나이트킵을 통째로 빼던 때는 a0 의 12/2 주휴가 DC 로 바뀌고
    오프특근이 사라졌다 (v4.14.0 뒤 재점검). 다음 달 나이트킵 표시 없이 같은 표면 a0 이 주휴를 지켰다."""
    from server.scheduler_cpsat import CpSatScheduler

    days = [f"2026-11-{d}" for d in (29, 30)] + [f"2026-12-0{d}" for d in range(1, 6)]
    per_day = {dk: {"D": dd, "E": 0, "N": nn}
               for dk, dd, nn in zip(days, [1, 2, 2, 3, 2, 3, 2], [1, 0, 0, 0, 0, 0, 0])}
    pre = {"a0": {"2026-12-02": "주"}, "a1": {"2026-12-03": "주"},
           "a2": {"2026-12-04": "주", "2026-11-30": "E"}}
    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="male", capable_shifts=CAPS,
                    seniority=i, night_months={"2026-11": True} if i == 0 else {}) for i in range(3)]
    week_req = Requirements()     # 다음 달 며칠은 요일별 인원을 본다
    for day, dd in zip(("sun", "mon", "tue", "wed", "thu", "fri", "sat"), [1, 2, 2, 3, 2, 3, 2]):
        setattr(week_req, day, DayRequirement(D=dd, E=0, N=0))
    req = GenerateRequest(
        year=2026, month=11, nurses=nurses, requirements=week_req,
        rules=Rules(**ISO, longRunLastResort=False), prev_schedule=pre, shifts=PROD_SHIFTS,
        per_day_requirements=per_day, time_limit=60)
    req.allow_pre_relax = True
    req.allow_juhu_relax = True
    req.juhu_block_lock = block_lock
    base = NurseScheduler if solver == "highs" else CpSatScheduler
    r = type("W", (_NovLastWeek, base), {})(req).solve()
    assert r["success"], r["message"]
    a0 = [r["schedule"]["a0"][dk] for dk in days[2:]]
    assert a0.count("주") == 1, a0
    assert r.get("off_teukgeun"), r.get("off_teukgeun")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_juhu_relax_keeps_keepers_juhu_once_a_week(solver):
    """주휴 이동 허용에서도 나이트킵이 미리 넣은 주휴는 그 주에 하나 남는다 — 야간 날(3/3·3/4·3/7)이
    정해져 있어 3/4 주휴는 그 주 다른 쉬는 날로 옮길 뿐이다. 나이트킵을 빼던 때는 주휴가 NC 로 바뀌고 그 주에
    주휴가 하나도 없었다(v4.14.0 뒤 재점검). 나이트킵의 날엔 새 주휴를 만들지 않는다 (N·V·생·OF 뿐 — 제1원칙 10)."""
    per_day = {f"2026-03-0{i + 1}": {"D": dd, "E": 0, "N": nn}
               for i, (dd, nn) in enumerate(zip([1, 1, 1, 1, 2, 2, 1], [0, 0, 1, 1, 0, 0, 1]))}
    pre = {"a0": {"2026-03-04": "주"}, "a1": {"2026-03-03": "주", "2026-03-05": "특"},
           "a2": {"2026-03-07": "주", "2026-03-01": "병", "2026-03-06": "E"}}
    req = _juhu_relax_request(3, pre, [0] * 7, a0={"is_night_shift": True, "capable_shifts": ["NC", "N"]})
    req.per_day_requirements = per_day
    req.juhu_block_lock = False
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    a0 = [r["schedule"]["a0"][f"2026-03-0{i}"] for i in range(1, 8)]
    assert a0.count("주") == 1, a0
    assert set(a0) <= {"N", "NC", "OF", "V", "생", "주"}, a0


def test_relax_gives_keeper_no_new_juhu():
    """주휴 이동 허용이어도 나이트킵의 날엔 미리 넣은 주휴가 없는 주에 주휴 변수를 두지 않는다 (제1원칙 10)."""
    pre = {"a0": {"2026-03-04": "주"}}
    req = _juhu_relax_request(2, pre, [1] * 7, a0={"is_night_shift": True})
    s = make_limited(req, days=14)
    n0 = next(n for n in s.nurses if n["id"] == "a0")
    n1 = next(n for n in s.nurses if n["id"] == "a1")
    assert all(s._relax_juhu_free_ok(n0, d) for d in range(0, 7))
    assert not any(s._relax_juhu_free_ok(n0, d) for d in range(7, 14))
    assert all(s._relax_juhu_free_ok(n1, d) for d in range(14))


@pytest.mark.parametrize("case", ["last_month", "outside_stay", "locked"])
def test_relax_gives_keeper_no_new_juhu_from_fixed_cells(case):
    """엔진이 옮길 수 없는 주휴(지난달 칸·재적 밖·잠긴 칸)로는 그 주 나이트킵의 날에 주휴 변수를 열지 않는다 —
    옮길 것이 없으니 연 변수는 새 주휴가 된다 (2026-10-16 검토)."""
    if case == "last_month":     # 4월 생성 · 두 달 다 나이트킵 · 3/31(지난달 칸)에 주
        nurses = [Nurse(id="a0", name="*k", group="A", gender="male", capable_shifts=["NC", "N"],
                        seniority=0, is_night_shift=True),
                  Nurse(id="a1", name="*r", group="A", gender="male", capable_shifts=CAPS, seniority=1)]
        req = GenerateRequest(year=2026, month=4, nurses=nurses, requirements=_req(), rules=Rules(**ISO),
                              prev_schedule={"a0": {"2026-03-30": "OF", "2026-03-31": "주"}},
                              shifts=PROD_SHIFTS, time_limit=60)
        req.allow_pre_relax = True
        req.allow_juhu_relax = True
        s = NurseScheduler(req)
        days = [s.date_to_idx[date(2026, 4, d)] for d in range(1, 5)]
    else:
        kw = {"is_night_shift": True, "capable_shifts": ["NC", "N"]}
        if case == "outside_stay":
            kw["start_date"] = "2026-03-04"
        req = _juhu_relax_request(2, {"a0": {"2026-03-02": "주"}}, [1] * 7, a0=kw)
        if case == "locked":
            req.locked_cells = {"a0": {"2026-03-02": True}}
        s = make_limited(req, days=7)
        days = range(3, 7)
    n0 = next(n for n in s.nurses if n["id"] == "a0")
    assert not any(s._relax_juhu_free_ok(n0, d) for d in days)


def _relaxed_only(solver, mixin, req):
    from server.scheduler_cpsat import CpSatScheduler
    base = NurseScheduler if solver == "highs" else CpSatScheduler
    s = type("W", (mixin, base), {})(req)
    if solver == "highs":
        s._build_pin_index()
        return s._solve_with_relaxed_pre()
    return s._solve_relaxed()


@pytest.mark.parametrize("lock", [False, True])
@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_juhu_relax_keeps_juhu_on_both_sides_of_keeper_month_end(solver, lock):
    """11월만 나이트킵인 a0 의 마지막 주(11/29~12/5): 11/29(나이트킵의 날)와 12/2(일반의 날) 주휴 둘 다 지킨다.
    상한을 주 전체에 1 로 걸던 때는 바닥 둘이 함께 설 수 없어 11/29 주휴가 NC 로 바뀌었다 (2026-10-16 검토).
    달이 바뀌는 주는 두 달의 근무표가 제 주휴를 따로 정한다 (결정 1-33). 블록 잠금을 켜도 같다 — 일반의 날(12/1~)이
    잠금에 들어가도 한 주라 묶을 것이 없다 (PR #97 검토 후속)."""
    days = [f"2026-11-{d}" for d in (29, 30)] + [f"2026-12-0{d}" for d in range(1, 6)]
    per_day = {dk: {"D": dd, "E": 0, "N": nn}
               for dk, dd, nn in zip(days, [1, 1, 2, 2, 2, 2, 2], [1, 1, 0, 0, 0, 0, 0])}
    pre = {"a0": {"2026-11-29": "주", "2026-12-02": "주"}, "a1": {"2026-12-03": "주"},
           "a2": {"2026-12-04": "주"}, "a3": {"2026-12-05": "주"}}
    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="male", capable_shifts=CAPS,
                    seniority=i, night_months={"2026-11": True} if i == 0 else {}) for i in range(4)]
    week_req = Requirements()
    for day, dd in zip(("sun", "mon", "tue", "wed", "thu", "fri", "sat"), [1, 1, 2, 2, 2, 2, 2]):
        setattr(week_req, day, DayRequirement(D=dd, E=0, N=0))
    req = GenerateRequest(year=2026, month=11, nurses=nurses, requirements=week_req,
                          rules=Rules(**ISO, longRunLastResort=False), prev_schedule=pre, shifts=PROD_SHIFTS,
                          per_day_requirements=per_day, time_limit=60)
    req.allow_pre_relax = True
    req.allow_juhu_relax = True
    req.juhu_block_lock = lock
    r = _relaxed_only(solver, _NovLastWeek, req)
    assert r, "완화 실패"
    a0 = r["schedule"]["a0"]
    assert a0["2026-11-29"] == "주" and a0["2026-12-02"] == "주", a0
    assert not (r.get("relaxed_cells") or {}).get("a0"), r.get("relaxed_cells")


class _NovBlock9:
    """11/8~12/5 — 블록 9 전체 (11/29~12/5 는 다음 달 며칠이 낀 주)."""

    def _build_date_range(self):
        super()._build_date_range()
        self.all_dates = [d for d in self.all_dates if date(2026, 11, 8) <= d <= date(2026, 12, 5)]
        self.T = len(self.all_dates)
        self.date_to_idx = {d: i for i, d in enumerate(self.all_dates)}
        self.weeks = [(i, i + 6) for i in range(0, self.T, 7)]


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_juhu_block_lock_leaves_next_month_keeper_days_out(solver):
    """11월엔 일반, 12월엔 나이트킵인 a0: 블록 9(11/8~12/5) 주휴 요일은 일요일(11/8·15·22), 12/3(목, 나이트킵의 날)에도
    미리 넣은 주휴. 블록 요일 잠금이 12/3 까지 한 요일로 묶던 때는 그 하나를 지키려고 11월 일요일 주휴 셋을 옮겼다
    (2026-10-16 검토). 나이트킵인지는 날짜의 달로 정하므로(결정 1-33) 잠금도 나이트킵의 날을 뺀다."""
    from datetime import timedelta
    lo = date(2026, 11, 8)
    tot = [3, 4, 4, 4, 3, 4, 3]       # 일~토
    per_day = {}
    for i in range(28):
        dt = lo + timedelta(days=i)
        w = (dt.weekday() + 1) % 7
        per_day[dt.isoformat()] = ({"D": tot[w] - 1, "E": 0, "N": 1} if dt.month == 12
                                   else {"D": tot[w], "E": 0, "N": 0})
    pre = {"a0": {"2026-11-08": "주", "2026-11-15": "주", "2026-11-22": "주", "2026-12-03": "주"}}
    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="male", capable_shifts=CAPS,
                    seniority=i, night_months={"2026-12": True} if i == 0 else {}) for i in range(5)]
    wk = Requirements()
    for k, (dd, nn) in dict(sun=(3, 0), mon=(4, 0), tue=(3, 1), wed=(3, 1), thu=(2, 1),
                            fri=(3, 1), sat=(2, 1)).items():
        setattr(wk, k, DayRequirement(D=dd, E=0, N=nn))
    req = GenerateRequest(year=2026, month=11, nurses=nurses, requirements=wk, rules=Rules(**ISO),
                          prev_schedule=pre, shifts=PROD_SHIFTS, per_day_requirements=per_day, time_limit=120)
    req.allow_pre_relax = True
    req.allow_juhu_relax = True
    req.juhu_block_lock = True
    r = _relaxed_only(solver, _NovBlock9, req)
    assert r, "완화 실패"
    a0 = r["schedule"]["a0"]
    assert all(a0[f"2026-11-{d}"] == "주" for d in ("08", "15", "22")), a0
    assert a0["2026-12-03"] == "주", a0
    assert not (r.get("relaxed_cells") or {}).get("a0"), r.get("relaxed_cells")


def test_fixed_date_leave_bonus_tops_off_teukgeun():
    """날이 정해진 휴가 한 칸 = 오프특근 감점 × 5, 주휴 없애기 = × 3 − 주휴 유지 보너스 − 100 —
    완화 이력 보정으로 감점이 커져도 따라간다. 순서: 오프특근 둘 < 주휴 없애기 < 날이 정해진 휴가,
    그리고 휴가와 주휴 없애기 사이에 오프특근 둘이 더 들어간다 (결정 1-35·1-36)."""
    from server.scheduler_base import _FIXED_DATE_LEAVE
    assert _FIXED_DATE_LEAVE == {"특", "공", "병", "경가", "조가", "산전"}
    s = NurseScheduler(_six_run_request())
    for boost, fixed, drop in ((None, 25500, 14900), (1.5, 38000, 22400)):
        if boost:
            s.relax_boosts = {"a0": boost}
        off = s._relax_off_teukgeun_pen(5000, 3000, 500)
        assert s._relax_fixed_leave_bonus(5000, 3000, 500) == fixed
        assert s._relax_juhu_drop_pen(300, 5000, 3000, 500) == drop
        assert 2 * off < drop + 300 < 3 * off
        assert drop + 300 + 2 * off < fixed


def test_relax_off_teukgeun_penalty_tops_boosted_leave_wish():
    """완화 이력 보정으로 커진 휴가 원티드(5000×1.5)보다도 오프특근 한 번이 더 비싸다."""
    s = NurseScheduler(_six_run_request())
    s._off_slack = ["s"]
    assert s._relax_off_teukgeun_terms(5000, 3000, 500) == [(5100, "s")]
    s.relax_boosts = {"a0": 1.5}
    assert s._relax_off_teukgeun_terms(5000, 3000, 500) == [(7600, "s")]


def test_manager_check_skips_user_entered_cells_in_relax_mode():
    """2차 집중 검토: 완화 모드에선 _pin 이 비어 사람이 넣은 6일 연속·E→D1 까지 '파트장 확인'으로
    셌다. 사전입력과 직접 견준다 (화면 scheduleWarnings 와 같은 기준)."""
    run = {f"2026-03-0{i}": "D" for i in range(2, 8)}
    s = NurseScheduler(_request(2, {"a0": dict(run), "a1": {"2026-03-02": "E", "2026-03-03": "D1"}}))
    s._pin = {}                                           # 완화 모드 — 사실-클램프 인덱스가 비어 있다
    sched = {"a0": {"2026-03-01": "주", **run, "2026-03-08": "OF"},
             "a1": {"2026-03-02": "E", "2026-03-03": "D1", "2026-03-04": "OF"}}
    assert s._manager_check_report(sched) == []
    sched["a0"]["2026-03-07"] = "DC"                      # D 원티드의 차지 승격도 지킨 것
    assert s._manager_check_report(sched) == []
    del s.prev["a0"]["2026-03-04"]                        # 한 칸이라도 엔진이 놓았으면 센다
    del s.prev["a1"]["2026-03-02"]
    assert sorted(c["kind"] for c in s._manager_check_report(sched)) == ["run", "transition"]


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
