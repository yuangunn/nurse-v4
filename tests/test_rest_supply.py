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


def test_월경계_주도_판정한다():
    """달 끝에 걸친 주도 이 근무표가 정한다 (병동 11월 번표 = 11/1~12/5, 2026-10-16) — 예전엔
    V·생 월 한도가 다음 달로 넘어간다며 건너뛰어, 주휴가 빠진 꼬리 주를 아무도 알리지 않았다.
    다음 달 몫은 따로 센다: V 는 끝에 붙은 며칠에 1회, 생은 미리 넣은 것만 (엔진 _tail_saeng_cap —
    자세한 산술은 test_month_tail)."""
    prev = {f"a{i}": {"2026-03-02": "V"} for i in range(6)}     # 3월 V 는 이미 씀
    s = LimitedScheduler(_req(prev=prev), max_days=40)
    rows = [w for w in s.rest_supply_shortfall() if w["boundary"]]
    assert [(w["start"], w["end"]) for w in rows] == [("2026-03-29", "2026-04-04")], rows
    # 6명×7 − 21 = 21 · 공급 = 사람마다 OF 1 + 4월 몫 V 1 + 3월 생(여성 4명) = 16 — 4월 생은 세지 않는다
    assert (rows[0]["demand"], rows[0]["supply"]) == (21, 16), rows[0]


def test_신호등_주휴가_첫주만_있으면_남은_주를_짚는다():
    from server.conflict_analyzer import check_feasibility
    nurses = _mini_nurses(6)
    res = check_feasibility(_req(prev=_juhu_prev(nurses, YEAR, MONTH, 7)))
    assert res["status"] == "infeasible", res
    weeks = [w["week"] for w in res["rest_shortfall"]]
    assert 1 not in weeks, f"주휴가 있는 1주차는 빠져야 한다: {weeks}"
    assert weeks, res


def test_공휴일_자유_칸은_법으로_쉴_수_있다():
    """주 중간 공휴일(병원 휴일 등)의 자유 칸은 일반 간호사가 '법'으로 쉰다 —
    공급에서 빼면 거짓 부족이 난다 (2026-10-03, 병원 휴일 4개 추가 때 발견)."""
    hol = ["2026-03-02", "2026-03-03", "2026-03-04"]
    s = LimitedScheduler(_req(holidays=hol), max_days=7)
    assert s.rest_supply_shortfall() == [], s.rest_supply_shortfall()
    # 공휴일이 하루면 그만큼만 는다: 16 + 6명×1 = 22 ≥ 21
    s1 = LimitedScheduler(_req(holidays=["2026-03-04"]), max_days=7)
    assert s1.rest_supply_shortfall() == []


def test_일반_간호사의_공휴일_OF_확정은_빈칸으로_센다():
    """엔진은 일반 간호사의 공휴일 OF 사전입력을 지우고(그 칸은 '법'으로 쉴 수 있다) 주 1회
    OF 도 그대로 남긴다. 수급 산술이 원본 사전입력을 보면 그 칸을 '이미 쉰 칸'으로 세어
    OF·법 자리를 둘 다 빼서 거짓 빨강을 냈다 (2026-10-03 PR #79 검토)."""
    prev = {"a1": {"2026-03-04": "OF"}, "a2": {"2026-03-04": "OF"}}
    s = LimitedScheduler(_req(prev=prev, holidays=["2026-03-04"]), max_days=7)
    assert s.rest_supply_shortfall() == [], s.rest_supply_shortfall()


def test_임신_달의_야간전담_표시는_일반으로_센다():
    """임신 중인 달은 야간전담이 아니다(엔진 __init__). 수급 산술이 night_months 만 보면
    그 사람을 수급에서 빼 거짓 빨강을 냈다 (2026-10-03 PR #79 검토)."""
    req = _req(prev=_juhu_prev(_mini_nurses(6), YEAR, MONTH, 7))
    req.nurses[1].night_months = {"2026-03": True}
    req.nurses[1].is_pregnant = True
    req.nurses[1].pregnancy = {"early": {"start": "2026-02-01", "end": "2026-04-30"},
                               "late": {"start": "2026-08-01", "end": "2026-09-30"}}
    s = LimitedScheduler(req, max_days=7)
    a1 = next(n for n in s.nurses if n["id"] == "a1")
    assert a1["is_night_shift"] is False
    base = LimitedScheduler(_req(prev=_juhu_prev(_mini_nurses(6), YEAR, MONTH, 7)), max_days=7)
    assert s.rest_supply_shortfall() == base.rest_supply_shortfall(), s.rest_supply_shortfall()


# ── 실제 병동 번표가 '쉴 코드 부족'으로 막히던 것 (2026-10-16) ─────────────────
# 1~10월 실제 번표 10개가 전부 이 산술에 걸렸다. 근무 칸을 요구 인원 그대로(하한)
# 잡고 나이트킵 근무를 최대치로 빼서, 쉬어야 할 칸이 실제보다 부풀었기 때문이다.
# 이 산술의 수요는 하한이어야 한다 — 근무 칸은 엔진 인원 제약과 같은 상한으로 잡는다.

def test_확정_근무가_요구보다_많으면_그만큼_덜_쉰다():
    """사실-클램프(결정 1-15): 3/2 D 를 셋이 확정하면 엔진은 그날 D 3명을 받아들인다.
    쉬어야 할 칸도 그만큼(2칸) 준다 — 요구(1명)로 세면 거짓 부족이 난다."""
    prev = {f"a{i}": {"2026-03-02": "D"} for i in range(3)}
    w = LimitedScheduler(_req(prev=prev), max_days=7).rest_supply_shortfall()[0]
    assert w["demand"] == 21 - 2, w
    # 완화를 켜면 엔진이 확정 칸을 규칙 앞에서 바꿀 수 있다 — 클램프 없이 요구 그대로
    w2 = LimitedScheduler(_req(prev=prev, allow_pre_relax=True), max_days=7).rest_supply_shortfall()[0]
    assert w2["demand"] == 21, w2


def test_날_전체가_확정이면_그날_인원은_확정된_근무_그대로():
    """빈칸 없는 날은 엔진이 인원 제약을 건너뛴다 — 그날 근무가 요구보다 적어도 사실이다."""
    day = {"a0": "D", "a1": "E", "a2": "OF", "a3": "주", "a4": "V", "a5": "OF"}
    prev = {nid: {"2026-03-02": c} for nid, c in day.items()}
    w = LimitedScheduler(_req(prev=prev), max_days=7).rest_supply_shortfall()[0]
    # 그날 근무 2칸(요구 3칸) — 쉬어야 할 칸이 하나 는다
    assert w["demand"] == 21 + 1, w


def test_나이트킵은_확정된_근무만큼만_뺀다():
    """나이트킵 근무는 정해진 것(하한)만 일반 간호사 몫에서 뺀다. 예전엔 재적 칸 전부(7)를
    빼서 수요가 21 로 부풀었고, 주휴까지 넣은 번표가 막혔다."""
    nurses = _mini_nurses(6)
    prev = _juhu_prev(nurses[:5], YEAR, MONTH, 7)
    prev["a5"] = {"2026-03-02": "N", "2026-03-03": "N", "2026-03-05": "N"}
    req = _req(prev=prev)
    req.nurses[5].night_months = {"2026-03": True}
    s = LimitedScheduler(req, max_days=7)
    assert next(n for n in s.nurses if n["id"] == "a5")["is_night_shift"] is True
    # 일반 5명 × 7일 = 35칸, 근무 21 − 나이트킵 확정 3 = 18 → 쉬어야 할 칸 17
    # 공급 = 주휴 5 + OF 5 + V 5 + 생 4(여성 a0·a1·a2·a4) = 19 ≥ 17
    assert s.rest_supply_shortfall() == [], s.rest_supply_shortfall()
    nojuhu = dict(prev)
    for nid in ("a0", "a1", "a2", "a3", "a4"):
        nojuhu.pop(nid)
    req2 = _req(prev=nojuhu)
    req2.nurses[5].night_months = {"2026-03": True}
    w = LimitedScheduler(req2, max_days=7).rest_supply_shortfall()[0]
    assert w["demand"] == 17, w


def test_D1_중_확정은_쉬는_칸도_DEN_칸도_아니다():
    """D1(상근)·중간번은 D·E·N 인원 밖 근무 — 그 칸을 '쉬어야 할 칸'으로 세면 거짓 부족."""
    prev = {"a1": {"2026-03-02": "D1"}, "a2": {"2026-03-03": "중"}}
    w = LimitedScheduler(_req(prev=prev), max_days=7).rest_supply_shortfall()[0]
    assert w["demand"] == 21 - 2, w


def test_V_월_한도가_2회_이상이면_한_주에_그만큼_쉴_수_있다():
    """공급은 상한 — 월 2회면 한 주에 V 둘도 된다. 1개로만 세면 엔진이 만드는 표에 거짓 '쉴 코드 부족'이 뜬다
    (2026-10-16 검토). 규칙이 0 이면 엔진은 V 월 한도를 걸지 않는다 — 부족으로 보지 않는다."""
    req = _req()
    one = LimitedScheduler(req, max_days=7).rest_supply_shortfall()
    assert one and (one[0]["demand"], one[0]["supply"]) == (21, 16), one
    # 월 2회: OF 6 + V 12 + 생 4 = 22 ≥ 21
    req.rules = Rules(**{**req.rules.model_dump(), "maxVPerMonth": 2})
    assert LimitedScheduler(req, max_days=7).rest_supply_shortfall() == []
    req.rules = Rules(**{**req.rules.model_dump(), "maxVPerMonth": 0})
    assert LimitedScheduler(req, max_days=7).rest_supply_shortfall() == []
