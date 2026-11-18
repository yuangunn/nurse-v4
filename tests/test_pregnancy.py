"""임산부(모성보호) 기능 검증 — HiGHS·CP-SAT 양 엔진.

임산부 간호사는:
  · P1 구간(초기/말기) 완전 포함 주마다 P1(임부휴무) 정확히 1회
  · 임신 전 구간 동안 야간(N/NC) 배정 금지
  · 임신-중-달엔 생리휴가(생) 면제 (사전입력 생도 무시)
  · 야간전담 설정이 있어도 임신 중이면 해제(정규 취급)
  · 임신 구간의 법정공휴일엔 근무 없이 쉰다 — 주휴를 넣은 날이면 주휴, 아니면 법 (결정 1-60)
비임산부에겐 P1이 배정되지 않으며, 사전입력 P1은 누구에게나 존중된다.
"""
from __future__ import annotations

from datetime import date

import pytest

from server.models import Rules

from .conftest import make_limited

SOLVERS = ["highs", "cpsat"]


def _preg(nurse, early=None, late=None):
    nurse.is_pregnant = True
    p = {}
    if early:
        p["early"] = {"start": early[0], "end": early[1]}
    if late:
        p["late"] = {"start": late[0], "end": late[1]}
    nurse.pregnancy = p
    return nurse


@pytest.mark.parametrize("solver", SOLVERS)
def test_pregnancy_p1_weekly_once(build_request, small_nurses, solve_small, solver):
    """P1 구간이 완전히 포함된 주 → P1 정확히 1회 + 야간 0."""
    nurses = small_nurses(6)
    _preg(nurses[1], early=("2026-03-01", "2026-03-07"))
    req = build_request(nurses=nurses, add_juhu=False,
                        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1))
    req.solver = solver
    res = solve_small(req, days=7, solver=solver)
    assert res["success"], f"[{solver}] {res['message']}"
    sch = res["schedule"][nurses[1].id]
    p1 = sum(1 for s in sch.values() if s == "P1")
    nights = sum(1 for s in sch.values() if s in ("N", "NC"))
    assert p1 == 1, f"[{solver}] P1 {p1}회 (1회 기대): {sch}"
    assert nights == 0, f"[{solver}] 임산부 야간 {nights}회 (0 기대): {sch}"


@pytest.mark.parametrize("solver", SOLVERS)
def test_pregnancy_non_pregnant_no_p1(build_request, small_nurses, solve_small, solver):
    """비임산부에게는 P1이 배정되지 않는다 (솔버가 P1을 흩뿌리지 않음)."""
    nurses = small_nurses(6)
    _preg(nurses[1], early=("2026-03-01", "2026-03-07"))
    req = build_request(nurses=nurses, add_juhu=False,
                        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1))
    req.solver = solver
    res = solve_small(req, days=7, solver=solver)
    assert res["success"], f"[{solver}] {res['message']}"
    for nurse in nurses[2:]:
        sch = res["schedule"].get(nurse.id, {})
        assert all(s != "P1" for s in sch.values()), \
            f"[{solver}] 비임산부 {nurse.id}에게 P1 배정: {sch}"


@pytest.mark.parametrize("solver", SOLVERS)
def test_pregnancy_preinput_p1_respected(build_request, small_nurses, solve_small, solver):
    """사전입력 P1은 (임산부 여부 무관) 존중된다."""
    nurses = small_nurses(6)
    prev = {nurses[2].id: {"2026-03-03": "P1"}}
    req = build_request(nurses=nurses, prev_schedule=prev, add_juhu=False,
                        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1))
    req.solver = solver
    res = solve_small(req, days=7, solver=solver)
    assert res["success"], f"[{solver}] {res['message']}"
    got = res["schedule"][nurses[2].id].get("2026-03-03")
    assert got == "P1", f"[{solver}] 사전입력 P1 미반영 → {got}"


@pytest.mark.parametrize("solver", SOLVERS)
def test_pregnancy_no_menstrual(build_request, small_nurses, solve_small, solver):
    """임산부는 생리휴가(생)를 받지 않는다 — 사전입력 생도 무시(드롭)."""
    nurses = small_nurses(6)
    _preg(nurses[1], early=("2026-03-01", "2026-03-07"))
    prev = {nurses[1].id: {"2026-03-02": "생"}}
    req = build_request(nurses=nurses, prev_schedule=prev, add_juhu=False,
                        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1))
    req.solver = solver
    res = solve_small(req, days=7, solver=solver)
    assert res["success"], f"[{solver}] {res['message']}"
    sch = res["schedule"][nurses[1].id]
    assert all(s != "생" for s in sch.values()), f"[{solver}] 임산부에게 생 배정: {sch}"


@pytest.mark.parametrize("solver", SOLVERS)
def test_pregnancy_overrides_night_dedicated(build_request, small_nurses, solve_small, solver):
    """임산부면 야간전담 설정도 해제 — 야간 0, 14일 야간 의무 미적용(정규 취급)."""
    nurses = small_nurses(6)
    nurses[1].night_months = {"2026-03": True}   # 원래 야간전담이지만
    _preg(nurses[1], early=("2026-03-01", "2026-03-07"))
    req = build_request(nurses=nurses, add_juhu=False,
                        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1))
    req.solver = solver
    res = solve_small(req, days=7, solver=solver)
    assert res["success"], f"[{solver}] {res['message']}"
    sch = res["schedule"][nurses[1].id]
    nights = sum(1 for s in sch.values() if s in ("N", "NC"))
    p1 = sum(1 for s in sch.values() if s == "P1")
    assert nights == 0, f"[{solver}] 임산부(야간전담 해제) 야간 {nights}회: {sch}"
    assert p1 == 1, f"[{solver}] P1 {p1}회 (1회 기대): {sch}"


@pytest.mark.parametrize("solver", SOLVERS)
def test_pregnancy_no_menstrual_in_mid_span(build_request, small_nurses, solve_small, solver):
    """두 구간 '사이'(중기)에도 생리휴가 면제 — 면제는 임신 전체 기간 적용.
    초기=3월·출산전=5월 임산부의 4월(중기) 생성: 4월은 어느 P1 구간에도 안 들지만
    임신 중이므로 ①생(生) 면제(사전입력 생도 드롭) ②야간 제외 ③P1은 없음(구간 한정)."""
    nurses = small_nurses(6)
    _preg(nurses[1], early=("2026-03-01", "2026-03-14"), late=("2026-05-15", "2026-05-31"))
    prev = {nurses[1].id: {"2026-04-03": "생"}}   # 중기에 생 사전입력 → 면제로 드롭돼야
    req = build_request(nurses=nurses, prev_schedule=prev, add_juhu=False,
                        year=2026, month=4,
                        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1))
    req.solver = solver
    res = solve_small(req, days=7, solver=solver)
    assert res["success"], f"[{solver}] {res['message']}"
    sch = res["schedule"][nurses[1].id]
    assert all(s != "생" for s in sch.values()), f"[{solver}] 중기에 생 배정(면제 누락): {sch}"
    assert all(s not in ("N", "NC") for s in sch.values()), f"[{solver}] 중기 야간 배정: {sch}"
    assert all(s != "P1" for s in sch.values()), f"[{solver}] 중기에 P1 배정(구간 외): {sch}"


@pytest.mark.parametrize("relax", [False, True])
@pytest.mark.parametrize("solver", SOLVERS)
def test_pregnancy_rests_on_holidays(build_request, small_nurses, solve_small, solver, relax):
    """임신 구간의 법정공휴일: 넣어 둔 근무는 무시하고 법, 주휴를 넣은 날은 주휴. 임신 구간 밖 공휴일과
    비임산부는 그대로 (결정 1-60). 엄격·완화(주휴 이동 허용) 두 경로 모두."""
    nurses = small_nurses(7)
    preg, other = nurses[1], nurses[2]
    _preg(preg, early=("2026-03-01", "2026-03-05"))          # 3/6 은 임신 구간 밖
    prev = {
        preg.id: {"2026-03-02": "주", "2026-03-03": "D"},     # 공휴일 주휴 · 공휴일 근무
        other.id: {"2026-03-03": "D"},                        # 비임산부의 공휴일 근무는 사실
    }
    req = build_request(nurses=nurses, prev_schedule=prev,
                        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1))
    req.holidays = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-06"]
    req.solver = solver
    if relax:
        req.allow_pre_relax = req.allow_juhu_relax = True
    eng = make_limited(req, days=7, solver=solver)
    if not relax:
        res = eng.solve()
    else:                                  # 완화 경로를 직접 — solve() 는 엄격이 풀리면 완화로 가지 않는다
        if solver == "highs":
            eng._build_pin_index()
        res = eng._solve_with_relaxed_pre() if solver == "highs" else eng._solve_relaxed()
    assert res and res["success"], f"[{solver}] {res and res['message']}"
    sch = res["schedule"][preg.id]
    assert sch["2026-03-03"] == "법", f"[{solver}] 넣어 둔 공휴일 근무가 남았다: {sch}"
    assert sch["2026-03-04"] == "법", f"[{solver}] 빈 공휴일이 법이 아니다: {sch}"
    assert sch["2026-03-02"] in (("주", "법") if relax else ("주",)), f"[{solver}] 공휴일 주휴: {sch}"
    assert res["schedule"][other.id]["2026-03-03"] in ("D", "DC"), f"[{solver}] 비임산부 공휴일 근무가 바뀌었다"
    assert not eng._preg_holiday_rest(preg.model_dump(), date(2026, 3, 6))    # 임신 구간 밖 공휴일
    assert not eng._preg_holiday_rest(other.model_dump(), date(2026, 3, 3))   # 비임산부
