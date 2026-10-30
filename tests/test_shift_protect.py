"""기본 근무는 지울 수 없다 — V(연차)도 (2026-10-26)."""
import pytest
from fastapi import testclient as fastapi_testclient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    from server.api import app

    db.init_db()
    return fastapi_testclient.TestClient(app)


@pytest.mark.parametrize("code", ["V", "D", "OF", "주"])
def test_protected_shift_cannot_be_deleted(client, code):
    assert client.delete(f"/api/shifts/{code}").status_code == 400
    assert code in {s["code"] for s in client.get("/api/shifts").json()}


def test_ward_leave_code_can_still_be_deleted(client):
    assert client.delete("/api/shifts/산전").status_code == 200
    assert "산전" not in {s["code"] for s in client.get("/api/shifts").json()}
