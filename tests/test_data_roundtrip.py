"""저장·가져오기 왕복 회귀 — 명부 가져오기·근무표 저장·배점 규칙·마이그레이션·관리 API (리뷰 2026-10-21).

APPDATA 를 tmp 로 돌려 시드 DB 를 쓴다. 이름은 가명(간호01…)."""
from __future__ import annotations

import base64
import io
import json
import sqlite3
import zipfile

import pytest

fastapi_testclient = pytest.importorskip("fastapi.testclient")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    from server.api import app

    db.init_db()
    with db.get_conn() as conn:
        conn.execute("DELETE FROM nurses")
    return fastapi_testclient.TestClient(app)


def _nurse(i, **kw):
    return {"id": f"g{i:02d}", "name": f"간호{i:02d}", "group": "A", **kw}


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode()


def _save(client, month, schedule, **kw):
    nurses = [{"id": nid, "name": nid} for nid in schedule]
    body = {"year": 2026, "month": month, "nurses": nurses, "requirements": {}, "rules": {},
            "schedule": schedule, **kw}
    r = client.post("/api/schedules", json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ── 명부 가져오기 ─────────────────────────────────────────────────────────────

def test_roster_roundtrip_keeps_fields_not_in_the_file(client):
    """내보낸 명부를 그대로(또는 한 칸만 고쳐) 다시 가져와도 파일에 없는 칸 — 임신(모성보호)·월별 야간전담·희망 —
    은 그대로다. 예전엔 모두 지워졌는데 미리보기는 '변경 없음'이었다."""
    from server import database as db

    keep = {"is_pregnant": True, "pregnancy": {"early": {"start": "2026-10-01", "end": "2026-12-31"}},
            "night_months": {"2026-11": True}, "wishes": {"2026-11-05": "OF"}}
    db.upsert_nurse(_nurse(1, **keep))
    db.upsert_nurse(_nurse(2, group="B"))

    xlsx = base64.b64encode(client.get("/api/nurses/export.xlsx").content).decode()
    pv = client.post("/api/nurses/import/preview", json={"csv_b64": xlsx}).json()
    assert (pv["unchanged_count"], pv["will_update"], pv["will_add"]) == (2, [], []), pv
    assert client.post("/api/nurses/import", json={"csv_b64": xlsx}).status_code == 200
    g01 = next(n for n in db.get_nurses() if n["id"] == "g01")
    assert {k: g01[k] for k in keep} == keep

    csv_text = client.get("/api/nurses/export").content.decode("utf-8-sig").replace("간호02,B", "간호02,C")
    pv = client.post("/api/nurses/import/preview", json={"csv": csv_text}).json()
    assert [(u["id"], [f["field"] for f in u["fields"]]) for u in pv["will_update"]] == [("g02", ["group"])], pv
    client.post("/api/nurses/import", json={"csv": csv_text})
    by_id = {n["id"]: n for n in db.get_nurses()}
    assert by_id["g02"]["group"] == "C"
    assert {k: by_id["g01"][k] for k in keep} == keep
    for bad in ("이름\n", "성명,그룹\n간호01,A\n"):                 # 행이 없거나 '이름' 열이 없다 — 경고만
        pv = client.post("/api/nurses/import/preview", json={"csv": bad})
        assert pv.status_code == 200 and pv.json()["errors"], pv.text


def test_roster_import_does_not_merge_namesakes(client):
    """id 칸 없는 명부에 같은 이름·그룹이 둘이면 누구인지 모른다 — 두 행이 한 사람으로 합쳐지고 '전체 교체'가
    다른 한 명과 그 저장 근무를 지웠다. 그 행은 건너뛰고(경고) 두 사람은 지우지 않는다."""
    from server import database as db

    for i in (1, 2):
        db.upsert_nurse(_nurse(i, name="간호01"))
    db.upsert_nurse(_nurse(3))
    sched = {"g01": {"2026-10-01": "D"}, "g02": {"2026-10-01": "E"}, "g03": {"2026-10-01": "N"}}
    _save(client, 10, sched)

    body = {"csv": "이름,그룹,야간전담\n간호01,A,N\n간호01,A,Y\n간호03,A,N\n", "replace_all": True}
    pv = client.post("/api/nurses/import/preview", json=body).json()
    assert pv["will_delete"] == [] and len(pv["errors"]) == 2, pv
    r = client.post("/api/nurses/import", json=body).json()
    assert r["imported"] == 1
    assert sorted(n["id"] for n in db.get_nurses()) == ["g01", "g02", "g03"]
    saved = client.get(f"/api/schedules/{client.get('/api/schedules').json()[0]['id']}").json()
    assert saved["data"]["schedule"] == sched

    # id 가 겹치는 두 행 — 뒤 행이 앞 행을 덮지 않는다
    r = client.post("/api/nurses/import", json={"csv": "id,이름,그룹\ng03,간호03,A\ng03,간호09,A\n"}).json()
    assert r["imported"] == 1 and len(r["errors"]) == 1, r
    assert next(n for n in db.get_nurses() if n["id"] == "g03")["name"] == "간호03"


def test_unclosed_quote_csv_is_a_400_not_a_500(client):
    """따옴표가 닫히지 않은 큰 CSV — 처리 안 된 csv.Error(500) 대신 원인을 알리는 400."""
    text = "이름,연차\n\"간호01,1\n" + "".join(f"간호{i:02d},1\n" for i in range(2, 20000))
    r = client.post("/api/parse-table-file", json={"file_b64": _b64(text), "filename": "명부.csv"})
    assert r.status_code == 400 and "따옴표" in r.json()["detail"], r.text
    r = client.post("/api/nurses/import/preview", json={"csv": text})
    assert r.status_code == 400 and "따옴표" in r.json()["detail"], r.text


def test_huge_xlsx_merge_is_refused_before_loading(monkeypatch):
    """수 KB 파일의 큰 병합 범위 하나 — openpyxl 은 적재하면서 칸마다 객체를 만들어 수 초·수백 MB 를 먹었다
    (셀 상한 검사는 적재 뒤라 막지 못했다). 적재하기 전에 거절한다."""
    import openpyxl
    from fastapi import HTTPException

    from server import api

    wb = openpyxl.Workbook()
    wb.active["A1"] = "간호01"
    buf = io.BytesIO()
    wb.save(buf)
    src, out = zipfile.ZipFile(io.BytesIO(buf.getvalue())), io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                data = data.replace(b"</sheetData>",
                                    b'</sheetData><mergeCells count="1"><mergeCell ref="A1:J100000"/></mergeCells>')
            z.writestr(item, data)

    loaded = []
    monkeypatch.setattr(openpyxl, "load_workbook", lambda *a, **k: loaded.append(1))
    with pytest.raises(HTTPException) as e:
        api._parse_xlsx_sheets(out.getvalue())
    assert not loaded, "병합 범위를 보기 전에 적재했다"
    assert e.value.status_code == 400 and "병합" in e.value.detail


# ── 근무표 저장 · 완화 이력 원장 ───────────────────────────────────────────────

def test_saved_relaxed_cells_drive_the_relax_ledger(client):
    """저장(POST /api/schedules)이 relaxed_cells 를 버리지 않는다 — 버리면 원장이 '사전입력 대 결과 차이'로 세어,
    지켜 준 원티드 D/E·N제외까지 뒤집힘으로 쳐 다음 달 보정 배수가 부풀었다. 다 지켜진 달(빈 {})도 그대로 믿는다."""
    prev = {"g01": {"2026-10-05": "D/E", "2026-10-06": "OF", "2026-10-07": "N제외"}}
    sid = _save(client, 10, {"g01": {"2026-10-05": "D", "2026-10-06": "D", "2026-10-07": "E"}}, prev_schedule=prev,
                relaxed_cells={"g01": {"2026-10-06": {"original": "OF", "assigned": "D", "is_timeoff": True}}})
    assert "2026-10-06" in client.get(f"/api/schedules/{sid}").json()["data"]["relaxed_cells"]["g01"]
    led = client.get("/api/relax_ledger", params={"year": 2026, "month": 11}).json()
    assert led["g01"]["overridden"] == 1, led

    _save(client, 10, {"g01": {"2026-10-05": "D", "2026-10-06": "D", "2026-10-07": "E"}}, prev_schedule=prev,
          relaxed_cells={})                                       # 다시 만들어 다 지켰다 — 최신 저장본
    assert client.get("/api/relax_ledger", params={"year": 2026, "month": 11}).json() == {}


def test_relax_ledger_fallback_for_old_saves(client):
    """구버전 저장본(relaxed_cells 없음) 폴백 — 지켜 준 원티드(D/E·E/N·N제외)·번표 표기(OFF)·신규 트레이닝 칸('/')은
    뒤집힘이 아니다. 실제로 뒤집힌 사람보다 지켜진 사람을 더 보호했다."""
    from server import database as db

    old = {"prev_schedule": {
        "g01": {"2026-10-05": "D/E", "2026-10-06": "E/N", "2026-10-07": "N제외", "2026-10-08": "OFF"},
        "g02": {"2026-10-05": "OF"},
        "t01": {"2026-10-05": "/D", "2026-10-06": "/E"},
    }, "schedule": {
        "g01": {"2026-10-05": "D", "2026-10-06": "EC", "2026-10-07": "OF", "2026-10-08": "OF"},
        "g02": {"2026-10-05": "D"},
        "t01": {"2026-10-05": "/DC", "2026-10-06": "/EC"},
    }}
    with db.get_conn() as conn:
        conn.execute("INSERT INTO schedules (year, month, name, data) VALUES (2026, 10, 'old', ?)", (json.dumps(old),))
    assert db.compute_relax_ledger(2026, 11) == {"g02": {"overridden": 1, "months": 1}}


# ── 배점 규칙 ─────────────────────────────────────────────────────────────────

def test_fractional_score_is_refused_and_old_ones_read_as_integers(client):
    """소수 배점(-0.5)이 저장되면 그 뒤 모든 생성·예상시간·정밀분석이 검증 오류(500)였다 — 저장은 422 로 거절하고,
    이미 들어간 소수·빈칸은 읽을 때 정수로 본다."""
    from server import database as db

    n = len(db.list_scoring_rules())
    rule = {"name": "단독 나이트 경미", "rule_type": "pattern",
            "params": {"pattern": ["non_night", "night", "non_night"]}, "score": -0.5}
    assert client.post("/api/scoring_rules", json=rule).status_code == 422
    assert client.post("/api/scoring_rules", json={**rule, "score": ""}).status_code == 422
    assert len(db.list_scoring_rules()) == n

    with db.get_conn() as conn:                                   # 고치기 전에 저장된 것
        conn.execute("INSERT INTO scoring_rules (name, rule_type, params, score) VALUES ('옛 소수', 'wish', '{}', -1.6)")
        conn.execute("INSERT INTO scoring_rules (name, rule_type, params, score) VALUES ('옛 빈칸', 'wish', '{}', '')")
    scores = {r["name"]: r["score"] for r in client.get("/api/scoring_rules").json()}
    assert (scores["옛 소수"], scores["옛 빈칸"]) == (-2, 0)
    req = {"year": 2026, "month": 11, "requirements": {}, "rules": {},
           "nurses": [{"id": f"g{i:02d}", "name": f"간호{i:02d}"} for i in range(1, 4)]}
    assert client.post("/api/estimate", json=req).status_code == 200


def test_old_rule_migrations_do_not_revive_deleted_rules(tmp_path, monkeypatch):
    """옛 배점 규칙 마이그레이션(퐁당퐁당·법정공휴일/주말 5종)은 버전 1 전 DB 에서 한 번만 — 지운 규칙이 열 때마다
    켜진 채 되살아났고, 이름을 바꾼 규칙은 하나 더 생겨 같은 패턴에 두 번 걸렸다."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db

    db.init_db()
    path = db.get_db_path()

    def rules():
        with sqlite3.connect(path) as c:
            return c.execute("SELECT name, rule_type FROM scoring_rules").fetchall()

    with sqlite3.connect(path) as c:
        c.execute("DELETE FROM scoring_rules WHERE rule_type='holiday_off'")
        c.execute("UPDATE scoring_rules SET name='징검다리 근무 회피' WHERE name='퐁당퐁당 회피'")
    before = rules()
    db.init_db()                                                  # 프로필 다시 열기
    assert rules() == before

    with sqlite3.connect(path) as c:                              # 이 규칙이 없던 옛 DB (버전 0)
        c.execute("PRAGMA user_version = 0")
    db.init_db()
    assert ("공휴일 OFF 페널티", "holiday_off") in rules()
    assert sum(1 for _, rt in rules() if rt == "pattern") == len([r for r in before if r[1] == "pattern"]) + 1


# ── 관리 API ──────────────────────────────────────────────────────────────────

def test_master_password_set_needs_the_current_one(client):
    """마스터가 있으면 바꿀 때 지금 마스터를 확인한다 (remove 와 같게) — 모르는 사람이 덮어써 열기 관문을 지났다."""
    url = "/api/profiles/master-password"
    assert client.post(url, json={"action": "set", "password": "m1"}).status_code == 200
    assert client.post(url, json={"action": "set", "password": "m2"}).status_code == 400
    assert client.post(url, json={"action": "set", "password": "m2", "current_password": "x"}).status_code == 400
    assert client.post(url, json={"action": "verify", "password": "m1"}).json() == {"ok": True}
    assert client.post(url, json={"action": "set", "password": "m2", "current_password": "m1"}).status_code == 200
    assert client.post(url, json={"action": "verify", "password": "m2"}).json() == {"ok": True}


def test_dev_reset_seed_refuses_when_saved_schedules_exist(client):
    """예시 데이터로 바꾸면 다음 열기의 유령 정리가 저장 근무표의 실제 간호사 칸을 모두 지웠다 —
    저장본이 있으면 거절하고 명부를 그대로 둔다 (init_db 가 재시드하지 않는 것과 같은 이유)."""
    from server import database as db

    assert client.post("/api/dev/reset-seed").status_code == 200       # 저장본 없음 — 예시 18명
    assert len(db.get_nurses()) == 18
    with db.get_conn() as conn:
        conn.execute("DELETE FROM nurses")
    db.upsert_nurse(_nurse(1))
    _save(client, 10, {"g01": {"2026-10-01": "D"}})
    r = client.post("/api/dev/reset-seed")
    assert r.status_code == 409, r.text
    assert [n["id"] for n in db.get_nurses()] == ["g01"]
