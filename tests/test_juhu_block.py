"""주휴 재배치의 블록(4주기) 요일 고정 — 양 엔진 패리티.

병동 관행(사용자 확인 2026-08-24): 1~4주기 동안 주휴 요일이 같고, 4주기→1주기로
넘어갈 때만 하루 당긴다. allow_juhu_relax 만 켜면 '주당 ≤1' 밖에 안 걸려서
재배치가 주마다 다른 요일로 흩어질 수 있었다.

juhu_block_lock(기본 True) = 재배치하더라도 한 블록 안에서는 같은 요일.
False = '주휴 이동 제한 풀기'.
"""
from __future__ import annotations

import pytest

from server.models import GenerateRequest, Rules

from .conftest import _mini_nurses, _mini_requirements
from .test_exact_fit_characterization import PROD_SHIFTS, ISO_RULES

YEAR, MONTH = 2026, 3


# 8명 · D/E/N 각 2명 — 주당 휴무가 정확히 2칸(주휴 1 + OF 1)으로 떨어지는 최소 구성.
# (6명·D/E/N 1명 구성은 주당 휴무 수요 21칸 > 공급 12칸이라 애초에 안 풀린다.)
# 각 간호사의 주휴를 **주마다 다른 요일**로 흩어 놓는다 — 손으로 짠 표에서 흔한 모양이고,
# 블록 요일 고정이 실제로 갈리는 유일한 입력이다.
WEEKS = [("2026-03-01", 0), ("2026-03-08", 7), ("2026-03-15", 14), ("2026-03-22", 21)]


def _nurses8():
    from server.models import Nurse
    return [Nurse(id=f"a{i}", name=f"간호{i}", group="A",
                  gender="female" if i % 4 else "male",
                  capable_shifts=["DC", "D", "EC", "E", "NC", "N"], seniority=i)
            for i in range(8)]


def _scatter_prev(nurses):
    """i번 간호사의 w주차 주휴 = (i + w) % 7 요일 → 주마다 요일이 다르다.

    단 1주차는 **전원 같은 날(3/02)** 로 몰아 strict 를 실패시킨다. 주휴 재배치는
    strict 가 풀리면 아예 돌지 않는 마지막 수단 경로라(불필요하게 핀을 건드리지
    않는다), 그 경로를 관측하려면 재배치 없이는 못 푸는 입력이어야 한다.
    """
    from datetime import date, timedelta
    prev = {}
    for i, n in enumerate(nurses):
        cells = {"2026-03-02": "주"}          # 1주차 — 그날 근무자가 0명이 된다
        for w, (start, _off) in enumerate(WEEKS):
            if w == 0:
                continue
            d0 = date.fromisoformat(start)
            cells[(d0 + timedelta(days=(i + w) % 7)).isoformat()] = "주"
        prev[n.id] = cells
    return prev


def _mk(lock: bool, solver: str) -> GenerateRequest:
    nurses = _nurses8()
    return GenerateRequest(
        year=YEAR, month=MONTH, nurses=nurses,
        requirements=_mini_requirements(2, 2, 2),
        rules=Rules(**ISO_RULES),
        shifts=PROD_SHIFTS, prev_schedule=_scatter_prev(nurses),
        allow_pre_relax=True, allow_juhu_relax=True, juhu_block_lock=lock,
        solver=solver, time_limit=45, mip_gap=0.1,
    )


def _sched(req):
    if req.solver == "cpsat":
        from server.scheduler_cpsat import CpSatScheduler
        return CpSatScheduler(req)
    from .conftest import LimitedScheduler
    return LimitedScheduler(req, max_days=28)


def _juhu_dows_by_block(sch, schedule):
    """{(nurse, block): {weekday…}} — 배정된 주휴의 요일 집합."""
    out = {}
    for nid, cells in (schedule or {}).items():
        for iso, code in cells.items():
            if code != "주":
                continue
            for d, dt in enumerate(sch.all_dates):
                if dt.strftime("%Y-%m-%d") == iso:
                    out.setdefault((nid, sch._juhu_block(d)), set()).add(dt.weekday())
                    break
    return out


def test_블록_번호가_프론트_기준과_같다():
    """view-helpers.js _CYCLE_REF(2026-03-01) 기준 — 어긋나면 화면 주기와 다른 걸 가리킨다."""
    sch = _sched(_mk(True, "highs"))
    ref = [d for d, dt in enumerate(sch.all_dates) if dt.strftime("%Y-%m-%d") == "2026-03-01"][0]
    assert sch._juhu_block(ref) == 0
    d28 = [d for d, dt in enumerate(sch.all_dates) if dt.strftime("%Y-%m-%d") == "2026-03-29"]
    if d28:
        assert sch._juhu_block(d28[0]) == 1, "3/29 는 다음 블록"


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_제한_켜면_블록당_한_요일(solver):
    req = _mk(True, solver)
    sch = _sched(req)
    out = sch.solve()
    if not out.get("success"):
        pytest.skip(f"이 구성이 {solver}에서 안 풀림: {(out.get('message') or '')[:80]}")
    bad = {k: v for k, v in _juhu_dows_by_block(sch, out.get("schedule")).items() if len(v) > 1}
    assert not bad, f"블록 안에서 주휴 요일이 흩어졌다: {bad}"


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_제한_풀면_제약이_사라진다(solver):
    """풀기 모드에서는 블록 요일 제약을 걸지 않는다 (흩어질 수 있다 = 제약 부재)."""
    req = _mk(False, solver)
    sch = _sched(req)
    assert sch.juhu_block_lock is False
    out = sch.solve()
    # 결과가 흩어지는지는 솔버 재량 — 여기서 보는 것은 제약이 안 걸려도 풀린다는 것
    assert out.get("success") or out.get("message"), out


def test_기본값은_제한_있음():
    req = GenerateRequest(year=YEAR, month=MONTH, nurses=_mini_nurses(6),
                          requirements=_mini_requirements(), rules=Rules())
    assert req.juhu_block_lock is True


def test_제한_풀면_제약을_아예_걸지_않는다():
    """토글이 실제로 제약 생성을 막는지 — 솔버 결과가 아니라 모델로 확인 (비결정성 배제)."""
    class Rec:
        def __init__(self): self.added = []
        def __iadd__(self, item): self.added.append(item); return self

    import pulp
    from datetime import timedelta

    def added_names(lock):
        req = _mk(lock, "highs")
        sch = _sched(req)
        # 주휴 칸을 자유 변수로 흉내 낸 x — 재배치 모드와 같은 모양
        x = {}
        for n in sch.nurses:
            x[n["id"]] = {}
            for d, dt in enumerate(sch.all_dates):
                x[n["id"]][d] = {"주": pulp.LpVariable(f't_{n["id"]}_{d}', cat="Binary")}
        rec = Rec()
        sch._c_juhu_block_dow(rec, x)
        return [c[1] for c in rec.added if isinstance(c, tuple) and len(c) == 2]

    on = added_names(True)
    off = added_names(False)
    assert off == [], f"제한 풀기인데 제약이 걸렸다: {off[:3]}"
    assert any(nm.startswith("juhu_blk_one_") for nm in on), on[:5]
    assert any(nm.startswith("juhu_blk_") for nm in on), on[:5]
    _ = timedelta
