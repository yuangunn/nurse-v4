"""한 사람의 1오프 한도 — 앞뒤가 근무인 하루짜리 휴무를 사람마다 N개까지 (결정 1-98). 기본은 꺼 둔다.

퐁당퐁당 감점은 1오프의 합만 줄여, 제약이 가장 적은 줄이 남는 쉬는 자리를 다 받았다(실제 12월: 한 줄에 5~6개).
사람마다 넘는 수를 깎는 감점도 넣어 봤지만 '최고와 2% 안'에 묻혀 분포가 그대로였다 — 그래서 꼭 지키는 규칙으로 둔다.

이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

from datetime import date

import pytest

from server.models import Rules

from .test_month_tail import _engine, _request

LO, HI = date(2026, 11, 29), date(2026, 12, 5)


def _solve(engine, cap=None, prev=None):
    req = _request(prev or {}, mip_gap=0.0)
    if cap is not None:
        req.rules.maxOneOff, req.rules.maxOneOffCount = True, cap
    s = _engine(engine, LO, HI)(req)
    r = s.solve()
    assert r["success"], r.get("message")
    work, rest = set(s._resolve_group("work")), set(s._resolve_group("rest_leave"))
    ones = []
    for n in s.nurses:
        row = r["schedule"][n["id"]]
        code = lambda d: row.get(s.all_dates[d].isoformat(), "")
        ones.append(sum(1 for a, b, c in s._oneoff_windows(n["id"])
                        if code(a) in work and code(b) in rest and code(c) in work))
    return ones, r


def test_off_by_default():
    assert Rules().maxOneOff is False and Rules().maxOneOffCount == 3


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_engine_keeps_the_cap(engine):
    """매일 D2 E2 N1 · 7명 — 한도가 없으면 한 사람에게 둘·셋이 나오고, 한도 1 이면 누구도 하나를 넘지 않는다."""
    ones, r = _solve(engine, cap=1)
    assert max(ones) <= 1, ones
    assert not r.get("relaxed_cells")
    assert max(_solve(engine)[0]) > 1, "한도가 없으면 넘는 입력이어야 검사가 된다"


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_ones_the_user_fixed_are_not_counted(engine):
    """D 주 D OF D 를 사전입력으로 정해 두면 1오프가 둘 — 한도 0 이어도 표가 나오고 그 칸은 그대로다. 규칙과 다르다는 안내만 낸다."""
    fixed = {"2026-11-29": "D", "2026-11-30": "주", "2026-12-01": "D", "2026-12-02": "OF", "2026-12-03": "D"}
    ones, r = _solve(engine, cap=0, prev={"a0": dict(fixed)})
    assert ones == [2, 0, 0, 0, 0, 0, 0], ones
    got = {k: r["schedule"]["a0"][k].replace("DC", "D") for k in fixed}     # 차지(DC)는 같은 낮 근무
    assert got == fixed and not r.get("relaxed_cells")
    assert any("1오프 2개 (생성 규칙은 ≤0개)" in n for n in r.get("pinned_notes") or []), r.get("pinned_notes")
