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
import time

_lock = threading.Lock()
_adapters: dict = {}       # id(adapter) -> adapter  (다중 = 레이스 안전)
_running: bool = False     # 생성 수명주기 래치 (어댑터 등록 전에도 True)
_cancelled: bool = False   # 사용자 취소 플래그 (레이스 패자 자동중지와 구분)
_all_cancel: bool = False  # cancel_all 발생 래치 — 레이스 패자가 완화 재시도 등
                           # 후속 솔브를 시작하지 않도록 신호 (사용자 취소와 구분)

# ── run 단위 이벤트 레코더 (생성 리포트·정체 감지의 정본) ─────────────────────
# 공유 _log_queue는 race/완화 재시도에서 상호 드레인되고 타임스탬프가 없어
# 분석 정본으로 쓸 수 없다. 샘플링은 별도 스레드 없이 get_progress() 호출
# (SSE 1초 heartbeat·진행 폴링)을 표본으로 활용한다.
_events: list = []
_run_t0 = None            # time.monotonic() at begin
_last_sample_t: float = 0.0
_rec_last_gap = None
_rec_has_sol: bool = False
_rec_improve_t = None     # 마지막 개선 시각(경과초)
_MAX_EVENTS = 5000


def _reset_recorder_locked():
    global _run_t0, _last_sample_t, _rec_last_gap, _rec_has_sol, _rec_improve_t
    _events.clear()
    _run_t0 = time.monotonic()
    _last_sample_t = 0.0
    _rec_last_gap = None
    _rec_has_sol = False
    _rec_improve_t = None


def record_event(kind: str, **kw):
    """run 수명주기 내 이벤트 기록 (밖이면 무시 — 레이스 패자 잔류 이벤트 차단)."""
    with _lock:
        if not _running or _run_t0 is None or len(_events) >= _MAX_EVENTS:
            return
        _events.append({"t": round(time.monotonic() - _run_t0, 1),
                        "kind": kind, **kw})

_IDLE = {"gap_percent": None, "nodes": 0, "has_solution": False, "is_running": False}


def clear():
    """전체 리셋 (테스트/안전용)."""
    global _running, _cancelled, _all_cancel
    with _lock:
        _adapters.clear()
        _running = False
        _cancelled = False
        _all_cancel = False


def begin():
    """생성 시작 — running 래치 ON, 취소 플래그 초기화 (어댑터는 아직 없음)."""
    global _running, _cancelled, _all_cancel
    with _lock:
        _running = True
        _cancelled = False
        _all_cancel = False
        _adapters.clear()
        _reset_recorder_locked()


def try_begin() -> bool:
    """원자적 생성 시작 — 이미 진행 중이면 False (is_running 체크와 begin 사이의
    TOCTOU 제거용). 성공 시 begin()과 동일한 상태가 된다."""
    global _running, _cancelled, _all_cancel
    with _lock:
        if _running or _adapters:
            return False
        _running = True
        _cancelled = False
        _all_cancel = False
        _adapters.clear()
        _reset_recorder_locked()
        return True


def end():
    """생성 종료 — 전체 비활성화. 남은 레이스 패자 어댑터는 clear 전에 cancel을
    전파한다 (clear만 하면 잔존 솔브가 어떤 취소 경로에도 잡히지 않음)."""
    global _running
    with _lock:
        leftovers = list(_adapters.values())
        _adapters.clear()
        _running = False
    for a in leftovers:
        try:
            a.cancel()
        except Exception:
            pass


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
    (레이스에서 승자 확정 후 패자를 멈출 때 사용 → 승자 결과가 stopped로 오인되지 않음).
    _all_cancel 래치를 켜서, cancel 시점에 미등록이던 패자의 후속 솔브(완화 재시도 등)도
    was_cancel_all()로 스스로 중단을 판단할 수 있게 한다."""
    global _all_cancel
    with _lock:
        _all_cancel = True
    _cancel_snapshot()


def was_cancel_all() -> bool:
    """이번 생성 수명주기에서 cancel_all이 발생했는가 (레이스 패자 판별용)."""
    return _all_cancel


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
        return _note_progress(best)
    p = dict(_IDLE)
    p["is_running"] = _running
    return _note_progress(p)


def _note_progress(p: dict) -> dict:
    """진행 조회를 표본으로 기록 + 정체 시간(stalled_seconds) 계산.
    SSE heartbeat/폴링이 1초 주기라 별도 스레드 없이 곡선이 만들어진다
    (클라이언트가 없으면 곡선 공백 — 데스크톱 앱은 생성 중 항상 스트리밍)."""
    global _last_sample_t, _rec_last_gap, _rec_has_sol, _rec_improve_t
    with _lock:
        if not _running or _run_t0 is None:
            return p
        now = time.monotonic()
        el = now - _run_t0
        improved = False
        if p.get("has_solution") and not _rec_has_sol:
            _rec_has_sol = True
            improved = True
        g = p.get("gap_percent")
        if g is not None and (_rec_last_gap is None or g <= _rec_last_gap - 0.01):
            _rec_last_gap = g
            improved = True
        if improved:
            _rec_improve_t = el
        if _rec_has_sol and _rec_improve_t is not None:
            p["stalled_seconds"] = int(el - _rec_improve_t)
        else:
            p["stalled_seconds"] = 0
        if now - _last_sample_t >= 1.0 and len(_events) < _MAX_EVENTS:
            _last_sample_t = now
            _events.append({"t": round(el, 1), "kind": "sample", "gap": g,
                            "nodes": p.get("nodes") or 0,
                            "has_solution": bool(p.get("has_solution"))})
    return p


def build_report(result: dict) -> dict:
    """생성 종료 시점의 run 리포트 — end() 호출 '전'에 만들어야 한다."""
    with _lock:
        events = list(_events)
        t0 = _run_t0
    if t0 is None:
        return {}
    duration = round(time.monotonic() - t0, 1)
    samples = [e for e in events if e["kind"] == "sample"]
    # 시간-gap 곡선: 변화점만 남기고 ≤120점 다운샘플
    curve = []
    last_gap = object()
    for s in samples:
        if s.get("gap") is None:
            continue
        if s["gap"] != last_gap:
            curve.append([s["t"], s["gap"]])
            last_gap = s["gap"]
    if samples and samples[-1].get("gap") is not None and \
            (not curve or curve[-1][0] != samples[-1]["t"]):
        curve.append([samples[-1]["t"], samples[-1]["gap"]])
    if len(curve) > 120:
        step = len(curve) / 120.0
        curve = [curve[int(i * step)] for i in range(120)]
    # 정체 구간: 해 보유 중 gap 무개선 ≥180초
    stalls = []
    run_start = None
    run_gap = None
    prev_t = None
    for s in samples:
        if not s.get("has_solution") or s.get("gap") is None:
            run_start = None
            continue
        if run_start is None or abs(s["gap"] - run_gap) >= 0.01:
            if run_start is not None and prev_t - run_start >= 180:
                stalls.append({"from": run_start, "to": prev_t, "gap": run_gap})
            run_start = s["t"]
            run_gap = s["gap"]
        prev_t = s["t"]
    if run_start is not None and prev_t is not None and prev_t - run_start >= 180:
        stalls.append({"from": run_start, "to": prev_t, "gap": run_gap})
    model_ev = next((e for e in events if e["kind"] == "model"), None)
    return {
        "duration_seconds": duration,
        "final_gap_percent": result.get("mip_gap_percent"),
        "curve": curve,
        "stalls": stalls[:5],
        "num_vars": (model_ev or {}).get("vars"),
        "num_constraints": (model_ev or {}).get("cons"),
        "engine": (model_ev or {}).get("engine"),
        "relax_attempted": any(e["kind"] == "relax_start" for e in events),
        "incumbents": sum(1 for e in events if e["kind"] == "incumbent"),
        "stopped": bool(result.get("stopped")),
    }
