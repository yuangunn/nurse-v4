"""conflict_analyzer (CP-SAT assumptions) 테스트 — Phase 5."""
from __future__ import annotations

from server.conflict_analyzer import analyze_conflicts, suggest_correction


def test_detects_demand_over_supply(build_request, small_nurses):
    """2명인데 D=E=N=1(=하루 3근무 필요) → 일별 인원 제약 충돌을 짚는다."""
    nurses = small_nurses(2)
    req = build_request(nurses=nurses, add_juhu=False)  # _mini_requirements: D=E=N=1
    res = analyze_conflicts(req)
    assert res["conflicts"], f"충돌이 검출되어야 함:\n{res['message']}"
    # 충돌 라벨이 사람이 읽는 핀포인트(인원/차지)를 포함
    joined = "\n".join(res["conflicts"])
    assert ("필요 인원" in joined) or ("차지" in joined), f"라벨이 모호함:\n{joined}"


def test_feasible_returns_no_conflict(build_request, small_nurses):
    """충분한 인원(6명, D=E=N=1)이면 하드 제약만으로 실현 가능 → 충돌 없음."""
    nurses = small_nurses(6)
    req = build_request(nurses=nurses, add_juhu=False)
    res = analyze_conflicts(req)
    assert res["conflicts"] == [], f"충돌이 없어야 함:\n{res['message']}"


def test_detects_preinput_forbidden_transition(build_request, small_nurses):
    """사전입력 E(2일)→D(3일) 고정 → 금지 전환 충돌을 짚는다 (새로 넓힌 게이팅)."""
    nurses = small_nurses(6)  # 인원은 충분 → 유일한 충돌이 금지전환이 되도록
    prev = {nurses[0].id: {"2026-03-02": "E", "2026-03-03": "D"}}
    req = build_request(nurses=nurses, prev_schedule=prev, add_juhu=False)
    res = analyze_conflicts(req)
    assert res["conflicts"], f"충돌이 검출되어야 함:\n{res['message']}"
    joined = "\n".join(res["conflicts"])
    assert "금지" in joined, f"금지 전환이 짚여야 함:\n{joined}"


# ── #3 MCS (최소 수정 처방) ──────────────────────────────────────────────────

def test_mcs_reports_capacity_shortfall(build_request, small_nurses):
    """2명 D=E=N=1 → 빼도 안 되는 진짜 인원 부족 → shortfall(인원 추가) 처방."""
    nurses = small_nurses(2)
    req = build_request(nurses=nurses, add_juhu=False)
    res = suggest_correction(req)
    assert res["fixable"] is True, res["message"]
    assert res["shortfalls"], f"인원 부족이 보고되어야 함:\n{res['message']}"
    assert "부족" in res["message"]


def test_mcs_relaxes_work_not_timeoff(build_request, small_nurses):
    """근무 사전입력 충돌(E→D 금지전환)은 근무만 조정해 해소하고, 다른 간호사의
    휴무(V/OF)는 건드리지 않는다 — 근무는 싸게, 휴무는 보호."""
    nurses = small_nurses(6)
    prev = {
        nurses[0].id: {"2026-03-05": "E", "2026-03-06": "D"},  # 근무 금지전환
        nurses[1].id: {"2026-03-04": "V"},                     # 휴무(연차)
        nurses[2].id: {"2026-03-04": "OF"},                    # 휴무(휴식)
    }
    req = build_request(nurses=nurses, prev_schedule=prev, add_juhu=False)
    res = suggest_correction(req)
    assert res["fixable"], res["message"]
    assert res["removals"], f"근무 조정 처방이 나와야 함:\n{res['message']}"
    assert all(not r["is_timeoff"] for r in res["removals"]), \
        f"근무만 조정되어야(휴무 보호) — 제거: {[(r['pre'], r['is_timeoff']) for r in res['removals']]}"


def test_mcs_protects_timeoff_prefers_shortfall(build_request, small_nurses):
    """같은 날 휴무(OF·V)로 충원이 막히면 — 휴무를 빼는 대신 '인원 부족(추가/감축)'을 먼저 제시.
    OFF도 V와 똑같이 보호된다(모든 휴무 = 간호사 개인의 시간)."""
    nurses = small_nurses(6)
    day = "2026-03-03"
    # 3 OFF + 2 V = 5명 고정, 1명 자유 → 3명 필요 → 부족 (근무 사전입력 없음)
    prev = {nurses[0].id: {day: "OF"}, nurses[1].id: {day: "OF"}, nurses[2].id: {day: "OF"},
            nurses[3].id: {day: "V"}, nurses[4].id: {day: "V"}}
    req = build_request(nurses=nurses, prev_schedule=prev, add_juhu=False)
    res = suggest_correction(req)
    assert res["fixable"], res["message"]
    assert res.get("shortfalls"), f"인원 부족이 보고되어야 함:\n{res['message']}"
    timeoff_removed = [r for r in res.get("removals", []) if r["is_timeoff"]]
    assert not timeoff_removed, \
        f"휴무(OFF 포함) 제거 대신 인원부족 보고가 우선되어야 — 제거된 휴무: {timeoff_removed}\n{res['message']}"


# ── #1 최소 MUS + #2 다중 충돌 열거 ──────────────────────────────────────────

def test_enumerates_multiple_independent_conflicts(build_request, small_nurses):
    """독립 충돌 2개(① E→D 금지전환  ② 같은 날 5명 V로 인원 부족) → muses 2+개."""
    nurses = small_nurses(6)
    prev = {nurses[0].id: {"2026-03-05": "E", "2026-03-06": "D"}}      # 충돌 ①
    for n in nurses[1:6]:
        prev[n.id] = {"2026-03-10": "V"}                               # 충돌 ② (5명 V)
    req = build_request(nurses=nurses, prev_schedule=prev, add_juhu=False)
    res = analyze_conflicts(req)
    assert res["conflicts"], res["message"]
    assert len(res.get("muses", [])) >= 2, f"독립 충돌 2개가 분리 보고되어야 함:\n{res['message']}"
    assert "금지" in "\n".join(res["conflicts"]), f"금지전환 충돌 포함되어야:\n{res['message']}"
