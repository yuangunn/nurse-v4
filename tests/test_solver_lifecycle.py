"""생성 수명주기 회귀 — 중지 플래그·로그 큐·레이스 패자의 늦은 풀이·병동별 생성 결과 (리뷰 2026-10-21)."""
from __future__ import annotations

import json
import threading
import time

import pytest

from server import solver_progress as sp

fastapi_testclient = pytest.importorskip("fastapi.testclient")


class _Adapter:
    cancelled = False

    def cancel(self):
        self.cancelled = True

    def progress(self):
        return {"gap_percent": None, "nodes": 0, "has_solution": False, "is_running": True}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import api
    from server import database as db

    db.init_db()
    sp.clear()
    monkeypatch.setattr(api, "_last_generate_result", None)
    yield fastapi_testclient.TestClient(api.app)
    sp.clear()


def test_stop_does_not_leave_diagnose_timed_out(build_request, small_nurses):
    """중지한 생성이 끝나면 중지 플래그도 끝난다 — 남아 있으면 생성 밖의 정밀 충돌 분석이
    다음 생성 전까지 '충돌 분석 미완료 (타임아웃)'만 냈다."""
    from server.conflict_analyzer import analyze_conflicts

    req = build_request(nurses=small_nurses(2), add_juhu=False)   # 2명에 D=E=N=1 — 인원 충돌
    sp.clear()
    sp.begin()
    sp.request_cancel()
    assert sp.is_cancelled()
    sp.end()
    assert not sp.is_cancelled()
    res = analyze_conflicts(req)
    assert res["conflicts"], res["message"]


def test_race_loser_cannot_start_solves_after_the_winner():
    """승자가 정해진 뒤(cancel_all)·생성이 끝난 뒤·다음 생성 중에 패자 스레드가 여는 풀이는 곧바로 취소되고
    등록되지 않는다 — 예전엔 아무 중지도 닿지 않아 time_limit 동안 돌거나 다음 생성의 진행으로 보였다."""
    sp.clear()
    sp.begin()
    step, done, seen = threading.Semaphore(0), threading.Semaphore(0), []

    def loser():
        try:
            sp.bind_thread()
            for _ in range(3):
                step.acquire(timeout=5)
                a = _Adapter()
                sp.register(a)
                seen.append((a.cancelled, sp.was_cancel_all(), sp.is_active()))
                done.release()
        except Exception as e:        # 메인 스레드가 기다리다 멈추지 않게
            seen.append(e)
            done.release()

    t = threading.Thread(target=loser, daemon=True)
    t.start()
    sp.cancel_all_adapters()          # 승자 확정 — 패자가 그 뒤에 완화·폴백 풀이를 연다
    step.release(); done.acquire(timeout=5)
    sp.end()                          # 생성 끝 — 패자는 아직 돈다
    step.release(); done.acquire(timeout=5)
    sp.begin()                        # 이어 찾기처럼 곧바로 다음 생성
    step.release(); done.acquire(timeout=5)
    t.join(5)
    assert len(seen) == 3, seen
    assert seen[0][0] is True, "cancel_all 뒤 등록한 풀이가 취소되지 않았다"
    assert seen[1][:2] == (True, True), "생성이 끝난 뒤 연 풀이에 중지가 닿지 않는다"
    assert seen[2] == (True, True, False), "다음 생성에 끼어들었다"
    mine = _Adapter()                 # 묶이지 않은 스레드(단일 엔진 요청)는 그대로
    sp.register(mine)
    assert not mine.cancelled and sp.is_active() and not sp.was_cancel_all()
    sp.clear()


def test_stream_waits_for_the_generation_despite_stale_logs(client):
    """중지 뒤 소비자 없이 남은 지난 실행 로그가 있어도, 먼저 연 스트림은 생성이 시작될 때까지 기다리고
    그 로그는 생성을 시작할 때 비운다 — 예전엔 그것만 흘리고 생성 전에 'done' 으로 끝나 진행이 안 보였다."""
    from server import api

    api._log_queue.put({"type": "log", "msg": "지난 실행"})

    def fake_generate():
        time.sleep(0.5)
        assert sp.try_begin()
        api._log_queue.put({"type": "log", "msg": "이번 실행"})
        time.sleep(1.2)
        sp.end()

    t = threading.Thread(target=fake_generate)
    t0 = time.monotonic()
    t.start()
    r = client.get("/api/generate/stream")
    elapsed = time.monotonic() - t0
    t.join()
    ev = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
    assert [e["msg"] for e in ev if e.get("type") == "log"] == ["이번 실행"], ev
    assert ev[-1] == {"type": "done"} and elapsed >= 1.5, (elapsed, ev)


class _QuickScheduler:
    """엔진 대신 — 바로 성공. on_solve 로 풀이 도중의 일을 흉내 낸다."""
    on_solve = None

    def __init__(self, request):
        self.request = request

    def solve(self):
        if _QuickScheduler.on_solve:
            _QuickScheduler.on_solve()
        return {"success": True, "message": "ok",
                "schedule": {n.id: {"2026-11-02": "D"} for n in self.request.nurses}}


def _body():
    return {"year": 2026, "month": 11, "requirements": {}, "rules": {},
            "nurses": [{"id": f"g{i:02d}", "name": f"간호{i:02d}"} for i in range(1, 4)]}


def test_generate_result_stays_with_its_ward(client, monkeypatch):
    """마지막 생성 결과는 그 병동에서만 복원된다 — 다른 병동을 열면 앞 병동의 표가 '저장됨'으로 깔렸다.
    생성 도중 다른 병동을 열면 그 병동 생성 이력에 쓰지 않고, 그 화면엔 '진행 중'으로도 보이지 않는다."""
    from server import api
    from server import database as db

    monkeypatch.setattr(api, "NurseScheduler", _QuickScheduler)
    monkeypatch.setattr(_QuickScheduler, "on_solve", None)
    monkeypatch.setattr(api, "_current_profile_id", "w101")
    r = client.post("/api/generate", json=_body()).json()
    assert (r["profile_id"], r["year"], r["month"]) == ("w101", 2026, 11)
    got = client.get("/api/generate/result").json()
    assert got["status"] == "done" and got["result"]["schedule"] == r["schedule"]
    assert len(db.list_generation_runs()) == 1
    api._current_profile_id = "w102"
    assert client.get("/api/generate/result").json() == {"status": "idle"}

    during = {}

    def switch_ward():                    # w101 생성 도중 w102 를 열었다
        during["own"] = api.get_generate_result()
        api._current_profile_id = "w102"
        during["other"] = api.get_generate_result()

    monkeypatch.setattr(_QuickScheduler, "on_solve", switch_ward)
    api._current_profile_id = "w101"
    client.post("/api/generate", json=_body())
    assert during == {"other": {"status": "idle"}, "own": {"status": "running"}}, during
    # 끝났을 때 열린 병동은 w102 — w101 생성 이력·결과가 거기로 가지 않는다
    assert len(db.list_generation_runs()) == 1
    assert client.get("/api/generate/result").json() == {"status": "idle"}
    api._current_profile_id = "w101"
    assert client.get("/api/generate/result").json()["status"] == "done"
