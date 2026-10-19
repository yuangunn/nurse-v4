"""신규간호사는 마지막 트레이닝 날의 다음 날부터 보통 간호사 — 달 중간에 끝나도 (2026-10-16).

101병동 11월: 트레이닝이 11/03 에 끝나는 신규가 11월 내내 '/'+프리셉터 근무로만 나왔다 —
엔진이 달 전체를 트레이니로 보고 독립한 뒤 칸을 비웠다(schedule[tid] = {}). 그 사람 몫을
남은 간호사가 메꾸느라 V 가 자동으로 쌓였고, 11/07·11/13… 에 미리 넣은 주휴도 사라졌다.

지금 규칙:
  · 마지막 트레이닝 날 = 트레이닝 끝나는 날과 생성 범위 안 '/' 사전입력 중 늦은 날 (trainee_last_day)
  · 그 다음 날부터 재적하는 보통 간호사 (전입처럼 start_date) — 인원·차지·주휴·사전입력 그대로
  · 트레이닝 날 = 자기 사전입력('/' 아닌 주·OF…)이 있으면 그것, 없으면 '/'+프리셉터 근무
  · 독립한 첫날들은 트레이닝 날 근무(그날 실제로 일했다)에 이어 역순 전환·연속 근무를 지킨다
"""
from __future__ import annotations

from datetime import date

import pytest

from server.api import _validate_staffing
from server.models import (DayRequirement, GenerateRequest, Nurse, Requirements, Rules,
                           ScoringRule)
from server.scheduler import NurseScheduler
from server.scheduler_base import generation_bounds, trainee_last_day
from server.scheduler_cpsat import CpSatScheduler

from .test_exact_fit_characterization import PROD_SHIFTS

CAPS = ["DC", "D", "EC", "E", "NC", "N"]
WORK = {"DC", "D", "EC", "E", "NC", "N"}
PERIOD = {"DC": "D", "D": "D", "EC": "E", "E": "E", "NC": "N", "N": "N"}
ISO = dict(noNOD=False, restAfterNight=False, maxConsecutiveNight=False,
           maxNightPerMonth=False, weeklyOff=False, maxConsecutiveWork=False)
DAYS = [f"2026-03-0{d}" for d in range(1, 8)]


class _Week:
    """2026-03 생성의 3/1~3/7 한 주만 — 3/1~3/3 트레이닝, 3/4 부터 독립."""

    def _build_date_range(self):
        super()._build_date_range()
        self.all_dates = [d for d in self.all_dates if date(2026, 3, 1) <= d <= date(2026, 3, 7)]
        self.T = len(self.all_dates)
        self.date_to_idx = {d: i for i, d in enumerate(self.all_dates)}
        self.weeks = [(0, 6)]


class _HighsWeek(_Week, NurseScheduler):
    pass


class _CpSatWeek(_Week, CpSatScheduler):
    pass


ENGINES = [_HighsWeek, _CpSatWeek]


def _request(*, end="2026-03-03", prev=None, wishes=None, per_day=None, rules=None,
             extra=False, relax=False):
    """간호01(선임) · 간호02(프리셉터) · [간호03] · 간호09(신규, 프리셉터 간호02).
    D=E=N=1 이 기본, 트레이닝 날(3/1~3/3)은 D·E 만 — 둘이서 하고 신규는 따라간다."""
    req = Requirements()
    for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, k, DayRequirement(D=1, E=1, N=1))
    pd = {dk: {"D": 1, "E": 1, "N": 0} for dk in DAYS[:3]}
    pd.update(per_day or {})
    nurses = [Nurse(id="a0", name="간호01", gender="female", capable_shifts=CAPS, seniority=0),
              Nurse(id="a1", name="간호02", gender="female", capable_shifts=CAPS, seniority=1)]
    if extra:
        nurses.append(Nurse(id="a2", name="간호03", gender="female", capable_shifts=CAPS,
                            seniority=2))
    nurses.append(Nurse(id="t0", name="간호09", gender="female", capable_shifts=CAPS,
                        seniority=9, is_trainee=True, training_end_date=end,
                        preceptor_id="a1", wishes=wishes or {}))
    return GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=req,
        rules=Rules(**{**ISO, **(rules or {})}), per_day_requirements=pd,
        prev_schedule=prev or {}, shifts=PROD_SHIFTS, time_limit=60,
        allow_pre_relax=relax,
        scoring_rules=[ScoringRule(name="희망", rule_type="wish", score=50)],
    )


def _period_counts(sched, dk):
    out = {"D": 0, "E": 0, "N": 0}
    for days in sched.values():
        p = PERIOD.get(days.get(dk))
        if p:
            out[p] += 1
    return out


def _forbidden_pairs(s):
    return [(set(g1), set(g2), tag) for tag, g1, g2, soft in s._transition_rules() if not soft]


# ── 마지막 트레이닝 날 ─────────────────────────────────────────────────────────

def test_trainee_last_day_rule():
    n = {"training_end_date": "2026-03-03"}
    rng = set(DAYS)
    assert trainee_last_day(n, {}, rng) == date(2026, 3, 3)
    # 끝나는 날 뒤에 사람이 '/E' 로 넣은 날 = 트레이닝 날 (101병동: 명부 11/03, 번표 11/04 까지 /E)
    assert trainee_last_day(n, {"2026-03-05": "/E", "2026-03-02": "주"}, rng) == date(2026, 3, 5)
    # 생성 범위 밖 '/' 는 보지 않는다
    assert trainee_last_day(n, {"2026-04-20": "/E"}, rng) == date(2026, 3, 3)
    # 끝나는 날이 없거나 읽을 수 없으면 계속 트레이닝
    assert trainee_last_day({"training_end_date": None}, {"2026-03-05": "/E"}, rng) is None
    assert trainee_last_day({"training_end_date": "3월 3일"}, {}, rng) is None


def test_generation_bounds_match_engine_range():
    s = NurseScheduler(_request())
    assert generation_bounds(2026, 3) == (s.schedule_start, s.schedule_end)
    assert generation_bounds(2026, 3) == (date(2026, 2, 22), date(2026, 4, 4))
    assert generation_bounds(2026, 11) == (date(2026, 10, 25), date(2026, 12, 5))


def test_split_marks_independence_day():
    s = _HighsWeek(_request())
    t0 = next(n for n in s.nurses if n["id"] == "t0")
    assert t0["start_date"] == "2026-03-04"          # 독립한 날부터 재적
    assert s._indep == {"t0": date(2026, 3, 4)}
    assert [t["id"] for t in s._trainees] == ["t0"]  # '/' 표시용으로 남는다
    assert "t0" not in {n["id"] for n in s._night_fairness_pool()}   # 이 달 신규는 야간 공정 대상 아님


# ── 엔진 ─────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("engine", ENGINES)
def test_scheduled_after_training_and_staffing_relies_on_her(engine):
    """3/4 부터 D·E·N 셋이 필요하고 간호사는 셋 — 독립한 신규 없이는 근무표가 안 나온다."""
    r = engine(_request()).solve()
    assert r["success"], r["message"]
    sch = r["schedule"]
    t0, a1 = sch["t0"], sch["a1"]
    for dk in DAYS[:3]:                         # 트레이닝 날 = 프리셉터 근무 + '/'
        assert t0[dk] == "/" + a1[dk], (dk, t0)
    for dk in DAYS[3:]:                         # 독립한 뒤 = 엔진이 배정한 근무
        assert t0[dk] in WORK, (dk, t0)
        assert _period_counts(sch, dk) == {"D": 1, "E": 1, "N": 1}, (dk, sch)


@pytest.mark.parametrize("engine", ENGINES)
def test_juhu_after_independence_is_kept(engine):
    r = engine(_request(prev={"t0": {"2026-03-06": "주"}},
                        per_day={"2026-03-06": {"D": 1, "E": 1, "N": 0}})).solve()
    assert r["success"], r["message"]
    assert r["schedule"]["t0"]["2026-03-06"] == "주", r["schedule"]["t0"]
    assert not r.get("relaxed_cells")


@pytest.mark.parametrize("engine", ENGINES)
def test_own_rest_on_training_day_wins_over_preceptor_copy(engine):
    """트레이닝 날 자기 주·OF 는 그대로, '/' 로 넣은 날·빈 날은 프리셉터 근무를 따른다."""
    prev = {"t0": {"2026-03-01": "주", "2026-03-02": "OF", "2026-03-03": "/D"}}
    r = engine(_request(prev=prev)).solve()
    assert r["success"], r["message"]
    t0, a1 = r["schedule"]["t0"], r["schedule"]["a1"]
    assert t0["2026-03-01"] == "주" and t0["2026-03-02"] == "OF", t0
    assert t0["2026-03-03"] == "/" + a1["2026-03-03"], t0
    assert not r.get("relaxed_cells")


# ── 신규가 '/'로 넣은 원티드 (2026-10-19) — 11월: /OF → /E, /D → /OF 로 조용히 덮였다 ─────────────

@pytest.mark.parametrize("engine", ENGINES)
def test_slash_rest_is_the_trainees_own_day_off(engine):
    """트레이닝 날 '/OF' 는 신규 혼자 쉬는 날 — 프리셉터가 그날 일해도 신규는 쉰다 (예전엔 '/D' 로 덮였다)."""
    r = engine(_request(prev={"t0": {"2026-03-02": "/OF"}, "a1": {"2026-03-02": "D"}})).solve()
    assert r["success"], r["message"]
    assert r["schedule"]["t0"]["2026-03-02"] == "/OF", r["schedule"]["t0"]


@pytest.mark.parametrize("engine", ENGINES)
def test_slash_work_pulls_the_preceptor_to_that_shift(engine):
    """'/D' 를 넣은 날은 프리셉터도 D 가 되게 한다 — 같이 일한다. 간호01 이 그날 D 를 바라도(위시 50) 프리셉터 쪽이
    먼저다 (예전엔 위시대로 프리셉터가 E, 신규는 '/E' 로 덮였다)."""
    req = _request(prev={"t0": {"2026-03-02": "/D"}})
    req.nurses[0].wishes = {"2026-03-02": "D"}
    r = engine(req).solve()
    assert r["success"], r["message"]
    assert r["schedule"]["a1"]["2026-03-02"] in ("D", "DC"), r["schedule"]["a1"]
    assert r["schedule"]["t0"]["2026-03-02"] in ("/D", "/DC"), r["schedule"]["t0"]


@pytest.mark.parametrize("engine", ENGINES)
def test_slash_work_against_preceptors_own_rest_is_kept_and_noted(engine):
    """프리셉터가 그날 주휴를 넣었으면 그대로 두고, 신규가 넣은 '/E' 도 그대로 낸다 — 같이 일할 사람을 정하라고 알린다."""
    r = engine(_request(prev={"t0": {"2026-03-02": "/E"}, "a1": {"2026-03-02": "주"}},
                        per_day={"2026-03-02": {"D": 1, "E": 0, "N": 0}})).solve()
    assert r["success"], r["message"]
    assert (r["schedule"]["a1"]["2026-03-02"], r["schedule"]["t0"]["2026-03-02"]) == ("주", "/E")
    assert any("같이 일할 사람" in t for t in r.get("trainee_notes", [])), r.get("trainee_notes")


@pytest.mark.parametrize("engine", ENGINES)
def test_slash_cell_of_a_nurse_who_is_not_a_trainee_is_that_shift(engine):
    """신규가 아닌 사람의 '/OF' 는 그날 OF — 신규 표시를 끈 사람·붙여넣기로 더한 사람의 '/' 칸을 예전엔 조용히 버렸다
    (2026-10-19 검토: 보통 간호사 3/5 '/OF' 가 NC 로 나왔고, 지난달 '/E' 다음 1일이 D 가 됐다)."""
    r = engine(_request(prev={"a0": {"2026-03-05": "/OF"}}, extra=True)).solve()
    assert r["success"], r.get("message")
    assert r["schedule"]["a0"]["2026-03-05"] == "OF", r["schedule"]["a0"]


@pytest.mark.parametrize("engine", ENGINES)
def test_slash_preinput_after_end_date_extends_training(engine):
    """끝나는 날(3/3) 뒤 3/4 에 '/E' — 3/4 도 트레이닝, 3/5 부터 독립."""
    r = engine(_request(prev={"t0": {"2026-03-04": "/E"}},
                        per_day={"2026-03-04": {"D": 1, "E": 1, "N": 0}})).solve()
    assert r["success"], r["message"]
    t0, a1 = r["schedule"]["t0"], r["schedule"]["a1"]
    assert t0["2026-03-04"] == "/" + a1["2026-03-04"], t0
    for dk in DAYS[4:]:
        assert t0[dk] in WORK, (dk, t0)


@pytest.mark.parametrize("engine", ENGINES)
def test_no_forbidden_transition_from_last_training_day(engine):
    """프리셉터가 3/3 E(확정) → 신규도 3/3 에 E 를 했다. 3/4 D 를 원해도 E→D 는 안 된다.
    (그날 D 는 한 자리라 차지 DC — 희망도 DC 로 넣어야 엔진이 그쪽으로 끌린다)"""
    req = _request(prev={"a1": {"2026-03-03": "E"}}, wishes={"2026-03-04": "DC"},
                   per_day={"2026-03-04": {"D": 1, "E": 1, "N": 0}})
    s = engine(req)
    r = s.solve()
    assert r["success"], r["message"]
    t0 = r["schedule"]["t0"]
    assert t0["2026-03-03"] in ("/E", "/EC"), t0     # 확정 E 는 차지로 오를 수 있다
    assert t0["2026-03-04"] not in ("D", "DC"), t0
    for i in range(len(DAYS) - 1):              # 트레이닝 날 근무까지 이어서 역순 전환 없음
        c1, c2 = t0[DAYS[i]].lstrip("/"), t0[DAYS[i + 1]].lstrip("/")
        if DAYS[i + 1] < "2026-03-04":
            continue                            # 트레이닝 날끼리는 프리셉터 쪽 일
        for g1, g2, tag in _forbidden_pairs(s):
            assert not (c1 in g1 and c2 in g2), (tag, DAYS[i], t0)


@pytest.mark.parametrize("engine", ENGINES)
def test_consecutive_work_counts_training_days(engine):
    """연속 근무 한도 3일(마지막 수단 끔) — 프리셉터와 3/1~3/3 사흘 일했으면 3/4 는 쉰다."""
    req = _request(prev={"a1": {"2026-03-01": "D", "2026-03-02": "D", "2026-03-03": "E"}},
                   wishes={"2026-03-04": "EC"}, extra=True,
                   per_day={dk: {"D": 1, "E": 1, "N": 0} for dk in DAYS},
                   rules=dict(maxConsecutiveWork=True, maxConsecutiveWorkDays=3,
                              longRunLastResort=False))
    r = engine(req).solve()
    assert r["success"], r["message"]
    t0 = r["schedule"]["t0"]
    assert [t0[dk].replace("C", "") for dk in DAYS[:3]] == ["/D", "/D", "/E"], t0
    assert t0["2026-03-04"] not in WORK, t0


@pytest.mark.parametrize("engine", ENGINES)
def test_two_pinned_facts_across_boundary_are_kept(engine):
    """프리셉터 확정 E(3/3) 다음 날 신규 확정 D(3/4) — 둘 다 사람이 넣은 사실이라 그대로 (결정 1-15)."""
    req = _request(prev={"a1": {"2026-03-03": "E"}, "t0": {"2026-03-04": "D"}},
                   per_day={"2026-03-04": {"D": 1, "E": 1, "N": 0}})
    r = engine(req).solve()
    assert r["success"], r["message"]
    assert r["schedule"]["t0"]["2026-03-04"] in ("D", "DC"), r["schedule"]["t0"]


@pytest.mark.parametrize("engine", ENGINES)
def test_relax_mode_keeps_her_cells(engine):
    """완화 경로도 같다 — 간호01 의 E→D 사전입력 충돌로 완화가 돌아도 신규의 주·트레이닝 날은 그대로."""
    prev = {"a0": {"2026-03-05": "E", "2026-03-06": "D"},
            "t0": {"2026-03-02": "OF", "2026-03-07": "주"}}
    req = _request(prev=prev, relax=True, per_day={"2026-03-07": {"D": 1, "E": 1, "N": 0}})
    r = engine(req).solve()
    assert r["success"], r["message"]
    t0, a1 = r["schedule"]["t0"], r["schedule"]["a1"]
    assert t0["2026-03-02"] == "OF" and t0["2026-03-07"] == "주", t0
    assert t0["2026-03-01"] == "/" + a1["2026-03-01"], t0
    assert "t0" not in (r.get("relaxed_cells") or {}), r.get("relaxed_cells")


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("end", ["2026-02-27", "2026-04-10", None])
def test_edges_before_after_or_no_end(engine, end):
    """범위 전에 끝남 = 보통 간호사 · 범위 뒤에 끝남/끝나는 날 없음 = 일주일 내내 '/'+프리셉터."""
    req = _request(end=end, per_day={dk: {"D": 1, "E": 1, "N": 0} for dk in DAYS})
    r = engine(req).solve()
    assert r["success"], r["message"]
    t0, a1 = r["schedule"]["t0"], r["schedule"]["a1"]
    assert len(t0) == 7, t0
    if end == "2026-02-27":
        assert not any(v.startswith("/") for v in t0.values()), t0
    else:
        assert all(t0[dk] == "/" + a1[dk] for dk in DAYS), t0


def test_confirm_pinned_table_shows_training_marks():
    """빈칸 없는 확정 표 폴백도 솔버 결과처럼 트레이닝 날을 채운다 (자기 사전입력이 먼저)."""
    a0 = dict(zip(DAYS, ["D", "D", "D", "D", "OF", "E", "E"]))
    a1 = dict(zip(DAYS, ["E", "E", "E", "E", "D", "OF", "N"]))
    t0 = {"2026-03-02": "OF", "2026-03-04": "N", "2026-03-05": "N",
          "2026-03-06": "D", "2026-03-07": "D"}
    s = _HighsWeek(_request(prev={"a0": a0, "a1": a1, "t0": t0}))
    assert s._fully_pinned()
    r = s._confirm_pinned_result()
    got = r["schedule"]["t0"]
    assert got["2026-03-01"] == "/E" and got["2026-03-03"] == "/E", got
    assert got["2026-03-02"] == "OF", got
    assert got["2026-03-04"] == "N", got


def test_staffing_precheck_counts_her_after_independence():
    """사전검증도 트레이닝 날(3/1~3/3)만 그를 빼고 센다 — 3/4 부터는 셋이 다 있다."""
    req = _request()
    req.per_day_requirements = {}
    warn = _validate_staffing(req, ["V", "생", "특", "공", "법", "병"], ["OF", "주", "P1"])
    assert warn and "03/01" in warn and "03/03" in warn, warn
    assert "03/04" not in warn, warn


def test_wish_report_skips_training_days():
    """트레이닝 날('/'+프리셉터 근무)은 엔진이 고르지 않는다 — 위시 미반영으로 세지 않는다
    (세면 다음 달 위시 보정이 그를 끌어올린다). 독립한 뒤 위시는 보통 간호사처럼 센다."""
    from server.api import _build_wish_report
    req = _request(wishes={"2026-03-02": "OFF", "2026-03-05": "OFF"})
    result = {"success": True, "schedule": {"t0": {"2026-03-02": "/D", "2026-03-05": "OF"}}}
    wr = _build_wish_report(req, result)
    assert wr["total_requested"] == 1 and wr["total_granted"] == 1, wr


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("slash", ["", "/"])
def test_training_day_of_counts_toward_that_weeks_of(engine, slash):
    """주 OF 1회는 달력 주 기준 — 트레이닝 날(3/1)에 병동이 넣은 OF 가 있으면 독립한 날(3/4~3/7)엔 OF 를 더 받지 않는다.
    11월 실제: 11/01 OF(트레이닝 날, 병동이 넣음) + 엔진 11/06 OF = 한 주에 OF 둘 (11월 한 달 다시 돌려 보기에서 발견).
    신규가 '/OF' 로 넣어도 같다 — 그날 신규 혼자 쉬는 OF 다 (2026-10-19 검토: '/OF' 에 더해 3/4 OF)."""
    req = _request(prev={"t0": {"2026-03-01": slash + "OF"}}, extra=True, rules={"weeklyOff": True})
    req = req.model_copy(update={"scoring_rules": [
        ScoringRule(name="V", rule_type="specific_shift", params={"shift_code": "V", "condition": "all"},
                    score=-500)]})
    s = engine(req)
    t0 = next(n for n in s.nurses if n["id"] == "t0")
    assert s._of_train_used(t0, 0, 6) == 1
    assert s._of_week_bound(t0, 0, 6, s._of_week_days(t0, 0, 6)) == 0
    r = s.solve()
    assert r["success"], r.get("message")
    t = r["schedule"]["t0"]
    assert t["2026-03-01"] == slash + "OF"
    assert [d for d in DAYS[3:] if t.get(d) == "OF"] == [], t
    # 트레이닝 날 OF 가 없으면 독립한 날에 하나까지
    s2 = engine(_request(extra=True, rules={"weeklyOff": True}))
    t2 = next(n for n in s2.nurses if n["id"] == "t0")
    assert s2._of_week_bound(t2, 0, 6, s2._of_week_days(t2, 0, 6)) == 1


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("code, rules", [("생", {}), ("V", {"maxVPerMonth": 1})])
@pytest.mark.parametrize("slash", ["", "/"])
def test_training_day_leave_counts_toward_the_month(engine, code, rules, slash):
    """생·V 월 한도도 달력 달 기준 — 신규가 트레이닝 날(3/2)에 넣은 생·V 가 있으면 독립한 뒤 또 받지 않는다.
    2026-10-16 검토: 생 보상(+80)이 있으면 3/2 생에 더해 3/5 생을 또 받았다 (V 도 같다). '/생'·'/V' 로 넣어도 같다."""
    req = _request(prev={"t0": {"2026-03-02": slash + code}}, extra=True,
                   per_day={dk: {"D": 1, "E": 1, "N": 0} for dk in DAYS}, rules=rules)
    req = req.model_copy(update={"scoring_rules": [
        ScoringRule(name=code, rule_type="specific_shift", params={"shift_code": code, "condition": "all"},
                    score=80)]})
    s = engine(req)
    t0 = next(n for n in s.nurses if n["id"] == "t0")
    month = list(range(s.T))
    assert s._train_own_count(t0, month, code) == 1
    assert s._cap_with_training(t0, month, code, 1) == 0
    r = s.solve()
    assert r["success"], r.get("message")
    t = r["schedule"]["t0"]
    assert t["2026-03-02"] == slash + code
    assert [d for d in DAYS[3:] if t.get(d) == code] == [], t
    # 다른 사람은 그대로 한 번까지
    a2 = next(n for n in s.nurses if n["id"] == "a2")
    assert s._cap_with_training(a2, month, code, 1) == 1
