"""낮·저녁 고르게 — 한 사람의 그 달 낮 수와 저녁 수의 차이가 tolerance 를 넘는 만큼 감점 (결정 1-107).

'같은 근무 이어가기'는 묶음을 길게 만들 뿐 누구의 낮·저녁이 얼마인지는 보지 않는다. 그 보상을 +15 → +80 으로 올리자
원티드가 없는 사람이 한 달 내내 낮(또는 저녁)만 받았다 — 실제 12월 입력에서 낮−저녁 차이 합 56 → 88~110, 8 이상인 사람 2 → 4~7명
(낮 15·저녁 3 등). 사람이 짠 번표 7~10월은 41~89.

이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from server.models import ScoringRule

from .test_month_tail import _engine, _request

LO, HI = date(2026, 11, 1), date(2026, 11, 14)          # 그 달 칸만 센다 — 두 주 모두 11월
KEYS = [(LO + timedelta(i)).isoformat() for i in range((HI - LO).days + 1)]


def _rule(score=-100, tol=0):
    return ScoringRule(name="낮·저녁 고르게", rule_type="shift_balance", params={"tolerance": tol}, score=score, enabled=True, sort_order=30)


def _skew(schedule):
    out = {}
    for nid, row in schedule.items():
        codes = [row.get(k, "") for k in KEYS]
        out[nid] = abs(sum(c in ("D", "DC") for c in codes) - sum(c in ("E", "EC") for c in codes))
    return out


def test_score_counts_what_is_over_the_tolerance():
    s = _engine("highs", LO, HI)(_request({}, scoring_rules=[_rule(tol=2)]))
    lop = dict(zip(KEYS, "D D D D D OF 주 D D D E OF OF 주".split()))       # 낮 8 · 저녁 1 → 차이 7, 2 까지는 두고 5
    even = dict(zip(KEYS, "D D E E N OF 주 D D E E OF OF 주".split()))      # 낮 4 · 저녁 4 → 0
    scores, details = s._compute_nurse_scores({"a0": lop, "a1": even})
    assert (scores["a0"], scores["a1"]) == (-500, 0)
    assert [d["count"] for d in details["a0"] if d.get("name") == "낮·저녁 고르게"] == [5]
    plus = _engine("highs", LO, HI)(_request({}, scoring_rules=[_rule(score=100)]))
    assert plus._compute_nurse_scores({"a0": lop})[0]["a0"] == 0, "가점으로 두면 걸지 않는다"


def test_pool_leaves_out_keepers_one_sided_and_those_with_a_preference():
    req = _request({}, keeper={"a0": {"2026-11": True}})
    req.nurses[1].capable_shifts = ["DC", "D", "NC", "N"]                   # 저녁을 못 선다
    req.nurses[2].shift_prefs = {"E": {"pref": "avoid"}}                     # 저녁 기피 — 일부러 다르게 받는다
    pool = {n["id"] for n in _engine("highs", LO, HI)(req)._shift_balance_pool()}
    assert pool == {"a3", "a4", "a5", "a6"}


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_engine_evens_day_and_evening(engine):
    """매일 D2 E2 N1 · 7명 · 두 주 — 이 규칙만 걸면 누구도 낮과 저녁이 둘 넘게 차이 나지 않는다."""
    r = _engine(engine, LO, HI)(_request({}, scoring_rules=[_rule()], mip_gap=0.0)).solve()
    assert r["success"], r.get("message")
    got = _skew(r["schedule"])
    assert max(got.values()) <= 2, got
    if engine == "highs":   # 대조는 결정적인 HiGHS 로만 — CP-SAT 은 규칙이 없을 때의 표가 기계마다 다르다
        base = _engine(engine, LO, HI)(_request({}, mip_gap=0.0)).solve()
        assert sum(_skew(base["schedule"]).values()) > sum(got.values()), "규칙이 없으면 더 치우치는 입력이어야 검사가 된다"


def test_default_rules_and_migration(tmp_path, monkeypatch):
    """새 병동은 '낮·저녁 고르게'와 5일 연속 감점 셋을 받고, 옛 DB 에는 한 번만 넣는다 — 같은 조건이 이미 있으면 넣지 않고, 지운 것을 되살리지 않는다."""
    import json
    import sqlite3

    from server import database as db
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()
    path = db.get_db_path()
    names = ("낮·저녁 고르게", "같은 근무 5일 연속 (낮)", "같은 근무 5일 연속 (저녁)", "5일 연속 근무")

    def got():
        with sqlite3.connect(path) as c:
            return {n: (s, json.loads(p)) for n, s, p in c.execute(
                "SELECT name, score, params FROM scoring_rules WHERE rule_type='shift_balance' OR params LIKE '%\"day\", \"day\", \"day\"%' "
                "OR params LIKE '%\"evening\", \"evening\", \"evening\"%' OR params LIKE '%\"work\", \"work\", \"work\"%'")}

    new = got()
    assert set(new) == set(names) and new["낮·저녁 고르게"] == (-100, {"tolerance": 4}) and new["같은 근무 5일 연속 (낮)"][0] == -300 and new["5일 연속 근무"][0] == -100
    with sqlite3.connect(path) as c:      # 옛 DB — 낮 5일 연속만 손으로 만들어 둠(다른 이름·다른 점수), 나머지는 없음
        c.execute("DELETE FROM scoring_rules WHERE name IN (?,?,?)", names[:1] + names[2:])
        c.execute("UPDATE scoring_rules SET name='내가 만든 것', score=-50 WHERE name=?", (names[1],))
        c.execute("PRAGMA user_version = 6")
    db.init_db()
    after = got()
    assert set(after) == {"내가 만든 것", names[0], names[2], names[3]} and after["내가 만든 것"][0] == -50, "같은 조건이 있으면 넣지 않는다"
    with sqlite3.connect(path) as c:
        c.execute("DELETE FROM scoring_rules WHERE name=?", (names[0],))
    db.init_db()
    assert names[0] not in got(), "지운 규칙을 되살리지 않는다"

