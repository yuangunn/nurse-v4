from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
from typing import List, Optional
import json

from . import database as db
from .models import GenerateRequest, ScheduleSave
from .scheduler import NurseScheduler

app = FastAPI(title="NurseScheduler v2")

# 정적 파일 서빙 (frontend/)
_frontend_dir = Path(__file__).parent.parent / "frontend"
if _frontend_dir.exists():
    app.mount("/static", StaticFiles(directory=str(_frontend_dir)), name="static")


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
def upsert_nurse(nurse: dict):
    db.upsert_nurse(nurse)
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


# ── 스케줄 생성 API ───────────────────────────────────────────────────────────

# 일별 인원 사전 검증
from datetime import date as _date, timedelta as _td
from .scheduler import WORK_SHIFTS, DAY_SHIFTS, EVENING_SHIFTS, NIGHT_SHIFTS, LEAVE_SHIFTS, REST_SHIFTS, WEEKDAY_KEYS

def _validate_staffing(request: GenerateRequest) -> Optional[str]:
    """
    prev_schedule의 고정 근무를 반영한 후, 각 날짜별 근무 가능 인원이
    요구사항을 충족할 수 있는지 사전 검증.
    부족한 날이 있으면 경고 메시지 반환, 없으면 None.
    """
    year, month = request.year, request.month
    first = _date(year, month, 1)
    if month == 12:
        last = _date(year + 1, 1, 1) - _td(days=1)
    else:
        last = _date(year, month + 1, 1) - _td(days=1)

    req_dict = request.requirements.model_dump()
    period_map = {"D": DAY_SHIFTS, "E": EVENING_SHIFTS, "N": NIGHT_SHIFTS}
    prev = request.prev_schedule or {}
    warnings = []

    cur = first
    while cur <= last:
        dt_str = cur.strftime("%Y-%m-%d")
        weekday_key = WEEKDAY_KEYS[cur.weekday()]
        day_req = req_dict.get(weekday_key, {})

        # 이날 사용 불가한 간호사 수 (V/생/특/공/병/주/OF로 고정된 경우)
        unavailable = sum(
            1 for nurse in request.nurses
            if prev.get(nurse.id, {}).get(dt_str, "") in (LEAVE_SHIFTS + REST_SHIFTS)
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


@app.post("/api/generate")
def generate(request: GenerateRequest):
    try:
        warning = _validate_staffing(request)
        scheduler = NurseScheduler(request)
        result = scheduler.solve()
        if warning and not result.get("success"):
            result["message"] = warning + "\n\n" + result.get("message", "")
        elif warning:
            result["warning"] = warning
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
