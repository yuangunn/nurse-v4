import sqlite3
import json
import os
from pathlib import Path
from typing import List, Optional, Dict, Any


def get_db_path() -> str:
    """DB 파일 경로 반환 (EXE 번들 또는 개발 환경 모두 대응)"""
    app_data = os.environ.get("APPDATA", "")
    if app_data:
        db_dir = Path(app_data) / "NurseScheduler"
    else:
        db_dir = Path(__file__).parent.parent / "data"
    db_dir.mkdir(parents=True, exist_ok=True)
    return str(db_dir / "nurse_scheduler.db")


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """테이블 초기화"""
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS nurses (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                grp TEXT DEFAULT '',
                gender TEXT DEFAULT 'female',
                capable_shifts TEXT DEFAULT '[]',
                is_night_shift INTEGER DEFAULT 0,
                seniority INTEGER DEFAULT 0,
                wishes TEXT DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS rules (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS requirements (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                data TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                year INTEGER NOT NULL,
                month INTEGER NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS prev_schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                year INTEGER NOT NULL,
                month INTEGER NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS shifts (
                code        TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                period      TEXT NOT NULL,
                is_charge   INTEGER DEFAULT 0,
                hours       TEXT DEFAULT '',
                color_bg    TEXT DEFAULT '#f3f4f6',
                color_text  TEXT DEFAULT '#374151',
                sort_order  INTEGER DEFAULT 0,
                auto_assign INTEGER DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS scoring_rules (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                rule_type  TEXT NOT NULL,
                params     TEXT NOT NULL DEFAULT '{}',
                score      INTEGER NOT NULL DEFAULT 0,
                enabled    INTEGER DEFAULT 1,
                sort_order INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS generation_runs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                year            INTEGER,
                month           INTEGER,
                solver          TEXT,
                success         INTEGER,
                stopped         INTEGER,
                relaxed         INTEGER,
                duration_s      REAL,
                final_gap       REAL,
                num_vars        INTEGER,
                num_constraints INTEGER,
                nurse_count     INTEGER,
                pre_filled      INTEGER,
                time_limit      INTEGER,
                mip_gap         REAL,
                created_at      TEXT DEFAULT (datetime('now','localtime'))
            );
        """)
        # 기존 DB 호환: juhu 컬럼 마이그레이션
        try:
            conn.execute("ALTER TABLE nurses ADD COLUMN juhu_day INTEGER DEFAULT NULL")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE nurses ADD COLUMN juhu_auto_rotate INTEGER DEFAULT 1")
        except Exception:
            pass
        # 기존 DB 호환: night_months 컬럼 마이그레이션
        try:
            conn.execute("ALTER TABLE nurses ADD COLUMN night_months TEXT DEFAULT '{}'")
        except Exception:
            pass
        # 기존 DB 호환: trainee 컬럼 마이그레이션
        for col, default in [("is_trainee", "0"), ("training_end_date", "NULL"), ("preceptor_id", "NULL")]:
            try:
                conn.execute(f"ALTER TABLE nurses ADD COLUMN {col} TEXT DEFAULT {default}")
            except Exception:
                pass
        # 기존 DB 호환: 전입/전출일 컬럼 마이그레이션
        for col in ("start_date", "end_date"):
            try:
                conn.execute(f"ALTER TABLE nurses ADD COLUMN {col} TEXT DEFAULT NULL")
            except Exception:
                pass
        # 기존 DB 호환: 임산부(모성보호) 컬럼 마이그레이션
        try:
            conn.execute("ALTER TABLE nurses ADD COLUMN is_pregnant INTEGER DEFAULT 0")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE nurses ADD COLUMN pregnancy TEXT DEFAULT '{}'")
        except Exception:
            pass
        # 기존 DB 호환: shifts.auto_assign 컬럼 마이그레이션
        try:
            conn.execute("ALTER TABLE shifts ADD COLUMN auto_assign INTEGER DEFAULT 1")
        except Exception:
            pass
        # 사전입력 전용 근무 코드의 auto_assign=0 보장 (기존 시드 데이터 포함)
        pre_input_only = ("D1", "중", "주", "특", "공", "법", "병")
        conn.execute(
            f"UPDATE shifts SET auto_assign=0 WHERE code IN ({','.join('?'*len(pre_input_only))})",
            pre_input_only
        )

        # 기본 요구사항 삽입 (D/E/N 통합 방식)
        existing = conn.execute("SELECT id FROM requirements WHERE id=1").fetchone()
        if not existing:
            default_req = {
                "mon": {"D": 4, "E": 5, "N": 3},
                "tue": {"D": 5, "E": 5, "N": 3},
                "wed": {"D": 5, "E": 5, "N": 3},
                "thu": {"D": 5, "E": 5, "N": 3},
                "fri": {"D": 5, "E": 4, "N": 3},
                "sat": {"D": 4, "E": 3, "N": 2},  # 제1원칙 4 (2026-08-20): 토 최소 4/3/2
                "sun": {"D": 3, "E": 4, "N": 3},
            }
            conn.execute("INSERT INTO requirements (id, data) VALUES (1, ?)", (json.dumps(default_req),))

        # 예시 간호사 삽입 (처음 실행 시 DB가 비어 있을 때만)
        # 단, 저장된 근무표/사전입력이 있으면 '사용하던 DB에서 간호사만 전부
        # 삭제된 상태'이므로 재시드하지 않는다 — 재시드하면 예시 ID(a0~c5)가
        # valid 집합이 되어 cleanup_orphan_nurse_refs()가 저장본의 실데이터
        # 키를 전부 유령으로 오인해 영구 삭제한다.
        existing_nurses = conn.execute("SELECT COUNT(*) FROM nurses").fetchone()[0]
        if existing_nurses == 0:
            saved_rows = conn.execute(
                "SELECT (SELECT COUNT(*) FROM schedules) + (SELECT COUNT(*) FROM prev_schedules)"
            ).fetchone()[0]
            if saved_rows == 0:
                _seed_nurses(conn)

        # 기본 근무 시드 (shifts 테이블이 비어 있을 때만)
        existing_shifts = conn.execute("SELECT COUNT(*) FROM shifts").fetchone()[0]
        if existing_shifts == 0:
            _seed_shifts(conn)

        # 기본 배점 규칙 시드 (scoring_rules 테이블이 비어 있을 때만)
        existing_scoring = conn.execute("SELECT COUNT(*) FROM scoring_rules").fetchone()[0]
        if existing_scoring == 0:
            _seed_scoring_rules(conn)

        # 퐁당퐁당 회피 규칙 마이그레이션 (기존 DB에 없을 경우 추가)
        has_pondang = conn.execute(
            "SELECT COUNT(*) FROM scoring_rules WHERE rule_type='pattern' AND name LIKE '%퐁당%'"
        ).fetchone()[0]
        if not has_pondang:
            conn.execute(
                "INSERT INTO scoring_rules (name, rule_type, params, score, enabled, sort_order) VALUES (?,?,?,?,?,?)",
                ("퐁당퐁당 회피", "pattern", json.dumps({"pattern": ["work", "rest_leave", "work"]}), -20, 1, 12)
            )

        # 법정공휴일 + 주말 배점 규칙 마이그레이션
        _migrate_holiday_weekend_rules(conn)

        # 임부휴무(P1) 근무 코드 마이그레이션 (기존 DB에 없을 경우 추가)
        conn.execute(
            "INSERT OR IGNORE INTO shifts "
            "(code, name, period, is_charge, hours, color_bg, color_text, sort_order, auto_assign) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            ("P1", "임부휴무", "rest", 0, "-", "#E3F4F4", "#2C7A7B", 16, 1),
        )


# ── 근무 시드 데이터 ─────────────────────────────────────────────────────────

def _seed_shifts(conn: sqlite3.Connection):
    """기본 근무 16종 삽입"""
    # auto_assign: 1=솔버 자동배정 가능, 0=사전입력 전용
    # YGinvest 팔레트: D=블루, E=레드, N=바이올렛, V=그린, 휴무=그레이
    shifts = [
        # code   name            period    is_charge  hours              color_bg   color_text  sort  auto_assign
        ("DC", "Day Charge",    "day",     1, "06:00~14:00", "#E2ECFD", "#1B4FC3", 0,  1),
        ("D",  "Day",           "day",     0, "06:00~14:00", "#EEF3FE", "#1B4FC3", 1,  1),
        ("D1", "Day1",          "day1",    0, "08:30~17:30", "#F0F6FF", "#2563EB", 2,  0),
        ("EC", "Evening Charge","evening", 1, "14:00~22:00", "#FCE3E5", "#C7384A", 3,  1),
        ("E",  "Evening",       "evening", 0, "14:00~22:00", "#FEEFEF", "#C7384A", 4,  1),
        ("중", "중간번",         "middle",  0, "11:00~19:00", "#FBF3E2", "#B7791F", 5,  0),
        ("NC", "Night Charge",  "night",   1, "22:00~06:00", "#E7E0F8", "#5B3FB0", 6,  1),
        ("N",  "Night",         "night",   0, "22:00~06:00", "#EFEBFB", "#5B3FB0", 7,  1),
        ("OF", "Off",           "rest",    0, "-",           "#F2F3F5", "#8A93A1", 8,  1),
        ("주", "주휴",           "rest",    0, "-",           "#EDEFF3", "#4A5160", 9,  0),
        ("P1", "임부휴무",        "rest",    0, "-",           "#E3F4F4", "#2C7A7B", 16, 1),
        ("V",  "연차",           "leave",   0, "-",           "#ECF7F0", "#1F8A5B", 10, 1),
        ("생", "생리휴가",        "leave",   0, "-",           "#FCEAF1", "#B83280", 11, 1),
        ("특", "특별휴가",        "leave",   0, "-",           "#F1ECFB", "#6D4AC0", 12, 0),
        ("공", "공적업무",        "leave",   0, "-",           "#E8F5EE", "#1F8A5B", 13, 0),
        ("법", "법정공휴일",      "leave",   0, "-",           "#FDEEE5", "#C2410C", 14, 0),
        ("병", "병가",           "leave",   0, "-",           "#FEEAEA", "#C7384A", 15, 0),
    ]
    conn.executemany(
        "INSERT OR IGNORE INTO shifts "
        "(code, name, period, is_charge, hours, color_bg, color_text, sort_order, auto_assign) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        shifts,
    )


# ── 예시 간호사 시드 데이터 ──────────────────────────────────────────────────

def _seed_nurses(conn: sqlite3.Connection):
    """
    앱 최초 실행 시 예시 간호사 18명 삽입 (이름 앞 * = 임시 데이터).
    그룹 A/B/C 각 6명, 그룹당 여4 + 남2.
    """
    ALL = json.dumps(["DC", "D", "D1", "EC", "E", "중", "NC", "N"])
    seed = [
        # id         name        grp  gender    capable_shifts  is_night  seniority
        ("a0", "*김지현", "A", "female", ALL, 0, 0),
        ("a1", "*이수진", "A", "female", ALL, 0, 1),
        ("a2", "*박민지", "A", "female", ALL, 0, 2),
        ("a3", "*정수아", "A", "female", ALL, 0, 3),
        ("a4", "*김준혁", "A", "male",   ALL, 0, 4),
        ("a5", "*이민준", "A", "male",   ALL, 0, 5),
        ("b0", "*최은혜", "B", "female", ALL, 0, 6),
        ("b1", "*강혜진", "B", "female", ALL, 0, 7),
        ("b2", "*조나연", "B", "female", ALL, 0, 8),
        ("b3", "*윤예진", "B", "female", ALL, 0, 9),
        ("b4", "*박정호", "B", "male",   ALL, 0, 10),
        ("b5", "*최현우", "B", "male",   ALL, 0, 11),
        ("c0", "*장소연", "C", "female", ALL, 0, 12),
        ("c1", "*임유진", "C", "female", ALL, 0, 13),
        ("c2", "*한지원", "C", "female", ALL, 0, 14),
        ("c3", "*신하은", "C", "female", ALL, 0, 15),
        ("c4", "*정성민", "C", "male",   ALL, 0, 16),
        ("c5", "*강동현", "C", "male",   ALL, 0, 17),
    ]
    conn.executemany(
        "INSERT OR IGNORE INTO nurses "
        "(id, name, grp, gender, capable_shifts, is_night_shift, seniority, wishes) "
        "VALUES (?,?,?,?,?,?,?,'{}')",
        seed,
    )


# ── Nurse CRUD ──────────────────────────────────────────────────────────────

def get_nurses() -> List[Dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM nurses ORDER BY seniority").fetchall()
        return [_nurse_row_to_dict(r) for r in rows]


def upsert_nurse(nurse: Dict) -> None:
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO nurses
                (id, name, grp, gender, capable_shifts, is_night_shift, seniority, wishes,
                 juhu_day, juhu_auto_rotate, night_months,
                 is_trainee, training_end_date, preceptor_id,
                 start_date, end_date, is_pregnant, pregnancy)
            VALUES
                (:id, :name, :grp, :gender, :capable_shifts, :is_night_shift, :seniority, :wishes,
                 :juhu_day, :juhu_auto_rotate, :night_months,
                 :is_trainee, :training_end_date, :preceptor_id,
                 :start_date, :end_date, :is_pregnant, :pregnancy)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, grp=excluded.grp, gender=excluded.gender,
                capable_shifts=excluded.capable_shifts, is_night_shift=excluded.is_night_shift,
                seniority=excluded.seniority, wishes=excluded.wishes,
                juhu_day=excluded.juhu_day, juhu_auto_rotate=excluded.juhu_auto_rotate,
                night_months=excluded.night_months,
                is_trainee=excluded.is_trainee, training_end_date=excluded.training_end_date,
                preceptor_id=excluded.preceptor_id,
                start_date=excluded.start_date, end_date=excluded.end_date,
                is_pregnant=excluded.is_pregnant, pregnancy=excluded.pregnancy
        """, {
            "id": nurse["id"],
            "name": nurse["name"],
            "grp": nurse.get("group", ""),
            "gender": nurse.get("gender", "female"),
            "capable_shifts": json.dumps(nurse.get("capable_shifts", [])),
            "is_night_shift": 1 if nurse.get("is_night_shift") else 0,
            "seniority": nurse.get("seniority", 0),
            "wishes": json.dumps(nurse.get("wishes", {})),
            "juhu_day": nurse.get("juhu_day"),
            "juhu_auto_rotate": 1 if nurse.get("juhu_auto_rotate", True) else 0,
            "night_months": json.dumps(nurse.get("night_months", {})),
            "is_trainee": 1 if nurse.get("is_trainee") else 0,
            "training_end_date": nurse.get("training_end_date"),
            "preceptor_id": nurse.get("preceptor_id"),
            "start_date": nurse.get("start_date"),
            "end_date": nurse.get("end_date"),
            "is_pregnant": 1 if nurse.get("is_pregnant") else 0,
            "pregnancy": json.dumps(nurse.get("pregnancy", {})),
        })


def delete_nurse(nurse_id: str) -> None:
    """간호사 삭제 + 저장된 prev_schedules / schedules JSON에서 해당 간호사 엔트리 캐스케이드 정리."""
    NURSE_KEYED_KEYS = (
        "schedule", "extended_schedule", "prev_schedule",
        "nurse_scores", "nurse_score_details", "prev_month_nights",
        "locked_cells", "cell_notes",
    )
    with get_conn() as conn:
        conn.execute("DELETE FROM nurses WHERE id=?", (nurse_id,))
        # prev_schedules, schedules 양쪽에서 캐스케이드 정리
        for table in ("prev_schedules", "schedules"):
            for row in conn.execute(f"SELECT id, data FROM {table}").fetchall():
                try:
                    data = json.loads(row["data"])
                except (json.JSONDecodeError, TypeError):
                    continue
                changed = False
                for key in NURSE_KEYED_KEYS:
                    sub = data.get(key)
                    if isinstance(sub, dict) and nurse_id in sub:
                        del sub[nurse_id]
                        changed = True
                if changed:
                    conn.execute(f"UPDATE {table} SET data=? WHERE id=?",
                                 (json.dumps(data, ensure_ascii=False), row["id"]))


def cleanup_orphan_nurse_refs() -> int:
    """모든 저장본 스캔하여 현재 nurses 테이블에 없는 간호사 ID 엔트리 제거.
    시작 시 한 번 호출하여 기존 유령 정리. 반환: 제거된 엔트리 수."""
    NURSE_KEYED_KEYS = (
        "schedule", "extended_schedule", "prev_schedule",
        "nurse_scores", "nurse_score_details", "prev_month_nights",
        "locked_cells", "cell_notes",
    )
    removed = 0
    with get_conn() as conn:
        valid = set(r["id"] for r in conn.execute("SELECT id FROM nurses").fetchall())
        for table in ("prev_schedules", "schedules"):
            for row in conn.execute(f"SELECT id, data FROM {table}").fetchall():
                try:
                    data = json.loads(row["data"])
                except (json.JSONDecodeError, TypeError):
                    continue
                changed = False
                for key in NURSE_KEYED_KEYS:
                    sub = data.get(key)
                    if isinstance(sub, dict):
                        orphans = [k for k in sub if k not in valid]
                        for k in orphans:
                            del sub[k]
                            removed += 1
                        if orphans:
                            changed = True
                if changed:
                    conn.execute(f"UPDATE {table} SET data=? WHERE id=?",
                                 (json.dumps(data, ensure_ascii=False), row["id"]))
    return removed


# 위시 판정용 표준 코드 집합 (저장본 기반 파생 계산 — 솔버 클래스와 독립)
WISH_REST_LIKE = {"OF", "주", "P1"}
WISH_LEAVE_LIKE = {"V", "생", "특", "공", "법", "병"}
_WORK_CODES = {"DC", "D", "D1", "EC", "E", "중", "NC", "N"}
_NIGHT_CODES = {"N", "NC"}


def _latest_saved(conn, year: int, month: int):
    """해당 월의 최신 저장 근무표 data(JSON dict) — 없으면 None."""
    row = conn.execute(
        "SELECT data FROM schedules WHERE year=? AND month=? "
        "ORDER BY id DESC LIMIT 1", (year, month)).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["data"])
    except (json.JSONDecodeError, TypeError):
        return None


def compute_prev_month_nights(year: int, month: int) -> Dict[str, int]:
    """직전 달 최신 저장 근무표에서 간호사별 야간(N/NC) 횟수 — '전월N' 자동 인수인계.
    수동으로 옮겨 적다 빼먹으면 월초 연속야간 검증이 빠지는 문제를 막는다."""
    py, pm = (year - 1, 12) if month == 1 else (year, month - 1)
    prefix = f"{py:04d}-{pm:02d}-"
    out: Dict[str, int] = {}
    with get_conn() as conn:
        data = _latest_saved(conn, py, pm)
    if not data:
        return out
    for nid, days in (data.get("schedule") or {}).items():
        c = sum(1 for dk, s in (days or {}).items()
                if dk.startswith(prefix) and s in _NIGHT_CODES)
        if c:
            out[nid] = c
    return out


def compute_fairness_ledger(year: int, month: int, months_back: int = 3) -> Dict:
    """공정성 원장 — 직전 months_back개월 저장본에서 간호사별 누적 부담 집계.
    Returns {nid: {"nights": n, "weekends": n, "holiday_work": n, "months": k}}"""
    import datetime as _dt
    targets = []
    y, m = year, month
    for _ in range(months_back):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        targets.append((y, m))
    ledger: Dict = {}
    with get_conn() as conn:
        for ty, tm in targets:
            data = _latest_saved(conn, ty, tm)
            if not data:
                continue
            prefix = f"{ty:04d}-{tm:02d}-"
            holidays = {h for h in (data.get("holidays") or []) if str(h).startswith(prefix)}
            for nid, days in (data.get("schedule") or {}).items():
                touched = False
                ent = ledger.setdefault(
                    nid, {"nights": 0, "weekends": 0, "holiday_work": 0, "months": 0})
                for dk, s in (days or {}).items():
                    if not dk.startswith(prefix) or s not in _WORK_CODES:
                        continue
                    touched = True
                    if s in _NIGHT_CODES:
                        ent["nights"] += 1
                    try:
                        if _dt.date.fromisoformat(dk).weekday() >= 5:
                            ent["weekends"] += 1
                    except ValueError:
                        pass
                    if dk in holidays:
                        ent["holiday_work"] += 1
                if touched:
                    ent["months"] += 1
    return ledger


def compute_wish_ledger(year: int, month: int, months_back: int = 3) -> Dict:
    """직전 months_back개월의 '최신 저장 근무표'에서 간호사별 위시 신청/반영 집계.
    별도 기록 테이블 없이 저장본(저장 시점의 nurses[].wishes + schedule)만으로
    계산하는 파생 뷰 — 같은 달을 여러 번 저장해도 최신본 1개만 본다.
    Returns: {nurse_id: {"requested": n, "granted": m}}"""
    targets = []
    y, m = year, month
    for _ in range(months_back):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        targets.append((y, m))
    ledger: Dict = {}
    with get_conn() as conn:
        for ty, tm in targets:
            row = conn.execute(
                "SELECT data FROM schedules WHERE year=? AND month=? "
                "ORDER BY id DESC LIMIT 1", (ty, tm)).fetchone()
            if not row:
                continue
            try:
                data = json.loads(row["data"])
            except (json.JSONDecodeError, TypeError):
                continue
            sched = data.get("schedule") or {}
            for n in data.get("nurses") or []:
                nid = n.get("id")
                wishes = n.get("wishes") or {}
                if not nid or not wishes:
                    continue
                ns = sched.get(nid) or {}
                ent = ledger.setdefault(nid, {"requested": 0, "granted": 0})
                for day_str, wish in wishes.items():
                    ds = str(day_str)
                    if "-" in ds:
                        dk = ds
                        if not dk.startswith(f"{ty:04d}-{tm:02d}-"):
                            continue  # 다른 달 키는 그 달 집계에서 제외
                    else:
                        try:
                            dk = f"{ty:04d}-{tm:02d}-{int(ds):02d}"
                        except (ValueError, TypeError):
                            continue
                    s = ns.get(dk, "")
                    if not s:
                        continue
                    ent["requested"] += 1
                    if wish == "OFF":
                        ok = s in WISH_REST_LIKE or s in WISH_LEAVE_LIKE
                    else:
                        ok = (s == wish)
                    if ok:
                        ent["granted"] += 1
    return ledger


def insert_generation_run(d: Dict):
    """생성 이력 1건 기록. (비교 노트, 최근 5건) 반환 — 노트는 유사 규모의 직전
    성공 이력 대비 3배 이상 느려졌을 때만 생성된다."""
    note = None
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT duration_s, pre_filled FROM generation_runs "
            "WHERE success=1 AND nurse_count BETWEEN ? AND ? "
            "ORDER BY id DESC LIMIT 5",
            (int(d.get("nurse_count") or 0) - 2, int(d.get("nurse_count") or 0) + 2),
        ).fetchall()
        if d.get("success") and len(rows) >= 2 and d.get("duration_s"):
            durs = sorted(float(r["duration_s"] or 0) for r in rows)
            med = durs[len(durs) // 2]
            if med > 0 and float(d["duration_s"]) > 3 * med:
                note = (f"유사 규모의 직전 생성(중앙값 {med:.0f}초) 대비 "
                        f"{float(d['duration_s'])/med:.1f}배 느렸습니다 — 사전입력 "
                        f"{rows[0]['pre_filled']}건 → {d.get('pre_filled')}건 변화가 "
                        f"원인일 수 있습니다.")
        conn.execute(
            "INSERT INTO generation_runs (year, month, solver, success, stopped, "
            "relaxed, duration_s, final_gap, num_vars, num_constraints, "
            "nurse_count, pre_filled, time_limit, mip_gap) "
            "VALUES (:year,:month,:solver,:success,:stopped,:relaxed,:duration_s,"
            ":final_gap,:num_vars,:num_constraints,:nurse_count,:pre_filled,"
            ":time_limit,:mip_gap)",
            {k: d.get(k) for k in (
                "year", "month", "solver", "success", "stopped", "relaxed",
                "duration_s", "final_gap", "num_vars", "num_constraints",
                "nurse_count", "pre_filled", "time_limit", "mip_gap")},
        )
        recent = [dict(r) for r in conn.execute(
            "SELECT created_at, solver, success, stopped, relaxed, duration_s, "
            "final_gap, pre_filled FROM generation_runs "
            "ORDER BY id DESC LIMIT 5").fetchall()]
    return note, recent


def list_generation_runs(limit: int = 20) -> List[Dict]:
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM generation_runs ORDER BY id DESC LIMIT ?",
            (int(limit),)).fetchall()]


def reorder_nurses(ordered_ids: List[str]) -> None:
    with get_conn() as conn:
        for i, nid in enumerate(ordered_ids):
            conn.execute("UPDATE nurses SET seniority=? WHERE id=?", (i, nid))


# ── Rules CRUD ──────────────────────────────────────────────────────────────

def get_rules() -> Dict:
    with get_conn() as conn:
        rows = conn.execute("SELECT key, value FROM rules").fetchall()
        result = {}
        for row in rows:
            try:
                result[row["key"]] = json.loads(row["value"])
            except Exception:
                result[row["key"]] = row["value"]
        return result


def save_rules(rules: Dict) -> None:
    with get_conn() as conn:
        for k, v in rules.items():
            conn.execute(
                "INSERT INTO rules (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, json.dumps(v))
            )


# ── Requirements CRUD ───────────────────────────────────────────────────────

def get_requirements() -> Dict:
    with get_conn() as conn:
        row = conn.execute("SELECT data FROM requirements WHERE id=1").fetchone()
        if row:
            return json.loads(row["data"])
        return {}


def save_requirements(data: Dict) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO requirements (id, data) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            (json.dumps(data),)
        )


# ── Schedule CRUD ────────────────────────────────────────────────────────────

def list_schedules() -> List[Dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, year, month, created_at FROM schedules ORDER BY created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def save_schedule(year: int, month: int, data: Dict, name: Optional[str] = None) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO schedules (name, year, month, data) VALUES (?,?,?,?)",
            (name, year, month, json.dumps(data))
        )
        return cur.lastrowid


def load_schedule(schedule_id: int) -> Optional[Dict]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM schedules WHERE id=?", (schedule_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["data"] = json.loads(result["data"])
        return result


def delete_schedule(schedule_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM schedules WHERE id=?", (schedule_id,))


# ── PrevSchedule CRUD ────────────────────────────────────────────────────────

def list_prev_schedules() -> List[Dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, year, month, created_at FROM prev_schedules ORDER BY created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def save_prev_schedule(year: int, month: int, data: Dict, name: Optional[str] = None) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO prev_schedules (name, year, month, data) VALUES (?,?,?,?)",
            (name, year, month, json.dumps(data))
        )
        return cur.lastrowid


def load_prev_schedule(prev_id: int) -> Optional[Dict]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM prev_schedules WHERE id=?", (prev_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["data"] = json.loads(result["data"])
        return result


def delete_prev_schedule(prev_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM prev_schedules WHERE id=?", (prev_id,))


# ── Shift CRUD ───────────────────────────────────────────────────────────────

def list_shifts() -> List[Dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM shifts ORDER BY sort_order, code").fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["auto_assign"] = bool(d.get("auto_assign", 1))
            result.append(d)
        return result


def save_shift(code: str, name: str, period: str, is_charge: bool,
               hours: str, color_bg: str, color_text: str, sort_order: int,
               auto_assign: bool = True) -> None:
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO shifts (code, name, period, is_charge, hours, color_bg, color_text, sort_order, auto_assign)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(code) DO UPDATE SET
                name=excluded.name, period=excluded.period, is_charge=excluded.is_charge,
                hours=excluded.hours, color_bg=excluded.color_bg, color_text=excluded.color_text,
                sort_order=excluded.sort_order, auto_assign=excluded.auto_assign
        """, (code, name, period, 1 if is_charge else 0, hours, color_bg, color_text, sort_order,
              1 if auto_assign else 0))


def delete_shift(code: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM shifts WHERE code=?", (code,))


# ── Scoring Rules 시드 ────────────────────────────────────────────────────────

def _seed_scoring_rules(conn: sqlite3.Connection):
    """기본 배점 규칙 12종 삽입 (기존 하드코딩 W_* 상수와 동일)"""
    rules = [
        # name, rule_type, params, score, enabled, sort_order
        ("D→N 전환 페널티",       "transition",       json.dumps({"from": "day",     "to": "night"}),                    -30,  1, 0),
        ("N→공 전환 페널티",       "transition",       json.dumps({"from": "night",   "to": "specific:공"}),              -40,  1, 1),
        ("V(연차) 사용 페널티",    "specific_shift",   json.dumps({"shift_code": "V", "condition": "all"}),              -500, 1, 2),
        ("생리휴가 보상",           "specific_shift",   json.dumps({"shift_code": "생","condition": "female_only"}),      +80,  1, 3),
        ("D→E 순방향 보상",        "transition",       json.dumps({"from": "day",     "to": "evening"}),                  +20, 1, 4),
        ("E→N 순방향 보상",        "transition",       json.dumps({"from": "evening", "to": "night"}),                    +20, 1, 5),
        ("연속 동일 낮 근무 보상",  "consecutive_same", json.dumps({"period": "day"}),                                     +15, 1, 6),
        ("연속 동일 저녁 근무 보상","consecutive_same", json.dumps({"period": "evening"}),                                 +15, 1, 7),
        ("연속 동일 야간 근무 보상","consecutive_same", json.dumps({"period": "night"}),                                   +15, 1, 8),
        ("연속 휴일 보상",          "consecutive_same", json.dumps({"period": "rest"}),                                    +30, 1, 9),
        ("희망 근무 반영 보상",     "wish",             json.dumps({}),                                                    +50, 1, 10),
        ("야간 근무 공평성",        "night_fairness",   json.dumps({}),                                                    -50, 1, 11),
        ("퐁당퐁당 회피",           "pattern",          json.dumps({"pattern": ["work", "rest_leave", "work"]}),           -20, 1, 12),
        ("법정공휴일 휴가 보상",     "specific_shift",   json.dumps({"shift_code": "법", "condition": "all"}),               +30, 1, 13),
        ("공휴일 근무 보상",         "holiday_work",     json.dumps({}),                                                     +20, 1, 14),
        ("주말 경감근무 보상",       "weekend_work",     json.dumps({"slots": [{"weekday": 5, "periods": ["evening", "night"]}, {"weekday": 6, "periods": ["day"]}]}), +20, 1, 15),
        ("공휴일 OFF 페널티",        "holiday_off",      json.dumps({}),                                                    -500, 1, 16),
    ]
    conn.executemany(
        "INSERT INTO scoring_rules (name, rule_type, params, score, enabled, sort_order) VALUES (?,?,?,?,?,?)",
        rules,
    )


def _migrate_holiday_weekend_rules(conn: sqlite3.Connection):
    """법정공휴일/주말 배점 규칙 3종 마이그레이션 (기존 DB에 없을 경우 추가)"""
    # 법정공휴일 휴가 보상
    has_holiday_leave = conn.execute(
        "SELECT COUNT(*) FROM scoring_rules WHERE name LIKE '%법정공휴일 휴가%'"
    ).fetchone()[0]
    if not has_holiday_leave:
        conn.execute(
            "INSERT INTO scoring_rules (name, rule_type, params, score, enabled, sort_order) VALUES (?,?,?,?,?,?)",
            ("법정공휴일 휴가 보상", "specific_shift", json.dumps({"shift_code": "법", "condition": "all"}), 30, 1, 13)
        )

    # 공휴일 근무 보상
    has_holiday_work = conn.execute(
        "SELECT COUNT(*) FROM scoring_rules WHERE rule_type='holiday_work'"
    ).fetchone()[0]
    if not has_holiday_work:
        conn.execute(
            "INSERT INTO scoring_rules (name, rule_type, params, score, enabled, sort_order) VALUES (?,?,?,?,?,?)",
            ("공휴일 근무 보상", "holiday_work", json.dumps({}), 20, 1, 14)
        )

    # 주말 경감근무 보상
    has_weekend_work = conn.execute(
        "SELECT COUNT(*) FROM scoring_rules WHERE rule_type='weekend_work'"
    ).fetchone()[0]
    if not has_weekend_work:
        conn.execute(
            "INSERT INTO scoring_rules (name, rule_type, params, score, enabled, sort_order) VALUES (?,?,?,?,?,?)",
            ("주말 경감근무 보상", "weekend_work",
             json.dumps({"slots": [{"weekday": 5, "periods": ["evening", "night"]}, {"weekday": 6, "periods": ["day"]}]}),
             20, 1, 15)
        )

    # 공휴일 OFF 페널티
    has_holiday_off = conn.execute(
        "SELECT COUNT(*) FROM scoring_rules WHERE rule_type='holiday_off'"
    ).fetchone()[0]
    if not has_holiday_off:
        conn.execute(
            "INSERT INTO scoring_rules (name, rule_type, params, score, enabled, sort_order) VALUES (?,?,?,?,?,?)",
            ("공휴일 OFF 페널티", "holiday_off", json.dumps({}), -500, 1, 16)
        )


# ── Scoring Rules CRUD ────────────────────────────────────────────────────────

def list_scoring_rules() -> List[Dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM scoring_rules ORDER BY sort_order, id"
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["params"] = json.loads(d["params"])
            d["enabled"] = bool(d["enabled"])
            result.append(d)
        return result


def save_scoring_rule(
    name: str, rule_type: str, params: dict, score: int,
    enabled: bool, sort_order: int, rule_id: Optional[int] = None
) -> int:
    with get_conn() as conn:
        if rule_id:
            conn.execute("""
                UPDATE scoring_rules
                SET name=?, rule_type=?, params=?, score=?, enabled=?, sort_order=?
                WHERE id=?
            """, (name, rule_type, json.dumps(params), score, 1 if enabled else 0, sort_order, rule_id))
            return rule_id
        else:
            cur = conn.execute("""
                INSERT INTO scoring_rules (name, rule_type, params, score, enabled, sort_order)
                VALUES (?,?,?,?,?,?)
            """, (name, rule_type, json.dumps(params), score, 1 if enabled else 0, sort_order))
            return cur.lastrowid


def delete_scoring_rule(rule_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM scoring_rules WHERE id=?", (rule_id,))


# ── 내부 헬퍼 ───────────────────────────────────────────────────────────────

def _nurse_row_to_dict(row: sqlite3.Row) -> Dict:
    d = dict(row)

    def _json(key, default):
        # 손상된 JSON 컬럼 하나가 간호사 목록 전체(=앱 전체)를 죽이지 않도록 방어
        try:
            return json.loads(d.get(key) or default)
        except (json.JSONDecodeError, TypeError):
            return json.loads(default)

    return {
        "id": d["id"],
        "name": d["name"],
        "group": d["grp"],
        "gender": d["gender"],
        "capable_shifts": _json("capable_shifts", "[]"),
        "is_night_shift": bool(d["is_night_shift"]),
        "seniority": d["seniority"],
        "wishes": _json("wishes", "{}"),
        "juhu_day": d.get("juhu_day"),           # None or 0-6
        "juhu_auto_rotate": bool(d.get("juhu_auto_rotate", 1)),
        "night_months": _json("night_months", "{}"),
        "is_trainee": d.get("is_trainee") in (1, "1", True),
        "training_end_date": d.get("training_end_date"),
        "preceptor_id": d.get("preceptor_id"),
        "start_date": d.get("start_date"),
        "end_date": d.get("end_date"),
        "is_pregnant": d.get("is_pregnant") in (1, "1", True),
        "pregnancy": _json("pregnancy", "{}"),
    }
