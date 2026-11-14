"""간호사 그룹 — 한 근무에 그룹원 최대·최소 n명 (2026-11-12).

한 사람이 여러 그룹에 속할 수 있다(팀 = Nurse.group 과 따로). 그룹마다 '한 근무(D·D1 / E·중 / N)에 n명까지'
(1명 = 같이 일하지 않기)·'n명 이상'을 건다. 하드가 아니라 사람 하나마다 감점(_GROUP_LIMIT_PENALTY) —
그룹 때문에 생성이 막히지 않고, 사람이 넣은 칸은 그대로 둔다.

이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from .test_month_tail import _engine, _request

LO, HI = date(2026, 11, 29), date(2026, 12, 5)
KEYS = [(LO + timedelta(i)).isoformat() for i in range((HI - LO).days + 1)]
PERIODS = {"D": ("DC", "D"), "E": ("EC", "E"), "N": ("NC", "N")}


def _req(groups, prev=None, **kw):
    r = _request(prev or {}, mip_gap=0.0, **kw)
    r.rules.nurseGroups = groups
    return r


def _counts(sch, nids):
    """[(날, 시간대, 그 근무에 선 그룹원 수)]"""
    return [(k, p, sum(1 for n in nids if sch[n].get(k) in codes)) for k in KEYS for p, codes in PERIODS.items()]


def test_limits_skip_unknown_members_bad_bounds_and_clamp_min_to_active():
    s = _engine("highs", LO, HI)(_req([
        {"name": "넷", "members": ["a0", "a1", "a1", "zz"], "maxPerShift": 1},   # 없는 사람·겹친 이름은 뺀다
        {"name": "작은", "members": ["a2"], "maxPerShift": 1},                   # 혼자면 넘을 수 없다
        {"name": "글자", "members": ["a3", "a4"], "maxPerShift": "1"},            # 화면 입력이 글자로 와도
        {"name": "빈", "members": ["a3", "a4"], "maxPerShift": None, "minPerShift": ""},
        {"name": "최소", "members": ["a5", "a6"], "minPerShift": 3},             # 둘뿐이면 2명까지만
    ]))
    lim = s._nurse_group_limits()
    by = {}
    for kind, bound, nids, d, codes in lim:
        by.setdefault((kind, bound, tuple(nids)), set()).add(d)
    assert set(by) == {("max", 1, ("a0", "a1")), ("max", 1, ("a3", "a4")), ("min", 2, ("a5", "a6"))}, by
    assert all(len(v) == len(KEYS) for v in by.values())
    assert len(lim) == 3 * 3 * len(KEYS)                       # 그룹 셋 × 시간대 셋 × 날


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_max_one_keeps_group_members_off_the_same_shift(engine):
    """같이 일하지 않기 — 셋이 한 근무에 둘 이상 서지 않는다 (짤 수 있는 입력)."""
    nids = ["a0", "a1", "a2"]
    r = _engine(engine, LO, HI)(_req([{"name": "신규", "members": nids, "maxPerShift": 1}])).solve()
    assert r["success"], r.get("message")
    bad = [c for c in _counts(r["schedule"], nids) if c[2] > 1]
    assert bad == [], bad
    if engine == "highs":   # 규칙이 없으면 겹치는 입력이어야 검사가 된다 (대조는 결정적인 HiGHS 로만)
        base = _engine(engine, LO, HI)(_req([])).solve()
        assert any(c[2] > 1 for c in _counts(base["schedule"], nids))


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_min_one_puts_a_member_on_every_shift(engine):
    nids = ["a0", "a1", "a2", "a3", "a4"]
    r = _engine(engine, LO, HI)(_req([{"name": "자격", "members": nids, "minPerShift": 1}])).solve()
    assert r["success"], r.get("message")
    bad = [c for c in _counts(r["schedule"], nids) if c[2] < 1]
    assert bad == [], bad
    if engine == "highs":
        base = _engine(engine, LO, HI)(_req([])).solve()
        assert any(c[2] < 1 for c in _counts(base["schedule"], nids))


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_pinned_cells_win_over_the_group_rule(engine):
    """사람이 넣은 칸은 사실 — 둘 다 11/30 D 로 넣었으면 그 시간대 그대로 내고 생성은 막히지 않는다. 나머지 날은 지킨다."""
    nids = ["a0", "a1"]
    prev = {"a0": {"2026-11-30": "D"}, "a1": {"2026-11-30": "D"}}
    r = _engine(engine, LO, HI)(_req([{"name": "짝", "members": nids, "maxPerShift": 1}], prev)).solve()
    assert r["success"], r.get("message")
    sch = r["schedule"]
    assert sch["a0"]["2026-11-30"] in PERIODS["D"] and sch["a1"]["2026-11-30"] in PERIODS["D"]   # 차지로 올라갈 수는 있다
    bad = [c for c in _counts(sch, nids) if c[2] > 1]
    assert bad == [("2026-11-30", "D", 2)], bad
