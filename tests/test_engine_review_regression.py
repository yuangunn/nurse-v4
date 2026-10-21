"""엔진 리뷰(2026-10-20) 회귀 — HiGHS 엔진·공용 베이스.

① 완화에서 잠긴 칸(상수 1)이 규칙 한도(월 V·주 OF·필요 인원·주 1회 P1)를 넘어도 모순이 아니다 — 엄격에서 되는 표가 완화를 켜면 실패했다.
② 엄격: 차지 자격 없는 사람의 사전입력 D 를 DC 로 올리지 않는다 · 그날 받을 수 없는 원티드 D/E 는 근무표를 막지 않는다.
③ 완화 단계 흐름: 2단계는 1단계 해에서 출발 · 1단계가 최적을 증명 못 하면 폴백 · 1단계 중 중지는 그 표를 낸다 ·
   레이스 패자 취소 뒤엔 새 풀이를 시작하지 않는다.
④ V 설명·근무자 점수·공정성 배점·블록 주휴 요일·HiGHS 진단 스캐너가 모델과 같은 기준을 본다.
이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

from datetime import date

import pytest

from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules, ScoringRule
from server.scheduler import NurseScheduler

from .conftest import _juhu_prev, _mini_nurses, _mini_requirements, make_limited
from .test_exact_fit_characterization import PROD_SHIFTS

CAPS = ["DC", "D", "EC", "E", "NC", "N"]
QUIET = Rules(weeklyOff=False, noNOD=False, maxConsecutiveWork=False, maxConsecutiveNight=False,
              restAfterNight=False, maxNightPerMonth=False)


def _zero_req():
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=0, E=0, N=0))
    return req


def _relax_req(cells=(), **kw):
    """6명·7일 · a5 의 사전입력 E→D 가 엄격을 막아 완화로 간다. cells = 잠글 (사람, 날짜, 코드)."""
    nurses = _mini_nurses(6)
    prev = _juhu_prev(nurses, 2026, 3, 7)
    prev["a5"].update({"2026-03-02": "E", "2026-03-03": "D"})
    locked = {}
    for nid, iso, code in cells:
        prev[nid][iso] = code
        locked.setdefault(nid, {})[iso] = True
    return GenerateRequest(year=2026, month=3, nurses=nurses, requirements=_mini_requirements(1, 1, 1),
                           rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1), prev_schedule=prev,
                           locked_cells=locked, allow_pre_relax=True, time_limit=30, **kw)


# ── ① 완화의 잠긴 칸 ─────────────────────────────────────────────────────────

LOCKED_OVER_CAP = {
    "V 둘 (월 1회)": [("a1", "2026-03-02", "V"), ("a1", "2026-03-04", "V")],
    "한 주 OF 둘": [("a2", "2026-03-02", "OF"), ("a2", "2026-03-03", "OF")],
    "필요 1명인 날 D 셋": [(f"a{i}", "2026-03-06", "D") for i in (1, 2, 3)],
}


@pytest.mark.parametrize("case", list(LOCKED_OVER_CAP))
@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_relax_keeps_locked_cells_over_rule_caps(engine, case):
    cells = LOCKED_OVER_CAP[case]
    r = make_limited(_relax_req(cells), days=7, solver=engine).solve()
    assert r["success"], r["message"]
    assert set(r["relaxed_cells"]) == {"a5"}, r["relaxed_cells"]     # 완화로 풀린 것은 a5 의 E→D 뿐
    for nid, iso, code in cells:
        assert r["schedule"][nid][iso] in {code} | NurseScheduler._PRE_FLEX.get(code, set())


def test_locked_cells_count_as_facts_when_clamp_is_off():
    s = make_limited(_relax_req(LOCKED_OVER_CAP["V 둘 (월 1회)"] + LOCKED_OVER_CAP["필요 1명인 날 D 셋"]), days=7)
    s._pin = {}                                         # 완화 모델과 같은 상태
    a1 = next(n for n in s.nurses if n["id"] == "a1")
    assert s._cap_with_training(a1, list(range(7)), "V", 1) == 2
    assert s._pin_day_period_count(5, s.DAY_SHIFTS) == 3   # 3/6
    assert s._pin_nurse_count("a5", range(7), ("E",)) == 0  # 잠그지 않은 사전입력은 완화가 옮길 수 있다


def test_relax_locked_p1_counts_toward_once_a_week():
    """임산부의 잠긴 P1(3/2) — 완화에서 같은 주에 P1 을 하나 더 놓지 않는다."""
    nurses = [Nurse(id="n0", name="간호01", seniority=0, capable_shifts=CAPS, is_pregnant=True,
                    pregnancy={"early": {"start": "2026-02-01", "end": "2026-04-30"}}),
              Nurse(id="n1", name="간호02", seniority=1, capable_shifts=CAPS),
              Nurse(id="n2", name="간호03", seniority=2, capable_shifts=CAPS)]
    req = GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=_zero_req(), rules=QUIET, shifts=PROD_SHIFTS,
        per_day_requirements={"2026-03-03": {"D": 0, "E": 1, "N": 0}, "2026-03-04": {"D": 1, "E": 0, "N": 0}},
        prev_schedule={"n0": {"2026-03-02": "P1"}, "n2": {"2026-03-03": "E", "2026-03-04": "D"}},
        locked_cells={"n0": {"2026-03-02": True}}, allow_pre_relax=True, time_limit=20)
    r = make_limited(req, days=7).solve()
    assert r["success"], r["message"]
    assert r.get("relaxed_cells"), "완화 경로를 타야 한다"
    row = r["schedule"]["n0"]
    assert row["2026-03-02"] == "P1" and sum(1 for v in row.values() if v == "P1") == 1, row


# ── ② 엄격의 사전입력 도메인 ─────────────────────────────────────────────────

def test_strict_pinned_day_is_not_promoted_to_charge_without_capability():
    """차지 자격 없는 최선임(간호01)의 사전입력 D — 차지는 자격 있는 간호02 가 맡는다."""
    nurses = [Nurse(id="n0", name="간호01", seniority=0, capable_shifts=["D", "E", "N"]),
              Nurse(id="n1", name="간호02", seniority=1, capable_shifts=CAPS, wishes={"2026-03-03": "D"})]
    req = GenerateRequest(year=2026, month=3, nurses=nurses, requirements=_zero_req(), rules=QUIET,
                          shifts=PROD_SHIFTS, per_day_requirements={"2026-03-03": {"D": 2, "E": 0, "N": 0}},
                          prev_schedule={"n0": {"2026-03-03": "D"}}, time_limit=20,
                          scoring_rules=[ScoringRule(id=1, name="wish", rule_type="wish", score=100)])
    s = make_limited(req, days=7)
    assert s._pre_domain(s.nurses[0], "D") == {"D"} and s._pre_domain(s.nurses[1], "D") == {"D", "DC"}
    assert s._pre_domain(s.nurses[0], "DC") == {"DC", "D"}    # 사람이 넣은 차지는 사실 — 자격과 상관없이 남는다
    r = s.solve()
    assert r["success"], r["message"]
    assert (r["schedule"]["n0"]["2026-03-03"], r["schedule"]["n1"]["2026-03-03"]) == ("D", "DC")


@pytest.mark.parametrize("who", ["keeper", "night_only"])
@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_strict_ignores_flex_wish_the_nurse_cannot_take(engine, who):
    """나이트킵·야간만 할 수 있는 사람의 원티드 'D/E' — 그 칸에 놓을 근무가 없어 근무표 전체가 막혔다.
    같은 칸에 확정 'D' 를 넣으면 사실로 받는다 (원티드는 사실이 아니라 허용 근무 묶음이다)."""
    nurses = _mini_nurses(6)
    if who == "keeper":
        nurses[5] = nurses[5].model_copy(update={"is_night_shift": True})
    else:
        nurses[5] = nurses[5].model_copy(update={"capable_shifts": ["N", "NC"]})
    prev = _juhu_prev(nurses, 2026, 3, 7)
    prev["a5"]["2026-03-03"] = "D/E"
    req = GenerateRequest(year=2026, month=3, nurses=nurses, requirements=_mini_requirements(2, 1, 1),
                          rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1), prev_schedule=prev,
                          time_limit=20)
    s = make_limited(req, days=7, solver=engine)
    if who == "keeper":
        s._night_dedicated_quota = lambda nurse, idxs, md: (7, 3)   # 7일 창 — 월 14회는 못 채운다 (하네스 전용)
    r = s.solve()
    assert r["success"], r["message"]
    assert r["schedule"]["a5"]["2026-03-03"] not in {"D", "DC", "E", "EC"}


# ── ③ 완화 단계 흐름 (HiGHS) ─────────────────────────────────────────────────

def _spy_solvers(monkeypatch):
    """_WarmHiGHS 생성 기록 — (gap, 시작해 칸 수)."""
    from server import scheduler as sch
    made = []
    orig = sch._WarmHiGHS.__init__

    def init(self, start=None, **kw):
        made.append((kw.get("mip_rel_gap"), len(start or [])))
        orig(self, start=start, **kw)
    monkeypatch.setattr(sch._WarmHiGHS, "__init__", init)
    return made


def test_relax_stage2_starts_from_stage1_table(monkeypatch):
    """2단계는 유지 수준을 못 박아 첫 해 찾기가 가장 어려운 꼴 — 1단계 해를 시작해로 받는다."""
    made = _spy_solvers(monkeypatch)
    r = make_limited(_relax_req(), days=7).solve()
    assert r["success"], r["message"]
    assert len(made) == 3, made                    # 엄격 · 완화 1단계 · 2단계
    assert made[2][1] > 0, made


def test_relax_stage1_without_proof_falls_back_to_weighted(monkeypatch):
    """1단계가 시간 제한으로 끝나면(pulp 는 'Optimal' 로 읽는다) 증명 안 된 유지 수준을 못 박지 않고 폴백(가중, gap 0)."""
    made = _spy_solvers(monkeypatch)
    monkeypatch.setattr(NurseScheduler, "_highs_proved_optimal", staticmethod(lambda prob: False))
    r = make_limited(_relax_req(), days=7).solve()
    assert r["success"], r["message"]
    assert made[2][0] == 0.0 and made[2][1] > 0, made


def test_highs_proved_optimal_reads_model_status():
    import highspy
    from types import SimpleNamespace as NS
    st = highspy.HighsModelStatus

    def prob(status):
        return NS(solverModel=NS(getModelStatus=lambda: status))
    assert NurseScheduler._highs_proved_optimal(prob(st.kOptimal)) is True
    assert NurseScheduler._highs_proved_optimal(prob(st.kTimeLimit)) is False
    assert NurseScheduler._highs_proved_optimal(NS()) is False


def _cancel_on_stage1_solution(monkeypatch, cancel):
    """완화 1단계가 첫 해를 찾는 순간 cancel() (그 전에 끝나면 끝난 직후 — 어느 쪽이든 2단계 전) — 실제 중지 경로
    (api 의 _TrackableHighs)를 탄다. 시작한 풀이 이름을 돌려준다."""
    import server.api  # noqa: F401  (중지 가능한 HiGHS)
    from server import scheduler as sch
    names = []
    orig = sch._WarmHiGHS.callSolver

    def call(self, lp):
        names.append(lp.name)
        first = lp.name == "nurse_schedule_relaxed" and names.count(lp.name) == 1
        if first:
            lp.solverModel.cbMipImprovingSolution.subscribe(lambda e: cancel())
        out = orig(self, lp)
        if first:
            cancel()
        return out
    monkeypatch.setattr(sch._WarmHiGHS, "callSolver", call)
    return names


def test_stop_in_relax_stage1_keeps_the_table_it_found(monkeypatch):
    from server import solver_progress as sp
    names = _cancel_on_stage1_solution(monkeypatch, sp.request_cancel)
    sp.clear()
    sp.begin()
    try:
        r = make_limited(_relax_req(), days=7).solve()
    finally:
        sp.clear()
    assert r["success"], r["message"]
    assert "(상태: 중지)" in r["message"] and r.get("relaxed_cells")
    assert names.count("nurse_schedule_relaxed") == 1, names    # 2단계를 시작하지 않는다


def test_race_loser_starts_no_new_solves(monkeypatch):
    """레이스에서 진 HiGHS(cancel_all) — 완화 2단계·13단계 진단을 새로 시작하지 않는다 (CP-SAT 과 같다)."""
    from server import solver_progress as sp
    names = _cancel_on_stage1_solution(monkeypatch, sp.cancel_all_adapters)
    diag = []
    monkeypatch.setattr(NurseScheduler, "_diagnose_infeasibility", lambda self: diag.append(1) or "")
    sp.clear()
    sp.begin()
    try:
        make_limited(_relax_req(), days=7).solve()
        assert names.count("nurse_schedule_relaxed") == 1, names
        names.clear()
        r = make_limited(_relax_req(), days=7).solve()         # 이미 진 뒤 — 엄격만 풀고 끝
    finally:
        sp.clear()
    assert not r["success"] and names == ["nurse_schedule"] and not diag, (names, r["message"])


# ── ④ 리포트·배점·블록 주휴·진단 ─────────────────────────────────────────────

@pytest.mark.parametrize("relax", [False, True])
def test_v_report_counts_pre_v_as_pinned_in_relax(relax):
    """사전입력 V 는 사람이 정한 것 — 완화(_pin 이 빈다)에서도 자동 배정으로 세지 않는다."""
    nurses = _mini_nurses(6)
    prev = _juhu_prev(nurses, 2026, 3, 7)
    prev["a0"]["2026-03-04"] = "V"
    req = GenerateRequest(year=2026, month=3, nurses=nurses, requirements=_mini_requirements(1, 1, 1),
                          rules=Rules(), prev_schedule=prev, allow_pre_relax=relax)
    s = make_limited(req, days=7)
    s._build_pin_index()                           # 완화를 켜면 비어 있다 (완화 성공 뒤 리포트를 붙일 때도)
    vr = s._v_report({"a0": {"2026-03-04": "V"}, "a1": {"2026-03-05": "V"}})
    assert vr["total"] == 1 and vr["weeks"][0]["leave_pinned"] == 1
    assert [c["nurse_id"] for c in vr["weeks"][0]["cells_v"]] == ["a1"]


def test_nurse_scores_count_wish_on_next_month_days():
    """목적함수는 끝에 붙은 다음 달 며칠의 위시에도 점수를 준다 — 근무자 점수표도 같은 날짜로."""
    from .test_month_tail import _request
    req = _request({}, n=2, scoring_rules=[ScoringRule(id=1, name="위시", rule_type="wish", score=50)])
    req.nurses[0].wishes = {"2026-12-02": "OF", "2026-10-28": "OF"}   # 꼬리 · 지난달 칸(기록 — 세지 않는다)
    s = NurseScheduler(req)
    scores, details = s._compute_nurse_scores({"a0": {"2026-12-02": "OF", "2026-10-28": "OF"}})
    assert scores["a0"] == 50 and details["a0"][0]["count"] == 1


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_positive_fairness_score_does_not_break_the_model(engine):
    """공정성 배점을 양수로 저장해도(편집 창이 부호를 막지 않는다) HiGHS 가 무한대로 실패하지 않는다 — CP-SAT 처럼 위 한계."""
    req = GenerateRequest(year=2026, month=3, nurses=_mini_nurses(6), requirements=_mini_requirements(1, 1, 1),
                          rules=Rules(maxConsecutiveWorkDays=6), prev_schedule=_juhu_prev(_mini_nurses(6), 2026, 3, 7),
                          time_limit=20,
                          scoring_rules=[ScoringRule(id=1, name="야간 공정", rule_type="night_fairness", score=50),
                                         ScoringRule(id=2, name="주말 공정", rule_type="weekend_fairness", score=50)])
    r = make_limited(req, days=7, solver=engine).solve()
    assert r["success"], r["message"]


def test_juhu_block_follows_locked_juhu_weekday():
    """주휴 이동 허용 + 블록 요일 잠금 — 잠근 월요일 주휴(3/2)가 있는 블록은 월요일로 (지난달 요일 잇기와 같은 감점).
    예전엔 잠긴 칸이 블록 요일 묶음에서 빠져 나머지 주휴 셋이 화요일에 남았다."""
    nurses = _mini_nurses(6)
    prev = _juhu_prev(nurses, 2026, 3, 28)
    for k in ("2026-03-09", "2026-03-16", "2026-03-23"):
        del prev["a0"][k]
    prev["a0"].update({"2026-03-10": "주", "2026-03-17": "주", "2026-03-24": "주"})
    prev["a5"].update({"2026-03-04": "E", "2026-03-05": "D"})          # 엄격을 막아 완화로
    req = GenerateRequest(year=2026, month=3, nurses=nurses, requirements=_mini_requirements(1, 1, 1),
                          rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1), prev_schedule=prev,
                          locked_cells={"a0": {"2026-03-02": True}}, allow_pre_relax=True,
                          allow_juhu_relax=True, juhu_block_lock=True, time_limit=30)
    r = make_limited(req, days=28).solve()
    assert r["success"], r["message"]
    assert sorted(k for k, v in r["schedule"]["a0"].items() if v == "주") == [
        "2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23"]


def test_strict_diagnosis_does_not_blame_pinned_facts():
    """엄격(사실-클램프)은 두 칸 다 확정인 E→D 를 사실로 받는다 — 진단이 그것을 원인·셀 기여도·이동 칩으로 짚지 않는다.
    (진짜 원인은 간호02 3/5 E 다음 날 D 가 강제되는 것)"""
    nurses = [Nurse(id=f"n{i}", name=f"간호0{i + 1}", seniority=i, capable_shifts=CAPS) for i in range(3)]
    prev = {"n0": {"2026-03-03": "E", "2026-03-04": "D", "2026-03-06": "OF"},
            "n1": {"2026-03-05": "E"}, "n2": {"2026-03-06": "OF"}}
    pdr = {"2026-03-03": {"D": 0, "E": 1, "N": 0}, "2026-03-04": {"D": 1, "E": 0, "N": 0},
           "2026-03-05": {"D": 0, "E": 1, "N": 0}, "2026-03-06": {"D": 1, "E": 0, "N": 0}}
    req = GenerateRequest(year=2026, month=3, nurses=nurses, requirements=_zero_req(), rules=QUIET, shifts=PROD_SHIFTS,
                          per_day_requirements=pdr, prev_schedule=prev, time_limit=20)
    r = make_limited(req, days=7).solve()
    assert not r["success"]
    assert "간호01" not in r["message"] and "셀 기여도" not in r["message"], r["message"]
    assert not any(a.get("nurse_id") == "n0" for a in r.get("anchored") or [])


def test_diagnosis_scanners_follow_model_scope():
    """완화 뒤 진단(클램프 없음)의 사전입력 스캐너 — 모델과 같은 범위: 끝에 붙은 다음 달 며칠의 역순 전환·차지 선임은 보고,
    N→휴무→D 는 셋째 날 D·DC 만(D1 은 모델이 막지 않는다), 지난달 안에 갇힌 창은 기록이라 뺀다."""
    from .test_month_tail import _request
    prev = {"a0": {"2026-12-02": "N", "2026-12-03": "OF", "2026-12-04": "D1",     # D1 — 원인 아님
                   "2026-10-26": "N", "2026-10-27": "OF", "2026-10-28": "D"},    # 지난달 안 — 기록
            "a1": {"2026-12-02": "E", "2026-12-03": "D", "2026-11-09": "N", "2026-11-10": "OF", "2026-11-11": "DC"},
            "a3": {"2026-12-03": "DC"}}
    s = NurseScheduler(_request(prev, n=4, allow_pre_relax=True))
    assert [(t["nurse_id"], t["date1_iso"]) for t in s._scan_pre_forbidden_transitions()] == [("a1", "2026-12-02")]
    assert [c["charge_label"] for c in s._scan_pre_charge_seniority_conflicts()] == ["간호04(A)"]
    nod = s._scan_pre_nod_patterns()
    assert len(nod) == 1 and "간호02" in nod[0] and "2026-11-11(DC)" in nod[0], nod


def test_diagnosis_phase6_keeps_p1_rule():
    """단계는 '앞 단계 + 제약 하나' — 6단계(연속 근무)도 5.5단계의 P1 주 1회를 품어야 처음 막힌 단계가 원인이다."""
    nurses = _mini_nurses(6)
    nurses[0] = nurses[0].model_copy(update={
        "is_pregnant": True, "pregnancy": {"early": {"start": "2026-02-01", "end": "2026-04-30"}}})
    req = GenerateRequest(year=2026, month=3, nurses=nurses, requirements=_mini_requirements(1, 1, 1),
                          rules=Rules(maxConsecutiveWorkDays=6), prev_schedule=_juhu_prev(nurses, 2026, 3, 7))
    s = make_limited(req, days=7)
    built = []
    orig = s._c_pregnancy_p1_weekly
    s._c_pregnancy_p1_weekly = lambda p, x: (built.append(p.name), orig(p, x))
    s._diagnose_phases()                            # 풀리는 입력 — 모든 단계를 쌓는다
    assert "diag6" in built, built
