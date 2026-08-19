"""이월(전월 완성 번표) 생성 — 경계 동작 특성화 (M4 후속, 2026-08-19).

사용자 시나리오: "전월 번표가 완성돼 있고 이월해서 당월을 만드는데 그 부분에서
오류가 난다." 풀 스케줄러(주기 확장 포함 — LimitedScheduler는 전월 구간을 잘라
재현 불가)로 확인한 사실:

  · 이월 자체는 버그가 아니다 — 깨끗한 전월 기록 + 규칙에 맞는 당월 표는 정상 생성.
  · 전월 '내부'에서 완결된 규칙 위반은 소급하지 않는다 (E→D가 3/29→3/30이면 통과).
  · 경계 걸침 검사(①경계 금지 전환 ②경계 걸침 연속근무/야간 ③전월말 연속야간 후
    휴무 부족 ④당월 첫 부분-주의 OF 2개)는 '자유 셀'에만 걸린다 — 사실-클램프
    (2026-08-19) 이후, 걸치는 셀이 전부 사전입력 확정이면 주어진 사실로 수용하고
    (생성 성공) 규칙 차이는 pinned_notes가 셀 좌표까지 짚어 안내만 한다.
    확정 셀 '옆'의 자유 셀에는 여전히 같은 검사가 걸린다 (한쪽 확정 = 상수 반영).

2026-04 주기: 2026-03-29(일)~2026-05-02(토), 전월 중첩 3일.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules
from server.scheduler import NurseScheduler

from .test_exact_fit_characterization import PROD_SHIFTS

CYCLE_START = date(2026, 3, 29)

ISO = dict(noNOD=False, restAfterNight=False, maxConsecutiveNight=False,
           maxNightPerMonth=False, maxConsecutiveWorkDays=6, maxVPerMonth=1)


def _nurses4():
    return [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="female",
                  capable_shifts=["DC", "D", "EC", "E", "NC", "N"], seniority=i)
            for i in range(4)]


def _req111():
    r = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(r, day, DayRequirement(D=1, E=1, N=1))
    return r


def _rest_pins():
    """주별 휴무 로테이션(쉬는 사람 1명/일) — 당월(4월) 날짜에만 핀.
    주 w·요일 t(0=일): 쉬는 간호사 = (t+w)%4, 첫 휴무=OF·둘째=주."""
    prev = {f"a{i}": {} for i in range(4)}
    for w in range(5):
        seen = {f"a{i}": 0 for i in range(4)}
        for t in range(7):
            d = CYCLE_START + timedelta(days=w * 7 + t)
            nid = f"a{(t + w) % 4}"
            code = "OF" if seen[nid] == 0 else "주"
            seen[nid] += 1
            if d.month == 4:
                prev[nid][d.strftime("%Y-%m-%d")] = code
    return prev


CLEAN_TAIL = {
    "a0": {"2026-03-29": "D", "2026-03-30": "D", "2026-03-31": "OF"},
    "a1": {"2026-03-29": "E", "2026-03-30": "E", "2026-03-31": "E"},
    "a2": {"2026-03-29": "N", "2026-03-30": "N", "2026-03-31": "주"},
    "a3": {"2026-03-29": "OF", "2026-03-30": "D", "2026-03-31": "D"},
}


def _solve(prev, rules_kw=None):
    req = GenerateRequest(year=2026, month=4, nurses=_nurses4(), requirements=_req111(),
                          rules=Rules(**(rules_kw or ISO)), prev_schedule=prev,
                          shifts=PROD_SHIFTS, time_limit=90)
    return NurseScheduler(req).solve()


def _with_tail(pins, tail):
    prev = {nid: dict(d) for nid, d in pins.items()}
    for nid, cells in tail.items():
        prev.setdefault(nid, {}).update(cells)
    return prev


def test_clean_carryover_succeeds():
    """깨끗한 전월 이월은 정상 생성 — 이월 자체는 버그가 아니다."""
    r = _solve(_with_tail(_rest_pins(), CLEAN_TAIL))
    assert r["success"], r["message"]


def test_prev_month_internal_violation_not_retroactive():
    """전월 내부에서 완결된 위반(E→D)은 소급하지 않는다."""
    tail = {nid: dict(c) for nid, c in CLEAN_TAIL.items()}
    tail["a0"].update({"2026-03-29": "E", "2026-03-30": "D", "2026-03-31": "OF"})
    r = _solve(_with_tail(_rest_pins(), tail))
    assert r["success"], r["message"]


def test_boundary_transition_pinned_pair_is_fact():
    """경계 걸침 위반(전월 3/31 N → 당월 4/1 D)이라도 '둘 다 확정'이면 주어진
    사실 — 생성은 성공하고 pinned_notes가 경계 셀 좌표를 짚는다 (사실-클램프)."""
    tail = {nid: dict(c) for nid, c in CLEAN_TAIL.items()}
    tail["a0"]["2026-03-31"] = "N"
    prev = _with_tail(_rest_pins(), tail)
    prev["a0"]["2026-04-01"] = "D"
    r = _solve(prev)
    assert r["success"], r["message"]
    assert any("N→D" in n and "03/31" in n for n in r["pinned_notes"]), r["pinned_notes"]
    # 확정 셀은 그대로 (D는 차지 승격 DC 가능)
    assert r["schedule"]["a0"]["2026-04-01"] in ("D", "DC")


def test_boundary_transition_free_cell_still_constrained():
    """대조: 전월말 확정 N 옆의 당월 첫날이 '자유' 셀이면 금지 전환이 그대로
    걸린다 — 확정 한쪽은 상수로 식에 반영 (사실-클램프는 양쪽 확정만 스킵).
    이 구성에선 인원상 a0가 4/1 근무해야 하는데 N 뒤라 N만 가능하다."""
    tail = {nid: dict(c) for nid, c in CLEAN_TAIL.items()}
    tail["a0"]["2026-03-31"] = "N"
    r = _solve(_with_tail(_rest_pins(), tail))
    assert r["success"], r["message"]
    assert r["schedule"]["a0"]["2026-04-01"] in ("N", "NC")


def test_boundary_partial_week_double_of_pinned_is_fact():
    """당월 첫 부분-주(4/1~4/4)에 확정 OF 2개 — 주휴 구분 없는 병동식 표의
    전형 — 도 확정 사실로 수용된다 (과거엔 infeasible). 규칙 차이는
    pinned_notes가 'OF 2회'로 안내하고 표는 변형되지 않는다."""
    pins = _rest_pins()
    prev = {nid: dict(d) for nid, d in pins.items()}
    del prev["a3"]["2026-04-01"]          # 쉬는 사람 스왑 — 일별 인원은 보존
    prev["a0"]["2026-04-01"] = "OF"
    prev["a0"]["2026-04-02"] = "OF"       # 로테이션의 '주' 자리를 병동식 OF로
    r = _solve(prev)
    assert r["success"], r["message"]
    assert any("OF 2회" in n for n in r["pinned_notes"]), r["pinned_notes"]
    assert r["schedule"]["a0"]["2026-04-01"] == "OF"
    assert r["schedule"]["a0"]["2026-04-02"] == "OF"
