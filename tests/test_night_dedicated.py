"""야간전담(14일·N/NC only) + 생리휴가 캡 단위 테스트 — 후보 C.

'당월 정확히 14 야간' 규칙은 월 전체가 필요하다(7일 윈도잉 LimitedScheduler로는
14를 채울 수 없어 항상 infeasible). 그래서 일별 수요 제약 없이 해당 제약만 격리한
서브모델을 직접 풀어 핵심 규칙을 검증한다:
  - 야간전담: N/NC만, 주간/이브닝 0, 당월 정확히 14 야간
  - 생휴는 강제하지 않는다 — "월 1회 주어질 수 있다"일 뿐 보장이 아님
    (2026-08-19 사용자 원칙, decisions.md). 월 ≤1 상한만 (_cs_menstrual_leave)
"""
from __future__ import annotations

from datetime import date

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


# ── 나이트킵 공휴일 OF (2026-10-03 병동 확인) ─────────────────────────────────
# 야간전담은 '법'을 받지 못한다 → 공휴일에도 OF로 쉰다. 공휴일 OF 금지는 일반 간호사만.
# 실제 101병동 번표의 공휴일 OF 15건이 모두 그 달 나이트킵이었다.

def test_night_keeper_in_month_resolution():
    from server.scheduler_base import night_keeper_in_month
    assert night_keeper_in_month({"is_night_shift": True}, 2026, 3)
    assert not night_keeper_in_month({"is_night_shift": False}, 2026, 3)
    # night_months 가 있으면 그 달 키가 이긴다
    nm = {"night_months": {"2026-03": True}, "is_night_shift": False}
    assert night_keeper_in_month(nm, 2026, 3)
    assert not night_keeper_in_month(nm, 2026, 4)
    # 임신 중인 달은 야간전담이 아니다
    preg = {"night_months": {"2026-03": True}, "is_pregnant": True,
            "pregnancy": {"early": {"start": "2026-03-10", "end": "2026-04-20"}}}
    assert not night_keeper_in_month(preg, 2026, 3)


def _holiday_of_request():
    """2026-03-01(일)~07(토) 한 주. 3/2 = 삼일절 대체공휴일.
    a0 = 그 달 나이트킵, a1 = 일반. 둘 다 3/2 에 OF 사전입력."""
    from .conftest import _mini_nurses, _mini_requirements
    nurses = _mini_nurses(6)
    nurses[0].night_months = {"2026-03": True}
    nurses[0].capable_shifts = ["N", "NC"]
    return GenerateRequest(
        year=2026, month=3, nurses=nurses,
        requirements=_mini_requirements(1, 1, 1),
        rules=Rules(),
        holidays=["2026-03-02"],
        prev_schedule={"a0": {"2026-03-02": "OF"}, "a1": {"2026-03-02": "OF"}},
    )


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_night_keeper_keeps_holiday_of(solver):
    """나이트킵의 공휴일 OF 사전입력은 그대로, 일반 간호사의 공휴일 OF 는 종전대로 드롭."""
    from .conftest import make_limited

    sched = make_limited(_holiday_of_request(), days=7, solver=solver)
    nk = next(n for n in sched.nurses if n["id"] == "a0")
    reg = next(n for n in sched.nurses if n["id"] == "a1")
    assert sched._effective_pre(nk, date(2026, 3, 2), "OF", True) == "OF"
    assert sched._effective_pre(reg, date(2026, 3, 2), "OF", True) is None

    result = sched.solve()
    assert result["success"], result.get("message")
    assert result["schedule"]["a0"]["2026-03-02"] == "OF", result["schedule"]["a0"]
    assert result["schedule"]["a1"]["2026-03-02"] != "OF", result["schedule"]["a1"]


def test_locked_holiday_of_warning_skips_night_keeper():
    """잠금 경고 — 나이트킵의 공휴일 OF 는 정상이라 경고하지 않는다."""
    from server.api import _validate_locked_conflicts

    req = _holiday_of_request()
    req.locked_cells = {"a0": {"2026-03-02": True}, "a1": {"2026-03-02": True}}
    msg = _validate_locked_conflicts(req)
    assert msg and "*간호1" in msg, msg
    assert "*시니어A" not in msg, msg


def test_last_month_holiday_of_is_history():
    """지난달 칸은 기록이다 — 1월에만 나이트킵이던 사람의 설날(1/28) OF 를 2월 기준
    (일반 간호사)으로 지우지 않는다 (2026-10-03 PR #79 검토)."""
    from server.scheduler import NurseScheduler
    from .conftest import _mini_nurses, _mini_requirements

    nurses = _mini_nurses(6)
    nurses[0].night_months = {"2025-01": True}
    req = GenerateRequest(
        year=2025, month=2, nurses=nurses, requirements=_mini_requirements(1, 1, 1),
        rules=Rules(), holidays=["2025-01-28", "2025-01-29", "2025-01-30"],
        prev_schedule={"a0": {"2025-01-28": "OF"}},
    )
    s = NurseScheduler(req)
    assert s.all_dates[0] <= date(2025, 1, 28)
    s._build_pin_index()
    d = s.all_dates.index(date(2025, 1, 28))
    assert s._pin.get(("a0", d)) == "OF"
    a0 = next(n for n in s.nurses if n["id"] == "a0")
    assert s._holiday_of_banned(a0, True, date(2025, 1, 28)) is False
    assert s._holiday_of_banned(a0, True, date(2025, 2, 3)) is True     # 2월엔 일반 간호사


def test_locked_holiday_off_alias_is_warned():
    """번표 표기 OFF 도 엔진은 OF 로 읽는다 — 잠긴 공휴일 OFF 도 경고해야 한다."""
    from server.api import _validate_locked_conflicts

    req = _holiday_of_request()
    req.prev_schedule = {"a1": {"2026-03-02": "OFF"}}
    req.locked_cells = {"a1": {"2026-03-02": True}}
    msg = _validate_locked_conflicts(req)
    assert msg and "*간호1" in msg, msg
