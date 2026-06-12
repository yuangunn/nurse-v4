"""생성 엔진 정밀 재검토(2026-06)에서 확정된 결함들의 회귀 테스트.

대상:
- 월경계 확장 주의 '역사 소급' 금지 (전월 기록이 당월 생성을 막거나 변조되지 않음)
- 완화 주당 주휴 게이트의 엔진 패리티 (잠금 주휴 2개 주에서 상수 모순 제약 금지)
- _pre_soft 플래그가 완화 실패 후 누수되지 않음
- conflict_analyzer가 솔버 의미론(홀짝월 클램프·명시적 0명)과 동기화됨
"""
from __future__ import annotations

from datetime import date

import pytest

from server.models import GenerateRequest, Rules
from tests.conftest import _mini_nurses, _mini_requirements, _juhu_prev, make_limited


def _full_request(year, month, nurses=None, rules=None, **kw):
    nurses = nurses or _mini_nurses(6)
    return GenerateRequest(
        year=year, month=month, nurses=nurses,
        requirements=kw.pop("requirements", _mini_requirements()),
        rules=rules or Rules(maxConsecutiveWorkDays=5, maxVPerMonth=1),
        prev_schedule=kw.pop("prev_schedule", _juhu_prev(nurses, year, month, 28)),
        time_limit=120,
        **kw,
    )


# ── 역사(전월 기록) 소급 금지 ─────────────────────────────────────────────────

@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_history_week_records_not_constrained_nor_modified(solver):
    """2026-03은 주기 정렬 달이라 전월 한 주(2/22~)가 범위에 들어온다.
    전월 기록이 현재 규칙(연속근무 5일)을 위반해도 ①당월 생성은 성공해야 하고
    ②완화 모드가 과거 기록을 변조하면 안 된다."""
    nurses = _mini_nurses(6)
    prev = _juhu_prev(nurses, 2026, 3, 28)
    # 전월 기록: a0가 2/22~2/27 6연속 근무 (당월 규칙 max 5 위반인 '역사')
    hist = {f"2026-02-{d:02d}": "D" for d in range(22, 28)}
    prev.setdefault("a0", {}).update(hist)

    req = _full_request(2026, 3, nurses=nurses, prev_schedule=prev)
    req.allow_pre_relax = True  # 완화가 켜져 있어도 역사는 불변이어야 함

    if solver == "highs":
        from server.scheduler import NurseScheduler
        result = NurseScheduler(req).solve()
    else:
        from server.scheduler_cpsat import CpSatScheduler
        result = CpSatScheduler(req).solve()

    assert result["success"], result.get("message")
    ext = result.get("extended_schedule") or {}
    merged = {**(ext.get("a0") or {}), **(result["schedule"].get("a0") or {})}
    for dt_str, code in hist.items():
        assert merged.get(dt_str) == code, (
            f"전월 기록 {dt_str}가 변조됨: {code} → {merged.get(dt_str)}")
    # 완화로도 역사 셀이 변경 보고되면 안 됨
    for dt_str in hist:
        assert dt_str not in (result.get("relaxed_cells") or {}).get("a0", {})


# ── 완화 주당 주휴 게이트 패리티 ─────────────────────────────────────────────

@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_two_locked_juhu_in_week_respected_in_relax(build_request, solver):
    """한 주에 잠금 주휴 2개 + 주휴 무시(allow_juhu_relax) 완화: 상수 모순 제약
    (2<=1)으로 전체가 실패하면 안 되고, 잠금 주휴 2개는 유지되어야 한다.
    (수정 전: HiGHS 실패 / CP-SAT 성공으로 엔진이 갈렸음)"""
    nurses = _mini_nurses(6)
    year, month, days = 2026, 3, 7
    prev = _juhu_prev(nurses, year, month, days)
    # a5: 같은 주(3/1~3/7)에 주휴 2개 잠금
    prev.setdefault("a5", {})["2026-03-02"] = "주"
    prev["a5"]["2026-03-05"] = "주"
    # strict infeasible 트리거: a1 E→D 사전입력 쌍
    prev.setdefault("a1", {})["2026-03-03"] = "E"
    prev["a1"]["2026-03-04"] = "D"

    req = build_request(nurses=nurses, prev_schedule=prev, year=year,
                        month=month, days=days,
                        requirements=_mini_requirements(1, 2, 1))
    req.allow_pre_relax = True
    req.allow_juhu_relax = True
    req.locked_cells = {"a5": {"2026-03-02": True, "2026-03-05": True}}

    result = make_limited(req, days=days, solver=solver).solve()
    assert result["success"], result.get("message")
    sched = result["schedule"]
    assert sched["a5"]["2026-03-02"] == "주"
    assert sched["a5"]["2026-03-05"] == "주"


# ── _pre_soft 누수 방지 ───────────────────────────────────────────────────────

def test_pre_soft_reset_after_relax_failure(build_request):
    """strict·완화 모두 infeasible인 입력에서 solve()가 끝난 뒤 _pre_soft가
    False로 복원되어야 한다 (누수 시 진단이 soft 게이팅으로 빌드되어 오진)."""
    nurses = _mini_nurses(6)
    # 6명으로 D=10은 어떤 완화로도 불가능 — strict/relax 모두 infeasible
    req = build_request(nurses=nurses, days=7,
                        requirements=_mini_requirements(10, 1, 1))
    req.allow_pre_relax = True
    s = make_limited(req, days=7, solver="highs")
    result = s.solve()
    assert not result["success"]
    assert getattr(s, "_pre_soft", None) is False, "_pre_soft가 완화 후 누수됨"


# ── conflict_analyzer 동기화 ──────────────────────────────────────────────────

def test_analyzer_two_month_clamp_no_false_conflict():
    """전월 야간 14회(한도 11 초과) 간호사: 솔버는 클램프로 성공하는 입력이므로
    분석기도 '홀짝월' 가짜 충돌을 보고하면 안 된다."""
    from server.conflict_analyzer import analyze_conflicts
    nurses = _mini_nurses(6)
    rules = Rules(maxConsecutiveWorkDays=5, maxVPerMonth=1,
                  maxNightTwoMonth=True, maxNightTwoMonthCount=11)
    req = _full_request(2026, 3, nurses=nurses, rules=rules)
    req.prev_month_nights = {"a1": 14}
    diag = analyze_conflicts(req)
    assert not any("홀짝월" in c for c in diag.get("conflicts", [])), diag


def test_analyzer_detects_explicit_zero_requirement_conflict():
    """요구 0명인 날의 사전입력 근무: 솔버는 infeasible — 분석기/처방도 이를
    짚어야 한다 (수정 전: '충돌 없음'/'수정 없이 가능' 오답)."""
    from server.conflict_analyzer import analyze_conflicts, suggest_correction
    nurses = _mini_nurses(6)
    prev = _juhu_prev(nurses, 2026, 3, 28)
    prev.setdefault("a0", {})["2026-03-10"] = "D"
    req = _full_request(2026, 3, nurses=nurses, prev_schedule=prev)
    req.per_day_requirements = {"2026-03-10": {"D": 0}}

    diag = analyze_conflicts(req)
    assert diag.get("conflicts"), "0명 요구 충돌이 '충돌 없음'으로 오진됨"
    assert any("0명" in c for c in diag["conflicts"]), diag["conflicts"]

    fix = suggest_correction(req)
    removals = fix.get("removals") or []
    assert any(r["nurse_id"] == "a0" and r["date_iso"] == "2026-03-10"
               for r in removals), f"0명 요구일 사전입력 제거 처방 누락: {fix}"
