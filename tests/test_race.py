"""두 엔진 레이스(D) + 레이스 안전 다중 어댑터 레지스트리 테스트.

실제 풀이는 무겁고 비결정적이라, 빠른 가짜 엔진으로 레이스 *로직*을 검증한다:
  - 먼저 성공한 엔진 채택 + race_winner 표기
  - 승자 확정 시 패자 어댑터 즉시 cancel → 패자 빠르게 종료(행 없음)
  - 둘 다 실패 시 결과 반환(race_winner=None)
다중 어댑터 레지스트리(register/unregister/cancel_all/get_progress)도 단위 검증.
"""
from __future__ import annotations

import time

from server import solver_progress
from server import api as apimod
from server.models import GenerateRequest, Nurse, Requirements, Rules


class _FakeAdapter:
    def __init__(self):
        self.cancelled = False
        self._has = False

    def cancel(self):
        self.cancelled = True

    def progress(self):
        return {"gap_percent": (1.0 if self._has else None), "nodes": 0,
                "has_solution": self._has, "is_running": True}


def _req():
    return GenerateRequest(
        year=2026, month=3,
        nurses=[Nurse(id="a0", name="n", group="A", gender="female", capable_shifts=["N"])],
        requirements=Requirements(), rules=Rules(),
    )


# ── 다중 어댑터 레지스트리 ───────────────────────────────────────────────────

def test_multi_adapter_register_cancel_all():
    solver_progress.clear()
    solver_progress.begin()  # register는 begin~end 수명주기 내에서만 유효
    a, b = _FakeAdapter(), _FakeAdapter()
    solver_progress.register(a)
    solver_progress.register(b)
    assert solver_progress.is_active()
    solver_progress.cancel_all_adapters()          # 사용자 취소 플래그는 X
    assert a.cancelled and b.cancelled
    assert solver_progress.is_cancelled() is False  # cancel_all은 플래그 안 올림
    solver_progress.unregister(a)                   # 하나만 제거
    assert solver_progress.is_active()              # b 남음
    solver_progress.unregister(b)
    assert not solver_progress.is_active()
    solver_progress.clear()


def test_get_progress_prefers_solution_holder():
    solver_progress.clear()
    solver_progress.begin()  # register는 begin~end 수명주기 내에서만 유효
    a, b = _FakeAdapter(), _FakeAdapter()
    b._has = True                                   # b만 해 보유
    solver_progress.register(a)
    solver_progress.register(b)
    p = solver_progress.get_progress()
    assert p["has_solution"] is True                # 해 가진 b를 표시
    assert p["is_running"] is True
    solver_progress.clear()


def test_request_cancel_sets_flag_and_cancels():
    solver_progress.clear()
    solver_progress.begin()  # register는 begin~end 수명주기 내에서만 유효
    a = _FakeAdapter()
    solver_progress.register(a)
    solver_progress.request_cancel()
    assert a.cancelled and solver_progress.is_cancelled() is True
    solver_progress.clear()


# ── 레이스 로직 (가짜 엔진) ──────────────────────────────────────────────────

class _FastWin:
    """0.05초 만에 성공하는 빠른 엔진."""
    def __init__(self, request):
        pass

    def solve(self):
        a = _FakeAdapter()
        solver_progress.register(a)
        try:
            time.sleep(0.05)
            return {"success": True, "schedule": {"a0": {"2026-03-01": "N"}}, "message": "빠름"}
        finally:
            solver_progress.unregister(a)


class _SlowCancellable:
    """최대 5초 도는 느린 엔진 — 어댑터 취소되면 즉시 중단(패자 시나리오)."""
    def __init__(self, request):
        pass

    def solve(self):
        a = _FakeAdapter()
        solver_progress.register(a)
        try:
            for _ in range(500):
                if a.cancelled:
                    return {"success": False, "message": "취소됨", "schedule": {}}
                time.sleep(0.01)
            return {"success": True, "schedule": {}, "message": "느림(완주)"}
        finally:
            solver_progress.unregister(a)


class _Fail:
    def __init__(self, request):
        pass

    def solve(self):
        return {"success": False, "message": "infeasible", "schedule": {}}


def test_race_fast_wins_and_cancels_loser(monkeypatch):
    """빠른 엔진이 이기고, 느린 패자는 취소되어 빠르게 끝난다(행 없음)."""
    solver_progress.clear()
    solver_progress.begin()  # 실제 generate() 경로와 동일하게 수명주기 시작
    monkeypatch.setattr(apimod, "NurseScheduler", _FastWin)
    import server.scheduler_cpsat as cps
    monkeypatch.setattr(cps, "CpSatScheduler", _SlowCancellable)
    t0 = time.time()
    res = apimod._run_race(_req())
    elapsed = time.time() - t0
    assert res["success"] is True
    assert res["race_winner"] == "HiGHS"
    assert "우승" in res["message"]
    assert elapsed < 2.0, f"패자 취소가 빨라야 함 (걸린 시간 {elapsed:.2f}s)"
    assert not solver_progress.is_active(), "레이스 후 어댑터가 모두 해제되어야 함"
    solver_progress.clear()


def test_race_both_fail_returns_result(monkeypatch):
    """둘 다 실패하면 race_winner=None + 결과(메시지) 반환."""
    solver_progress.clear()
    monkeypatch.setattr(apimod, "NurseScheduler", _Fail)
    import server.scheduler_cpsat as cps
    monkeypatch.setattr(cps, "CpSatScheduler", _Fail)
    res = apimod._run_race(_req())
    assert res["success"] is False
    assert res["race_winner"] is None
    assert "infeasible" in res["message"]
    solver_progress.clear()
