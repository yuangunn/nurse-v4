"""사전입력 사실-클램프 (부분 확정 일반화, 2026-08-19 사용자 지시).

사용자 시나리오: "1월 2주차까지만 사전입력으로 꽉 채우고 바꾸고 싶은 부분만
비워서 생성하는 경우에도 (완전 확정 표처럼) 작동해야 한다. 일 단위로 근무표가
모두 차 있다면 그 일에만 확정하는 게 맞다."

의미론 (scheduler_base._build_pin_index 주석 참조):
  · 확정 셀만으로 결정되는 제약(일 전체·인접 쌍·윈도우·주 전체 확정)은 걸지 않는다.
  · 확정+자유 혼합 카운트 제약(일별 인원·주 OF·월 V/야간 등)은 확정분만큼 상한을
    올린다 — 기존 확정은 수용하되 자유 셀이 위반을 '추가'하는 건 여전히 금지.
  · 자유 셀에는 모든 규칙이 그대로 걸린다 (확정 이웃은 상수로 식에 반영).
  · 규칙과 다른 확정 사실은 pinned_notes로만 안내 (성공 결과에 첨부).
  · allow_pre_relax=True면 클램프 비활성 (완화가 우선 — test_pre_relax_recovers).
"""
from __future__ import annotations

from .conftest import make_limited, _mini_nurses, _mini_requirements
from server.models import GenerateRequest, Rules

from .test_exact_fit_characterization import (
    BASE7, BASE_W2, DATES_W1, DATES_W2, ISO_RULES, PROD_SHIFTS, to_prev,
)

YEAR, MONTH = 2026, 3
DATES_W3 = [f"2026-03-{i:02d}" for i in range(15, 22)]


def _req(prev, days):
    return GenerateRequest(
        year=YEAR, month=MONTH, nurses=_mini_nurses(4),
        requirements=_mini_requirements(), rules=Rules(**ISO_RULES),
        prev_schedule=prev, shifts=PROD_SHIFTS, time_limit=90,
    )


def _two_weeks_pinned_prev():
    """주 1~2 완전 확정 (규칙 차이 3건 포함: a3 OF 2회·a2 OF 0회·a0 V 2회),
    주 3은 완전 자유."""
    t = {k: v[:] for k, v in BASE7.items()}
    t["a2"][2], t["a3"][2] = "N", "OF"      # 3/03 OF 몰림 (a3 W1 OF 2회, a2 0회)
    prev = to_prev(t, DATES_W1)
    for nid, days in to_prev(BASE_W2, DATES_W2).items():
        prev[nid].update(days)
    prev["a0"]["2026-03-05"] = "V"          # 주 자리 → V (월 2회)
    prev["a0"]["2026-03-13"] = "V"
    return prev


def _period_count(sched, dk, codes):
    return sum(1 for days in sched.values() if days.get(dk) in codes)


def test_two_weeks_pinned_rest_free():
    """주 1~2 확정(위반 포함) + 주 3 자유 → 성공. 확정 셀은 그대로, 위반은
    notes로만, 자유 주는 앱 규칙대로 채워진다."""
    r = make_limited(_req(_two_weeks_pinned_prev(), 21), days=21).solve()
    assert r["success"], r["message"]
    s = r["schedule"]
    # 확정 셀 보존 — 완전 확정 날은 리터럴(차지 승격도 없음)
    assert s["a3"]["2026-03-03"] == "OF"
    assert s["a2"]["2026-03-03"] == "N"
    assert s["a0"]["2026-03-05"] == "V"
    assert s["a0"]["2026-03-13"] == "V"
    # 규칙 차이는 안내로만
    notes = r["pinned_notes"]
    assert any("OF 2회" in n for n in notes), notes
    # OF 0회는 규칙 차이가 아니다 — 결원 시 불가피한 오프특근(제1원칙 3)이라
    # 안내가 아니라 off_teukgeun 리포트로 보고된다.
    assert not any("OF 0회" in n for n in notes), notes
    assert any("V 2회" in n for n in notes), notes
    # 자유 주(3주차)는 앱 규칙 준수: 일별 인원 정확, 간호사별 OF 1회
    for dk in DATES_W3:
        assert _period_count(s, dk, ("DC", "D")) == 1, dk
        assert _period_count(s, dk, ("EC", "E")) == 1, dk
        assert _period_count(s, dk, ("NC", "N")) == 1, dk
    for nid in s:
        assert sum(1 for dk in DATES_W3 if s[nid].get(dk) == "OF") == 1, nid
    # 월 V 클램프: a0는 확정 2회가 이미 상한 — 자유 셀에 V 추가 금지
    assert sum(1 for dk in DATES_W3 if s["a0"].get(dk) == "V") == 0


def test_single_day_fully_pinned_is_fact():
    """일 단위 확정: 3/03 하루만 전원 확정(D 2명·E 0명 — 기준과 다름) →
    그 날만 사실로 확정(인원 제약 스킵 + 리터럴), 나머지 날은 기준대로."""
    prev = {"a0": {"2026-03-03": "D"}, "a1": {"2026-03-03": "D"},
            "a2": {"2026-03-03": "N"}, "a3": {"2026-03-03": "OF"}}
    r = make_limited(_req(prev, 7), days=7).solve()
    assert r["success"], r["message"]
    s = r["schedule"]
    # 완전 확정 날은 리터럴 그대로 (차지 승격조차 없음)
    assert [s[n]["2026-03-03"] for n in ("a0", "a1", "a2", "a3")] == ["D", "D", "N", "OF"]
    assert any("일별 인원" in n and "03/03" in n for n in r["pinned_notes"]), r["pinned_notes"]
    # 다른 날들은 기준(1/1/1) 정확
    for i in (1, 2, 4, 5, 6, 7):
        dk = f"2026-03-{i:02d}"
        assert _period_count(s, dk, ("DC", "D")) == 1, dk
        assert _period_count(s, dk, ("EC", "E")) == 1, dk
        assert _period_count(s, dk, ("NC", "N")) == 1, dk


def test_mixed_day_pinned_surplus_clamps_daily_req():
    """부분 확정 날: 3/04에 D 2명이 확정(기준 1) → 기준을 확정분(2)으로
    클램프해 수용하고, 자유 셀이 그 날 D를 더 늘리진 못한다. E/N은 기준대로."""
    prev = {"a0": {"2026-03-04": "D"}, "a1": {"2026-03-04": "D"}}
    r = make_limited(_req(prev, 7), days=7).solve()
    assert r["success"], r["message"]
    s = r["schedule"]
    # 부분 확정 날은 플렉스 유지 — 차지 승격(D→DC)은 가능
    assert s["a0"]["2026-03-04"] in ("D", "DC")
    assert s["a1"]["2026-03-04"] in ("D", "DC")
    assert _period_count(s, "2026-03-04", ("DC", "D")) == 2
    assert _period_count(s, "2026-03-04", ("EC", "E")) == 1
    assert _period_count(s, "2026-03-04", ("NC", "N")) == 1
    for i in (1, 2, 3, 5, 6, 7):
        assert _period_count(s, f"2026-03-{i:02d}", ("DC", "D")) == 1, i


def test_cpsat_partial_pin_parity():
    """CP-SAT 엔진도 동일 의미론 (클램프 12곳 미러) — 주 1~2 확정 시나리오."""
    r = make_limited(_req(_two_weeks_pinned_prev(), 21), days=21,
                     solver="cpsat").solve()
    assert r["success"], r["message"]
    s = r["schedule"]
    assert s["a0"]["2026-03-05"] == "V"
    assert s["a3"]["2026-03-03"] == "OF"
    assert any("V 2회" in n for n in r["pinned_notes"]), r["pinned_notes"]
    assert sum(1 for dk in DATES_W3 if s["a0"].get(dk) == "V") == 0
