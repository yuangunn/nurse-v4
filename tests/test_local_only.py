"""로컬 서버는 이 컴퓨터의 앱 화면만 (리뷰 2026-10-21) — 다른 Host(DNS 리바인딩)·다른 사이트 Origin 의 바꾸는 요청은 403."""
from fastapi.testclient import TestClient

from server.api import app

c = TestClient(app)


def test_rebinding_host_is_rejected():
    assert c.get("/health", headers={"host": "evil.example:5757"}).status_code == 403
    assert c.get("/health", headers={"host": "127.0.0.1:5757"}).status_code == 200
    assert c.get("/health", headers={"host": "localhost:5757"}).status_code == 200


def test_cross_site_write_is_rejected_but_app_origin_passes():
    r = c.post("/api/profiles/close", headers={"host": "127.0.0.1:5757", "origin": "https://evil.example"})
    assert r.status_code == 403
    r = c.post("/api/profiles/close", headers={"host": "127.0.0.1:5757", "origin": "null"})
    assert r.status_code == 403, '파일로 연 웹페이지(Origin null)'
    r = c.post("/api/profiles/close", headers={"host": "127.0.0.1:5757", "origin": "http://127.0.0.1:5757"})
    assert r.status_code == 200
