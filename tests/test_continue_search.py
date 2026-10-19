"""이어 찾기 (결정 1-50) — 시간이 다 됐는데 차이가 목표보다 크면 그 표에서 한 번 더 찾는다.

실제 11월 입력(HiGHS): 20분에 8.8%. 같은 탐색을 60분까지 이으면 24분 뒤로 표가 그대로이고 3.4%,
20분 표를 시작해로 다시 찾으면 41분에 1.9% (목표 2% 도달). 다시 찾을 때 하한이 처음부터 다시 쌓여
앞 하한을 합치지 않으면 같은 표인데도 차이가 커 보였다(8.8% → 10.7%).

이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

from datetime import date

import pytest

from server import solver_progress as sp

from .test_month_tail import _engine, _request

LO, HI = date(2026, 11, 29), date(2026, 12, 5)
PREV = {"a0": {"2026-11-29": "주"}, "a1": {"2026-11-30": "주"}, "a2": {"2026-12-01": "주"},
        "a3": {"2026-12-02": "주"}, "a4": {"2026-12-03": "주"}, "a5": {"2026-12-04": "주"},
        "a6": {"2026-12-05": "주"}}


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_result_reports_objective_bound_and_fingerprint(engine):
    """결과에 목적값·하한(감점 점수, 낮을수록 좋다)·모델 지문 — 같은 입력이면 같은 지문."""
    r = _engine(engine, LO, HI)(_request(PREV)).solve()
    assert r["success"], r.get("message")
    assert r["engine"] == {"highs": "HiGHS", "cpsat": "CP-SAT"}[engine]
    assert r["mip_dual_bound"] <= r["objective"] + 1e-6, r
    again = _engine(engine, LO, HI)(_request(PREV)).solve()
    assert again["model_fingerprint"] == r["model_fingerprint"]
    other = _engine(engine, LO, HI)(_request({**PREV, "a0": {"2026-11-29": "주", "2026-12-02": "N"}})).solve()
    assert other["model_fingerprint"] != r["model_fingerprint"]


def test_highs_starts_from_the_given_table():
    """앞 표의 칸만 넘겨도 HiGHS 가 나머지를 채워 그 표에서 출발한다 — 결과가 앞 표보다 나빠지지 않는다."""
    import server.api as api      # highspy.Highs → _TrackableHighs (로그를 _log_queue 로)
    r = _engine("highs", LO, HI)(_request(PREV)).solve()
    assert r["success"], r.get("message")
    r2 = _engine("highs", LO, HI)(_request(PREV, warm_start=r["extended_schedule"])).solve()
    logs = []
    while not api._log_queue.empty():
        logs.append(api._log_queue.get_nowait().get("msg", ""))
    text = "\n".join(logs)
    assert "user-supplied values" in text and "MIP start solution is feasible" in text, text[-1500:]
    assert r2["success"] and r2["objective"] <= r["objective"] + 1e-6, (r["objective"], r2["objective"])


def test_cpsat_hints_the_given_table(monkeypatch):
    """CP-SAT 은 앞 표의 칸을 힌트로 받는다 — 결과가 앞 표보다 나빠지지 않는다."""
    from server.scheduler_cpsat import CpSatScheduler
    r = _engine("cpsat", LO, HI)(_request(PREV)).solve()
    assert r["success"], r.get("message")
    counts = []
    orig = CpSatScheduler._apply_hints
    monkeypatch.setattr(CpSatScheduler, "_apply_hints",
                        lambda self, model, x: counts.append(orig(self, model, x)) or counts[-1])
    r2 = _engine("cpsat", LO, HI)(_request(PREV, warm_start=r["extended_schedule"])).solve()
    assert counts and counts[0] > 0, counts
    assert r2["success"] and r2["objective"] <= r["objective"] + 1e-6, (r["objective"], r2["objective"])


def test_mip_start_takes_only_known_codes_of_scheduled_nurses():
    """시작해는 근무표 칸만 — 신규의 '/' 칸, 모르는 코드, 명부에 없는 사람은 건너뛴다."""
    s = _engine("highs", LO, HI)(_request(PREV, warm_start={
        "a0": {"2026-11-29": "주", "2026-11-30": "/E", "2026-12-01": "모름"}, "zz": {"2026-11-29": "D"}}))
    x = {n["id"]: {d: {"D": f"{n['id']}{d}D", "주": f"{n['id']}{d}주"} for d in range(s.T)} for n in s.nurses}
    pairs = s._mip_start_pairs(x, lambda v: isinstance(v, str))
    assert pairs == [("a00D", 0), ("a00주", 1)], pairs


def test_carry_bound_uses_the_larger_bound_only_for_the_same_model():
    """같은 모델(지문)일 때만 앞 하한을 이어 쓴다 — 차이 = (목적값 − 두 하한 중 큰 것) / 목적값."""
    from server.api import _carry_bound
    base = _request(PREV)
    res = {"objective": 100.0, "mip_dual_bound": 80.0, "model_fingerprint": "f1", "mip_gap_percent": 20.0}
    same = dict(res)
    _carry_bound(same, base.model_copy(update={"prev_bound": 90.0, "prev_fingerprint": "f1"}))
    assert (same["mip_gap_percent"], same["mip_dual_bound"]) == (10.0, 90.0)
    other = dict(res)
    _carry_bound(other, base.model_copy(update={"prev_bound": 90.0, "prev_fingerprint": "f2"}))
    assert other == res
    lower = dict(res)      # 앞 하한이 더 낮으면 이번 하한 그대로
    _carry_bound(lower, base.model_copy(update={"prev_bound": 70.0, "prev_fingerprint": "f1"}))
    assert (lower["mip_gap_percent"], lower["mip_dual_bound"]) == (20.0, 80.0)


def test_live_progress_combines_the_previous_bound():
    """만드는 동안의 차이도 앞 하한과 합친다 — 답·하한을 알려 주는 어댑터만."""
    class Fake:
        def cancel(self):
            pass

        def progress(self):
            return {"gap_percent": 20.0, "nodes": 5, "has_solution": True, "is_running": True,
                    "primal": 100.0, "dual": 80.0}

    sp.clear()
    sp.begin()
    sp.register(Fake())
    assert sp.get_progress()["gap_percent"] == 20.0
    sp.set_prev_bound(90.0)
    assert sp.get_progress()["gap_percent"] == 10.0
    sp.end()
    sp.begin()                       # 새 생성은 앞 하한을 물려받지 않는다
    sp.register(Fake())
    assert sp.get_progress()["gap_percent"] == 20.0
    sp.clear()
