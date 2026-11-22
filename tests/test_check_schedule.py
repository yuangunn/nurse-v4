"""완성된 근무표를 규칙과 견주는 창구 /api/check_schedule — 근무 교환 검사가 쓴다 (결정 1-90)."""
from __future__ import annotations

from server.api import CheckScheduleRequest, check_schedule
from server.models import Rules
from tests.conftest import _mini_nurses, _mini_requirements


def _req(schedule, prev=None):
    return CheckScheduleRequest(year=2026, month=12, nurses=_mini_nurses(3), requirements=_mini_requirements(),
                                rules=Rules(maxConsecutiveWorkDays=5), prev_schedule=prev, schedule=schedule)


def test_notes_only_for_what_breaks(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    db.init_db()
    ok = {"a0": {"2026-12-08": "D", "2026-12-09": "E"}, "a1": {"2026-12-08": "E", "2026-12-09": "N"}}
    assert check_schedule(_req(ok))["notes"] == []
    # a0 과 a1 이 12/9 를 맞바꾸면 a1 은 E→E, a0 은 D→N — 문제 없음. 12/10 까지 넣어 N→D 를 만들면 걸린다
    bad = {"a0": {"2026-12-08": "D", "2026-12-09": "N", "2026-12-10": "D"}}
    notes = check_schedule(_req(bad))["notes"]
    assert any("N" in n and "D" in n and "전환" in n for n in notes), notes


def test_history_comes_from_prev_schedule(tmp_path, monkeypatch):
    """지난달 칸은 사전입력의 기록 — 11/30 N 다음 12/1 D 는 걸린다. 표에 지난달 칸을 다시 싣지 않아도."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    db.init_db()
    notes = check_schedule(_req({"a0": {"2026-12-01": "D"}}, prev={"a0": {"2026-11-30": "N"}}))["notes"]
    assert any("12/01" in n and "전환" in n for n in notes), notes
    assert check_schedule(_req({"a0": {"2026-12-01": "OF"}}, prev={"a0": {"2026-11-30": "N"}}))["notes"] == []
