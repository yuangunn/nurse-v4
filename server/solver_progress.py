"""
솔버 무관 진행/취소 레지스트리 (다중 어댑터 = 레이스 안전).

기존엔 api.py의 취소·진행·동시성·SSE가 전역 `_current_highs_instance`(highspy
객체)에 직접 묶여 있어 CP-SAT가 그 기계를 재사용할 수 없었다. 이 모듈은 그 제어
평면을 엔진 무관 어댑터로 추상화한다.

v4.3.1: 단일 슬롯(`_current`) → 다중 어댑터(`_adapters`)로 확장. 두 엔진을 동시에
실행하는 레이스 모드에서 양쪽 어댑터가 공존하고, 패자만/전체 취소를 구분할 수 있다.
단일 엔진 경로의 동작은 동일(어댑터 1개).

어댑터 규약 (HiGHS·CP-SAT가 각각 구현해 register):
    .cancel()              중지 신호 (HiGHS: cancelSolve, CP-SAT: StopSearch 플래그)
    .progress() -> dict    {gap_percent, nodes, has_solution, is_running}

생성 수명주기:
    begin()                /api/generate 진입 — running 래치 ON (솔버 등록 전 구간)
    register(adapter)      솔버가 실제 실행 시작 시 (HiGHS run() / CP-SAT solve())
    unregister(adapter)    그 솔버 종료 시 (해당 어댑터만 제거)
    end()                  /api/generate 종료 — 전체 리셋(남은 어댑터까지 정리)
"""
from __future__ import annotations

import threading

_lock = threading.Lock()
_adapters: dict = {}       # id(adapter) -> adapter  (다중 = 레이스 안전)
_running: bool = False     # 생성 수명주기 래치 (어댑터 등록 전에도 True)
_cancelled: bool = False   # 사용자 취소 플래그 (레이스 패자 자동중지와 구분)

_IDLE = {"gap_percent": None, "nodes": 0, "has_solution": False, "is_running": False}


def clear():
    """전체 리셋 (테스트/안전용)."""
    global _running, _cancelled
    with _lock:
        _adapters.clear()
        _running = False
        _cancelled = False


def begin():
    """생성 시작 — running 래치 ON, 취소 플래그 초기화 (어댑터는 아직 없음)."""
    global _running, _cancelled
    with _lock:
        _running = True
        _cancelled = False
        _adapters.clear()


def try_begin() -> bool:
    """원자적 생성 시작 — 이미 진행 중이면 False (is_running 체크와 begin 사이의
    TOCTOU 제거용). 성공 시 begin()과 동일한 상태가 된다."""
    global _running, _cancelled
    with _lock:
        if _running or _adapters:
            return False
        _running = True
        _cancelled = False
        _adapters.clear()
        return True


def end():
    """생성 종료 — 전체 비활성화 (남은 레이스 패자 어댑터까지 정리)."""
    global _running
    with _lock:
        _adapters.clear()
        _running = False


def register(adapter):
    """솔버 실행 시작 — 진행/취소 어댑터 등록.

    - 생성 수명주기 밖(end() 이후 레이스 패자의 완화 솔브, 테스트의 직접 호출)
      에서는 등록하지 않는다 — running 고착(이후 생성 409 차단) 방지.
    - 이미 사용자 취소 상태면 등록 직후 cancel()을 보낸다 — 모델 빌드 구간에
      눌린 중지가 유실되지 않도록.
    """
    cancel_now = False
    with _lock:
        if _running:
            _adapters[id(adapter)] = adapter
            cancel_now = _cancelled
    if cancel_now:
        try:
            adapter.cancel()
        except Exception:
            pass


def unregister(adapter=None):
    """솔버 종료 — 해당 어댑터만 해제. adapter=None이면 전체 해제(하위호환)."""
    with _lock:
        if adapter is None:
            _adapters.clear()
        else:
            _adapters.pop(id(adapter), None)


def is_active() -> bool:
    """솔버 어댑터가 하나라도 등록되어 실행 중인가."""
    with _lock:
        return bool(_adapters)


def is_running() -> bool:
    """생성이 진행 중인가 (래치 또는 어댑터 등록)."""
    with _lock:
        return _running or bool(_adapters)


def _cancel_snapshot():
    """등록된 모든 어댑터를 락 밖에서 cancel() (스냅샷 후 호출 — 데드락 회피)."""
    with _lock:
        items = list(_adapters.values())
    for a in items:
        try:
            a.cancel()
        except Exception:
            pass


def cancel_all_adapters():
    """등록된 모든 어댑터 취소 — 사용자 취소 플래그는 건드리지 않음.
    (레이스에서 승자 확정 후 패자를 멈출 때 사용 → 승자 결과가 stopped로 오인되지 않음)."""
    _cancel_snapshot()


def request_cancel():
    """사용자 중지 — 취소 플래그 ON + 등록된 모든 어댑터 cancel()."""
    global _cancelled
    with _lock:
        _cancelled = True
    _cancel_snapshot()


def is_cancelled() -> bool:
    return _cancelled


def get_progress() -> dict:
    """현재 진행 상황 dict. 어댑터 있으면 가장 앞선 어댑터(해 보유 우선, 그다음 gap
    작은 쪽)의 progress(), 없으면 idle/래치 반영. 레이스 중엔 더 잘 풀고 있는 엔진을 표시."""
    with _lock:
        items = list(_adapters.values())
    if items:
        best = None
        for a in items:
            try:
                p = dict(a.progress())
            except Exception:
                continue
            if best is None:
                best = p
                continue
            # 해를 가진 쪽 우선
            if p.get("has_solution") and not best.get("has_solution"):
                best = p
            elif bool(p.get("has_solution")) == bool(best.get("has_solution")):
                pg, bg = p.get("gap_percent"), best.get("gap_percent")
                if pg is not None and (bg is None or pg < bg):
                    best = p
        if best is None:
            best = dict(_IDLE)
        best["is_running"] = True
        return best
    p = dict(_IDLE)
    p["is_running"] = _running
    return p
