from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pathlib import Path
from typing import List, Optional
import json
import queue
import logging
import traceback
import threading

logger = logging.getLogger(__name__)

from . import database as db
from .models import GenerateRequest, ScheduleSave, ScoringRule, Nurse, Rules
from .scheduler import NurseScheduler

# ── HiGHS 인스턴스 추적 (중지 기능용) ────────────────────────────────────────
# PuLP의 HiGHS 솔버가 내부적으로 생성하는 highspy.Highs 인스턴스를 가로채
# cancelSolve() 호출과 mip_gap 캡처를 가능하게 함.
_solve_lock = threading.Lock()
_current_highs_instance = None
_last_mip_gap: Optional[float] = None
_solve_cancelled: bool = False
_solve_progress: dict = {"gap_percent": None, "nodes": 0, "has_solution": False, "is_running": False}
_log_queue: queue.Queue = queue.Queue()
_last_generate_result: Optional[dict] = None  # 마지막 생성 결과 보관 (새로고침 복구용)

try:
    import highspy as _highspy_mod
    _OrigHighs = _highspy_mod.Highs

    class _TrackableHighs(_OrigHighs):
        def run(self):
            global _current_highs_instance, _last_mip_gap, _log_queue
            _current_highs_instance = self
            # 큐 초기화 (이전 실행 잔여 로그 제거)
            while not _log_queue.empty():
                try: _log_queue.get_nowait()
                except Exception: break
            # 로그 콜백 등록 — 솔버 출력을 큐에 적재
            # highspy 1.8+: cbLogging.subscribe(fn) — event.message로 로그 수신
            def _on_log(event):
                msg = getattr(event, "message", "")
                if msg and msg.strip():
                    _log_queue.put({"type": "log", "msg": msg.rstrip()})
            try:
                self.cbLogging.subscribe(_on_log)
            except Exception:
                pass
            self.setOptionValue("output_flag", True)
            # HandleUserInterrupt=True 필수: 이 플래그가 있어야 cancelSolve()가
            # MIP 인터럽트 콜백을 활성화하여 솔버를 실제로 중단할 수 있음
            self.HandleUserInterrupt = True
            try:
                result = super().run()
                return result
            finally:
                try:
                    status, gap = super().getInfoValue("mip_gap")
                    if status.value == 0:  # kOk
                        _last_mip_gap = float(gap)
                except Exception:
                    pass
                _current_highs_instance = None

    _highspy_mod.Highs = _TrackableHighs
except ImportError:
    pass  # highspy 없으면 패스 (cancel/gap 기능 비활성화)

app = FastAPI(title="NurseScheduler v3")

# 정적 파일 서빙 (frontend/ 하위 css, js, lib)
_frontend_dir = Path(__file__).parent.parent / "frontend"
for _subdir in ("css", "js", "lib", "fonts"):
    _sub_path = _frontend_dir / _subdir
    if _sub_path.exists():
        app.mount(f"/{_subdir}", StaticFiles(directory=str(_sub_path)), name=_subdir)


@app.on_event("startup")
def startup():
    db.init_db()


# ── 헬스체크 ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "healthy", "message": "서버가 정상 동작 중입니다."}


# ── 프론트엔드 서빙 ─────────────────────────────────────────────────────────

@app.get("/")
def index():
    html_path = Path(__file__).parent.parent / "frontend" / "index.html"
    if html_path.exists():
        return FileResponse(str(html_path))
    raise HTTPException(status_code=404, detail="index.html not found")


# ── 간호사 API ────────────────────────────────────────────────────────────────

@app.get("/api/nurses")
def get_nurses():
    return db.get_nurses()


@app.post("/api/nurses")
def upsert_nurse(nurse: Nurse):
    db.upsert_nurse(nurse.model_dump())
    return {"ok": True}


@app.delete("/api/nurses/{nurse_id}")
def delete_nurse(nurse_id: str):
    db.delete_nurse(nurse_id)
    return {"ok": True}


@app.post("/api/nurses/reorder")
def reorder_nurses(body: dict):
    ids = body.get("ids", [])
    db.reorder_nurses(ids)
    return {"ok": True}


# ── 규칙 API ──────────────────────────────────────────────────────────────────

@app.get("/api/rules")
def get_rules():
    rules = db.get_rules()
    if not rules:
        # 기본값 반환
        from .models import Rules
        return Rules().model_dump()
    return rules


@app.post("/api/rules")
def save_rules(rules: dict):
    db.save_rules(rules)
    return {"ok": True}


# ── 요구사항 API ──────────────────────────────────────────────────────────────

@app.get("/api/requirements")
def get_requirements():
    req = db.get_requirements()
    if not req:
        from .models import Requirements
        return Requirements().model_dump()
    return req


@app.post("/api/requirements")
def save_requirements(body: dict):
    db.save_requirements(body)
    return {"ok": True}


# ── 근무 API ──────────────────────────────────────────────────────────────────

@app.get("/api/shifts")
def get_shifts():
    return db.list_shifts()


@app.post("/api/shifts")
def save_shift(body: dict):
    db.save_shift(
        code=body["code"],
        name=body["name"],
        period=body["period"],
        is_charge=body.get("is_charge", False),
        hours=body.get("hours", ""),
        color_bg=body.get("color_bg", "#f3f4f6"),
        color_text=body.get("color_text", "#374151"),
        sort_order=body.get("sort_order", 0),
        auto_assign=body.get("auto_assign", True),
    )
    return {"ok": True}


@app.delete("/api/shifts/{code}")
def delete_shift(code: str):
    db.delete_shift(code)
    return {"ok": True}


# ── 스케줄 생성 API ───────────────────────────────────────────────────────────

# 일별 인원 사전 검증
from datetime import date as _date, timedelta as _td

def _validate_staffing(request: GenerateRequest, leave_shifts: list, rest_shifts: list) -> Optional[str]:
    """
    prev_schedule의 고정 근무를 반영한 후, 각 날짜별 근무 가능 인원이
    요구사항을 충족할 수 있는지 사전 검증.
    부족한 날이 있으면 경고 메시지 반환, 없으면 None.
    """
    weekday_keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    year, month = request.year, request.month
    first = _date(year, month, 1)
    if month == 12:
        last = _date(year + 1, 1, 1) - _td(days=1)
    else:
        last = _date(year, month + 1, 1) - _td(days=1)

    req_dict = request.requirements.model_dump()
    off_shifts = leave_shifts + rest_shifts
    prev = request.prev_schedule or {}
    warnings = []

    cur = first
    while cur <= last:
        dt_str = cur.strftime("%Y-%m-%d")
        weekday_key = weekday_keys[cur.weekday()]
        per_day = request.per_day_requirements or {}
        day_req = per_day.get(dt_str) or req_dict.get(weekday_key, {})

        unavailable = sum(
            1 for nurse in request.nurses
            if prev.get(nurse.id, {}).get(dt_str, "") in off_shifts
        )
        available = len(request.nurses) - unavailable

        total_needed = sum(day_req.get(p, 0) for p in ["D", "E", "N"])
        if available < total_needed:
            warnings.append(
                f"{cur.strftime('%m/%d')}({['월','화','수','목','금','토','일'][cur.weekday()]}): "
                f"필요 {total_needed}명, 가용 {available}명 (부족 {total_needed - available}명)"
            )
        cur += _td(days=1)

    if warnings:
        return "경고: 일부 날짜에 인원이 부족할 수 있습니다.\n" + "\n".join(warnings[:5]) + (
            f"\n... 외 {len(warnings)-5}일" if len(warnings) > 5 else ""
        )
    return None


@app.post("/api/estimate")
def estimate(request: GenerateRequest):
    """스케줄 생성 전 예상 소요시간(초) 반환."""
    try:
        if not request.scoring_rules:
            raw = db.list_scoring_rules()
            request.scoring_rules = [ScoringRule(**r) for r in raw]
        if not request.shifts:
            from .models import ShiftDef
            raw = db.list_shifts()
            request.shifts = [ShiftDef(**s) for s in raw]
        scheduler = NurseScheduler(request)
        return {"estimated_seconds": scheduler.estimate_seconds()}
    except Exception as e:
        logger.error("Server error: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail="서버 오류가 발생했습니다. 다시 시도해주세요.")


@app.post("/api/generate/stop")
def stop_generate():
    """진행 중인 스케줄 생성을 중지하고 지금까지 찾은 최선의 해를 반환하도록 신호."""
    global _solve_cancelled
    h = _current_highs_instance
    if h is not None:
        _solve_cancelled = True
        h.cancelSolve()
        return {"ok": True, "message": "중지 신호를 전송했습니다."}
    return {"ok": False, "message": "진행 중인 생성이 없습니다."}


@app.get("/api/generate/stream")
def generate_stream():
    """SSE: 솔버 로그 + 진행 상황 실시간 스트리밍"""
    def event_gen():
        import time
        # 솔버가 아직 시작되지 않았을 수 있으므로 최대 30초 대기
        waited = 0
        while _current_highs_instance is None and _log_queue.empty() and waited < 30:
            if _solve_progress.get("is_running"):
                # generate()가 호출됨 → 솔버 시작 대기
                time.sleep(0.2)
                waited += 0.2
            else:
                # generate() 자체가 아직 호출 안 됨 → 짧게 대기
                time.sleep(0.5)
                waited += 0.5
        while True:
            h = _current_highs_instance
            # 로그 메시지 우선 드레인
            try:
                item = _log_queue.get(timeout=0.05)
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                continue
            except queue.Empty:
                pass
            # 솔버 종료 + 큐 비어있으면 done
            if h is None and _log_queue.empty() and not _solve_progress.get("is_running"):
                yield "data: {\"type\":\"done\"}\n\n"
                break
            # 1초 heartbeat — 현재 progress 전송
            prog = dict(_solve_progress)
            prog["type"] = "progress"
            yield f"data: {json.dumps(prog)}\n\n"
            time.sleep(1)
    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/generate/progress")
def get_generate_progress():
    """생성 중 실시간 진행 상황 반환 (2초 간격 폴링용)"""
    global _solve_progress
    h = _current_highs_instance
    _solve_progress["is_running"] = h is not None
    if h is not None:
        try:
            import math
            status, gap = h.getInfoValue("mip_gap")
            if status.value == 0 and math.isfinite(float(gap)):
                _solve_progress["gap_percent"] = round(float(gap) * 100, 2)
                _solve_progress["has_solution"] = True
            status2, nodes = h.getInfoValue("mip_node_count")
            if status2.value == 0:
                _solve_progress["nodes"] = int(nodes)

        except Exception:
            pass
    return _solve_progress


@app.post("/api/generate")
def generate(request: GenerateRequest):
    global _last_mip_gap, _solve_cancelled, _solve_progress, _last_generate_result
    # 이전 솔버가 아직 돌고 있으면 거부
    if _current_highs_instance is not None or _solve_progress.get("is_running"):
        raise HTTPException(status_code=409, detail="이미 생성이 진행 중입니다. 중지 후 다시 시도하세요.")
    _last_mip_gap = None
    _solve_cancelled = False
    _solve_progress = {"gap_percent": None, "nodes": 0, "has_solution": False, "is_running": True}
    _last_generate_result = None  # 새 생성 시작 시 이전 결과 초기화
    try:
        # shifts가 비어있으면 DB에서 로드
        if not request.scoring_rules:
            raw = db.list_scoring_rules()
            request.scoring_rules = [ScoringRule(**r) for r in raw]

        # shifts가 비어있으면 DB에서 로드
        if not request.shifts:
            from .models import ShiftDef
            raw = db.list_shifts()
            request.shifts = [ShiftDef(**s) for s in raw]

        leave_shifts = [s.code for s in request.shifts if s.period == "leave"]
        rest_shifts  = [s.code for s in request.shifts if s.period == "rest"]

        warning = _validate_staffing(request, leave_shifts, rest_shifts)
        scheduler = NurseScheduler(request)
        result = scheduler.solve()

        # MIP gap 및 중지 여부 추가
        if _last_mip_gap is not None:
            import math
            if math.isfinite(_last_mip_gap):
                result["mip_gap_percent"] = round(_last_mip_gap * 100, 2)
        if _solve_cancelled and result.get("success"):
            result["stopped"] = True

        if warning and not result.get("success"):
            result["message"] = warning + "\n\n" + result.get("message", "")
        elif warning:
            result["warning"] = warning

        _last_generate_result = result  # 결과 보관
        _solve_progress["is_running"] = False
        return result
    except Exception as e:
        _solve_progress["is_running"] = False
        _last_generate_result = {"success": False, "message": str(e), "schedule": {}}
        logger.error("Server error: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail="서버 오류가 발생했습니다. 다시 시도해주세요.")


@app.get("/api/generate/result")
def get_generate_result():
    """마지막 생성 결과 조회 (새로고침 복구용)"""
    if _solve_progress.get("is_running"):
        return {"status": "running"}
    if _last_generate_result is not None:
        return {"status": "done", "result": _last_generate_result}
    return {"status": "idle"}


# ── 스케줄 저장/관리 API ──────────────────────────────────────────────────────

@app.get("/api/schedules")
def list_schedules():
    return db.list_schedules()


@app.post("/api/schedules")
def save_schedule(body: ScheduleSave):
    sid = db.save_schedule(
        year=body.year,
        month=body.month,
        data={
            "nurses": [n.model_dump() for n in body.nurses],
            "requirements": body.requirements.model_dump(),
            "rules": body.rules.model_dump(),
            "schedule": body.schedule,
        },
        name=body.name,
    )
    return {"id": sid}


@app.get("/api/schedules/{schedule_id}")
def load_schedule(schedule_id: int):
    result = db.load_schedule(schedule_id)
    if not result:
        raise HTTPException(status_code=404, detail="스케줄을 찾을 수 없습니다.")
    return result


@app.delete("/api/schedules/{schedule_id}")
def delete_schedule(schedule_id: int):
    db.delete_schedule(schedule_id)
    return {"ok": True}


# ── 사전입력 저장/관리 API ─────────────────────────────────────────────────────

@app.get("/api/prev_schedules")
def list_prev_schedules():
    return db.list_prev_schedules()


@app.post("/api/prev_schedules")
def save_prev_schedule(body: dict):
    pid = db.save_prev_schedule(
        year=body["year"],
        month=body["month"],
        data=body["data"],
        name=body.get("name"),
    )
    return {"id": pid}


@app.get("/api/prev_schedules/{prev_id}")
def load_prev_schedule(prev_id: int):
    result = db.load_prev_schedule(prev_id)
    if not result:
        raise HTTPException(status_code=404, detail="사전입력을 찾을 수 없습니다.")
    return result


@app.delete("/api/prev_schedules/{prev_id}")
def delete_prev_schedule(prev_id: int):
    db.delete_prev_schedule(prev_id)
    return {"ok": True}


# ── 배점 규칙 API ─────────────────────────────────────────────────────────────

@app.get("/api/scoring_rules")
def get_scoring_rules():
    return db.list_scoring_rules()


@app.post("/api/scoring_rules")
def save_scoring_rule(body: dict):
    rid = db.save_scoring_rule(
        name=body["name"],
        rule_type=body["rule_type"],
        params=body.get("params", {}),
        score=body["score"],
        enabled=body.get("enabled", True),
        sort_order=body.get("sort_order", 0),
        rule_id=body.get("id"),
    )
    return {"id": rid}


@app.delete("/api/scoring_rules/{rule_id}")
def delete_scoring_rule(rule_id: int):
    db.delete_scoring_rule(rule_id)
    return {"ok": True}
