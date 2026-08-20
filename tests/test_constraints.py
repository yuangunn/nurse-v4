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


def _teukgeun_request(pre, hol_range=range(2, 7)):
    """오프특근 검증용 요청 — 3명·일 D=2, 월~금 전부 공휴일인 완전한 주.

    하루 휴무 자리 1칸 × 7일 = 7칸. 공휴일엔 OF 금지라 OF 가능 날은 일·토 2칸뿐.
    → 전원 'OF 정확히 1회'(3칸 필요)는 불가능. 제1원칙 3의 오프특근 —
    '그 주 공휴일에 법휴를 받았거나 근무한 사람은 OF를 뺄 수 있다' — 로 풀린다."""
    from server.models import GenerateRequest, Nurse
    from .test_exact_fit_characterization import PROD_SHIFTS

    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="male",
                    capable_shifts=["DC", "D", "EC", "E", "NC", "N"], seniority=i)
              for i in range(3)]
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=2, E=0, N=0))
    holidays = [f"2026-03-{i:02d}" for i in hol_range]
    # 연속 근무 한도는 이 시나리오의 관심사가 아니다 (3명뿐이라 연휴를 이어 일하게 됨)
    return GenerateRequest(
        year=2026, month=3, nurses=nurses, requirements=req,
        rules=Rules(maxConsecutiveWorkDays=7),
        prev_schedule=pre, shifts=PROD_SHIFTS, holidays=holidays, time_limit=60,
    ), holidays


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_off_teukgeun_only_for_holiday_work_or_beop(solver):
    """OF 0회는 '그 주 공휴일에 법휴를 받았거나 근무한 사람'에게만 허용된다.

    a0에게 법휴를 부여한 구성. 누가 OF 0회가 되든 그 근거(법휴·공휴일 근무)가
    반드시 있어야 한다 — 근거 없는 면제가 생기면 규칙이 헐거워진 것."""
    from .conftest import make_limited

    req, holidays = _teukgeun_request({"a0": {"2026-03-02": "법"}})
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    work = {"DC", "D", "D1", "EC", "E", "중", "NC", "N"}
    for nid, days in r["schedule"].items():
        ofs = sum(1 for c in days.values() if c == "OF")
        assert ofs <= 1, (nid, days)
        if ofs == 0:
            grounds = [dk for dk in holidays
                       if days.get(dk) == "법" or days.get(dk) in work]
            assert grounds, f"{nid}: 근거 없는 OF 면제 — {days}"
        # 공휴일에 OF는 여전히 금지 — 공휴일 휴무는 법/V 등
        for dk in holidays:
            assert days.get(dk) != "OF", (nid, dk)


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_off_teukgeun_not_for_idle_nurse(solver):
    """연휴 내내 근무도 법휴도 없는 사람은 종전대로 OF 1회 의무.

    a0을 공휴일 5일 전부 '주'로 확정 → 공휴일 근무 0·법휴 0 → 면제 근거 없음.
    (a1·a2는 공휴일을 일하므로 오프특근 대상이 된다.)"""
    from .conftest import make_limited

    hol = range(2, 5)   # 월~수 3일 연휴
    pre = {"a0": {f"2026-03-{i:02d}": "주" for i in hol}}
    req, _ = _teukgeun_request(pre, hol_range=hol)
    r = make_limited(req, days=7, solver=solver).solve()
    assert r["success"], r["message"]
    a0 = r["schedule"]["a0"]
    assert sum(1 for c in a0.values() if c == "OF") == 1, a0


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
