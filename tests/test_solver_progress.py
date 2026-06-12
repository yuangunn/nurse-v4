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
