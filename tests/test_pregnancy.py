"""임산부(모성보호) 기능 검증 — HiGHS·CP-SAT 양 엔진.

임산부 간호사는:
  · P1 구간(초기/말기) 완전 포함 주마다 P1(임부휴무) 정확히 1회
  · 임신 전 구간 동안 야간(N/NC) 배정 금지
  · 임신-중-달엔 생리휴가(생) 면제 (사전입력 생도 무시)
  · 야간전담 설정이 있어도 임신 중이면 해제(정규 취급)
비임산부에겐 P1이 배정되지 않으며, 사전입력 P1은 누구에게나 존중된다.
"""
from __future__ import annotations

import pytest

from server.models import Rules

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
