"""원티드 '둘 중 하나'(D/E·E/N·D/N)·'N 빼고'(N제외) — 제1원칙 14 (2026-10-03, 101병동 원티드).

"D/E·E/N·DN 은 둘 중 아무거나, N제외는 N 만 아니면 됨" (원근). 한 근무로 정해진 칸이 아니라
허용 근무 집합이다. strict 에선 사전입력처럼 하드, 완화에선 근무 원티드(500)처럼 지키고
못 지키면 relaxed_cells 로 알린다. 두 엔진·진단·최소 수정 처방이 같은 뜻으로 읽는다.
"""
from __future__ import annotations

import pytest

from server.conflict_analyzer import suggest_correction
from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules
from server.scheduler import NurseScheduler

from .conftest import make_limited
from .test_exact_fit_characterization import PROD_SHIFTS

CAPS = ["DC", "D", "EC", "E", "NC", "N"]
# 원인 격리 — 주 OF·야간 규칙은 이 검사와 무관하다 (OF 는 얼마든지 쉴 수 있게)
ISO = dict(weeklyOff=False, noNOD=False, restAfterNight=False, maxConsecutiveNight=False,
           maxNightPerMonth=False, maxNightTwoMonth=False)
D2 = "2026-03-02"


def _req(d=0, e=0, n=0):
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=d, E=e, N=n))
    return req


def _request(pre, d=1, e=0, n=1, locked=None, boosts=None, relax=False):
    """3명 · 3/1~3/2 · 매일 D=d E=e N=n (차지 포함)."""
    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="male",
                    capable_shifts=CAPS, seniority=i) for i in range(3)]
    return GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=_req(d, e, n),
        rules=Rules(**ISO), prev_schedule=pre, shifts=PROD_SHIFTS, holidays=[],
        locked_cells=locked or {}, relax_boosts=boosts or {}, allow_pre_relax=relax,
        time_limit=60,
    )


def _solve(req, solver):
    return make_limited(req, days=2, solver=solver).solve()


# ── 읽기 ────────────────────────────────────────────────────────────────────


def test_flex_codes_leave_prev_and_aliases_normalize():
    req = _request({"a0": {D2: "DN", "2026-03-01": "D"}, "a1": {D2: "N 제외"},
                    "a2": {D2: "E/D"}})
    s = NurseScheduler(req)
    assert s.prev["a0"] == {"2026-03-01": "D"}           # 확정 칸만 남는다
    assert s.flex_pre == {"a0": {D2: "D/N"}, "a1": {D2: "N제외"}, "a2": {D2: "D/E"}}
    assert s._flex_allowed("D/E") == {"DC", "D", "EC", "E"}   # D1·중 은 아니다
    assert s._flex_allowed("E/N") == {"EC", "E", "NC", "N"}
    assert s._flex_allowed("D/N") == {"DC", "D", "NC", "N"}
    allowed = s._flex_allowed("N제외")
    assert "N" not in allowed and "NC" not in allowed
    assert {"OF", "주", "V", "D", "E", "D1", "중"} <= allowed     # 쉬어도 된다


# ── strict: 허용 근무만 ─────────────────────────────────────────────────────


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
@pytest.mark.parametrize("code,want", [("D/E", {"DC", "D"}), ("E/N", {"NC", "N"}),
                                       ("D/N", {"DC", "D", "NC", "N"})])
def test_one_of_picks_an_allowed_shift(solver, code, want):
    """a1 OF → a0·a2 가 D 하나·N 하나. a0 의 원티드가 어느 쪽인지 정한다."""
    r = _solve(_request({"a0": {D2: code}, "a1": {D2: "OF"}}), solver)
    assert r["success"], r["message"]
    assert r["schedule"]["a0"][D2] in want


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_n_exclude_works_day_instead(solver):
    r = _solve(_request({"a0": {D2: "N제외"}, "a1": {D2: "OF"}}), solver)
    assert r["success"], r["message"]
    assert r["schedule"]["a0"][D2] in ("DC", "D")
    assert r["schedule"]["a2"][D2] in ("NC", "N")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_n_exclude_may_rest(solver):
    """N 만 아니면 된다 — 쉬는 것도 지킨 것."""
    r = _solve(_request({"a0": {D2: "N제외"}, "a1": {D2: "D"}}, d=1, n=1), solver)
    assert r["success"], r["message"]
    assert r["schedule"]["a0"][D2] not in ("N", "NC")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_strict_one_of_unmet_is_infeasible(solver):
    """그 날 야간만 필요하고 둘이 OF → a0 가 N 이어야 하는데 D/E 원티드 — strict 는 실패."""
    r = _solve(_request({"a0": {D2: "D/E"}, "a1": {D2: "OF"}, "a2": {D2: "OF"}},
                        d=0, n=1), solver)
    assert not r["success"]


# ── 완화: 근무 원티드처럼 지키고, 못 지키면 알린다 ─────────────────────────


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_relax_breaks_flex_before_off_and_reports(solver):
    r = _solve(_request({"a0": {D2: "D/E"}, "a1": {D2: "OF"}, "a2": {D2: "OF"}},
                        d=0, n=1, relax=True), solver)
    assert r["success"], r["message"]
    assert r["schedule"]["a0"][D2] in ("NC", "N")          # OF(3000)보다 근무 원티드(500)를 판다
    cell = r["relaxed_cells"]["a0"][D2]
    assert cell["original"] == "D/E" and cell["is_timeoff"] is False
    assert r["timeoff_relaxed_count"] == 0
    assert not r["relaxed_cells"].get("a1") and not r["relaxed_cells"].get("a2")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_relax_n_exclude_report(solver):
    r = _solve(_request({"a0": {D2: "N제외"}, "a1": {D2: "OF"}, "a2": {D2: "N제외"}},
                        d=0, n=1, relax=True), solver)
    assert r["success"], r["message"]
    broken = {nid for nid, cells in r["relaxed_cells"].items() if D2 in cells}
    assert broken in ({"a0"}, {"a2"})
    nid = broken.pop()
    assert r["relaxed_cells"][nid][D2]["original"] == "N제외"
    assert r["schedule"][nid][D2] in ("NC", "N")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_relax_kept_flex_is_not_reported(solver):
    """지킨 원티드(E/N 에 N)는 완화 목록에도 차지 승격에도 들어가지 않는다."""
    r = _solve(_request({"a0": {D2: "E/N"}, "a1": {D2: "OF"}, "a2": {D2: "D"}},
                        relax=True), solver)
    assert r["success"], r["message"]
    assert r["schedule"]["a0"][D2] in ("NC", "N")
    assert not any(D2 in c for c in r.get("relaxed_cells", {}).values())


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_locked_flex_stays_hard_in_relax(solver):
    """a0 D/E 잠금 · a2 D (원티드 보정 ×3) · a1 OF — D 하나 N 하나라 둘 중 하나를 깨야 한다.
    잠기지 않았다면 싼 a0 를 깨겠지만 잠금이라 a2 를 깬다."""
    pre = {"a0": {D2: "D/E"}, "a1": {D2: "OF"}, "a2": {D2: "D"}}
    r = _solve(_request(pre, relax=True, boosts={"a2": 3.0}), solver)
    assert r["success"], r["message"]
    assert r["schedule"]["a0"][D2] in ("NC", "N")            # 잠금 없으면 a0 를 판다
    r = _solve(_request(pre, relax=True, boosts={"a2": 3.0},
                        locked={"a0": {D2: True}}), solver)
    assert r["success"], r["message"]
    assert r["schedule"]["a0"][D2] in ("DC", "D")
    assert r["schedule"]["a2"][D2] in ("NC", "N")
    assert r["relaxed_cells"]["a2"][D2]["original"] == "D"


# ── 최소 수정 처방 (MCS) ───────────────────────────────────────────────────


def test_suggest_correction_removes_flex_wish_first():
    """야간만 필요한 날 a0 D/E · a1·a2 OF → 근무 원티드(1)를 빼는 게 OF(30)보다 싸다."""
    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="male",
                    capable_shifts=CAPS, seniority=i) for i in range(3)]
    req = GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=_req(),
        rules=Rules(**ISO), shifts=PROD_SHIFTS, holidays=[],
        prev_schedule={"a0": {D2: "D/E"}, "a1": {D2: "OF"}, "a2": {D2: "OF"}},
        per_day_requirements={D2: {"D": 0, "E": 0, "N": 1}}, time_limit=60,
    )
    res = suggest_correction(req)
    assert res.get("fixable"), res
    assert "'D/E' 제거" in res["message"], res["message"]
    assert "(휴무)" not in res["message"]
