"""CP-SAT 엔진 리뷰(2026-10) 회귀 — 완화 1단계 중지·레이스 패자, 멈춤 문구, 목록에 없는 근무 코드, V 삭제, 충돌 위치."""
from __future__ import annotations

import pytest
from ortools.sat.python import cp_model

from server import solver_progress as sp
from server.models import GenerateRequest, Rules
from server.scheduler import NurseScheduler
from server.scheduler_cpsat import CpSatScheduler
from tests.conftest import _juhu_prev, _mini_nurses, _mini_requirements, make_limited
from tests.test_exact_fit_characterization import PROD_SHIFTS

STOPPED = NurseScheduler._stopped_result()["message"]   # 멈춤 문구는 HiGHS 와 같다


@pytest.fixture(autouse=True)
def _clean_progress():
    sp.clear()
    yield
    sp.clear()


def _relax_request(**kw):
    """6명 7일 — 3/3 에 모두 OF 라 엄격으로는 안 되고 완화로 된다."""
    nurses = _mini_nurses(6)
    prev = _juhu_prev(nurses, 2026, 3, 7)
    for n in nurses:
        prev[n.id]["2026-03-03"] = "OF"
    return GenerateRequest(year=2026, month=3, nurses=nurses, requirements=_mini_requirements(),
                           rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1), prev_schedule=prev,
                           allow_pre_relax=True, time_limit=20, **kw)


def _spy_solves(monkeypatch, on_start):
    """CpSolver.Solve 를 감싼다 — n 번째 풀이(1=엄격, 2=완화 1단계, 3=2단계)가 시작할 때 on_start(n).
    돌려주는 목록엔 풀이마다 그때 진행 레지스트리에 어댑터가 있었는지가 쌓인다."""
    calls = []
    orig = cp_model.CpSolver.Solve

    def solve(self, model, cb=None):
        calls.append(sp.is_active())
        on_start(len(calls))
        return orig(self, model, cb)

    monkeypatch.setattr(cp_model.CpSolver, "Solve", solve)
    return calls


def test_stop_during_relax_stage1_stops_there(monkeypatch):
    """완화 1단계 도중 누른 중지가 1단계에 닿는다 — 2단계를 시작하지 않고 '멈췄습니다', 정밀 분석도 안 돈다."""
    import server.conflict_analyzer as ca
    analyzed = []
    monkeypatch.setattr(ca, "analyze_conflicts", lambda req: analyzed.append(1) or {})
    calls = _spy_solves(monkeypatch, lambda n: n == 2 and sp.request_cancel())
    sp.begin()
    r = make_limited(_relax_request(), 7, "cpsat").solve()
    assert calls == [True, True], calls        # 1단계도 등록돼 중지가 닿는다 · 2단계는 없다
    assert not r["success"] and r["message"] == STOPPED, r["message"]
    assert not analyzed


def test_race_loser_in_relax_stage1_does_not_leak_into_the_next_run(monkeypatch):
    """레이스 패자가 완화 1단계에 있을 때 정리되면(cancel_all → end) 거기서 멈춘다 —
    바로 이은 다음 생성에 2단계가 등록되거나 해·기록을 남기지 않는다."""
    def race_cleanup(n):
        if n == 2:                  # 1단계 도중 승자 확정 → 패자 정리 → 사용자가 바로 다음 생성
            sp.cancel_all_adapters()
            sp.end()
            assert sp.try_begin()

    calls = _spy_solves(monkeypatch, race_cleanup)
    sp.begin()
    r = make_limited(_relax_request(solver="race"), 7, "cpsat").solve()
    assert len(calls) == 2, calls               # 2단계를 시작하지 않는다
    assert not r["success"]
    assert not sp.is_active()
    assert sp.build_report({}).get("incumbents") == 0   # 다음 생성의 리포트에 패자 해가 없다


def test_stop_during_relax_says_stopped_without_analysis(monkeypatch):
    """완화 도중 멈춰 표가 없으면 'infeasible' 이 아니라 '멈췄습니다' — 정밀 분석을 돌리지 않는다 (HiGHS 패리티)."""
    import server.conflict_analyzer as ca
    analyzed = []
    monkeypatch.setattr(ca, "analyze_conflicts", lambda req: analyzed.append(1) or {})

    def stopped_relax(self):
        sp.request_cancel()
        return None

    monkeypatch.setattr(CpSatScheduler, "_solve_relaxed", stopped_relax)
    sp.begin()                              # 중지는 생성 수명주기 안에서만 참이다 (solver_progress.is_cancelled)
    r = make_limited(_relax_request(), 7, "cpsat").solve()
    assert not r["success"] and r["message"] == STOPPED, r["message"]
    assert not analyzed


def test_stop_before_the_first_solution_says_stopped(monkeypatch):
    """첫 해 전에 멈춘 풀이(UNKNOWN)는 '제한 시간 내에 해를 찾지 못했습니다'가 아니라 '멈췄습니다'."""
    def stopped(self, model, cb=None):
        sp.request_cancel()
        return cp_model.UNKNOWN

    monkeypatch.setattr(cp_model.CpSolver, "Solve", stopped)
    sp.begin()
    r = make_limited(_relax_request(), 7, "cpsat").solve()
    assert not r["success"] and r["message"] == STOPPED, r["message"]


def test_stop_while_building_the_model_says_stopped():
    """모델을 만드는 동안 누른 중지도 같은 문구."""
    sp.begin()
    sp.request_cancel()
    r = make_limited(_relax_request(), 7, "cpsat").solve()
    assert not r["success"] and r["message"] == STOPPED, r["message"]


def test_relax_skips_a_pre_code_not_in_the_shift_list():
    """설정에서 지운 근무 코드가 사전입력에 남아 있어도 완화가 KeyError 로 죽지 않는다 — 그 칸을 풀어 만든다 (HiGHS 패리티)."""
    req = GenerateRequest(year=2026, month=3, nurses=_mini_nurses(6), requirements=_mini_requirements(),
                          rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1),
                          prev_schedule={"a2": {"2026-03-03": "모름"}}, allow_pre_relax=True, time_limit=20)
    r = make_limited(req, 7, "cpsat").solve()
    assert r["success"], r.get("message")
    assert r["relaxed_cells"]["a2"]["2026-03-03"]["original"] == "모름"


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_generates_after_the_v_shift_is_deleted(engine):
    """근무 설정에서 V 를 지워도 생성된다 — V 가 없으면 V 상한도 없다.
    (낮 2명 — 1/1/1 이면 쉬는 칸이 남아 V 없이는 정말 안 된다)"""
    nurses = _mini_nurses(6)
    req = GenerateRequest(year=2026, month=3, nurses=nurses, requirements=_mini_requirements(2, 1, 1),
                          rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1),
                          prev_schedule=_juhu_prev(nurses, 2026, 3, 7),
                          shifts=[s for s in PROD_SHIFTS if s.code != "V"], time_limit=20)
    r = make_limited(req, 7, engine).solve()
    assert r["success"], r.get("message")


def test_infeasible_result_keeps_the_conflict_cells():
    """완화로도 안 되면 정밀 분석의 충돌 위치(anchored)를 결과에 싣는다 — HiGHS 처럼 '충돌 위치로 이동' 칩이 뜬다."""
    req = GenerateRequest(year=2026, month=3, nurses=_mini_nurses(2), requirements=_mini_requirements(),
                          rules=Rules(maxConsecutiveWorkDays=6), allow_pre_relax=True, time_limit=20)
    r = make_limited(req, 7, "cpsat").solve()
    assert not r["success"]
    assert any(a.get("nurse_id") or a.get("date") for a in r.get("anchored") or []), r.get("anchored")
