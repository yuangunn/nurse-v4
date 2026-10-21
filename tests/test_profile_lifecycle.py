"""프로필 열기·닫기·전환 수명주기 회귀 (2026-10 리뷰).

닫은 뒤에도 DB 경로가 닫힌 병동의 평문 .db 를 가리켜, 늦게 온 요청(생성 끝의 이력 쓰기·새로고침·비밀번호가 틀린 전환 뒤의
편집)이 빈 스텁 .db 를 만들었다. 다음 열기가 그 스텁을 '크래시로 남은 최신 평문'으로 믿어 예시 명부를 시드했고, 닫을 때
진짜 .db.enc 를 덮었다. 이름은 가명(간호01…)만 쓴다.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time

import pytest

fastapi_testclient = pytest.importorskip("fastapi.testclient")


@pytest.fixture
def env(tmp_path, monkeypatch):
    """임시 데이터 폴더 + 서버 전역(지금 DB·열린 프로필)을 테스트 뒤 되돌린다."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import api, database as db
    monkeypatch.setattr(db, "_profile_db", None)
    monkeypatch.setattr(db, "_closed", False)
    monkeypatch.setattr(api, "_current_profile_id", None)
    monkeypatch.setattr(api, "_current_profile_password", None)
    return fastapi_testclient.TestClient(api.app, raise_server_exceptions=False), tmp_path / "NurseScheduler"


@pytest.fixture
def prof_env(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import profiles as prof
    return prof, tmp_path / "NurseScheduler"


def _nurse(i):
    return {"id": f"g{i:02d}", "name": f"간호{i:02d}", "group": "A", "gender": "female",
            "capable_shifts": ["D", "E", "N"], "seniority": i}


def _names(c):
    r = c.get("/api/nurses")
    return [n["name"] for n in r.json()] if r.status_code == 200 else None


def _open(c, pid="w101", pw="pw1"):
    return c.post("/api/profiles/open", json={"id": pid, "password": pw}).json()


def _make_ward(c, pid="w101", pw="pw1"):
    """암호 병동을 만들어 열고, 명부를 간호01 한 명으로."""
    assert c.post("/api/profiles/create", json={"id": pid, "name": "병동", "password": pw}).status_code == 200
    assert _open(c, pid, pw)["ok"]
    for n in c.get("/api/nurses").json():
        c.delete(f"/api/nurses/{n['id']}")
    assert c.post("/api/nurses", json=_nurse(1)).status_code == 200
    assert _names(c) == ["간호01"]


def _db_names(path):
    con = sqlite3.connect(str(path))
    try:
        return [r[0] for r in con.execute("SELECT name FROM nurses ORDER BY seniority")]
    finally:
        con.close()


def _ward_with_marker(prof, pid="w101", pw="pw1"):
    """prof 함수만으로 — 암호 병동을 만들고 간호01 을 넣은 뒤 닫는다."""
    assert prof.create_profile(pid, "병동", password=pw)["ok"]
    r = prof.open_profile(pid, pw)
    con = sqlite3.connect(r["db_path"])
    con.execute("INSERT INTO nurses (id, name, seniority) VALUES ('g01', '간호01', -1)")
    con.commit()
    con.close()
    prof.close_profile(pid, pw)


def _stub(d, pid="w101"):
    """옛 판의 늦은 요청이 남긴 0바이트 스텁 — .db.enc 보다 새것."""
    stub = d / f"{pid}.db"
    stub.write_bytes(b"")
    later = time.time() + 5
    os.utime(stub, (later, later))
    return stub


# ── ① 닫은 뒤 늦은 요청 ──────────────────────────────────────────────────────

def test_late_request_after_close_makes_no_stub(env):
    c, d = env
    _make_ward(c)
    assert c.post("/api/profiles/close").json()["ok"]
    r = c.get("/api/nurses")                                # 닫힌 병동 DB 접근은 거부
    assert r.status_code == 409 and "다시 열어" in r.json()["detail"]
    assert not (d / "w101.db").exists(), "닫힌 병동 경로에 빈 스텁 .db 가 생기면 안 된다"
    assert _open(c)["ok"]
    assert _names(c) == ["간호01"], "다시 열면 예시 명부가 아니라 원래 명부여야 한다"


def test_generation_finishing_after_close_makes_no_stub(env, monkeypatch):
    """생성 중 새로고침(F5 → beforeunload 닫기) — 닫힌 뒤 끝난 생성의 이력 쓰기가 빈 스텁을 만들지 않는다.
    생성은 멈추지 않는다 (같은 병동을 다시 열면 새로고침 복구로 결과를 받는다)."""
    c, d = env
    _make_ward(c)
    from server import api
    entered, gate = threading.Event(), threading.Event()

    def slow_solve(self):
        entered.set()
        gate.wait(5)
        return {"success": True, "message": "가짜", "schedule": {}}

    monkeypatch.setattr(api.NurseScheduler, "solve", slow_solve)
    monkeypatch.setattr(api, "_last_generate_result", None)
    req ={"year": 2026, "month": 3, "nurses": [_nurse(1)], "requirements": {}, "rules": {}}
    out = {}
    t = threading.Thread(target=lambda: out.update(r=c.post("/api/generate", json=req)))
    t.start()
    assert entered.wait(10)
    assert c.post("/api/profiles/close").json()["ok"]
    gate.set()
    t.join(10)
    assert out["r"].status_code == 200 and out["r"].json()["success"]
    assert not (d / "w101.db").exists()
    assert _open(c)["ok"]
    assert _names(c) == ["간호01"]


def test_delete_open_profile_then_late_request_makes_no_stub(env):
    c, d = env
    _make_ward(c)
    assert c.delete("/api/profiles/w101").status_code == 200
    assert c.get("/api/nurses").status_code >= 400
    assert not (d / "w101.db").exists()


# ── ④ 열기 계약: 새 프로필 비밀번호를 먼저 확인, 틀리면 지금 프로필은 그대로 ─────────

def test_wrong_password_open_keeps_current_profile(env):
    c, d = env
    _make_ward(c)
    assert c.post("/api/profiles/create", json={"id": "w102", "name": "병동2", "password": "pw2"}).status_code == 200
    assert _open(c, "w102", "틀림")["ok"] is False          # 다른 병동, 틀린 비밀번호
    assert _names(c) == ["간호01"]
    assert _open(c, "w101", "틀림")["ok"] is False          # 같은 병동을 틀린 비밀번호로 다시 열기
    assert _names(c) == ["간호01"], "틀린 비밀번호로 지금 프로필이 닫히면 안 된다"
    assert c.get("/api/profiles").json()["current_profile"] == "w101"


def test_same_profile_reopen_and_switch_keep_data(env):
    c, d = env
    _make_ward(c)
    assert _open(c)["ok"]                                     # 같은 병동 다시 열기 (새로고침)
    assert _names(c) == ["간호01"]
    assert c.post("/api/profiles/create", json={"id": "w102", "name": "병동2", "password": "pw2"}).status_code == 200
    assert _open(c, "w102", "pw2")["ok"]                       # 맞는 비밀번호로 전환 → 앞 병동은 닫혀 암호화
    assert not (d / "w101.db").exists() and (d / "w101.db.enc").exists()
    assert "간호01" not in _names(c)
    assert _open(c)["ok"]
    assert _names(c) == ["간호01"]


# ── ② 열 때 스텁은 버리고 .db.enc 를 푼다, 크래시로 남은 진짜 평문은 살린다 ─────────────

def test_stub_plain_is_discarded_on_open(env):
    c, d = env
    _make_ward(c)
    c.post("/api/profiles/close")
    _stub(d)
    assert _open(c)["ok"]
    assert _names(c) == ["간호01"], "스텁을 진짜로 쓰면 예시 명부가 시드된다"
    c.post("/api/profiles/close")
    assert _open(c)["ok"]
    assert _names(c) == ["간호01"], "닫을 때 시드본이 진짜 .db.enc 를 덮으면 안 된다"


def test_crash_leftover_plain_is_kept(prof_env):
    prof, d = prof_env
    _ward_with_marker(prof)
    r = prof.open_profile("w101", "pw1")
    con = sqlite3.connect(r["db_path"])
    con.execute("INSERT INTO nurses (id, name, seniority) VALUES ('g02', '간호02', -1)")   # 최신 편집
    con.commit()
    con.close()
    # 크래시 — 닫지 않고 끝났다. 다음 실행이 다시 연다
    r = prof.open_profile("w101", "pw1")
    assert r["ok"]
    assert {"간호01", "간호02"} <= set(_db_names(r["db_path"]))


# ── ③ 스텁이 있을 때 비밀번호 바꾸기·강제 초기화 ───────────────────────────────

def test_change_password_with_stub_reencrypts(prof_env):
    prof, d = prof_env
    _ward_with_marker(prof)
    _stub(d)
    assert prof.change_password("w101", "pw1", "pw9")["ok"]
    r = prof.open_profile("w101", "pw9")
    assert r["ok"], r
    assert "간호01" in _db_names(r["db_path"])


def test_force_reset_with_stub_keeps_enc(prof_env):
    prof, d = prof_env
    _ward_with_marker(prof)
    _stub(d)
    assert not prof.force_reset_password("w101")["ok"]
    assert (d / "w101.db.enc").exists()
    r = prof.open_profile("w101", "pw1")
    assert r["ok"] and "간호01" in _db_names(r["db_path"])


def test_change_password_while_open_keeps_session(env):
    c, d = env
    _make_ward(c)
    bad = {"id": "w101", "old_password": "틀림", "new_password": "pw9"}
    assert c.post("/api/profiles/change-password", json=bad).status_code == 400
    assert _names(c) == ["간호01"]
    ok = {"id": "w101", "old_password": "pw1", "new_password": "pw9"}
    assert c.post("/api/profiles/change-password", json=ok).status_code == 200
    assert _names(c) == ["간호01"], "열린 프로필은 비밀번호를 바꾼 뒤에도 그대로 이어 쓴다"
    c.post("/api/profiles/close")
    assert _open(c, "w101", "pw9")["ok"]
    assert _names(c) == ["간호01"]


# ── ⑥ 같은 파일을 가리키는 ID ───────────────────────────────────────────────

def test_case_only_different_id_is_rejected(prof_env):
    prof, d = prof_env
    _ward_with_marker(prof, "ward", "pwA")
    assert not prof.create_profile("WARD", "병동2", password="pwB")["ok"]
    r = prof.open_profile("ward", "pwA")
    assert r["ok"] and "간호01" in _db_names(r["db_path"])


def test_reserved_and_leftover_ids_are_rejected(prof_env):
    prof, d = prof_env
    for bad in ("_guest_temp", "nurse_scheduler", "Nurse_Scheduler"):
        assert not prof.create_profile(bad, "이름")["ok"], bad
    d.mkdir(parents=True, exist_ok=True)
    left = d / "w9.db.enc"
    left.write_bytes(b"x" * 200)                              # 목록에 없는 남은 암호화본
    assert not prof.create_profile("w9", "병동", password="pw")["ok"]
    assert left.read_bytes() == b"x" * 200


# ── ⑦ profiles.json 원자적 쓰기 ────────────────────────────────────────────

def test_profiles_json_survives_failed_write(prof_env):
    prof, d = prof_env
    prof.create_profile("w101", "병동", password="pw1")
    path = d / "profiles.json"
    before = path.read_text(encoding="utf-8")
    data = json.loads(before)
    data["profiles"].append({"id": "x", "bad": object()})     # 쓰는 도중 실패
    with pytest.raises(TypeError):
        prof._save_profiles(data)
    assert path.read_text(encoding="utf-8") == before, "쓰다 끊겨도 profiles.json(enc_salt)이 온전해야 한다"


# ── ⑤ 닫기는 쓰는 중인 요청이 끝난 뒤에 찍는다 ───────────────────────────────────

def test_close_waits_for_inflight_write(env):
    c, d = env
    _make_ward(c)
    from server import database as db
    started = threading.Event()

    def writer():
        with db.get_conn() as conn:
            conn.execute("INSERT INTO nurses (id, name, seniority) VALUES ('g09', '간호09', 9)")
            started.set()
            time.sleep(0.3)                                    # 커밋 전에 닫기가 들어온다

    t = threading.Thread(target=writer)
    t.start()
    assert started.wait(5)
    assert c.post("/api/profiles/close").json()["ok"]
    t.join()
    assert _open(c)["ok"]
    assert "간호09" in _names(c), "닫기 직전에 쓰던 행이 암호화본에 있어야 한다"
