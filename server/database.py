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
                "sat": {"D": 3, "E": 3, "N": 2},
                "sun": {"D": 3, "E": 4, "N": 3},
            }
            conn.execute("INSERT INTO requirements (id, data) VALUES (1, ?)", (json.dumps(default_req),))

        # 예시 간호사 삽입 (처음 실행 시 DB가 비어 있을 때만)
        existing_nurses = conn.execute("SELECT COUNT(*) FROM nurses").fetchone()[0]
        if existing_nurses == 0:
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


# ── 근무 시드 데이터 ─────────────────────────────────────────────────────────

def _seed_shifts(conn: sqlite3.Connection):
    """기본 근무 16종 삽입"""
    # auto_assign: 1=솔버 자동배정 가능, 0=사전입력 전용
    shifts = [
        # code   name            period    is_charge  hours              color_bg   color_text  sort  auto_assign
        ("DC", "Day Charge",    "day",     1, "06:00~14:00", "#bfdbfe", "#1d4ed8", 0,  1),
        ("D",  "Day",           "day",     0, "06:00~14:00", "#dbeafe", "#1d4ed8", 1,  1),
        ("D1", "Day1",          "day1",    0, "08:30~17:30", "#e0f2fe", "#0284c7", 2,  0),
        ("EC", "Evening Charge","evening", 1, "14:00~22:00", "#bbf7d0", "#15803d", 3,  1),
        ("E",  "Evening",       "evening", 0, "14:00~22:00", "#dcfce7", "#15803d", 4,  1),
        ("중", "중간번",         "middle",  0, "11:00~19:00", "#ccfbf1", "#0f766e", 5,  0),
        ("NC", "Night Charge",  "night",   1, "22:00~06:00", "#fde68a", "#92400e", 6,  1),
        ("N",  "Night",         "night",   0, "22:00~06:00", "#fef9c3", "#92400e", 7,  1),
        ("OF", "Off",           "rest",    0, "-",           "#f3f4f6", "#6b7280", 8,  1),
        ("주", "주휴",           "rest",    0, "-",           "#e0e7ff", "#4338ca", 9,  0),
        ("V",  "연차",           "leave",   0, "-",           "#fce7f3", "#be185d", 10, 1),
        ("생", "생리휴가",        "leave",   0, "-",           "#fdf2f8", "#be185d", 11, 1),
        ("특", "특별휴가",        "leave",   0, "-",           "#fdf4ff", "#7e22ce", 12, 0),
        ("공", "공적업무",        "leave",   0, "-",           "#ecfdf5", "#064e3b", 13, 0),
        ("법", "법정공휴일",      "leave",   0, "-",           "#fff7ed", "#c2410c", 14, 0),
        ("병", "병가",           "leave",   0, "-",           "#fef2f2", "#dc2626", 15, 0),
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
                 start_date, end_date)
            VALUES
                (:id, :name, :grp, :gender, :capable_shifts, :is_night_shift, :seniority, :wishes,
                 :juhu_day, :juhu_auto_rotate, :night_months,
                 :is_trainee, :training_end_date, :preceptor_id,
                 :start_date, :end_date)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, grp=excluded.grp, gender=excluded.gender,
                capable_shifts=excluded.capable_shifts, is_night_shift=excluded.is_night_shift,
                seniority=excluded.seniority, wishes=excluded.wishes,
                juhu_day=excluded.juhu_day, juhu_auto_rotate=excluded.juhu_auto_rotate,
                night_months=excluded.night_months,
                is_trainee=excluded.is_trainee, training_end_date=excluded.training_end_date,
                preceptor_id=excluded.preceptor_id,
                start_date=excluded.start_date, end_date=excluded.end_date
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
    return {
        "id": d["id"],
        "name": d["name"],
        "group": d["grp"],
        "gender": d["gender"],
        "capable_shifts": json.loads(d["capable_shifts"]),
        "is_night_shift": bool(d["is_night_shift"]),
        "seniority": d["seniority"],
        "wishes": json.loads(d["wishes"]),
        "juhu_day": d.get("juhu_day"),           # None or 0-6
        "juhu_auto_rotate": bool(d.get("juhu_auto_rotate", 1)),
        "night_months": json.loads(d.get("night_months", "{}") or "{}"),
        "is_trainee": d.get("is_trainee") in (1, "1", True),
        "training_end_date": d.get("training_end_date"),
        "preceptor_id": d.get("preceptor_id"),
        "start_date": d.get("start_date"),
        "end_date": d.get("end_date"),
    }
