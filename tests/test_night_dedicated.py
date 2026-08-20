"""야간전담(14일·N/NC only) + 생리휴가 캡 단위 테스트 — 후보 C.

'당월 정확히 14 야간' 규칙은 월 전체가 필요하다(7일 윈도잉 LimitedScheduler로는
14를 채울 수 없어 항상 infeasible). 그래서 일별 수요 제약 없이 해당 제약만 격리한
서브모델을 직접 풀어 핵심 규칙을 검증한다:
  - 야간전담: N/NC만, 주간/이브닝 0, 당월 정확히 14 야간
  - 생휴는 강제하지 않는다 — "월 1회 주어질 수 있다"일 뿐 보장이 아님
    (2026-08-19 사용자 원칙, decisions.md). 월 ≤1 상한만 (_cs_menstrual_leave)
"""
from __future__ import annotations

import pytest
from ortools.sat.python import cp_model

from server.models import GenerateRequest, Nurse, Requirements, Rules
from server.scheduler_cpsat import CpSatScheduler


def _night_request(gender: str) -> GenerateRequest:
    """31일 달(2026-03)에 야간전담 1명 + 비교용 정규 여성 1명."""
    nurses = [
        Nurse(id="a0", name="야간전담", group="A", gender=gender,
              capable_shifts=["NC", "N", "DC", "D", "EC", "E"], is_night_shift=True),
        Nurse(id="a1", name="정규", group="A", gender="female",
              capable_shifts=["DC", "D", "EC", "E", "NC", "N"]),
    ]
    return GenerateRequest(
        year=2026, month=3, nurses=nurses,
        requirements=Requirements(),  # 서브모델에 일별 수요 제약을 넣지 않으므로 미사용
        rules=Rules(),
        prev_schedule={},
    )


def _solve_night_only(req: GenerateRequest):
    """'1일 1근무 + 야간전담 + 생 월상한' 만 건 격리 서브모델."""
    sch = CpSatScheduler(req)
    model = cp_model.CpModel()
    x = sch._build_vars(model)
    sch._cs_one_shift_per_day(model, x)
    sch._cs_night_shift_nurses(model, x)
    sch._cs_menstrual_leave(model, x)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 30
    solver.parameters.num_workers = 8
    status = solver.Solve(model)
    return sch, solver, x, status


def _month_idxs(sch) -> list[int]:
    """all_dates에는 인접월 lookahead가 섞여 있으므로 당월 날짜 인덱스만 추린다
    (야간전담·생휴 제약은 모두 '당월'에만 적용되기 때문)."""
    return [d for d, dt in enumerate(sch.all_dates)
            if dt.month == sch.month and dt.year == sch.year]


def _count(sch, solver, x, nid, codes, days=None) -> int:
    """nid가 codes 근무에 배정된 총 횟수(고정 int 0 셀 제외). days 미지정 시 당월."""
    days = _month_idxs(sch) if days is None else days
    return sum(solver.Value(x[nid][d][s])
               for d in days for s in codes
               if not isinstance(x[nid][d][s], int))


def test_night_dedicated_female_14_nights_menstrual_not_forced():
    """여성 야간전담: 정확히 14 야간 + 주간/이브닝 0.
    생은 강제되지 않는다(보장 아님) — 월 ≤1 상한만."""
    sch, solver, x, status = _solve_night_only(_night_request("female"))
    assert status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    nights = _count(sch, solver, x, "a0", sch.NIGHT_SHIFTS)
    day_eve = _count(sch, solver, x, "a0", sch.DAY_SHIFTS + sch.EVENING_SHIFTS)
    saeng = _count(sch, solver, x, "a0", ["생"])
    assert nights == 14, f"야간전담은 당월 정확히 14 야간 (실제 {nights})"
    assert day_eve == 0, f"야간전담은 주간/이브닝 0 (실제 {day_eve})"
    assert saeng <= 1, f"생은 월 최대 1회 상한만 — 강제 아님 (실제 {saeng})"


def test_night_dedicated_male_no_menstrual():
    """남성 야간전담: 14 야간은 동일, 생 제약은 없음(생=0)."""
    sch, solver, x, status = _solve_night_only(_night_request("male"))
    assert status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    nights = _count(sch, solver, x, "a0", sch.NIGHT_SHIFTS)
    saeng = _count(sch, solver, x, "a0", ["생"])
    assert nights == 14, f"남성 야간전담도 정확히 14 야간 (실제 {nights})"
    assert saeng == 0, f"남성 야간전담엔 생 제약이 없어야 함 (실제 {saeng})"


def test_menstrual_leave_caps_female_at_one_per_month():
    """정규 여성의 생은 당월 최대 1회 — 생을 최대화해도 1을 넘지 못한다."""
    sch = CpSatScheduler(_night_request("female"))
    model = cp_model.CpModel()
    x = sch._build_vars(model)
    sch._cs_one_shift_per_day(model, x)
    sch._cs_menstrual_leave(model, x)
    saeng_vars = [x["a1"][d]["생"] for d in _month_idxs(sch)
                  if not isinstance(x["a1"][d]["생"], int)]
    assert saeng_vars, "정규 여성 생 변수가 있어야 함"
    model.Maximize(sum(saeng_vars))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 20
    status = solver.Solve(model)
    assert status == cp_model.OPTIMAL
    total = sum(solver.Value(v) for v in saeng_vars)
    assert total == 1, f"여성 생은 당월 최대 1회 (실제 {total})"


# ── 나이트킵 → 다음 달 일반 전환 (홀짝월 합산과 무관해야 한다) ─────────────


def _two_month_request(night_months: dict, prev_nights: dict,
                       night_only_a0: bool = False) -> GenerateRequest:
    """6명 중 a0만 night_months 지정.

    night_only_a0=True 면 야간 가능자를 a0 하나로 좁혀서 '야간을 받을 수 있는가'가
    솔버의 선택이 아니라 강제가 되게 한다 (막히면 곧바로 infeasible)."""
    from .conftest import _mini_nurses, _mini_requirements

    nurses = _mini_nurses(6)
    a0 = next(n for n in nurses if n.id == "a0")
    a0.night_months = night_months
    if night_only_a0:
        for n in nurses:
            if n.id != "a0":
                n.capable_shifts = ["DC", "D", "EC", "E"]
    return GenerateRequest(
        year=2026, month=3, nurses=nurses,
        requirements=_mini_requirements(1, 1, 1),
        rules=Rules(maxNightTwoMonth=True, maxNightTwoMonthCount=11),
        prev_schedule={},
        prev_month_nights=prev_nights,
    )


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_night_kept_month_excluded_from_two_month_sum(solver):
    """전월 나이트킵(14N)이어도 당월 야간 배정이 막히면 안 된다.

    2026-08-20 사용자 명시: "나이트킵 때 한 나이트는 수면오프와 전혀 연관 없는
    나이트". 홀짝월 합산(≤11)은 수면오프 회피 규칙이므로 야간전담 달의 야간은
    합산 대상이 아니다 — 그대로 더하면 전월 14회 → 당월 상한 0이 되어 나이트킵을
    마친 사람만 야간을 못 받는다.
    """
    from .conftest import make_limited

    req = _two_month_request({"2026-02": True}, {"a0": 14}, night_only_a0=True)
    sched = make_limited(req, days=3, solver=solver)
    assert sched._two_month_rhs("a0") == 11, "나이트킵 달 야간이 합산에서 빠져야 한다"

    result = sched.solve()
    assert result["success"], result.get("message")
    a0_nights = sum(1 for c in result["schedule"]["a0"].values() if c in ("N", "NC"))
    assert a0_nights == 3, f"야간 가능자가 a0뿐인데 야간을 못 받았다: {result['schedule']['a0']}"


def test_regular_prev_month_nights_still_capped():
    """일반 근무로 쌓은 전월 야간은 종전대로 합산에 들어간다 (규칙 자체는 유지)."""
    from .conftest import make_limited

    req = _two_month_request({}, {"a0": 6})
    sched = make_limited(req, days=7, solver="highs")
    assert sched._two_month_rhs("a0") == 5
