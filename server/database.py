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
                code       TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                period     TEXT NOT NULL,
                is_charge  INTEGER DEFAULT 0,
                hours      TEXT DEFAULT '',
                color_bg   TEXT DEFAULT '#f3f4f6',
                color_text TEXT DEFAULT '#374151',
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


# ── 근무 시드 데이터 ─────────────────────────────────────────────────────────

def _seed_shifts(conn: sqlite3.Connection):
    """기본 근무 16종 삽입"""
    shifts = [
        # code   name            period    is_charge  hours              color_bg   color_text  sort
        ("DC", "Day Charge",    "day",     1, "06:00~14:00", "#bfdbfe", "#1d4ed8", 0),
        ("D",  "Day",           "day",     0, "06:00~14:00", "#dbeafe", "#1d4ed8", 1),
        ("D1", "Day1",          "day1",    0, "08:30~17:30", "#e0f2fe", "#0284c7", 2),
        ("EC", "Evening Charge","evening", 1, "14:00~22:00", "#bbf7d0", "#15803d", 3),
        ("E",  "Evening",       "evening", 0, "14:00~22:00", "#dcfce7", "#15803d", 4),
        ("중", "중간번",         "middle",  0, "11:00~19:00", "#ccfbf1", "#0f766e", 5),
        ("NC", "Night Charge",  "night",   1, "22:00~06:00", "#fde68a", "#92400e", 6),
        ("N",  "Night",         "night",   0, "22:00~06:00", "#fef9c3", "#92400e", 7),
        ("OF", "Off",           "rest",    0, "-",           "#f3f4f6", "#6b7280", 8),
        ("주", "주휴",           "rest",    0, "-",           "#e0e7ff", "#4338ca", 9),
        ("V",  "연차",           "leave",   0, "-",           "#fce7f3", "#be185d", 10),
        ("생", "생리휴가",        "leave",   0, "-",           "#fdf2f8", "#be185d", 11),
        ("특", "특별휴가",        "leave",   0, "-",           "#fdf4ff", "#7e22ce", 12),
        ("공", "공적업무",        "leave",   0, "-",           "#ecfdf5", "#064e3b", 13),
        ("법", "법정공휴일",      "leave",   0, "-",           "#fff7ed", "#c2410c", 14),
        ("병", "병가",           "leave",   0, "-",           "#fef2f2", "#dc2626", 15),
    ]
    conn.executemany(
        "INSERT OR IGNORE INTO shifts "
        "(code, name, period, is_charge, hours, color_bg, color_text, sort_order) "
        "VALUES (?,?,?,?,?,?,?,?)",
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
                 juhu_day, juhu_auto_rotate)
            VALUES
                (:id, :name, :grp, :gender, :capable_shifts, :is_night_shift, :seniority, :wishes,
                 :juhu_day, :juhu_auto_rotate)
            ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, grp=excluded.grp, gender=excluded.gender,
                capable_shifts=excluded.capable_shifts, is_night_shift=excluded.is_night_shift,
                seniority=excluded.seniority, wishes=excluded.wishes,
                juhu_day=excluded.juhu_day, juhu_auto_rotate=excluded.juhu_auto_rotate
        """, {
            "id": nurse["id"],
            "name": nurse["name"],
            "grp": nurse.get("group", ""),
            "gender": nurse.get("gender", "female"),
            "capable_shifts": json.dumps(nurse.get("capable_shifts", [])),
            "is_night_shift": 1 if nurse.get("is_night_shift") else 0,
            "seniority": nurse.get("seniority", 0),
            "wishes": json.dumps(nurse.get("wishes", {})),
            "juhu_day": nurse.get("juhu_day"),  # None or 0-6
            "juhu_auto_rotate": 1 if nurse.get("juhu_auto_rotate", True) else 0,
        })


def delete_nurse(nurse_id: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM nurses WHERE id=?", (nurse_id,))


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
        return [dict(r) for r in rows]


def save_shift(code: str, name: str, period: str, is_charge: bool,
               hours: str, color_bg: str, color_text: str, sort_order: int) -> None:
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO shifts (code, name, period, is_charge, hours, color_bg, color_text, sort_order)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(code) DO UPDATE SET
                name=excluded.name, period=excluded.period, is_charge=excluded.is_charge,
                hours=excluded.hours, color_bg=excluded.color_bg, color_text=excluded.color_text,
                sort_order=excluded.sort_order
        """, (code, name, period, 1 if is_charge else 0, hours, color_bg, color_text, sort_order))


def delete_shift(code: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM shifts WHERE code=?", (code,))


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
    }
