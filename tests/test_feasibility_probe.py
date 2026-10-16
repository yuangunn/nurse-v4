"""check_feasibility (실시간 신호등 프로브) 테스트 — 하드 제약 1회 풀이."""
from __future__ import annotations

from server.conflict_analyzer import check_feasibility


def test_probe_feasible(build_request, small_nurses):
    """충분한 인원(6명, D=E=N=1) → feasible + 예상시간 동봉."""
    res = check_feasibility(build_request(nurses=small_nurses(6), add_juhu=False))
    assert res["status"] == "feasible", res
    assert res["conflicts"] == []
    assert res["estimated_seconds"] >= 5


def test_probe_infeasible_supply(build_request, small_nurses):
    """2명인데 하루 3근무 필요 → infeasible + 대략적 원인 라벨."""
    res = check_feasibility(build_request(nurses=small_nurses(2), add_juhu=False))
    assert res["status"] == "infeasible", res
    assert res["conflicts"], "원인 라벨이 있어야 함"
    assert "estimated_seconds" in res


def test_probe_pinned_pair_is_fact_feasible(build_request, small_nurses):
    """사전입력 E→D '양쪽 확정' 쌍은 사실-클램프로 엔진이 수용한다 — 신호등도
    같은 의미론이어야 한다 (feasible). 과거엔 거짓 빨강 (2026-08-19 수정)."""
    nurses = small_nurses(6)
    prev = {nurses[0].id: {"2026-03-02": "E", "2026-03-03": "D"}}
    res = check_feasibility(build_request(nurses=nurses, prev_schedule=prev, add_juhu=False))
    assert res["status"] == "feasible", res


def test_probe_pinned_double_of_week_feasible(build_request, small_nurses):
    """한 주에 확정 OF 2개(신청 OFF 몰림)도 엔진이 수용 → 신호등 feasible."""
    nurses = small_nurses(6)
    prev = {nurses[0].id: {"2026-03-03": "OF", "2026-03-05": "OF"}}
    res = check_feasibility(build_request(nurses=nurses, prev_schedule=prev, add_juhu=False))
    assert res["status"] == "feasible", res


def test_probe_one_side_pin_transition_infeasible(build_request, small_nurses, small_requirements):
    """확정 N 4명(월) 다음날 화 D=2 — 전날 D였던 1명 외엔 전부 N/E 뒤라 D 불가
    → infeasible. 한쪽만 확정인 전환 제약은 자유 셀에 그대로 걸린다."""
    nurses = small_nurses(6)
    req = small_requirements()
    req.tue.D = 2
    prev = {f"a{i}": {"2026-03-02": "N"} for i in range(4)}
    res = check_feasibility(build_request(
        nurses=nurses, prev_schedule=prev, requirements=req, add_juhu=False))
    assert res["status"] == "infeasible", res


def test_probe_no_nurses(build_request):
    """간호사 0명 → unknown (신호등 미확정, 오류 아님)."""
    req = build_request(add_juhu=False)
    req.nurses = []
    res = check_feasibility(req)
    assert res["status"] == "unknown"


# ── 완성된 번표 · 한 줄 요약 (2026-10-16) ───────────────────────────────────

def _full_table(nurses, year=2026, month=3):
    """빈칸 없는 한 달 표 — 앱 규칙(인원·OF 주 1회)과 일부러 다르게."""
    import calendar
    from datetime import date
    pat = ["D", "E", "N", "OF", "주", "D", "OF"]
    days = calendar.monthrange(year, month)[1]
    return {n.id: {date(year, month, k + 1).isoformat(): pat[(i + k) % 7] for k in range(days)}
            for i, n in enumerate(nurses)}


def test_probe_full_table_is_feasible(build_request, small_nurses):
    """빈칸 없는 표는 만들기에서 그대로 근무표로 확정된다 — 신호등도 '가능'.
    병동이 실제로 쓴 번표를 넣었는데 빨간 불이 뜨던 것 (2026-10-16)."""
    nurses = small_nurses(6)
    req = build_request(nurses=nurses, prev_schedule=_full_table(nurses), add_juhu=False)
    res = check_feasibility(req)
    assert res["status"] == "feasible" and res.get("pinned_table"), res
    # 완화를 켜면 엔진이 표를 고쳐 보려 한다 — 지름길을 쓰지 않는다
    req.allow_pre_relax = True
    assert not check_feasibility(req).get("pinned_table")


def test_weekly_of_label_names_the_dates(build_request, small_nurses):
    """주 OF 한도 라벨은 'N주차'가 아니라 날짜로 — 생성 범위 첫 주부터 세어 화면 주기와 달랐다."""
    from server.conflict_analyzer import _ConflictAnalyzer
    a = _ConflictAnalyzer(build_request(nurses=small_nurses(6), add_juhu=False))
    a._gated_model()
    labels = [lab for lab in a._labels.values() if "OF" in lab and "한도" in lab]
    assert labels and all("주차" not in lab for lab in labels), labels[:3]
    assert any("03/01~03/07 OF 주 1회 한도" in lab for lab in labels), labels[:3]


def _analyzer(build_request, small_nurses, prev=None):
    from server.conflict_analyzer import _ConflictAnalyzer
    return _ConflictAnalyzer(build_request(nurses=small_nurses(6), prev_schedule=prev, add_juhu=False))


def test_summary_one_nurse_rest_cap(build_request, small_nurses):
    """한 사람의 전환 금지 + 휴무 한도 묶음 → 날짜·원인·이미 넣은 휴무 한 줄, 칸은 전환 날."""
    a = _analyzer(build_request, small_nurses)
    who = a._fmt_nurse_label(next(n for n in a.nurses if n["id"] == "a1"))
    anchored = [
        {"label": f"{who} 03/04(수)→03/05(목) N→D 금지", "nurse_id": "a1", "date": "2026-03-04",
         "kind": "transition", "info": {"frm": "N"}},
        {"label": f"{who} 03/01~03/07 OF 주 1회 한도", "nurse_id": "a1", "date": "2026-03-01",
         "kind": "rest_cap", "info": {"code": "OF", "used": ["2026-03-07"]}},
        {"label": f"{who} V(연차) 월 1회 이하", "nurse_id": "a1", "date": None,
         "kind": "rest_cap", "info": {"code": "V", "used": ["2026-03-20"]}},
    ]
    summary, focus = a._conflict_summary(anchored)
    assert summary.startswith(f"{who}: 03/04(수) N 뒤로 쉬는 날이 있어야 하는데"), summary
    assert "이미 넣은 OF(03/07)·V(03/20)로 휴무 한도가 찼어요" in summary, summary
    assert focus is anchored[0]


def test_summary_staff_day_and_unknown(build_request, small_nurses):
    a = _analyzer(build_request, small_nurses)
    staff = [{"label": "03/02(월) D 필요 인원 1명", "nurse_id": None, "date": "2026-03-02", "kind": "staff"}]
    summary, focus = a._conflict_summary(staff)
    assert summary.startswith("03/02(월) 인원을 채울 수 없어요"), summary
    assert focus is staff[0]
    mixed = [{"label": "x", "nurse_id": "a0", "date": "2026-03-03"},
             {"label": "y", "nurse_id": "a1", "date": "2026-03-04"}]
    assert a._conflict_summary(mixed) == ("", mixed[0])
    assert a._conflict_summary([]) == ("", None)


def test_probe_explains_one_nurse_rest_conflict(build_request, small_nurses):
    """11월 실제 사례를 줄인 것: N 다음 날은 N·휴무만 되고 그다음이 D 로 확정이면 휴무만 남는데,
    OF·V·생을 이미 다 넣었다 → '2주차 OF 2회 이상 금지' 한 줄 대신 왜 막혔는지 말한다."""
    from server.conflict_analyzer import _ConflictAnalyzer
    from .conftest import _LimitedMixin, _juhu_prev

    class _Limited(_LimitedMixin, _ConflictAnalyzer):
        def __init__(self, req):
            self._max_days = 7
            super().__init__(req)

    from server.models import GenerateRequest, Rules
    from .test_exact_fit_characterization import PROD_SHIFTS
    from .conftest import _mini_requirements

    nurses = small_nurses(6)
    prev = _juhu_prev(nurses, 2026, 3, 7)          # a1 주휴 = 3/3(화)
    prev["a1"].update({"2026-03-01": "V", "2026-03-02": "생", "2026-03-04": "N",
                       "2026-03-06": "D", "2026-03-07": "OF"})
    req = GenerateRequest(year=2026, month=3, nurses=nurses, requirements=_mini_requirements(),
                          rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1),
                          shifts=PROD_SHIFTS, prev_schedule=prev)   # 실제 병동 근무 정의(특·D1 은 사전입력 전용)
    res = _Limited(req).probe(10.0)
    assert res["status"] == "infeasible", res
    summary = res.get("summary") or ""
    assert "휴무 한도가 찼어요" in summary, res
    assert "OF(03/07)" in summary and "V(03/01)" in summary, summary
    assert (res.get("focus") or {}).get("nurse_id") == "a1", res


# ── 원인 찾기 모델도 사람이 넣은 칸은 사실로 본다 (엔진 사실-클램프와 같게, 2026-10-16 검토) ──────────

def _gated(request):
    """신호등과 같은 순서로 — 사실 인덱스를 먼저 만들고 게이팅 모델."""
    from server.conflict_analyzer import _ConflictAnalyzer
    a = _ConflictAnalyzer(request)
    a._build_pin_index()
    model, lits = a._gated_model()
    return a, model, lits


def _alone_is_infeasible(a, model, lits, pred):
    """pred(라벨) 인 게이트만 켜고 풀었을 때 막히는가 — _nurse_core 가 '그 사람 탓'으로 확정하는 방식."""
    from ortools.sat.python import cp_model
    own = [lit for lit in lits if pred(a._labels[lit.Index()])]
    assert own, "게이트가 있어야 한다"
    model.ClearAssumptions()
    model.AddAssumptions(own)
    s = cp_model.CpSolver()
    s.parameters.max_time_in_seconds = 10
    return s.Solve(model) == cp_model.INFEASIBLE


def test_gates_skip_pinned_transition_pairs(build_request, small_nurses):
    """엔진은 두 칸 다 사람이 넣은 역순 쌍(지난달 E → 1일 D, 달 안 E → D)을 사실로 받는다 — 원인 후보로도 걸지 않는다.
    예전엔 그 쌍 게이트가 혼자서도 모순이라 다른 이유로 막혀도 그 칸을 원인으로 짚었다."""
    from server.models import GenerateRequest, Rules
    nurses = small_nurses(6)
    prev = {"a0": {"2026-03-31": "E", "2026-04-01": "D", "2026-04-06": "E", "2026-04-07": "D",
                   "2026-04-10": "E"}}
    a, model, lits = _gated(GenerateRequest(year=2026, month=4, nurses=nurses, requirements=_req_dict(),
                                            rules=Rules(maxConsecutiveWorkDays=6), prev_schedule=prev))
    labels = list(a._labels.values())
    assert not [lab for lab in labels if "E→D" in lab and lab.startswith("*시니어A")
                and ("03/31" in lab or "04/06" in lab)], [lab for lab in labels if "E→D" in lab][:4]
    # 한쪽만 확정이면 그대로 건다 — 4/10 E(확정) 다음 날 4/11(빈칸) D
    assert any("04/10" in lab and "04/11" in lab and "E→D" in lab
               for lab in labels if lab.startswith("*시니어A")), [lab for lab in labels if "E→D" in lab][:4]


def _req_dict():
    from .conftest import _mini_requirements
    return _mini_requirements()


def test_gates_clamp_pinned_runs_and_night_counts(build_request, small_nurses):
    """사람이 넣은 6일 연속 근무(한도 4 + 파트장 확인 하루 = 5 를 넘음)·야간 3회(월 2회 한도)는 엔진이 받는다 —
    그 사람 게이트만 켜도 풀려야 한다. 예전 게이트는 확정 칸까지 세어 혼자서 막혔고 _nurse_core 가 그 사람 탓으로 확정했다."""
    from server.models import GenerateRequest, Rules
    nurses = small_nurses(6)
    prev = {"a0": {f"2026-03-0{k}": "D" for k in range(1, 7)},
            "a1": {"2026-03-01": "N", "2026-03-02": "N", "2026-03-03": "N"}}
    rules = Rules(maxConsecutiveWorkDays=4, maxVPerMonth=1, maxNightPerMonthCount=2, maxConsecutiveNightDays=3)
    a, model, lits = _gated(GenerateRequest(year=2026, month=3, nurses=nurses, requirements=_req_dict(),
                                            rules=rules, prev_schedule=prev))
    assert not _alone_is_infeasible(a, model, lits, lambda lab: lab.startswith("*시니어A") and "연속근무" in lab)
    assert not _alone_is_infeasible(a, model, lits, lambda lab: lab.startswith("*간호1") and "월 야간" in lab)


def test_charge_gate_skips_fully_pinned_days(build_request, small_nurses):
    """그날 칸을 사람이 다 채웠으면 엔진은 그날 차지 구성을 표 그대로 둔다 — 붙여 넣은 번표의 날을 '차지 1명 필요'로 짚지 않는다."""
    from datetime import date
    nurses = small_nurses(6)
    day = {"a0": "D", "a1": "E", "a2": "N", "a3": "OF", "a4": "OF", "a5": "OF"}
    prev = {nid: {"2026-03-03": c} for nid, c in day.items()}
    a, _, _ = _gated(build_request(nurses=nurses, prev_schedule=prev, add_juhu=False))
    tag = a._fmt_date(date(2026, 3, 3))
    assert not [lab for lab in a._labels.values() if lab.startswith(tag) and "차지" in lab]
    assert [lab for lab in a._labels.values() if lab.startswith(a._fmt_date(date(2026, 3, 4))) and "차지" in lab]
