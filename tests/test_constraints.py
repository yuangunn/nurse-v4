"""
스케줄러 하드 제약 회귀 테스트.

각 테스트는 7~14일짜리 작은 문제를 풀어서 결과의 구조적 invariant를 검증.
솔버 호출이 포함되므로 케이스당 5~30초 소요. 빠른 피드백 위해 days 작게 유지.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from server.models import DayRequirement, Requirements, Rules


# ── helpers ──────────────────────────────────────────────────────────────────


WORK_D = {"D", "DC"}
WORK_E = {"E", "EC"}
WORK_N = {"N", "NC"}
CHARGE = {"DC", "EC", "NC"}

# 9개 물리적 역순(<8시간 간격) 전환: 절대 발생하면 안 됨.
FORBIDDEN_TRANSITIONS = [
    ("E", "D"), ("E", "D1"), ("E", "중"),
    ("N", "E"), ("N", "D"), ("N", "D1"), ("N", "중"),
    ("중", "D"), ("중", "D1"),
]


def _sorted_days(nurse_days: dict) -> list[tuple[str, str]]:
    return sorted(nurse_days.items())


def _ok(result: dict) -> None:
    assert result["success"], f"솔버 실패: {result.get('message')}"


# ── smoke ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_smoke_solve_succeeds(build_request, solve_small, solver):
    """기본 6명 × 7일 구성으로 해를 찾는다."""
    result = solve_small(build_request(), solver=solver)
    _ok(result)
    schedule = result["schedule"]
    # 모든 간호사가 매 날짜에 정확히 한 셀
    nurses_with_data = [nid for nid, days in schedule.items() if days]
    assert len(nurses_with_data) >= 1
    for nid, days in schedule.items():
        for d, code in days.items():
            assert code, f"{nid} {d} 빈 셀"


# ── hard: 9개 금지 전환 ──────────────────────────────────────────────────────


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_no_forbidden_transitions(build_request, solve_small, solver):
    """E→D, N→E 등 9개 역순 전환이 결과에 절대 나타나지 않는다."""
    result = solve_small(build_request(), solver=solver)
    _ok(result)
    violations: list[str] = []
    for nid, days in result["schedule"].items():
        sd = _sorted_days(days)
        for i in range(len(sd) - 1):
            s1, s2 = sd[i][1], sd[i + 1][1]
            # 코드 정규화: DC/EC/NC도 D/E/N 카테고리로
            cat1 = s1.replace("DC", "D").replace("EC", "E").replace("NC", "N")
            cat2 = s2.replace("DC", "D").replace("EC", "E").replace("NC", "N")
            if (cat1, cat2) in FORBIDDEN_TRANSITIONS:
                violations.append(f"{nid}: {sd[i][0]}({s1}) → {sd[i+1][0]}({s2})")
    assert not violations, "역순 전환 발견:\n" + "\n".join(violations)


# ── hard: 일별 인원 정확 충족 (D/E/N 등호 제약) ──────────────────────────────


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_daily_requirements_exact_match(build_request, solve_small, small_nurses, solver):
    """일별 D/E/N 합계가 요구치와 정확히 같다 (초과/부족 모두 불가)."""
    nurses = small_nurses(6)
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=1, E=1, N=1))
    result = solve_small(build_request(nurses=nurses, requirements=req), solver=solver)
    _ok(result)

    schedule = result["schedule"]
    by_date: dict[str, dict[str, int]] = {}
    for nid, days in schedule.items():
        for d, code in days.items():
            row = by_date.setdefault(d, {"D": 0, "E": 0, "N": 0})
            if code in WORK_D:
                row["D"] += 1
            elif code in WORK_E:
                row["E"] += 1
            elif code in WORK_N:
                row["N"] += 1

    for d, row in by_date.items():
        assert row["D"] == 1, f"{d} D={row['D']} (≠1)"
        assert row["E"] == 1, f"{d} E={row['E']} (≠1)"
        assert row["N"] == 1, f"{d} N={row['N']} (≠1)"


# ── hard: charge 시니어리티 ──────────────────────────────────────────────────


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_charge_goes_to_senior(build_request, solve_small, small_nurses, solver):
    """
    같은 듀티에 두 명 이상 배정될 때 charge(DC/EC/NC)는 seniority 가장 낮은
    (선임) 간호사에게만 부여된다.
    """
    nurses = small_nurses(6)  # seniority 0~5
    sen_map = {n.id: n.seniority for n in nurses}
    result = solve_small(build_request(nurses=nurses), solver=solver)
    _ok(result)

    schedule = result["schedule"]
    # 날짜·듀티별 묶음
    for day_offset in range(7):
        d = (date(2026, 3, 1) + timedelta(days=day_offset)).strftime("%Y-%m-%d")
        for duty_code, charge_code, work_set in [
            ("D", "DC", WORK_D),
            ("E", "EC", WORK_E),
            ("N", "NC", WORK_N),
        ]:
            assigned = [
                (nid, schedule[nid][d])
                for nid in schedule
                if d in schedule[nid] and schedule[nid][d] in work_set
            ]
            chargers = [nid for nid, c in assigned if c == charge_code]
            workers = [nid for nid, c in assigned if c != charge_code]
            if not chargers or not workers:
                continue
            # 시니어리티: 모든 charger는 모든 worker보다 같거나 낮은 값(=같거나 선임)이어야 함
            for cid in chargers:
                for wid in workers:
                    assert sen_map[cid] <= sen_map[wid], (
                        f"{d} {duty_code}: charger {cid}(sen={sen_map[cid]}) > "
                        f"worker {wid}(sen={sen_map[wid]})"
                    )


# ── hard: V 월 최대 ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("max_v", [1, 2])
@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_v_per_month_limit(build_request, solve_small, max_v, solver):
    """maxVPerMonth 설정 이하로만 V가 배정된다.

    주의: scheduler._c_max_v_per_month는 `max_v > 0` 조건이므로 0은 '제약 미적용'
    의미 (= 무제한). UI는 unlimited_v 플래그를 별도로 사용함.
    """
    rules = Rules(maxConsecutiveWorkDays=6, maxVPerMonth=max_v)
    result = solve_small(build_request(rules=rules), solver=solver)
    _ok(result)
    for nid, days in result["schedule"].items():
        v_count = sum(1 for v in days.values() if v == "V")
        assert v_count <= max_v, f"{nid} V={v_count} > {max_v}"


# ── hard: 1일 1근무 ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_one_shift_per_day(build_request, solve_small, solver):
    """매 간호사가 매 날짜에 정확히 1개 코드를 받는다 (중복/누락 없음)."""
    result = solve_small(build_request(), solver=solver)
    _ok(result)
    schedule = result["schedule"]
    # 7일 모두 날짜 키 존재
    all_dates = {f"2026-03-{i:02d}" for i in range(1, 8)}
    for nid, days in schedule.items():
        if not days:
            continue  # 전입/전출 외 비활성 간호사는 비어있을 수 있음
        keys = set(days.keys())
        assert keys == all_dates, f"{nid} 날짜 불일치: {sorted(keys ^ all_dates)}"
        for d, code in days.items():
            assert code, f"{nid} {d} 코드 누락"


# ── hard: 사전 고정 주휴 유지 ───────────────────────────────────────────────


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_prev_schedule_juhu_preserved(build_request, solve_small, solver):
    """prev_schedule에 '주'로 사전 고정한 셀은 결과에서 그대로 '주' 이다."""
    request = build_request()
    pre = request.prev_schedule or {}
    result = solve_small(request, solver=solver)
    _ok(result)
    schedule = result["schedule"]
    for nid, days in pre.items():
        for d, code in days.items():
            assert schedule.get(nid, {}).get(d) == code, (
                f"{nid} {d}: 사전 '{code}' → 결과 '{schedule.get(nid, {}).get(d)}'"
            )
