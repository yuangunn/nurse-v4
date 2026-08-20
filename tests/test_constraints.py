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


# ── 오프특근 (제1원칙 3, 2026-08-20) ─────────────────────────────────────────


def _teukgeun_request(pre, nurse_n=4, need_d=3, holidays=None):
    """오프특근 검증용 요청 — 하루 D=need_d, 간호사 nurse_n명의 완전한 한 주.

    제1원칙 3(2026-08-20 사용자 명시): 오프특근은 **어쩔 수 없을 때 발생한다**.
    경가·조가 등으로 휴무가 갑자기 많아지면 남은 근무자가 오프를 줄여가며 근무를
    뛰고, 그때도 깎이지 않는 최소 보장이 주휴다.
    → 주 1회 OF는 조건부 면제가 아니라 '최대한 지키는 의무'다."""
    from server.models import GenerateRequest, Nurse
    from .test_exact_fit_characterization import PROD_SHIFTS

    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="male",
                    capable_shifts=["DC", "D", "EC", "E", "NC", "N"], seniority=i)
              for i in range(nurse_n)]
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=need_d, E=0, N=0))
    return GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=req,
        rules=Rules(maxConsecutiveWorkDays=7),
        prev_schedule=pre, shifts=PROD_SHIFTS, holidays=holidays or [],
        time_limit=60,
    ), nurses


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_off_teukgeun_when_rest_supply_short(solver):
    """휴무 자리가 모자라면 OF를 반납하고 근무를 메꾼다 — 그리고 그것만 반납한다.

    4명·일 D=3 → 하루 휴무 1칸 × 7일 = 7칸. 주휴 4칸(전원 사전입력)을 빼면 3칸,
    OF 수요는 4명 → 딱 1명이 오프특근. 페널티가 압도적이라 '필요한 만큼만'
    반납해야 한다(2명 이상 0회면 규칙이 헐거워진 것)."""
    from .conftest import _juhu_prev, make_limited

    req, nurses = _teukgeun_request({})
    req.prev_schedule = _juhu_prev(nurses, 2026, 3, 7)
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    of_counts = {nid: sum(1 for c in days.values() if c == "OF")
                 for nid, days in r["schedule"].items()}
    assert all(c <= 1 for c in of_counts.values()), of_counts      # 상한은 하드
    zero = [nid for nid, c in of_counts.items() if c == 0]
    assert len(zero) == 1, of_counts                                # 최소한만 반납
    # 누가 반납했는지 결과가 알려줘야 한다 (수당·보상은 사람이 처리)
    rows = r.get("off_teukgeun") or []
    assert [x["nurse_id"] for x in rows] == zero, rows
    # 최소 보장인 주휴는 그대로
    for nid, days in r["schedule"].items():
        assert sum(1 for c in days.values() if c == "주") == 1, (nid, days)


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_off_teukgeun_not_used_when_avoidable(solver):
    """여유가 있으면 아무도 오프를 반납하지 않는다 (오프특근은 마지막 수단).

    7명·일 D=5 → 휴무 2칸/일 × 7일 = 14칸 = 주휴 7 + OF 7 로 딱 맞는다."""
    from .conftest import _juhu_prev, make_limited

    req, nurses = _teukgeun_request({}, nurse_n=7, need_d=5)
    req.prev_schedule = _juhu_prev(nurses, 2026, 3, 7)
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    for nid, days in r["schedule"].items():
        assert sum(1 for c in days.values() if c == "OF") == 1, (nid, days)
    assert not r.get("off_teukgeun")


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_holiday_off_ban_holds_under_teukgeun(solver):
    """공휴일 OF 금지는 오프특근과 무관하게 유지된다."""
    from .conftest import _juhu_prev, make_limited

    holidays = ["2026-03-04", "2026-03-05"]
    req, nurses = _teukgeun_request({}, nurse_n=7, need_d=5, holidays=holidays)
    req.prev_schedule = _juhu_prev(nurses, 2026, 3, 7)
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    for nid, days in r["schedule"].items():
        for dk in holidays:
            assert days.get(dk) != "OF", (nid, dk, days)


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_weekly_of_exact_kept_for_normal_weeks(solver):
    """공휴일 없는 완전한 주는 종전대로 OF 정확 1회 유지 (오프특근 미적용)."""
    from server.models import GenerateRequest
    from .conftest import make_limited, _juhu_prev, _mini_nurses, _mini_requirements
    from .test_exact_fit_characterization import PROD_SHIFTS

    nurses = _mini_nurses(6)
    r = make_limited(GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=_mini_requirements(),
        rules=Rules(maxConsecutiveWorkDays=6),
        prev_schedule=_juhu_prev(nurses, 2026, 3, 7), shifts=PROD_SHIFTS,
        holidays=[], time_limit=60,
    ), days=7, solver=solver).solve()
    assert r["success"], r["message"]
    for nid, days in r["schedule"].items():
        assert sum(1 for c in days.values() if c == "OF") == 1, nid
