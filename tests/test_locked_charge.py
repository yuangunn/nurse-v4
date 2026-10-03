"""잠긴 D·E·N 은 완화에서도 차지로 올릴 수 있다 (2026-10-03, 제1원칙 11).

병동 번표엔 누가 차지인지 없다. 실제 번표를 붙여 넣고 첫 며칠을 🔒 잠그면 그 날은 D·E·N 뿐이라,
잠긴 칸을 글자 그대로 묶던 완화는 '차지 정확히 1명'을 못 채워 늘 실패했다 (strict 는 사람이 넣은
칸에 D→DC 승격을 허용하고, 꽉 찬 날은 사실-클램프로 넘긴다). 잠긴 칸이 지키는 것은 '그 시간대 근무'다.
"""
from __future__ import annotations

from datetime import date

import pytest

from server.conflict_analyzer import _ConflictAnalyzer

from .conftest import _LimitedMixin, make_limited
from .test_last_resort import _request

CAPS = ["DC", "D", "EC", "E", "NC", "N"]


def _locked_day_request(per_day, pre, locked, nurse_n=2):
    """3/1(일) 모두 주휴. 3/3 은 모두 D 여야 하는데 막내가 OF 를 원한다 → strict 실패 → 완화."""
    pre = {f"a{i}": {"2026-03-01": "주", **pre.get(f"a{i}", {})} for i in range(nurse_n)}
    per_day = {"2026-03-03": {"D": nurse_n, "E": 0, "N": 0}, **per_day}
    req = _request(nurse_n, pre, per_day=per_day)
    req.allow_pre_relax = True
    req.locked_cells = locked
    return req


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_locked_day_shift_becomes_charge_in_relax(solver):
    """3/2 은 D 1명 = 차지. 그 사람(a0)의 D 가 잠겨 있어도 DC 로 올려 완화가 성공한다."""
    req = _locked_day_request({"2026-03-02": {"D": 1, "E": 0, "N": 0}},
                              {"a0": {"2026-03-02": "D"}, "a1": {"2026-03-03": "OF"}},
                              {"a0": {"2026-03-02": True}})
    r = make_limited(req, days=3, solver=solver).solve()
    assert r["success"], r["message"]
    assert r["schedule"]["a0"]["2026-03-02"] == "DC"
    # 차지 승격은 원티드 미반영이 아니다 — 뒤집힌 것은 a1 의 3/3 OF 하나
    assert r["relaxed_cells"] == {"a1": {"2026-03-03": {
        "original": "OF", "assigned": r["schedule"]["a1"]["2026-03-03"], "is_timeoff": True}}}


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_fully_locked_pasted_day_gets_its_charges(solver):
    """붙여 넣은 번표처럼 차지 표시 없이 꽉 잠근 날 — 낮·저녁 차지를 그 안에서 고른다.
    (3/3 은 저녁 2명 — E→D 역순을 피해 a1 의 OF 원티드만 걸리게)"""
    pre = {"a0": {"2026-03-02": "D"}, "a1": {"2026-03-02": "E", "2026-03-03": "OF"}}
    locked = {"a0": {"2026-03-02": True}, "a1": {"2026-03-02": True}}
    req = _locked_day_request({"2026-03-02": {"D": 1, "E": 1, "N": 0},
                               "2026-03-03": {"D": 0, "E": 2, "N": 0}}, pre, locked)
    r = make_limited(req, days=3, solver=solver).solve()
    assert r["success"], r["message"]
    assert (r["schedule"]["a0"]["2026-03-02"], r["schedule"]["a1"]["2026-03-02"]) == ("DC", "EC")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_locked_day_charge_goes_to_the_senior(solver):
    """잠긴 D 두 명 중 차지는 선임(a1) — 승격을 열면서 시니어리티도 다시 건다 (제1원칙 9)."""
    pre = {"a0": {"2026-03-02": "OF"}, "a1": {"2026-03-02": "D"},
           "a2": {"2026-03-02": "D", "2026-03-03": "OF"}}
    locked = {nid: {"2026-03-02": True} for nid in ("a0", "a1", "a2")}
    req = _locked_day_request({"2026-03-02": {"D": 2, "E": 0, "N": 0}}, pre, locked, nurse_n=3)
    r = make_limited(req, days=3, solver=solver).solve()
    assert r["success"], r["message"]
    assert (r["schedule"]["a1"]["2026-03-02"], r["schedule"]["a2"]["2026-03-02"]) == ("DC", "D")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_locked_charge_chosen_by_hand_stays(solver):
    """사람이 후임(a2)에게 DC 를 잠가 두면 그대로 — 선임(a1)의 잠긴 D 는 D."""
    pre = {"a0": {"2026-03-02": "OF"}, "a1": {"2026-03-02": "D"},
           "a2": {"2026-03-02": "DC", "2026-03-03": "OF"}}
    locked = {nid: {"2026-03-02": True} for nid in ("a0", "a1", "a2")}
    req = _locked_day_request({"2026-03-02": {"D": 2, "E": 0, "N": 0}}, pre, locked, nurse_n=3)
    r = make_limited(req, days=3, solver=solver).solve()
    assert r["success"], r["message"]
    assert (r["schedule"]["a1"]["2026-03-02"], r["schedule"]["a2"]["2026-03-02"]) == ("D", "DC")


def test_locked_domain_keeps_what_the_ward_decided():
    s = make_limited(_request(2, {}), days=3)
    n = next(x for x in s.nurses if x["id"] == "a0")
    mar2 = date(2026, 3, 2)
    assert s._locked_domain(n, mar2, "D") == {"D", "DC"}
    assert s._locked_domain(n, mar2, "N") == {"N", "NC"}
    assert s._locked_domain(n, mar2, "DC") == {"DC"}            # 사람이 고른 차지는 그대로
    assert s._locked_domain(n, mar2, "OF") == {"OF"}
    assert s._locked_domain(n, date(2026, 2, 28), "D") == {"D"}  # 지난달 기록은 과거
    plain = dict(n, capable_shifts=["D", "E", "N"])
    assert s._locked_domain(plain, mar2, "D") == {"D"}           # 차지 자격 없음
    no_day = dict(n, capable_shifts=["DC", "E", "N"])
    assert s._locked_domain(no_day, mar2, "D") == {"D"}          # 그 근무 자격이 없으면 손대지 않는다
    keeper = dict(n, night_months={"2026-03": True}, is_night_shift=True)
    assert s._locked_domain(keeper, mar2, "N") == {"N", "NC"}
    assert s._locked_domain(keeper, mar2, "D") == {"D"}          # 나이트킵의 낮 근무는 달 규칙이 막는다


def test_correction_does_not_blame_the_locked_charge_day():
    """처방(최소 수정집합)도 같은 모델 — 3/2 차지를 '인원 부족'으로 보고하지 않는다."""

    class _Limited(_LimitedMixin, _ConflictAnalyzer):
        def __init__(self, req):
            self._max_days = 3
            super().__init__(req)

    req = _locked_day_request({"2026-03-02": {"D": 1, "E": 0, "N": 0}},
                              {"a0": {"2026-03-02": "D"}, "a1": {"2026-03-03": "OF"}},
                              {"a0": {"2026-03-02": True}})
    res = _Limited(req).suggest_correction()
    assert not any(f["date"] == "2026-03-02" for f in res.get("shortfalls", [])), res["message"]


def test_keeper_wish_on_next_month_days_follows_relax_toggle():
    """완화를 켰으면 다음 달 나이트킵의 사전입력 D 도 달 안과 같이 규칙 앞에서 풀린다."""
    from .test_keeper_by_month import _request as keeper_request
    from server.scheduler import NurseScheduler
    req = keeper_request({"2026-10": True})
    s = NurseScheduler(req)
    n = next(x for x in s.nurses if x["id"] == "a3")
    assert not s._keeper_forbids(n, date(2026, 10, 1), "D", pre="D")
    req.allow_pre_relax = True
    s = NurseScheduler(req)
    n = next(x for x in s.nurses if x["id"] == "a3")
    assert s._keeper_forbids(n, date(2026, 10, 1), "D", pre="D")
    assert not s._keeper_forbids(n, date(2026, 10, 1), "N", pre="D")

