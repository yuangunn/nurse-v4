"""
공유 pytest 픽스처.

LimitedScheduler를 사용해 작은 문제(<=14일, <=6 간호사)로 빠르게 회귀 검증.
실제 솔버를 호출하므로 케이스당 수 초 ~ 수십 초 소요.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

import pytest

from server.models import (
    DayRequirement,
    GenerateRequest,
    Nurse,
    Requirements,
    Rules,
)
from server.scheduler import NurseScheduler


class _LimitedMixin:
    """월 전체 대신 max_days 일만 커버하도록 _build_date_range를 윈도잉.
    엔진 무관 — HiGHS/CP-SAT 스케줄러 어느 쪽에든 믹스인.
    (_max_days는 __init__에서 super().__init__ 호출 전에 세팅되어야 함)"""

    def _build_date_range(self):
        super()._build_date_range()
        first = date(self.year, self.month, 1)
        cutoff = first + timedelta(days=self._max_days)
        self.all_dates = [d for d in self.all_dates if first <= d < cutoff]
        self.T = len(self.all_dates)
        self.date_to_idx = {d: i for i, d in enumerate(self.all_dates)}
        self.weeks = [(ws, we) for ws, we in self.weeks if we < self.T]


class LimitedScheduler(_LimitedMixin, NurseScheduler):
    """HiGHS 윈도잉 스케줄러 (하위호환 이름)."""

    def __init__(self, request: GenerateRequest, max_days: int = 7):
        self._max_days = max_days
        super().__init__(request)


def make_limited(request: GenerateRequest, days: int = 7, solver: str = "highs"):
    """solver별 윈도잉 스케줄러 생성. cpsat는 CpSatScheduler 구현 전까지 skip."""
    if solver == "highs":
        return LimitedScheduler(request, max_days=days)
    if solver == "cpsat":
        try:
            from server.scheduler_cpsat import CpSatScheduler
        except ImportError:
            import pytest
            pytest.skip("CpSatScheduler 미구현 (Phase 4)")

        class LimitedCpSat(_LimitedMixin, CpSatScheduler):
            def __init__(self, req: GenerateRequest, max_days: int = 7):
                self._max_days = max_days
                super().__init__(req)

        return LimitedCpSat(request, max_days=days)
    raise ValueError(f"unknown solver: {solver}")


def _mini_nurses(n: int = 6) -> list[Nurse]:
    """seniority 0번이 가장 선임, 수석 charge 가능자."""
    data = [
        ("a0", "*시니어A", "A", "female", 0),
        ("a1", "*간호1", "A", "female", 1),
        ("a2", "*간호2", "A", "female", 2),
        ("a3", "*간호3", "A", "male", 3),
        ("a4", "*간호4", "A", "female", 4),
        ("a5", "*간호5", "A", "male", 5),
    ][:n]
    return [
        Nurse(
            id=nid,
            name=name,
            group=grp,
            gender=gen,
            capable_shifts=["DC", "D", "EC", "E", "NC", "N"],
            seniority=sen,
        )
        for nid, name, grp, gen, sen in data
    ]


def _mini_requirements(d: int = 1, e: int = 1, n: int = 1) -> Requirements:
    """모든 요일 동일 요구 (D=1, E=1, N=1) — 6명 7일에 풀이 가능한 최소 구성.

    6명 × 7일 = 42 셀. 주휴 6 + OF 6 = 12 휴무, 30 근무 셀로 7일×3 = 21 demand 커버.
    """
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=d, E=e, N=n))
    return req


def _juhu_prev(nurses: list[Nurse], year: int, month: int, days: int) -> dict:
    """간호사별 (id 인덱스 % 7) 요일에 주휴 사전 고정."""
    prev: dict[str, dict[str, str]] = {}
    first = date(year, month, 1)
    for nurse in nurses:
        idx = int(nurse.id[1:]) if nurse.id[1:].isdigit() else 0
        joo_wd = idx % 7
        prev[nurse.id] = {}
        for i in range(days):
            d = first + timedelta(days=i)
            if d.weekday() == joo_wd:
                prev[nurse.id][d.strftime("%Y-%m-%d")] = "주"
    return prev


@pytest.fixture
def build_request():
    """파라미터 가능한 GenerateRequest 빌더."""

    def _build(
        nurses: Optional[list[Nurse]] = None,
        rules: Optional[Rules] = None,
        requirements: Optional[Requirements] = None,
        prev_schedule: Optional[dict] = None,
        year: int = 2026,
        month: int = 3,
        days: int = 7,
        add_juhu: bool = True,
    ) -> GenerateRequest:
        nurses = nurses or _mini_nurses(6)
        rules = rules or Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1)
        requirements = requirements or _mini_requirements()
        if prev_schedule is None and add_juhu:
            prev_schedule = _juhu_prev(nurses, year, month, days)
        return GenerateRequest(
            year=year,
            month=month,
            nurses=nurses,
            requirements=requirements,
            rules=rules,
            prev_schedule=prev_schedule or {},
        )

    return _build


@pytest.fixture
def solve_small():
    """빌더 → 윈도잉 스케줄러.solve() 결과 반환. solver 인자로 엔진 선택."""

    def _solve(request: GenerateRequest, days: int = 7, solver: str = "highs") -> dict:
        return make_limited(request, days=days, solver=solver).solve()

    return _solve


@pytest.fixture
def small_nurses():
    return _mini_nurses


@pytest.fixture
def small_requirements():
    return _mini_requirements
