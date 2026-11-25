"""설정 값의 약속 (결정 1-116) — 화면에서 넣은 값이 그 뜻 그대로 엔진에 닿는가.

'연차 월 최대 0회'가 엔진에서 '상한 없음'으로 읽혀, 0 으로 낮추면 연차가 오히려 더 들어갔다. 같은 종류를 미리 막는다:

  · 숫자 설정마다 0 의 뜻을 여기 적는다 — 새 숫자 설정을 넣고 적지 않으면 이 검사가 떨어진다
  · 숫자 설정은 화면 입력 · 화면의 범위 표(RULE_NUM) · 서버 모델이 같은 최소 · 같은 기본값을 쓴다
  · 저장(POST /api/rules)은 빈칸(null) · 글자 · 범위 밖 값을 거절하고, 예전에 그렇게 저장된 값은 기본값으로 읽는다
  · 코드에 '0 이면 끔/기본값' 꼴(`rules.x > 0` · `rules.x || 5`)을 쓰지 않는다
  · 모델에 있는 설정은 엔진 어딘가에서 읽는다 (읽지 않는 설정은 사용자가 바꿔도 아무 일이 없다)

이름은 가명, 자료는 모두 지어낸 것.
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import database as db
from server.models import Rules

ROOT = Path(__file__).resolve().parent.parent
SERVER = [p for p in (ROOT / "server").glob("*.py") if p.name != "models.py"]
FRONT = [ROOT / "frontend" / "index.html", ROOT / "frontend" / "js" / "app.js", *(ROOT / "frontend" / "js" / "modules").glob("*.js")]

# 숫자 설정마다 — 0 을 넣으면 무슨 뜻인가. '넣을 수 없다'는 화면 최소가 1 이상이고 서버도 거절한다는 뜻.
ZERO = {
    "maxConsecutiveWorkDays": "넣을 수 없다 (끄려면 maxConsecutiveWork)",
    "maxConsecutiveNightDays": "넣을 수 없다 (끄려면 maxConsecutiveNight)",
    "restAfterNightDays": "넣을 수 없다 (끄려면 restAfterNight)",
    "restAfterNightMinConsec": "넣을 수 없다",
    "maxOneOffCount": "1오프를 하나도 두지 않는다",
    "minRestHours": "휴식 시간을 재지 않는다 (화면 최소는 1)",
    "maxVPerMonth": "연차를 자동으로 넣지 않는다 (한도를 없애는 것은 unlimited_v)",
    "maxNightPerMonthCount": "야간을 하나도 두지 않는다 (화면 최소는 1)",
    "maxNightTwoMonthCount": "두 달 야간을 하나도 두지 않는다 (화면 최소는 1)",
    "preBonusLeave": "휴가 사전입력을 지키는 보너스가 없다",
    "preBonusOff": "쉬는 날 사전입력을 지키는 보너스가 없다",
    "preBonusWork": "근무 사전입력을 지키는 보너스가 없다",
    "preBonusRest": "주휴 사전입력을 지키는 보너스가 없다",
}
NOT_READ_BY_ENGINE = {"hospitalHolidays": "화면의 공휴일 채우기가 holidays 에 넣는다", "teamColors": "화면 · 엑셀의 팀 색"}
NUMERIC = [k for k, f in Rules.model_fields.items() if f.annotation in (int, float)]


def _ge(name):
    return next((m.ge for m in Rules.model_fields[name].metadata if hasattr(m, "ge")), None)


def _front_rule_num():
    text = (ROOT / "frontend" / "js" / "modules" / "settings-defs.js").read_text(encoding="utf-8")
    block = re.search(r"RULE_NUM:\{(.*?)\},\n", text, re.S).group(1)
    return {k: [float(x) for x in v.split(",")] for k, v in re.findall(r"(\w+):\[([\d.,]+)\]", block)}


def test_every_numeric_setting_says_what_zero_means():
    assert sorted(ZERO) == sorted(NUMERIC), "숫자 설정을 보탰으면 0 의 뜻을 ZERO 에 적는다 (0 은 0 이다 — '끔 · 무제한 · 기본값'으로 읽지 않는다)"
    assert all(_ge(k) is not None for k in NUMERIC), "숫자 설정에는 최소(ge)를 둔다"


def test_screen_and_model_agree_on_range_and_default():
    table, html = _front_rule_num(), FRONT[0].read_text(encoding="utf-8")
    assert sorted(table) == sorted(NUMERIC), "화면의 RULE_NUM 이 서버의 숫자 설정과 같아야 한다"
    for k, (lo, _hi, dflt, _int) in table.items():
        assert lo >= _ge(k), f"{k}: 화면 최소 {lo} 가 서버 최소 {_ge(k)} 보다 작다 — 화면에서 넣은 값을 서버가 거절한다"
        assert dflt == Rules.model_fields[k].default, f"{k}: 화면 기본값과 모델 기본값이 다르다"
    for k, lo, hi in re.findall(r'x-model\.number="rules\.(\w+)"[^>]*?min="([\d.]+)" max="([\d.]+)"', html):
        assert (float(lo), float(hi)) == tuple(table[k][:2]), f"{k}: 입력 칸의 min · max 가 RULE_NUM 과 다르다"
    for k, _d, lo, hi in re.findall(r"bumpRule\('(\w+)',(-?1),([\d.]+),([\d.]+)\)", html):
        assert (float(lo), float(hi)) == tuple(table[k][:2]), f"{k}: ± 단추의 범위가 RULE_NUM 과 다르다"


def test_screen_defaults_match_what_a_new_ward_gets(tmp_path, monkeypatch):
    """새 병동(규칙을 저장한 적 없음)이 받는 값 = 화면의 처음 값. 어긋나면 병동마다 다르게 시작한다 ('여성 생휴 먼저 챙기기'가 그랬다)."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()
    from server.api import app
    got = TestClient(app).get("/api/rules").json()
    block = re.search(r"\n    rules: \{(.*?)hospitalHolidays", (ROOT / "frontend" / "js" / "app.js").read_text(encoding="utf-8"), re.S).group(1)
    block = re.sub(r"//[^\n]*", "", block)
    front = {k: json.loads(v) for k, v in re.findall(r"(\w+):\s*(true|false|-?\d+(?:\.\d+)?)", block)}
    simple = {k for k, f in Rules.model_fields.items() if f.annotation in (int, float, bool)}
    assert set(front) == simple, f"화면 기본값과 모델의 설정이 다르다: {sorted(set(front) ^ simple)}"
    assert {k: got[k] for k in simple} == front


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()
    from server.api import app
    return TestClient(app)


@pytest.mark.parametrize("name", NUMERIC)
def test_save_refuses_what_the_engine_cannot_read(client, name):
    """빈칸(null) · 글자 · 최소보다 작은 값은 저장하지 않는다 — 저장되면 그 뒤 만들기가 매번 막힌다. 최소값은 받는다."""
    lo = _ge(name)
    for bad in (None, "", "많이", lo - 1):
        assert client.post("/api/rules", json={name: bad}).status_code == 422, (name, bad)
    if Rules.model_fields[name].annotation is int:
        assert client.post("/api/rules", json={name: lo + 0.5}).status_code == 422
    assert client.post("/api/rules", json={name: lo}).status_code == 200
    assert client.get("/api/rules").json()[name] == lo, "최소값(0 포함)은 그대로 돌아온다"


def test_old_blank_values_are_read_as_defaults(client):
    """예전에 빈칸으로 저장된 값(null)이 DB 에 있어도 기본값으로 읽는다 — 그대로 돌려주면 만들기 요청이 422 로 막힌다."""
    with sqlite3.connect(db.get_db_path()) as c:
        c.execute("INSERT OR REPLACE INTO rules (key, value) VALUES ('maxVPerMonth', 'null')")
        c.execute("INSERT OR REPLACE INTO rules (key, value) VALUES ('maxConsecutiveWorkDays', '0')")
    got = client.get("/api/rules").json()
    assert (got["maxVPerMonth"], got["maxConsecutiveWorkDays"]) == (1, 5)
    Rules(**{k: v for k, v in got.items() if k in Rules.model_fields})


def test_no_zero_means_off_idiom_in_code():
    """`rules.x > 0` · `if rules.x:` (서버) · `rules.x || 5` (화면) — 0 을 '끔 · 기본값'으로 바꿔 읽는 꼴. 숫자 설정에는 쓰지 않는다."""
    names = "|".join(NUMERIC)
    hits = []
    for path in SERVER:
        for n, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
            code = line.split("#")[0]
            if (re.search(rf"rules\.({names})\s*>\s*0", code) or re.search(rf"\b(if|and|or|not)\s+(self\.)?rules\.({names})\s*(:|and\b|or\b|\)|$)", code)
                    or re.search(rf"rules\.({names})\s+or\s+\d", code)):
                hits.append(f"{path.name}:{n}: {line.strip()[:90]}")
    for path in FRONT:
        for n, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
            for m in re.finditer(rf"\b(?:rules|r)\.({names})\s*\)?\s*\|\|\s*[\d'\"]", line):
                hits.append(f"{path.name}:{n}: …{line[max(0, m.start() - 30):m.end() + 10]}…")
    assert hits == [], "0 을 다른 뜻으로 읽는 꼴:\n" + "\n".join(hits)


def test_every_setting_is_read_somewhere():
    """모델에 있는 설정은 엔진 · API 어딘가에서 읽는다 — 읽지 않는 설정은 화면에서 바꿔도 아무 일이 없다."""
    text = "\n".join(p.read_text(encoding="utf-8") for p in SERVER)
    unread = [k for k in Rules.model_fields if k not in NOT_READ_BY_ENGINE and not re.search(rf"\b{k}\b", text)]
    assert unread == [], f"엔진이 읽지 않는 설정: {unread} — 쓰거나, 지우거나, NOT_READ_BY_ENGINE 에 까닭을 적는다"
