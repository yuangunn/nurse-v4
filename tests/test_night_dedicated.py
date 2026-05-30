"""야간전담(14일·N/NC only·생휴) + 생리휴가 캡 단위 테스트 — 후보 C.

'당월 정확히 14 야간' 규칙은 월 전체가 필요하다(7일 윈도잉 LimitedScheduler로는
14를 채울 수 없어 항상 infeasible). 그래서 일별 수요 제약 없이 해당 제약만 격리한
서브모델을 직접 풀어 핵심 규칙을 검증한다:
  - 야간전담: N/NC만, 주간/이브닝 0, 당월 정확히 14 야간
  - 여성 + 31일 달: 생 1회
  - 남성: 생 제약 없음
  - 정규 여성: 생 당월 최대 1회 (_cs_menstrual_leave)
"""
from __future__ import annotations

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
    """'1일 1근무 + 야간전담' 만 건 격리 서브모델."""
    sch = CpSatScheduler(req)
    model = cp_model.CpModel()
    x = sch._build_vars(model)
    sch._cs_one_shift_per_day(model, x)
    sch._cs_night_shift_nurses(model, x)
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


def test_night_dedicated_female_14_nights_and_menstrual():
    """여성 야간전담: 정확히 14 야간 + 주간/이브닝 0 + 생 1회."""
    sch, solver, x, status = _solve_night_only(_night_request("female"))
    assert status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    nights = _count(sch, solver, x, "a0", sch.NIGHT_SHIFTS)
    day_eve = _count(sch, solver, x, "a0", sch.DAY_SHIFTS + sch.EVENING_SHIFTS)
    saeng = _count(sch, solver, x, "a0", ["생"])
    assert nights == 14, f"야간전담은 당월 정확히 14 야간 (실제 {nights})"
    assert day_eve == 0, f"야간전담은 주간/이브닝 0 (실제 {day_eve})"
    assert saeng == 1, f"여성+31일달 야간전담은 생 1회 (실제 {saeng})"


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
