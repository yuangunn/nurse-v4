"""단독 나이트 — 앞뒤 날이 야간이 아닌 야간 하루에 경미한 감점 (결정 1-55, 2026-10-20).

야간이 단독으로 하루 들어가면 경미하게 감점한다 — 단독 나이트는 그렇게까지 바람직하지 않다.
실제 번표 1~10월(나이트킵 제외): 야간 602회 중 단독 87회(14%) — 연속 1일 87 · 2일 100 · 3일 90번. 금지가 아니라 경미하게.
엔진이 만든 11월 표: 야간 58회 중 단독 21회(36%).

배점 규칙 pattern [non_night, night, non_night] — 두 엔진·점수표가 같은 창(_score_windows)을 쓴다.

이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

import sqlite3
from datetime import date, timedelta

import pytest

from server import database as db
from server.models import ScoringRule

from .test_month_tail import _engine, _request

LO, HI = date(2026, 11, 29), date(2026, 12, 5)
KEYS = [(LO + timedelta(i)).isoformat() for i in range((HI - LO).days + 1)]


def _rule(score=-10):
    return ScoringRule(name="단독 나이트 감점", rule_type="pattern",
                       params={"pattern": ["non_night", "night", "non_night"]}, score=score, enabled=True, sort_order=18)


def _singles(row):
    """표 안쪽(첫날·끝날 빼고) 단독 나이트 수 — 첫날·끝날은 앞뒤를 몰라 엔진도 세지 않는다."""
    n = [row.get(k, "") in ("N", "NC") for k in KEYS]
    return sum(1 for i in range(1, len(n) - 1) if n[i] and not n[i - 1] and not n[i + 1])


def test_non_night_group_is_every_shift_but_nights():
    s = _engine("highs", LO, HI)(_request({}))
    g = s._resolve_group("non_night")
    assert set(g) == set(s.ALL_SHIFTS) - set(s.NIGHT_SHIFTS)
    assert {"D", "E", "OF", "V"} <= set(g) and not {"N", "NC"} & set(g)


def test_score_counts_only_nights_with_non_night_on_both_sides():
    """OF N OF N N OF D — 11/30 하나만 단독. 11/29(첫날)는 앞날을 몰라 세지 않는다."""
    s = _engine("highs", LO, HI)(_request({}, scoring_rules=[_rule()]))
    row = dict(zip(KEYS, ["N", "N", "OF", "N", "N", "OF", "D"]))           # 첫날 N N — 단독 아님
    row2 = dict(zip(KEYS, ["OF", "N", "OF", "N", "N", "OF", "D"]))
    scores, details = s._compute_nurse_scores({"a0": row, "a1": row2})
    assert scores["a0"] == 0 and scores["a1"] == -10, (scores["a0"], scores["a1"])
    d = [x for x in details["a1"] if x.get("name") == "단독 나이트 감점"]
    assert d and d[0]["count"] == 1, details["a1"]
    assert _singles(row2) == 1


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_engine_avoids_single_nights_when_it_can(engine):
    """매일 N1 · 7명 — 단독 없이 짤 수 있다(둘·셋씩). 규칙이 없으면 HiGHS 3 · CP-SAT 1 이 나오고, 기본 -10 이면 0.
    오차 0 으로 끝까지 — 기본 오차 2% 면 목적값 1500 의 30 점 안이라 작은 감점은 묻힐 수 있다 (CP-SAT -10 에서 2 개)."""
    r = _engine(engine, LO, HI)(_request({}, scoring_rules=[_rule()], mip_gap=0.0)).solve()
    assert r["success"], r.get("message")
    got = {nid: _singles(row) for nid, row in r["schedule"].items()}
    assert sum(got.values()) == 0, got
    if engine == "highs":   # 대조는 결정적인 HiGHS 로만 — CP-SAT(여러 스레드)은 규칙이 없을 때의 표가 기계마다 달랐다 (CI 에서 단독 0)
        base = _engine(engine, LO, HI)(_request({}, mip_gap=0.0)).solve()
        assert sum(_singles(row) for row in base["schedule"].values()) > 0, '규칙이 없으면 단독이 나오는 입력이어야 검사가 된다'



def test_migration_adds_rule_once_and_never_revives_a_deleted_one(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()                                                   # 새 DB — 시드에 들어 있다
    path = db.get_db_path()

    def rows():
        with sqlite3.connect(path) as c:
            return c.execute("SELECT id, score, enabled FROM scoring_rules WHERE params LIKE '%non_night%'").fetchall()

    def version():
        with sqlite3.connect(path) as c:
            return c.execute("PRAGMA user_version").fetchone()[0]

    assert len(rows()) == 1 and rows()[0][1:] == (-200, 1) and version() == 3
    db.init_db()
    assert len(rows()) == 1, '다시 열어도 하나'
    with sqlite3.connect(path) as c:                               # 이 규칙이 없던 옛 DB
        c.execute("DELETE FROM scoring_rules WHERE params LIKE '%non_night%'")
        c.execute("PRAGMA user_version = 0")
    db.init_db()
    assert len(rows()) == 1 and version() == 3, '옛 DB 엔 한 번 넣는다'
    with sqlite3.connect(path) as c:                               # 사용자가 지웠다
        c.execute("DELETE FROM scoring_rules WHERE params LIKE '%non_night%'")
    db.init_db()
    assert rows() == [], '지운 규칙을 되살리지 않는다'


def test_migration_raises_the_first_default_score_once(tmp_path, monkeypatch):
    """처음 값(-10)으로 둔 DB 만 새 기본값(-200)으로 한 번 올린다 — 사람이 고친 값과, 올린 뒤 되돌린 값은 그대로 (결정 1-76)."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()
    path = db.get_db_path()

    def score():
        with sqlite3.connect(path) as c:
            return c.execute("SELECT score FROM scoring_rules WHERE params LIKE '%non_night%'").fetchone()[0]

    def set_(value, version):
        with sqlite3.connect(path) as c:
            c.execute("UPDATE scoring_rules SET score=? WHERE params LIKE '%non_night%'", (value,))
            c.execute(f"PRAGMA user_version = {version}")

    set_(-10, 1); db.init_db()
    assert score() == -200, '처음 값으로 둔 옛 DB 는 올린다'
    set_(-50, 1); db.init_db()
    assert score() == -50, '사람이 고친 값은 그대로'
    set_(-10, 2); db.init_db()
    assert score() == -10, '올린 뒤 되돌린 값은 다시 바꾸지 않는다'


def test_migration_adds_juhu_off_rules_once(tmp_path, monkeypatch):
    """'주휴 옆에 OFF 붙이기' 두 규칙 — 새 DB 는 시드에, 옛 DB 는 한 번만. 같은 조건을 직접 만들어 둔 것이 있으면 겹쳐 넣지 않고,
    지운 규칙은 되살리지 않는다 (결정 1-83)."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()
    path = db.get_db_path()

    def rows():                                  # 저장된 params 는 한글이 \\u 로 적힌다 — 풀어서 본다
        import json
        with sqlite3.connect(path) as c:
            return sorted((n, s) for n, s, p in c.execute("SELECT name, score, params FROM scoring_rules WHERE rule_type='transition'")
                          if {json.loads(p).get("from"), json.loads(p).get("to")} == {"specific:주", "specific:OF"})

    def run(sql, version):
        with sqlite3.connect(path) as c:
            for s in sql:
                c.execute(s)
            c.execute(f"PRAGMA user_version = {version}")

    assert rows() == [("OFF 뒤에 주휴 붙이기", 150), ("주휴 뒤에 OFF 붙이기", 150)]
    db.init_db()
    assert len(rows()) == 2, '다시 열어도 둘'
    run(["DELETE FROM scoring_rules WHERE name LIKE '%주휴%붙이기'"], 2); db.init_db()
    assert len(rows()) == 2, '옛 DB 엔 한 번 넣는다'
    run(["DELETE FROM scoring_rules WHERE name='주휴 뒤에 OFF 붙이기'",
         "UPDATE scoring_rules SET name='내가 만든 것', score=70 WHERE name='OFF 뒤에 주휴 붙이기'"], 2); db.init_db()
    assert rows() == [("내가 만든 것", 70), ("주휴 뒤에 OFF 붙이기", 150)], '같은 조건이 이미 있으면 그대로 두고 없는 쪽만'
    run(["DELETE FROM scoring_rules WHERE name LIKE '%주휴%붙이기' OR name='내가 만든 것'"], 3); db.init_db()
    assert rows() == [], '지운 규칙을 되살리지 않는다'
