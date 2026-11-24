"""배점 프리셋 — 지금 배점 규칙 전체를 이름 붙여 남기고, 불러오기·기본값 되돌리기는 규칙 전체를 바꾼다 (결정 1-78)."""
from __future__ import annotations

from server import database as db


def _snap():
    return [(r["name"], r["rule_type"], r["params"], r["score"], r["enabled"], r["sort_order"]) for r in db.list_scoring_rules()]


def _edit(name, **kw):
    r = next(x for x in db.list_scoring_rules() if x["name"] == name)
    r.update(kw)
    db.save_scoring_rule(name=r["name"], rule_type=r["rule_type"], params=r["params"], score=r["score"],
                         enabled=r["enabled"], sort_order=r["sort_order"], rule_id=r["id"])


def test_preset_save_apply_delete_and_reset(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()
    default = _snap()
    assert ("단독 나이트 감점", -400) in [(n, s) for n, _, _, s, _, _ in default]

    _edit("야간 근무 공평성", score=-120)
    _edit("퐁당퐁당 회피", enabled=False)
    db.save_scoring_rule(name="내가 만든 규칙", rule_type="transition", params={"from": "night", "to": "day"},
                         score=-70, enabled=True, sort_order=30)
    mine = _snap()
    db.save_scoring_preset("우리 병동")
    assert db.list_scoring_presets()[0]["name"] == "우리 병동" and db.list_scoring_presets()[0]["count"] == len(mine)

    db.reset_scoring_rules()                                   # 기본값으로 — 프리셋은 그대로
    assert _snap() == default
    assert [p["name"] for p in db.list_scoring_presets()] == ["우리 병동"]

    assert db.apply_scoring_preset("우리 병동") is True          # 불러오면 규칙 전체가 그때 것으로
    assert _snap() == mine
    assert db.apply_scoring_preset("없는 이름") is False and _snap() == mine

    _edit("야간 근무 공평성", score=-10)
    db.save_scoring_preset("우리 병동")                         # 같은 이름은 덮어쓴다
    assert len(db.list_scoring_presets()) == 1
    db.reset_scoring_rules(); db.apply_scoring_preset("우리 병동")
    assert next(s for n, _, _, s, _, _ in _snap() if n == "야간 근무 공평성") == -10

    db.delete_scoring_preset("우리 병동")
    assert db.list_scoring_presets() == []
    db.init_db()                                               # 다시 열어도 규칙이 겹쳐 들어가지 않는다
    assert len(_snap()) == len(mine)


def test_preset_api(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()
    from fastapi.testclient import TestClient
    from server.api import app
    c = TestClient(app)
    n0 = len(c.get("/api/scoring_rules").json())
    assert c.post("/api/scoring_presets", json={"name": "  "}).status_code == 422
    assert [p["name"] for p in c.post("/api/scoring_presets", json={"name": " 12월 "}).json()] == ["12월"]
    rule = c.get("/api/scoring_rules").json()[0]
    c.post("/api/scoring_rules", json={**rule, "score": rule["score"] - 7})
    assert c.post("/api/scoring_presets/apply", json={"name": "없음"}).status_code == 404
    back = c.post("/api/scoring_presets/apply", json={"name": "12월"}).json()
    assert len(back) == n0 and back[0]["score"] == rule["score"]
    c.post("/api/scoring_rules", json={**back[0], "score": 1})
    assert c.post("/api/scoring_rules/reset").json()[0]["score"] == rule["score"]
    assert c.post("/api/scoring_presets/delete", json={"name": "12월"}).json() == []
