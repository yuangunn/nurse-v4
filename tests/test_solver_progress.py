"""솔버 무관 진행/취소 레지스트리 단위 테스트 (Phase 2)."""
from server import solver_progress as sp


def test_registry_default_idle():
    sp.clear()
    assert sp.get_progress()["is_running"] is False


def test_register_and_progress():
    sp.clear()
    sp.begin()  # register는 begin~end 수명주기 내에서만 유효

    class Fake:
        cancelled = False
        def cancel(self):
            self.cancelled = True
        def progress(self):
            return {"gap_percent": 1.5, "nodes": 10, "has_solution": True, "is_running": True}

    f = Fake()
    sp.register(f)
    assert sp.get_progress()["gap_percent"] == 1.5
    assert sp.is_active() is True
    sp.request_cancel()
    assert f.cancelled is True
    assert sp.is_cancelled() is True
    sp.clear()
    assert sp.get_progress()["is_running"] is False
    assert sp.is_active() is False


def test_running_latch_without_adapter():
    """generate() 진입~솔버 등록 사이 구간: 어댑터 없어도 running 래치로 is_running True."""
    sp.clear()
    sp.begin()  # 생성 시작 (아직 솔버 미등록)
    assert sp.is_running() is True
    assert sp.is_active() is False  # 솔버 인스턴스는 아직 없음
    sp.end()
    assert sp.is_running() is False


def test_recorder_and_report_lifecycle():
    """run 레코더: 수명주기 내 기록·리포트 생성, 밖에서는 무시 (레이스 패자 차단)."""
    sp.clear()
    sp.begin()
    sp.record_event("model", engine="HiGHS", vars=10, cons=20)
    sp.record_event("relax_start", engine="HiGHS")
    p = sp.get_progress()  # 래치 경로 호출이 곧 샘플링
    assert "stalled_seconds" in p
    rep = sp.build_report({"mip_gap_percent": 1.5, "stopped": False})
    assert rep["num_vars"] == 10 and rep["num_constraints"] == 20
    assert rep["relax_attempted"] is True
    assert rep["final_gap_percent"] == 1.5
    sp.end()
    sp.record_event("model", engine="X", vars=1, cons=1)  # 수명주기 밖 — 무시
    sp.begin()
    rep2 = sp.build_report({})
    assert rep2.get("num_vars") is None, "이전 run 이벤트가 새 run에 누출됨"
    sp.clear()


def test_generation_runs_table(tmp_path, monkeypatch):
    """생성 이력 테이블 — insert/list 및 최근 이력 반환."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    db.init_db()
    row = {"year": 2026, "month": 6, "solver": "highs", "success": 1,
           "stopped": 0, "relaxed": 0, "duration_s": 12.5, "final_gap": 1.2,
           "num_vars": 100, "num_constraints": 200, "nurse_count": 18,
           "pre_filled": 80, "time_limit": 1200, "mip_gap": 0.02}
    note, recent = db.insert_generation_run(row)
    assert recent and recent[0]["solver"] == "highs"
    assert db.list_generation_runs(5)[0]["nurse_count"] == 18
