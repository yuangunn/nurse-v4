"""
솔버 무관 진행/취소 레지스트리.

기존엔 api.py의 취소·진행·동시성·SSE가 전역 `_current_highs_instance`(highspy
객체)에 직접 묶여 있어 CP-SAT가 그 기계를 재사용할 수 없었다. 이 모듈은 그 제어
평면을 엔진 무관 어댑터로 추상화한다.

어댑터 규약 (HiGHS·CP-SAT가 각각 구현해 register):
    .cancel()              중지 신호 (HiGHS: cancelSolve, CP-SAT: StopSearch 플래그)
    .progress() -> dict    {gap_percent, nodes, has_solution, is_running}

생성 수명주기:
    begin()                /api/generate 진입 — running 래치 ON (솔버 등록 전 구간)
    register(adapter)      솔버가 실제 실행 시작 시 (HiGHS run() / CP-SAT solve())
    unregister()           솔버 종료 시
    end()                  /api/generate 종료 — 전체 리셋
"""
from __future__ import annotations

import threading
from typing import Optional

_lock = threading.Lock()
_current = None            # 활성 솔버 어댑터 (.cancel(), .progress())
_running: bool = False     # 생성 수명주기 래치 (어댑터 등록 전에도 True)
_cancelled: bool = False

_IDLE = {"gap_percent": None, "nodes": 0, "has_solution": False, "is_running": False}


def clear():
    """전체 리셋 (테스트/안전용)."""
    global _current, _running, _cancelled
    with _lock:
        _current = None
        _running = False
        _cancelled = False


def begin():
    """생성 시작 — running 래치 ON, 취소 플래그 초기화 (어댑터는 아직 없음)."""
    global _running, _cancelled, _current
    with _lock:
        _running = True
        _cancelled = False
        _current = None


def end():
    """생성 종료 — 전체 비활성화."""
    global _current, _running
    with _lock:
        _current = None
        _running = False


def register(adapter):
    """솔버 실행 시작 — 진행/취소 어댑터 등록."""
    global _current
    with _lock:
        _current = adapter


def unregister():
    """솔버 종료 — 어댑터 해제 (running 래치는 generate finally에서 end로 내림)."""
    global _current
    with _lock:
        _current = None


def is_active() -> bool:
    """솔버 인스턴스가 실제로 등록되어 실행 중인가."""
    return _current is not None


def is_running() -> bool:
    """생성이 진행 중인가 (래치 또는 어댑터 등록)."""
    return _running or _current is not None


def request_cancel():
    """중지 신호 — 취소 플래그 + 어댑터 cancel()."""
    global _cancelled
    with _lock:
        _cancelled = True
        a = _current
    if a is not None:
        try:
            a.cancel()
        except Exception:
            pass


def is_cancelled() -> bool:
    return _cancelled


def get_progress() -> dict:
    """현재 진행 상황 dict. 어댑터 있으면 그 progress(), 없으면 idle/래치 반영."""
    a = _current
    if a is not None:
        try:
            p = dict(a.progress())
        except Exception:
            p = dict(_IDLE)
        p["is_running"] = True
        return p
    p = dict(_IDLE)
    p["is_running"] = _running
    return p
