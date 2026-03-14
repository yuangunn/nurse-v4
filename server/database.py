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
