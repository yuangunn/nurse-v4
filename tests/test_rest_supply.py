"""M4-P1 — '쉴 코드' 수급 산술 검사 (rest_supply_shortfall).

일별 인원이 '정확히 일치'라 남는 인력은 반드시 휴무 칸에 들어가야 한다. 솔버가
놓을 수 있는 휴무는 OF(주1)·V(월1)·생(월1·여성)·P1뿐이고 주휴(주)는 사전입력
전용이라, 주휴를 안 넣으면 채울 코드가 없어 infeasible 이 된다.

이 산술은 **수요를 하한, 공급을 상한**으로 잡는다 → 부족이 나오면 확정이다
(거짓 양성 없음). 반대로 0이라고 생성이 보장되지는 않는다.
"""
from __future__ import annotations

from server.models import GenerateRequest, Rules

from .conftest import LimitedScheduler, _mini_nurses, _mini_requirements, _juhu_prev
from .test_exact_fit_characterization import PROD_SHIFTS, ISO_RULES

YEAR, MONTH = 2026, 3   # 2026-03-01 = 일요일 (주기 경계)


def _req(prev=None, **kw) -> GenerateRequest:
    return GenerateRequest(
        year=YEAR, month=MONTH,
        nurses=_mini_nurses(6),
        requirements=_mini_requirements(1, 1, 1),
        rules=Rules(**ISO_RULES),
        shifts=PROD_SHIFTS,
        prev_schedule=prev,
        **kw,
    )


def test_주휴_없으면_부족을_산술로_잡는다():
    """6명·일 3명 수요·주휴 미입력 → 주당 휴무 수요가 공급을 넘는다."""
    s = LimitedScheduler(_req(), max_days=7)
    rows = s.rest_supply_shortfall()
    assert rows, "주휴 없이도 부족이 안 잡히면 산술이 헐겁다"
    w = rows[0]
    # 6명×7일 = 42칸, 근무 21칸 → 휴무 21칸 필요
    assert w["demand"] == 21, w
    # 공급 상한 = OF 6 + V 6 + 생 4(여성) = 16
    assert w["supply"] == 16, w
    assert w["shortfall"] == 5, w
    assert w["nurses"] == 6


def test_주휴를_넣으면_부족이_사라진다():
    """같은 조건 + 주휴 사전입력 → 공급이 수요를 만난다."""
    nurses = _mini_nurses(6)
    prev = _juhu_prev(nurses, YEAR, MONTH, 7)
    s = LimitedScheduler(_req(prev=prev), max_days=7)
    assert s.rest_supply_shortfall() == []


def test_V_무제한이면_부족으로_보지_않는다():
    """V 무제한은 쉴 코드가 사실상 무한 — 이 산술이 걸면 거짓 양성이다."""
    s = LimitedScheduler(_req(unlimited_v=True), max_days=7)
    assert s.rest_supply_shortfall() == []


def test_안내문에_주휴_경로가_들어간다():
    s = LimitedScheduler(_req(), max_days=7)
    msg = s.rest_supply_message(s.rest_supply_shortfall())
    assert "쉴 코드가 없습니다" in msg
    assert "주휴" in msg and "분석 탭" in msg
    assert s.rest_supply_message([]) == ""


def test_진단_Phase5가_1급_원인으로_보고한다():
    """오진(생리휴가 충돌) 대신 쉴 코드 부족을 먼저 짚어야 한다."""
    s = LimitedScheduler(_req(), max_days=7)
    out = s.solve()
    assert out.get("status") != "success"
    msg = (out.get("message") or "") + (out.get("diagnosis") or "")
    assert "쉴 코드가 없습니다" in msg, msg[:600]
    # 정반대 안내(인원을 늘리세요)가 1급 원인으로 나오면 안 된다
    assert msg.index("쉴 코드가 없습니다") < (msg + "간호사를 늘리").index("간호사를 늘리")


def test_신호등도_산술로_즉시_빨강():
    """/api/feasibility — 솔버를 돌리기 전에 산술로 확정 판정."""
    from server.conflict_analyzer import check_feasibility
    res = check_feasibility(_req())
    assert res["status"] == "infeasible", res
    assert res.get("rest_shortfall"), res
    assert "쉴 코드가 없습니다" in res.get("message", ""), res


def test_신호등_주휴_넣으면_쉴코드_부족은_사라진다():
    """주휴를 그 달 전체에 넣으면 이 산술은 더 이상 걸리지 않는다.

    (6명·한 달 전체는 V 월 1회·연속근무 한도 등 다른 이유로 여전히 infeasible 일
    수 있다 — 여기서 보는 것은 '쉴 코드 부족'이 원인 목록에서 빠지는가뿐이다.)"""
    from server.conflict_analyzer import check_feasibility
    nurses = _mini_nurses(6)
    res = check_feasibility(_req(prev=_juhu_prev(nurses, YEAR, MONTH, 31)))
    assert not res.get("rest_shortfall"), res
    assert "쉴 코드" not in (res.get("message") or ""), res


def test_월경계_주는_판정하지_않는다():
    """V·생 월 한도가 다음 달로 넘어가 공급이 달라진다 — 거짓 부족 방지."""
    s = LimitedScheduler(_req(), max_days=40)
    weeks = {w["week"] for w in s.rest_supply_shortfall()}
    boundary = {wi + 1 for wi, (ws, we) in enumerate(s.weeks)
                if any(s.all_dates[d].month != MONTH for d in range(ws, we + 1)
                       if s.all_dates[d] >= __import__("datetime").date(YEAR, MONTH, 1))}
    assert not (weeks & boundary), f"월 경계 주가 잡혔다: {weeks & boundary}"


def test_신호등_주휴가_첫주만_있으면_남은_주를_짚는다():
    from server.conflict_analyzer import check_feasibility
    nurses = _mini_nurses(6)
    res = check_feasibility(_req(prev=_juhu_prev(nurses, YEAR, MONTH, 7)))
    assert res["status"] == "infeasible", res
    weeks = [w["week"] for w in res["rest_shortfall"]]
    assert 1 not in weeks, f"주휴가 있는 1주차는 빠져야 한다: {weeks}"
    assert weeks, res
