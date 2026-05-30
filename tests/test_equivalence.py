"""HiGHS ↔ CP-SAT 동등성 (Phase 4d).

비트 동일이 아니라: 동일 입력에 두 엔진 모두 모든 하드 제약 충족 + 목적함수가
동일하게 작동(night_fairness 최소 range를 양쪽 다 달성)함을 검증.
"""
from __future__ import annotations

from server.models import Rules, ScoringRule

WORK_D = {"D", "DC"}
WORK_E = {"E", "EC"}
WORK_N = {"N", "NC"}


def _daily_counts(schedule):
    by = {}
    for nid, days in schedule.items():
        for d, code in days.items():
            row = by.setdefault(d, {"D": 0, "E": 0, "N": 0})
            if code in WORK_D: row["D"] += 1
            elif code in WORK_E: row["E"] += 1
            elif code in WORK_N: row["N"] += 1
    return by


def _night_range(schedule, nurse_ids):
    counts = []
    for nid in nurse_ids:
        days = schedule.get(nid, {})
        counts.append(sum(1 for c in days.values() if c in WORK_N))
    return max(counts) - min(counts) if counts else 0


def test_engines_equivalent_hard_and_objective(build_request, solve_small, small_nurses):
    nurses = small_nurses(6)
    nurse_ids = [n.id for n in nurses]
    rules = Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1)
    # night_fairness: 야간 분배 range 최소화 (음수 가중치 = 페널티)
    fair = [ScoringRule(id=1, name="night_fair", rule_type="night_fairness",
                        params={}, score=-30, enabled=True, sort_order=0)]

    results = {}
    for solver in ("highs", "cpsat"):
        req = build_request(nurses=nurses, rules=rules)
        req.scoring_rules = fair
        r = solve_small(req, solver=solver)
        assert r["success"], f"{solver} 실패: {r.get('message')}"
        results[solver] = r["schedule"]

    # 1) 두 엔진 모두 일별 D/E/N 정확 충족 (하드)
    for solver, sched in results.items():
        for d, row in _daily_counts(sched).items():
            assert row["D"] == 1 and row["E"] == 1 and row["N"] == 1, \
                f"{solver} {d} 인원 불일치: {row}"

    # 2) 목적함수(night_fairness)가 양쪽 동일하게 작동 → 야간 range 동일
    rng_highs = _night_range(results["highs"], nurse_ids)
    rng_cpsat = _night_range(results["cpsat"], nurse_ids)
    assert rng_highs == rng_cpsat, \
        f"야간 분배 range 불일치 — highs={rng_highs} cpsat={rng_cpsat}"
