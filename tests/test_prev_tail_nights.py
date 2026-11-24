"""전월N 을 이 달 표에 함께 보이는 지난달 칸(사전입력)에 맞춘다 (결정 1-104).

전월N 은 지난달 저장본에서 센다. 표의 지난달 칸(그 주 일요일~말일)을 사전입력에서 실제로 선 근무로 고치면 저장본과 어긋난다 —
11/29 를 N 으로 고쳐 11월 야간이 5회인데 4회로 세어, 두 달 합산 한도 10 에서 12월에 6회를 줬다(합 11회 = 수면오프).

이름은 가명, 자료는 모두 지어낸 것.
"""
from __future__ import annotations

from server import api
from server import database as db
from server.models import GenerateRequest, Nurse, Requirements, Rules


def _req(pre, nights):
    return GenerateRequest(year=2026, month=12, nurses=[Nurse(id="a", name="간호01"), Nurse(id="b", name="간호02")],
                           requirements=Requirements(), rules=Rules(maxNightTwoMonth=True), prev_schedule=pre, prev_month_nights=nights)


def test_edited_tail_cells_change_the_count(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()
    nov = {"a": {"2026-11-10": "N", "2026-11-11": "N", "2026-11-29": "D", "2026-11-30": "N"},      # 저장본: 11월 야간 3회
           "b": {"2026-11-29": "N", "2026-11-30": "N"}}                                                # 2회
    db.save_schedule(2026, 11, {"schedule": nov}, "11월")
    assert db.compute_prev_month_nights(2026, 12) == {"a": 3, "b": 2}
    # a: 11/29 를 N 으로 고침(+1) · b: 11/29 를 OF 로 고침(-1), 11/30 칸은 비움(저장본 그대로)
    pre = {"a": {"2026-11-29": "N", "2026-11-30": "N", "2026-12-03": "N"}, "b": {"2026-11-29": "OF"}}
    assert db.prev_month_tail_night_delta(2026, 12, pre) == {"a": 1, "b": -1}
    req = _req(pre, {"a": 3, "b": 2})
    assert sorted(api._attach_prev_tail_nights(req)) == [("a", 3, 4), ("b", 2, 1)]
    assert req.prev_month_nights == {"a": 4, "b": 1}
    # 전월N 을 사람이 직접 적어 둔 값(저장본과 다름)은 그대로 둔다 — 두 번 더하지 않는다
    req = _req(pre, {"a": 4, "b": 2})
    assert api._attach_prev_tail_nights(req) == [("b", 2, 1)] and req.prev_month_nights["a"] == 4
    # 고친 칸이 없으면 아무것도 바꾸지 않는다 · 규칙이 꺼져 있어도
    same = {"a": {"2026-11-29": "D", "2026-11-30": "N"}}
    assert api._attach_prev_tail_nights(_req(same, {"a": 3})) == []
    off = _req(pre, {"a": 3, "b": 2}); off.rules.maxNightTwoMonth = False
    assert api._attach_prev_tail_nights(off) == []


def test_month_that_starts_on_sunday_has_no_tail(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()
    db.save_schedule(2026, 10, {"schedule": {"a": {"2026-10-31": "N"}}}, "10월")
    assert db.prev_month_tail_night_delta(2026, 11, {"a": {"2026-10-31": "D"}}) == {}      # 2026-11-01 은 일요일 — 표에 지난달 칸이 없다
