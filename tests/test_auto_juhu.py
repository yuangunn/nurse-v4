"""끝 주(끝에 붙은 다음 달 며칠이 든 주)에 주휴가 빠졌으면 블록 요일로 채운다 (결정 1-41).

사용자의 11월 근무표 (2026-10-16): 옛 주휴 추천이 끝 주(11/29~12/5)를 건너뛰어 그 주 주휴가 거의
비어 있었다. 엔진은 주휴를 만들지 않으므로(사전입력 전용) 꼬리 생을 막고 신규가 독립하자 쉬는 칸이
모자라 '생리휴가 제약 충돌'로 막혔다. 병동이 실제로 넣은 그 주 주휴는 13명 중 12명이 같은 블록의 요일.

블록: _CYCLE_REF(2026-03-01)부터 28일 — 11/08~12/05 가 한 블록이라 11/29 주는 4주기.
이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules
from server.scheduler import NurseScheduler
from server.scheduler_cpsat import CpSatScheduler

from .test_exact_fit_characterization import PROD_SHIFTS

CAPS = ["DC", "D", "EC", "E", "NC", "N"]
RULES = dict(noNOD=False, restAfterNight=False, maxConsecutiveNight=False,
             maxNightPerMonth=False, maxConsecutiveWorkDays=6)
BLOCK_WEEKS = [date(2026, 11, 8), date(2026, 11, 15), date(2026, 11, 22), date(2026, 11, 29)]


def _iso(d: date) -> str:
    return d.strftime("%Y-%m-%d")


def _request(prev, n=7, d=2, e=2, nn=1, nurses=None, **kw) -> GenerateRequest:
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=d, E=e, N=nn))
    if nurses is None:
        nurses = [Nurse(id=f"a{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                        capable_shifts=CAPS, seniority=i) for i in range(n)]
    return GenerateRequest(year=2026, month=11, nurses=nurses, requirements=req,
                           rules=Rules(**RULES), prev_schedule=prev, shifts=PROD_SHIFTS,
                           time_limit=60, **kw)


def _juhu_on(prev, nid, weeks, offset):
    """weeks 의 각 주 일요일 + offset 날에 주휴 (offset 3 = 수요일)."""
    for ws in weeks:
        prev.setdefault(nid, {})[_iso(ws + timedelta(days=offset))] = "주"
    return prev


def _added(s):
    return {(a["nurse_id"], a["date"]) for a in s.auto_juhu}


def test_fills_missing_week_on_block_weekday():
    """간호01: 11/11·11/18·11/25(수) 주휴, 11/29 주는 비어 있다 → 12/02(수)."""
    prev = _juhu_on({}, "a0", BLOCK_WEEKS[:3], 3)
    s = NurseScheduler(_request(prev))
    assert _added(s) == {("a0", "2026-12-02")}
    assert s.prev["a0"]["2026-12-02"] == "주"
    assert s.auto_juhu[0]["name"] == "간호01"
    # 다른 블록의 주(11/1 주는 10/11 블록의 4주기)는 그 블록에 주휴가 없으니 손대지 않는다
    assert not any(d < "2026-11-08" for _, d in _added(s))


def test_skips_when_target_cell_is_taken_or_locked():
    prev = _juhu_on({}, "a0", BLOCK_WEEKS[:3], 3)
    _juhu_on(prev, "a1", BLOCK_WEEKS[:3], 3)
    _juhu_on(prev, "a2", BLOCK_WEEKS[:3], 3)
    prev["a0"]["2026-12-02"] = "D"                       # 사람이 넣은 칸 — 그대로
    prev["a1"]["2026-12-02"] = "D/E"                     # 둘 중 하나 원티드도 사람이 넣은 칸
    locked = {"a2": {"2026-12-02": True}}
    s = NurseScheduler(_request(prev, locked_cells=locked))
    assert _added(s) == set()
    assert s.prev["a0"]["2026-12-02"] == "D"


def test_skips_when_week_already_has_juhu_or_weekday_is_unclear():
    prev = _juhu_on({}, "a0", BLOCK_WEEKS, 3)            # 네 주 모두 있음
    _juhu_on(prev, "a1", BLOCK_WEEKS[:1], 1)             # 월 하나 · 수 하나 — 요일이 하나로 안 정해진다
    _juhu_on(prev, "a1", BLOCK_WEEKS[1:2], 3)
    s = NurseScheduler(_request(prev))
    assert _added(s) == set()


def test_keeper_days_and_juhu_relax_are_left_alone():
    """나이트킵의 주휴는 미리 넣은 것만 (제1원칙 10) — 12월 나이트킵의 12/02 는 나이트킵의 날.
    주휴 무시(allow_juhu_relax)면 엔진이 주휴를 직접 놓으므로 채우지 않는다."""
    prev = _juhu_on({}, "a0", BLOCK_WEEKS[:3], 3)
    _juhu_on(prev, "a1", BLOCK_WEEKS[:3], 3)
    nurses = [Nurse(id=f"a{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                    capable_shifts=CAPS, seniority=i,
                    night_months={"2026-12": True} if i == 0 else {}) for i in range(7)]
    s = NurseScheduler(_request(prev, nurses=nurses))
    assert _added(s) == {("a1", "2026-12-02")}           # 간호01 은 12월 나이트킵
    s = NurseScheduler(_request(prev, nurses=nurses, allow_juhu_relax=True))
    assert _added(s) == set()


def test_november_keeper_juhu_is_no_reference_for_december_days():
    """11월 나이트킵의 11월 주휴는 나이트킵의 날이라 일반의 날(12/1~12/5) 요일의 근거가 아니다
    (_juhu_anchor 와 같다 — 결정 1-36 후속 2)."""
    prev = _juhu_on({}, "a0", BLOCK_WEEKS[:3], 3)
    nurses = [Nurse(id=f"a{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                    capable_shifts=CAPS, seniority=i,
                    night_months={"2026-11": True} if i == 0 else {}) for i in range(7)]
    assert _added(NurseScheduler(_request(prev, nurses=nurses))) == set()


def test_partial_week_and_staffing_guard():
    """그 주 7일 내내 재적이 아니면(전출) 채우지 않는다. 주휴 하나가 그날 인원을 깨면 채우지 않는다
    — 3명이 매일 D1 E1 N1 이면 그날 쉴 사람이 없다."""
    prev = _juhu_on({}, "a0", BLOCK_WEEKS[:3], 3)
    nurses = [Nurse(id=f"a{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                    capable_shifts=CAPS, seniority=i,
                    end_date="2026-12-03" if i == 0 else None) for i in range(7)]
    assert _added(NurseScheduler(_request(prev, nurses=nurses))) == set()
    assert _added(NurseScheduler(_request(prev, n=3, d=1, e=1, nn=1))) == set()
    assert _added(NurseScheduler(_request(prev, n=4, d=1, e=1, nn=1))) == {("a0", "2026-12-02")}


def test_only_the_tail_week_is_filled():
    """달 안의 주는 사람이 넣는 자리다 (주휴 추천이 여유 있는 요일로 블록을 옮겨 준다) — 11/22 주가 비어도 그대로."""
    prev = _juhu_on({}, "a0", BLOCK_WEEKS[:2], 3)
    assert _added(NurseScheduler(_request(prev))) == {("a0", "2026-12-02")}


def test_new_block_tail_week_pulls_one_day_earlier():
    """2027년 1월: 끝 주 1/31~2/6 이 새 블록의 첫 주 — 앞 블록(1/3~1/30) 수요일이면 하루 당긴 화요일 2/2.
    실제 번표: 블록이 바뀔 때 85% 가 하루 당겼다. 요일 고정(juhu_auto_rotate 끔)이면 같은 수요일."""
    first = [date(2027, 1, 3) + timedelta(days=7 * k) for k in range(4)]
    for rotate, want in ((True, "2027-02-02"), (False, "2027-02-03")):
        nurses = [Nurse(id=f"a{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                        capable_shifts=CAPS, seniority=i, juhu_auto_rotate=rotate) for i in range(7)]
        prev = _juhu_on({}, "a0", first, 3)
        req = _request(prev, nurses=nurses).model_copy(update={"year": 2027, "month": 1})
        s = NurseScheduler(req)
        assert _iso(s.all_dates[-1]) == "2027-02-06"
        assert _added(s) == {("a0", want)}, (rotate, s.auto_juhu)


def test_trainee_slash_juhu_counts_as_reference():
    """달 중간에 독립한 신규: 트레이닝 날의 '/주' 도 블록 요일의 근거다 (결정 1-39)."""
    nurses = [Nurse(id=f"a{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                    capable_shifts=CAPS, seniority=i) for i in range(7)]
    nurses.append(Nurse(id="t0", name="신규01", group="A", gender="female", capable_shifts=CAPS,
                        seniority=9, is_trainee=True, preceptor_id="a0",
                        training_end_date="2026-11-20"))
    prev = {"t0": {"2026-11-11": "/주", "2026-11-18": "/주"}}
    s = NurseScheduler(_request(prev, nurses=nurses))
    assert _added(s) == {("t0", "2026-12-02")}


@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_generated_tail_week_gets_block_juhu_and_is_reported(engine):
    """7명 · 매일 D2 E2 N1 · 11/15~12/05 세 주만 푼다 — 앞 두 주에 사람마다 다른 요일 주휴, 끝 주는 비어 있다.
    채우면 끝 주도 주휴 7 + OF 7 로 딱 맞아 V·꼬리 생이 없다. 넣은 칸은 결과 auto_juhu 와 문구로 알린다."""
    from .test_month_tail import _engine
    prev = {}
    for i in range(7):
        _juhu_on(prev, f"a{i}", BLOCK_WEEKS[1:3], i)
    cls = _engine(engine, date(2026, 11, 15), date(2026, 12, 5))
    s = cls(_request(prev))
    assert len(s.auto_juhu) == 7
    r = s.solve()
    assert r["success"], r.get("message")
    ext = r["extended_schedule"]
    for i in range(7):
        assert ext[f"a{i}"][_iso(BLOCK_WEEKS[3] + timedelta(days=i))] == "주", ext[f"a{i}"]
    assert not [(nid, d) for nid, row in ext.items() for d, c in row.items() if c in ("V", "생")]
    assert {(a["nurse_id"], a["date"]) for a in r["auto_juhu"]} == {
        (f"a{i}", _iso(BLOCK_WEEKS[3] + timedelta(days=i))) for i in range(7)}
    assert "같은 주기(1~4주기) 요일로 주휴를 넣었습니다 7칸" in r["message"], r["message"][-600:]
    assert "12/01(화) 간호03" in r["message"]
    assert not r.get("missing_juhu"), r.get("missing_juhu")


def test_tail_per_day_requirement_sizes_the_fill():
    """끝 주의 날짜별 인원도 그 날짜에 건다(결정 1-47) — 주휴를 채울 때도 같은 수로 센다. 8명 모두 수요일 블록이라
    12/02(수)에 주휴를 넣는데, 그날 낮 근무를 3명으로 올려 두면(그날 6명 근무) 넣을 수 있는 건 둘이다.
    예전엔 요일 기본(5명)으로 세어 셋을 넣어 그날 인원을 못 채우고 생성이 실패했다."""
    prev = {}
    for i in range(8):
        _juhu_on(prev, f"a{i}", BLOCK_WEEKS[:3], 3)
    assert len(_added(NurseScheduler(_request(prev, n=8)))) == 3
    s = NurseScheduler(_request(prev, n=8, per_day_requirements={"2026-12-02": {"D": 3}}))
    assert len(_added(s)) == 2 and all(d == "2026-12-02" for _, d in _added(s)), s.auto_juhu


def test_next_month_keepers_are_not_day_side_capacity():
    """12월 나이트킵 둘은 12/02 에 야간만 받는다 — 낮·저녁 자리(D2 E2)엔 일반 6명만 있다. 주휴를 셋 넣으면
    낮·저녁에 셋만 남아 인원을 못 채운다 → 둘만 넣는다 (예전엔 나이트킵까지 세어 셋)."""
    prev = {}
    for i in range(6):
        _juhu_on(prev, f"a{i}", BLOCK_WEEKS[:3], 3)
    nurses = [Nurse(id=f"a{i}", name=f"간호{i + 1:02d}", group="A", gender="female", capable_shifts=CAPS,
                    seniority=i, night_months={"2026-12": True} if i >= 6 else {}) for i in range(8)]
    assert len(_added(NurseScheduler(_request(prev, nurses=nurses)))) == 2
