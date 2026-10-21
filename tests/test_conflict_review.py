"""충돌 분석 리뷰 반영 (2026-10-21) — 처방(MCS)이 지난달 기록 칸을 '제거'하라고 내지 않는다.

지난달 칸(1일 앞 주기 칸)은 기록이다 — 완화·진단처럼 고정한다. 예전엔 지난달 N 제거(비용 1)가 휴무 제거(30~100)보다 싸서
처방으로 뽑혔고, 적용하면 다음 생성이 그날을 자유 칸으로 보고 밤근무 다음 날인 사람에게 D 를 줬다.
이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

from datetime import date, timedelta

from server.conflict_analyzer import suggest_correction
from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules

from .test_exact_fit_characterization import PROD_SHIFTS


def _juhu_prev(ns, start, end):
    prev = {n.id: {} for n in ns}
    dt = start
    while dt <= end:
        for i, n in enumerate(ns):
            if dt.weekday() == i % 7:
                prev[n.id][dt.isoformat()] = "주"
        dt += timedelta(days=1)
    return prev


def test_mcs_never_removes_previous_month_records():
    """3/1 에 간호02~05 가 D·E·E·N 잠금, 간호06 OF, 간호07 V — 지난달 2/28 에 N 을 선 간호01 은 3/1 에 D 를 못 받는다(N→D).
    예전 처방: "간호01 02/28 'N' 제거". 이제 처방에 3/1 전 칸이 없다."""
    ns = [Nurse(id=f"n{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                capable_shifts=["DC", "D", "EC", "E", "NC", "N"], seniority=i) for i in range(7)]
    prev = _juhu_prev(ns, date(2026, 2, 22), date(2026, 4, 4))
    prev["n0"]["2026-02-28"] = "N"
    prev["n0"].pop("2026-03-01", None)
    locked = {}
    for i, c in {1: "D", 2: "E", 3: "E", 4: "N", 5: "OF", 6: "V"}.items():
        prev[f"n{i}"]["2026-03-01"] = c
        if i <= 4:
            locked.setdefault(f"n{i}", {})["2026-03-01"] = True
    req = Requirements()
    for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, k, DayRequirement(D=2, E=2, N=1))
    r = GenerateRequest(year=2026, month=3, nurses=ns, requirements=req, rules=Rules(), prev_schedule=prev,
                        shifts=PROD_SHIFTS, locked_cells=locked, time_limit=20)
    f = suggest_correction(r)
    bad = [rm for rm in (f.get("removals") or []) if rm["date_iso"] < "2026-03-01"]
    assert bad == [], bad


def test_mcs_accepts_locked_cells_above_the_day_requirement():
    """3/17 에 잠긴 D 셋(필요 2명) — 엔진은 사실로 받아 만든다. 처방도 그날 때문에 통째로 '계산하지 못했습니다'가 되지 않는다."""
    ns = [Nurse(id=f"n{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                capable_shifts=["DC", "D", "EC", "E", "NC", "N"], seniority=i) for i in range(7)]
    prev = _juhu_prev(ns, date(2026, 2, 22), date(2026, 4, 4))
    locked = {}
    for i in (0, 2, 3):
        prev[f"n{i}"]["2026-03-17"] = "D"
        locked.setdefault(f"n{i}", {})["2026-03-17"] = True
    req = Requirements()
    for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, k, DayRequirement(D=2, E=2, N=1))
    r = GenerateRequest(year=2026, month=3, nurses=ns, requirements=req, rules=Rules(), prev_schedule=prev,
                        shifts=PROD_SHIFTS, locked_cells=locked, time_limit=20)
    f = suggest_correction(r)
    assert f.get("fixable") is True, f.get("message")


def test_analysis_names_a_day_nobody_can_cover():
    """3/10 에 모두 확정(D·D·E·E·OF) 또는 'N제외' — 그날 N 을 설 사람이 없다(식이 모두 상수). 예전엔 그 게이트를 건너뛰어
    원인이 빠졌다(병동 근무 정의에 NC 가 없으면 '충돌 없음'). 이제 'N 필요 인원'을 짚는다."""
    from server.conflict_analyzer import analyze_conflicts
    caps = ["DC", "D", "EC", "E", "N"]
    ns = [Nurse(id=f"n{i}", name=f"간호{i + 1:02d}", group="A", gender="female", capable_shifts=caps, seniority=i)
          for i in range(7)]
    prev = _juhu_prev(ns, date(2026, 2, 22), date(2026, 4, 4))
    for i, c in enumerate(["D", "D", "E", "E", "OF", "N제외", "N제외"]):
        prev[f"n{i}"]["2026-03-10"] = c
    req = Requirements()
    for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, k, DayRequirement(D=2, E=2, N=1))
    r = GenerateRequest(year=2026, month=3, nurses=ns, requirements=req, rules=Rules(), prev_schedule=prev,
                        shifts=[s for s in PROD_SHIFTS if s.code != "NC"], time_limit=20)
    a = analyze_conflicts(r)
    assert any("03/10" in c and "N 필요 인원" in c for c in a.get("conflicts") or []), a
