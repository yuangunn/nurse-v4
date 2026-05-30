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

from . import solver_progress  # solver-agnostic progress/cancel registry

logger = logging.getLogger(__name__)

from . import database as db
from . import profiles as prof
from .models import GenerateRequest, ScheduleSave, ScoringRule, Nurse, Rules
from .scheduler import NurseScheduler

# ── 현재 활성 프로필 ──────────────────────────────────────────────────────────
_current_profile_id: Optional[str] = None
_current_profile_password: Optional[str] = None

# ── HiGHS 인스턴스 추적 (중지 기능용) ────────────────────────────────────────
# PuLP의 HiGHS 솔버가 내부적으로 생성하는 highspy.Highs 인스턴스를 가로채
# cancelSolve() 호출과 mip_gap 캡처를 가능하게 함.
_solve_lock = threading.Lock()
_last_mip_gap: Optional[float] = None
_log_queue: queue.Queue = queue.Queue()
_last_generate_result: Optional[dict] = None  # 마지막 생성 결과 보관 (새로고침 복구용)

try:
    import highspy as _highspy_mod
    _OrigHighs = _highspy_mod.Highs

    class _HighsAdapter:
        """solver_progress 어댑터 — HiGHS 라이브 인스턴스 래핑 (cancel/progress)."""
        def __init__(self, highs):
            self._h = highs

        def cancel(self):
            try:
                self._h.cancelSolve()
            except Exception:
                pass

        def progress(self) -> dict:
            import math
            out = {"gap_percent": None, "nodes": 0, "has_solution": False, "is_running": True}
            try:
                status, gap = self._h.getInfoValue("mip_gap")
                if status.value == 0 and math.isfinite(float(gap)):
                    out["gap_percent"] = round(float(gap) * 100, 2)
                    out["has_solution"] = True
                status2, nodes = self._h.getInfoValue("mip_node_count")
                if status2.value == 0:
                    out["nodes"] = int(nodes)
            except Exception:
                pass
            return out

    class _TrackableHighs(_OrigHighs):
        def run(self):
            global _last_mip_gap, _log_queue
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
            solver_progress.register(_HighsAdapter(self))
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
                solver_progress.unregister()

    _highspy_mod.Highs = _TrackableHighs
except ImportError:
    pass  # highspy 없으면 패스 (cancel/gap 기능 비활성화)

app = FastAPI(title="NurseScheduler v3")

# 정적 파일 서빙 (frontend/ 하위 css, js, lib)
_frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
for _subdir in ("css", "js", "lib", "fonts", "assets"):
    _sub_path = _frontend_dir / _subdir
    if _sub_path.exists():
        app.mount(f"/{_subdir}", StaticFiles(directory=str(_sub_path)), name=_subdir)


# 개발 중 stylesheet/script 캐시로 인한 stale UI 방지 — 정적 파일에 no-cache
@app.middleware("http")
async def _no_cache_static(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith(("/css/", "/js/", "/lib/", "/fonts/", "/assets/")) or path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        # ETag / Last-Modified 제거 — 브라우저 304 conditional 응답 차단
        for h in ("etag", "last-modified"):
            if h in response.headers:
                del response.headers[h]
    return response


@app.on_event("startup")
def startup():
    prof.init_default_profiles()
    # 기본 DB 초기화 (프로필 전환 전 폴백)
    db.init_db()


# ── 프로필 API ────────────────────────────────────────────────────────────────

@app.get("/api/profiles")
def get_profiles():
    return {
        "profiles": prof.list_profiles(),
        "has_master_password": prof.has_master_password(),
        "current_profile": _current_profile_id,
    }


@app.post("/api/profiles/create")
def create_profile(body: dict):
    profile_id = body.get("id", "").strip()
    name = body.get("name", "").strip()
    password = body.get("password", "")
    is_guest = body.get("is_guest", False)
    if not profile_id or not name:
        raise HTTPException(400, "프로필 ID와 이름을 입력해주세요.")
    result = prof.create_profile(profile_id, name, password, is_guest)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error", "프로필 생성 실패"))
    return result


@app.post("/api/profiles/open")
def open_profile(body: dict):
    global _current_profile_id, _current_profile_password
    profile_id = body.get("id", "")
    password = body.get("password", "")

    # 마스터 비밀번호 확인
    if prof.has_master_password():
        master_pw = body.get("master_password", "")
        if not master_pw:
            return {"ok": False, "need_master_password": True,
                    "error": "마스터 비밀번호를 입력해주세요."}
        if not prof.verify_master_password(master_pw):
            return {"ok": False, "error": "마스터 비밀번호가 틀렸습니다."}

    # 현재 프로필 닫기
    if _current_profile_id:
        prof.close_profile(_current_profile_id, _current_profile_password or "")

    result = prof.open_profile(profile_id, password)
    if not result.get("ok"):
        return result

    # DB 경로 전환
    db_path = result["db_path"]
    db.get_db_path = lambda: db_path
    db.init_db()

    # 한 번 열릴 때 유령 간호사 참조 정리 (과거 데이터 호환)
    try:
        removed = db.cleanup_orphan_nurse_refs()
        if removed:
            print(f"[cleanup] {removed} orphan nurse references removed from saved data")
    except Exception as e:
        print(f"[cleanup] failed: {e}")

    _current_profile_id = profile_id
    _current_profile_password = password if not result.get("is_guest") else ""

    return {"ok": True, "profile_id": profile_id,
            "is_guest": result.get("is_guest", False)}


@app.post("/api/profiles/close")
def close_profile():
    global _current_profile_id, _current_profile_password
    if _current_profile_id:
        prof.close_profile(_current_profile_id, _current_profile_password or "")
        _current_profile_id = None
        _current_profile_password = None
    return {"ok": True}


@app.delete("/api/profiles/{profile_id}")
def delete_profile(profile_id: str):
    global _current_profile_id, _current_profile_password
    # 현재 열린 프로필이면 먼저 close 상태로 전환 (삭제 중 암호화 시도 방지)
    if _current_profile_id == profile_id:
        _current_profile_id = None
        _current_profile_password = None
    result = prof.delete_profile(profile_id)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error"))
    return result


@app.post("/api/profiles/change-password")
def change_profile_password(body: dict):
    profile_id = body.get("id", "")
    old_password = body.get("old_password", "")
    new_password = body.get("new_password", "")
    force_reset = body.get("force_reset", False)
    if force_reset:
        # 개발자 모드: 비밀번호 강제 초기화 (제거)
        result = prof.force_reset_password(profile_id)
        if not result.get("ok"):
            raise HTTPException(400, result.get("error"))
        return result
    if not new_password:
        raise HTTPException(400, "새 비밀번호를 입력해주세요.")
    result = prof.change_password(profile_id, old_password, new_password)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error"))
    # 현재 열린 프로필이면 비밀번호 업데이트
    global _current_profile_password
    if _current_profile_id == profile_id:
        _current_profile_password = new_password
    return result


@app.post("/api/profiles/master-password")
def set_master_password(body: dict):
    action = body.get("action", "set")
    if action == "set":
        password = body.get("password", "")
        if not password:
            raise HTTPException(400, "비밀번호를 입력해주세요.")
        prof.set_master_password(password)
        return {"ok": True}
    elif action == "remove":
        current = body.get("current_password", "")
        if prof.has_master_password() and not prof.verify_master_password(current):
            raise HTTPException(400, "현재 마스터 비밀번호가 틀렸습니다.")
        prof.remove_master_password()
        return {"ok": True}
    elif action == "verify":
        password = body.get("password", "")
        return {"ok": prof.verify_master_password(password)}
    raise HTTPException(400, "알 수 없는 action")


# ── 개발자 API ────────────────────────────────────────────────────────────────

@app.get("/api/dev/cpsat-selftest")
def dev_cpsat_selftest():
    """CP-SAT(ortools)가 번들 환경에서 임포트·풀이되는지 셀프테스트.
    Phase 0 오프라인 번들 게이트 검증용 — 번들된 exe에서 호출해 ortools 네이티브
    libs가 올바로 실렸는지 확인한다. (ortools는 런타임 네트워크를 쓰지 않음.)"""
    try:
        from ortools.sat.python import cp_model
        m = cp_model.CpModel()
        xs = [m.NewBoolVar(f"x{i}") for i in range(5)]
        m.Add(sum(xs) == 2)
        s = cp_model.CpSolver()
        st = s.Solve(m)
        ok = st in (cp_model.OPTIMAL, cp_model.FEASIBLE)
        return {
            "ok": ok,
            "sum": sum(int(s.Value(x)) for x in xs) if ok else None,
            "ortools_status": int(st),
        }
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.get("/api/dev/info")
def dev_info():
    """현재 DB 경로, 크기, 간호사 수"""
    import os
    db_path = db.get_db_path()
    size_bytes = os.path.getsize(db_path) if os.path.exists(db_path) else 0
    if size_bytes < 1024:
        size_str = f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        size_str = f"{size_bytes / 1024:.1f} KB"
    else:
        size_str = f"{size_bytes / 1024 / 1024:.1f} MB"
    nurses = db.get_nurses()
    return {"path": db_path, "size": size_str, "nurses": len(nurses)}


@app.post("/api/dev/reset-seed")
def dev_reset_seed():
    """예시 데이터(18명) 재생성"""
    with db.get_conn() as conn:
        conn.execute("DELETE FROM nurses")
    from .database import _seed_nurses
    _seed_nurses(db.get_conn())
    return {"ok": True}


@app.get("/api/dev/download-db")
def dev_download_db():
    """현재 DB 파일 다운로드"""
    from fastapi.responses import FileResponse as FR
    db_path = db.get_db_path()
    return FR(db_path, media_type="application/octet-stream",
              filename="nurse_backup.db")


# ── 간호사 CSV 템플릿/임포트 ──────────────────────────────────────────────

_NURSE_CSV_HEADER = [
    "id", "이름", "그룹", "성별", "가능근무",
    "야간전담", "시니어리티", "주휴요일", "주휴로테이션",
    "트레이닝", "트레이닝종료일", "프리셉터ID",
    "전입일", "전출일",
]
_NURSE_CSV_EXAMPLE = [
    ["n001", "김지현", "A", "female", "DC,D,EC,E,NC,N", "N", "0", "", "Y", "N", "", "", "", ""],
    ["n002", "이수진", "A", "female", "DC,D,EC,E,NC,N", "N", "1", "목", "Y", "N", "", "", "2026-04-01", ""],
    ["n003", "박민지", "B", "male", "D,E,N", "Y", "5", "", "N", "N", "", "", "", "2026-06-30"],
    ["n004", "신입간호사", "C", "female", "D,E,N", "N", "20", "", "Y", "Y", "2026-04-30", "n001", "2026-04-01", ""],
]
_NURSE_CSV_GUIDE = [
    ["# 작성 방법:"],
    ["# id — 고유 ID (영문/숫자, 중복 불가)"],
    ["# 이름 — 간호사 이름"],
    ["# 그룹 — A/B/C 등 자유 입력"],
    ["# 성별 — female 또는 male"],
    ["# 가능근무 — 쉼표로 구분 (예: DC,D,EC,E,NC,N)"],
    ["# 야간전담 — Y(야간전담) 또는 N(일반)"],
    ["# 시니어리티 — 숫자 (작을수록 선임). 앱 내 간호사 목록 순서로 자동 결정됨 (생략 가능)"],
    ["# 주휴요일 — 일/월/화/수/목/금/토 중 하나, 또는 빈칸(임의)"],
    ["# 주휴로테이션 — Y(4주마다 당김) 또는 N(고정)"],
    ["# 트레이닝 — Y(신규) 또는 N"],
    ["# 트레이닝종료일 — YYYY-MM-DD (트레이닝=Y일 때)"],
    ["# 프리셉터ID — 트레이닝=Y일 때 담당 프리셉터의 id"],
    ["# 전입일 — YYYY-MM-DD (이 날부터 근무 가능, 빈칸=상시 근무)"],
    ["# 전출일 — YYYY-MM-DD (이 날까지 근무 가능, 빈칸=상시 근무)"],
    ["#"],
    ["# 주의: #으로 시작하는 행은 무시됩니다. 헤더 행과 데이터 행만 남기고 사용하세요."],
    ["#"],
]


@app.get("/api/nurses/template")
def nurse_template():
    """간호사 일괄 등록용 CSV 템플릿 다운로드"""
    import io
    import csv
    from fastapi.responses import Response

    buf = io.StringIO()
    # UTF-8 BOM (한글 엑셀 호환)
    buf.write("\ufeff")
    writer = csv.writer(buf)
    for row in _NURSE_CSV_GUIDE:
        writer.writerow(row)
    writer.writerow(_NURSE_CSV_HEADER)
    for row in _NURSE_CSV_EXAMPLE:
        writer.writerow(row)

    content = buf.getvalue().encode("utf-8")
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="nurses_template.csv"'
        },
    )


@app.get("/api/nurses/export")
def nurse_export():
    """현재 등록된 간호사 목록을 템플릿 형식 CSV로 내보내기"""
    import io
    import csv
    from fastapi.responses import Response

    nurses = db.get_nurses()
    buf = io.StringIO()
    buf.write("\ufeff")  # UTF-8 BOM
    writer = csv.writer(buf)
    writer.writerow(_NURSE_CSV_HEADER)

    juhu_rev = {0: "일", 1: "월", 2: "화", 3: "수", 4: "목", 5: "금", 6: "토"}
    for n in nurses:
        capable = n.get("capable_shifts", [])
        if isinstance(capable, str):
            capable = [capable]
        juhu_day = n.get("juhu_day")
        juhu_ko = juhu_rev.get(juhu_day, "") if juhu_day is not None else ""

        writer.writerow([
            n.get("id", ""),
            n.get("name", ""),
            n.get("group", ""),
            n.get("gender", ""),
            ",".join(capable),
            "Y" if n.get("is_night_shift") else "N",
            str(n.get("seniority", 0)),
            juhu_ko,
            "Y" if n.get("juhu_auto_rotate", True) else "N",
            "Y" if n.get("is_trainee") else "N",
            n.get("training_end_date") or "",
            n.get("preceptor_id") or "",
            n.get("start_date") or "",
            n.get("end_date") or "",
        ])

    content = buf.getvalue().encode("utf-8")
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="nurses_current.csv"'
        },
    )


# ── CSV 파싱 헬퍼 (preview / import 양쪽에서 사용) ─────────────────────

_CSV_ENCODINGS = ("utf-8-sig", "cp949", "euc-kr", "utf-8")


def _decode_csv_input(body: dict) -> str:
    """body에서 CSV 텍스트 추출. csv_b64(바이트)면 인코딩 자동 감지."""
    import base64

    csv_b64 = body.get("csv_b64")
    if csv_b64:
        try:
            raw = base64.b64decode(csv_b64)
        except Exception as e:
            raise HTTPException(400, f"base64 디코딩 실패: {e}")
        for enc in _CSV_ENCODINGS:
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        raise HTTPException(400, "지원되지 않는 인코딩 (UTF-8 / CP949 모두 실패)")

    csv_text = body.get("csv", "")
    if not csv_text:
        raise HTTPException(400, "CSV 내용이 비어 있습니다.")
    if csv_text.startswith("\ufeff"):
        csv_text = csv_text[1:]
    return csv_text


def _parse_nurses_csv(csv_text: str) -> dict:
    """CSV 텍스트 → {nurses, errors[{row,col,got,expected,message}]}.
    id 비어 있으면 자동 생성."""
    import io
    import csv as _csv
    import re
    import uuid

    if csv_text.startswith("\ufeff"):
        csv_text = csv_text[1:]

    lines = [ln for ln in csv_text.splitlines() if not ln.lstrip().startswith("#")]
    cleaned = "\n".join(lines)
    reader = _csv.reader(io.StringIO(cleaned))
    rows = [r for r in reader if any(c.strip() for c in r)]

    if len(rows) < 2:
        return {
            "nurses": [],
            "errors": [{
                "row": 0, "col": "_file", "got": "",
                "expected": "헤더 행 + 최소 1명",
                "message": "헤더 행과 최소 1명의 데이터 행이 필요합니다.",
            }],
        }

    header = [c.strip() for c in rows[0]]
    data_rows = rows[1:]

    if "이름" not in header:
        return {
            "nurses": [],
            "errors": [{
                "row": 1, "col": "이름", "got": ",".join(header)[:120],
                "expected": "헤더에 '이름' 포함",
                "message": (
                    "필수 컬럼 '이름'이 헤더에 없습니다. "
                    "엑셀이 다른 인코딩으로 저장한 경우, 템플릿(📥)을 다시 받아 "
                    "수정 후 업로드해 주세요."
                ),
            }],
        }

    juhu_map = {"일": 0, "월": 1, "화": 2, "수": 3, "목": 4, "금": 5, "토": 6}

    def col(row, name, default=""):
        if name in header:
            try:
                return row[header.index(name)].strip()
            except IndexError:
                return default
        return default

    def yn(val, default=False):
        v = (val or "").strip().upper()
        if v in ("Y", "YES", "TRUE", "1", "O"):
            return True
        if v in ("N", "NO", "FALSE", "0", "X"):
            return False
        return default

    def err(row_idx, col_name, got, expected, msg):
        return {"row": row_idx, "col": col_name, "got": got,
                "expected": expected, "message": msg}

    nurses = []
    errors = []

    for idx, row in enumerate(data_rows, start=2):
        name = col(row, "이름")
        if not name:
            errors.append(err(idx, "이름", "", "비어있지 않음",
                              f"{idx}행: 이름이 비어 있어 건너뜀"))
            continue

        nid = col(row, "id")
        if not nid:
            nid = f"n_{uuid.uuid4().hex[:10]}"

        capable_str = col(row, "가능근무", "DC,D,EC,E,NC,N")
        capable = [s.strip() for s in capable_str.split(",") if s.strip()]

        juhu_ko = col(row, "주휴요일")
        juhu_day = juhu_map.get(juhu_ko) if juhu_ko else None
        if juhu_ko and juhu_day is None:
            errors.append(err(idx, "주휴요일", juhu_ko,
                              "일/월/화/수/목/금/토 또는 빈칸",
                              f"{idx}행: 주휴요일 '{juhu_ko}' 인식 불가 → 임의로 처리"))

        seniority_str = col(row, "시니어리티", "0")
        try:
            seniority = int(seniority_str) if seniority_str else 0
        except ValueError:
            seniority = 0
            errors.append(err(idx, "시니어리티", seniority_str, "정수",
                              f"{idx}행: 시니어리티 정수 변환 실패 → 0 처리"))

        def chk_date(field):
            v = col(row, field)
            if not v:
                return None
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
                errors.append(err(idx, field, v, "YYYY-MM-DD",
                                  f"{idx}행: {field} 형식 오류 → 빈값 처리"))
                return None
            return v

        gender_raw = col(row, "성별", "female").lower()
        if gender_raw == "여":
            gender_raw = "female"
        elif gender_raw == "남":
            gender_raw = "male"
        elif gender_raw == "":
            gender_raw = "female"
        elif gender_raw not in ("female", "male"):
            errors.append(err(idx, "성별", gender_raw, "female/male/여/남",
                              f"{idx}행: 성별 '{gender_raw}' → female 처리"))
            gender_raw = "female"

        nurses.append({
            "id": nid,
            "name": name,
            "group": col(row, "그룹"),
            "gender": gender_raw,
            "capable_shifts": capable,
            "is_night_shift": yn(col(row, "야간전담"), False),
            "seniority": seniority,
            "wishes": {},
            "juhu_day": juhu_day,
            "juhu_auto_rotate": yn(col(row, "주휴로테이션"), True),
            "night_months": {},
            "is_trainee": yn(col(row, "트레이닝"), False),
            "training_end_date": chk_date("트레이닝종료일"),
            "preceptor_id": col(row, "프리셉터ID") or None,
            "start_date": chk_date("전입일"),
            "end_date": chk_date("전출일"),
        })

    return {"nurses": nurses, "errors": errors}


_NURSE_DIFF_FIELDS = (
    "name", "group", "gender", "capable_shifts", "is_night_shift",
    "seniority", "juhu_day", "juhu_auto_rotate", "is_trainee",
    "training_end_date", "preceptor_id", "start_date", "end_date",
)


def _resolve_nurse_ids(parsed_nurses: list, existing_nurses: list):
    """파싱한 nurse의 id를 기존 DB와 매칭. id 우선, name+group fallback.
    매칭된 기존 ID 집합 반환."""
    by_id = {n["id"]: n for n in existing_nurses}
    by_name_grp = {(n.get("name", "").strip(), n.get("group", "").strip()): n
                   for n in existing_nurses}

    matched_ids = set()
    for p in parsed_nurses:
        match = None
        if p["id"] in by_id:
            match = by_id[p["id"]]
        else:
            key = (p.get("name", "").strip(), p.get("group", "").strip())
            if key[0] and key in by_name_grp:
                match = by_name_grp[key]
        if match:
            p["id"] = match["id"]
            matched_ids.add(match["id"])
    return matched_ids


def _build_diff(parsed_nurses: list, existing_nurses: list, matched_ids: set,
                replace_all: bool) -> dict:
    by_id = {n["id"]: n for n in existing_nurses}

    will_add = []
    will_update = []
    unchanged = 0

    for p in parsed_nurses:
        old = by_id.get(p["id"])
        if old is None:
            will_add.append({
                "id": p["id"], "name": p["name"], "group": p.get("group", ""),
            })
            continue

        diff_fields = []
        for key in _NURSE_DIFF_FIELDS:
            old_v = old.get(key)
            new_v = p.get(key)
            if isinstance(old_v, list):
                old_v = sorted(old_v or [])
            if isinstance(new_v, list):
                new_v = sorted(new_v or [])
            if old_v != new_v:
                diff_fields.append({
                    "field": key, "old": old.get(key), "new": p.get(key),
                })
        if diff_fields:
            will_update.append({
                "id": p["id"], "name": p["name"],
                "group": p.get("group", ""), "fields": diff_fields,
            })
        else:
            unchanged += 1

    will_delete = []
    if replace_all:
        for n in existing_nurses:
            if n["id"] not in matched_ids:
                will_delete.append({
                    "id": n["id"], "name": n["name"],
                    "group": n.get("group", ""),
                })

    return {
        "will_add": will_add,
        "will_update": will_update,
        "will_delete": will_delete,
        "unchanged_count": unchanged,
    }


@app.post("/api/nurses/import/preview")
def nurse_import_preview(body: dict):
    """업로드 전 미리보기: 어떤 행이 추가/수정/삭제될지 계산만 하고 DB는 건드리지 않음."""
    csv_text = _decode_csv_input(body)
    replace_all = bool(body.get("replace_all", False))

    parsed = _parse_nurses_csv(csv_text)
    existing = db.get_nurses()
    matched_ids = _resolve_nurse_ids(parsed["nurses"], existing)
    diff = _build_diff(parsed["nurses"], existing, matched_ids, replace_all)

    return {
        "ok": True,
        "errors": parsed["errors"],
        "parsed_count": len(parsed["nurses"]),
        "replace_all": replace_all,
        **diff,
    }


@app.post("/api/nurses/import")
def nurse_import(body: dict):
    """
    CSV 파싱 + 매칭 + 저장.
    body: {"csv": "<text>"} 또는 {"csv_b64": "<base64>"} + "replace_all"(bool)
    """
    csv_text = _decode_csv_input(body)
    replace_all = bool(body.get("replace_all", False))

    parsed = _parse_nurses_csv(csv_text)
    nurses_to_save = parsed["nurses"]
    errors = parsed["errors"]

    if not nurses_to_save:
        raise HTTPException(
            400,
            f"유효한 행이 없습니다. 오류 {len(errors)}건: "
            + "; ".join(e["message"] for e in errors[:5]),
        )

    existing = db.get_nurses()
    matched_ids = _resolve_nurse_ids(nurses_to_save, existing)

    try:
        if replace_all:
            for n in existing:
                if n["id"] not in matched_ids:
                    db.delete_nurse(n["id"])
        for nurse in nurses_to_save:
            db.upsert_nurse(nurse)
    except Exception as e:
        raise HTTPException(500, f"DB 저장 실패: {e}")

    return {
        "ok": True,
        "imported": len(nurses_to_save),
        "errors": errors,
        "replaced": replace_all,
    }


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
    if solver_progress.is_active():
        solver_progress.request_cancel()
        return {"ok": True, "message": "중지 신호를 전송했습니다."}
    return {"ok": False, "message": "진행 중인 생성이 없습니다."}


@app.get("/api/generate/stream")
def generate_stream():
    """SSE: 솔버 로그 + 진행 상황 실시간 스트리밍"""
    def event_gen():
        import time
        # 솔버가 아직 시작되지 않았을 수 있으므로 최대 30초 대기
        waited = 0
        while not solver_progress.is_active() and _log_queue.empty() and waited < 30:
            if solver_progress.is_running():
                # generate()가 호출됨 → 솔버 시작 대기
                time.sleep(0.2)
                waited += 0.2
            else:
                # generate() 자체가 아직 호출 안 됨 → 짧게 대기
                time.sleep(0.5)
                waited += 0.5
        while True:
            # 로그 메시지 우선 드레인
            try:
                item = _log_queue.get(timeout=0.05)
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                continue
            except queue.Empty:
                pass
            # 솔버 종료 + 큐 비어있으면 done
            if not solver_progress.is_active() and _log_queue.empty() and not solver_progress.is_running():
                yield "data: {\"type\":\"done\"}\n\n"
                break
            # 1초 heartbeat — 현재 progress 전송
            prog = solver_progress.get_progress()
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
    return solver_progress.get_progress()


@app.post("/api/generate")
def generate(request: GenerateRequest):
    global _last_mip_gap, _last_generate_result
    # 이전 솔버가 아직 돌고 있으면 거부
    if solver_progress.is_running():
        raise HTTPException(status_code=409, detail="이미 생성이 진행 중입니다. 중지 후 다시 시도하세요.")
    _last_mip_gap = None
    solver_progress.begin()
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
        if request.solver == "cpsat":
            from .scheduler_cpsat import CpSatScheduler
            scheduler = CpSatScheduler(request)
        else:
            scheduler = NurseScheduler(request)
        result = scheduler.solve()

        # MIP gap 및 중지 여부 추가
        if _last_mip_gap is not None:
            import math
            if math.isfinite(_last_mip_gap):
                result["mip_gap_percent"] = round(_last_mip_gap * 100, 2)
        if solver_progress.is_cancelled() and result.get("success"):
            result["stopped"] = True

        if warning and not result.get("success"):
            result["message"] = warning + "\n\n" + result.get("message", "")
        elif warning:
            result["warning"] = warning

        _last_generate_result = result  # 결과 보관
        solver_progress.end()
        return result
    except Exception as e:
        solver_progress.end()
        _last_generate_result = {"success": False, "message": str(e), "schedule": {}}
        logger.error("Server error: %s\n%s", e, traceback.format_exc())
        raise HTTPException(status_code=500, detail="서버 오류가 발생했습니다. 다시 시도해주세요.")


@app.get("/api/generate/result")
def get_generate_result():
    """마지막 생성 결과 조회 (새로고침 복구용)"""
    if solver_progress.is_running():
        return {"status": "running"}
    if _last_generate_result is not None:
        return {"status": "done", "result": _last_generate_result}
    return {"status": "idle"}


@app.post("/api/diagnose")
def diagnose(request: GenerateRequest):
    """CP-SAT assumptions 기반 정밀 충돌 분석.
    어느 엔진으로 생성하다 infeasible이 나든 '어느 제약이 동시 충족 불가인지' 짚는다."""
    from .conflict_analyzer import analyze_conflicts
    if not request.shifts:
        from .models import ShiftDef
        request.shifts = [ShiftDef(**s) for s in db.list_shifts()]
    if not request.scoring_rules:
        request.scoring_rules = [ScoringRule(**r) for r in db.list_scoring_rules()]
    try:
        return analyze_conflicts(request)
    except Exception as e:
        logger.error("diagnose error: %s\n%s", e, traceback.format_exc())
        return {"conflicts": [], "message": f"충돌 분석 중 오류: {e}"}


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
    # 저장 전 정규화: 삭제된 간호사(유령) 엔트리 제거
    data = body.get("data") or {}
    valid_ids = set(n["id"] for n in db.get_nurses())
    for key in ("schedule", "prev_month_nights", "locked_cells", "cell_notes"):
        sub = data.get(key)
        if isinstance(sub, dict):
            data[key] = {k: v for k, v in sub.items() if k in valid_ids}
    pid = db.save_prev_schedule(
        year=body["year"],
        month=body["month"],
        data=data,
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
