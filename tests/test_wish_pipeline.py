"""위시 파이프라인 회귀 테스트 — 원장(거절 누적), 공정성 가중, 반영 리포트."""
from __future__ import annotations

import json

import pytest

from server.models import GenerateRequest, Rules, ScoringRule
from tests.conftest import _mini_nurses, _mini_requirements, _juhu_prev, make_limited


def test_wish_ledger_from_saved_schedules(tmp_path, monkeypatch):
    """저장본(저장 시점의 wishes+schedule)만으로 직전 달 신청/반영을 집계한다."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    db.init_db()
    db.save_schedule(
        year=2026, month=5,
        data={
            "nurses": [{"id": "a1", "name": "간호1",
                        "wishes": {"10": "OFF", "12": "OFF", "20": "E"}}],
            "schedule": {"a1": {"2026-05-10": "OF",   # OFF 희망 → 반영
                                "2026-05-12": "D",    # OFF 희망 → 미반영
                                "2026-05-20": "E"}},  # E 희망 → 반영
        },
        name="5월 확정",
    )
    ledger = db.compute_wish_ledger(2026, 6)
    assert ledger["a1"] == {"requested": 3, "granted": 2}


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_wish_boost_prefers_previously_rejected_nurse(build_request, solver):
    """같은 날 OFF 위시가 경합할 때, 거절 누적 가중(wish_boosts)이 큰 간호사가
    우선 반영되어야 한다 — '지난달 거절당한 사람 우선'의 솔버 반영 검증."""
    nurses = _mini_nurses(6)
    # a1·a2 모두 3/5(목) OFF 희망. 3/5는 a3 주휴 + 요구 4명 → 잔여 휴식 슬롯 1개.
    for n in nurses:
        if n.id in ("a1", "a2"):
            n.wishes = {"5": "OFF"}
    req = build_request(nurses=nurses, year=2026, month=3, days=7,
                        requirements=_mini_requirements(1, 2, 1))
    req.scoring_rules = [ScoringRule(name="희망 반영", rule_type="wish", score=50)]
    req.wish_boosts = {"a2": 3.0}  # a2가 지난달 미반영 누적 보유 가정

    result = make_limited(req, days=7, solver=solver).solve()
    assert result["success"], result.get("message")
    rest_like = {"OF", "주", "P1", "V", "생", "특", "공", "법", "병"}
    a2_shift = result["schedule"]["a2"]["2026-03-05"]
    a1_shift = result["schedule"]["a1"]["2026-03-05"]
    assert a2_shift in rest_like, f"보정 간호사의 위시가 밀림: a2={a2_shift}"
    assert a1_shift not in rest_like, f"슬롯이 1개인데 둘 다 쉼?: a1={a1_shift}"


def test_build_wish_report_counts_and_unmet():
    """반영 리포트 — 신청/반영 집계와 미반영 목록(셀 점프용 좌표)."""
    from server.api import _build_wish_report
    nurses = _mini_nurses(2)
    nurses[0].wishes = {"3": "OFF", "4": "D"}   # a0
    nurses[1].wishes = {"2026-03-06": "OFF"}     # a1 — ISO 키도 허용
    req = GenerateRequest(year=2026, month=3, nurses=nurses,
                          requirements=_mini_requirements(),
                          rules=Rules(), prev_schedule={})
    req.wish_boosts = {"a0": 1.5}
    result = {"success": True, "schedule": {
        "a0": {"2026-03-03": "OF", "2026-03-04": "E"},
        "a1": {"2026-03-06": "주"},
    }}
    wr = _build_wish_report(req, result)
    assert wr["total_requested"] == 3 and wr["total_granted"] == 2
    a0 = next(r for r in wr["per_nurse"] if r["nurse_id"] == "a0")
    assert a0["boost"] == 1.5
    assert a0["unmet"] == [{"date": "2026-03-04", "wish": "D", "assigned": "E"}]


# ── 공정성 원장 / 전월N 자동 ─────────────────────────────────────────────────

def test_fairness_ledger_and_prev_month_nights(tmp_path, monkeypatch):
    """저장본에서 누적 야간/주말/공휴일 근무와 전월N을 파생 계산한다."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    db.init_db()
    db.save_schedule(
        year=2026, month=5,
        data={
            "holidays": ["2026-05-05"],
            "schedule": {"a1": {
                "2026-05-01": "N",        # 금 — 야간
                "2026-05-02": "N",        # 토 — 야간+주말
                "2026-05-03": "OF",       # 일 — 휴무 (주말근무 아님)
                "2026-05-05": "D",        # 공휴일 근무
            }},
        },
        name="5월 확정",
    )
    ledger = db.compute_fairness_ledger(2026, 6)
    assert ledger["a1"]["nights"] == 2
    assert ledger["a1"]["weekends"] == 1
    assert ledger["a1"]["holiday_work"] == 1
    nights = db.compute_prev_month_nights(2026, 6)
    assert nights == {"a1": 2}


def test_prev_month_nights_excludes_night_kept_month(tmp_path, monkeypatch):
    """나이트킵(야간전담) 달의 야간은 '전월N'에서 제외된다.

    2026-08-20 사용자 명시: 나이트킵 때 한 나이트는 수면오프와 무관하다.
    이 값이 홀짝월 합산(≤11) 상한에 쓰이므로, 14회를 그대로 넘기면 다음 달
    야간 상한이 0이 되어 나이트킵을 마친 사람만 야간을 못 받는다.
    """
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    db.init_db()
    days_a1 = {f"2026-05-{i:02d}": "N" for i in range(1, 15)}   # 나이트킵 14회
    days_a2 = {f"2026-05-{i:02d}": "N" for i in range(1, 4)}    # 일반 3회
    db.save_schedule(
        year=2026, month=5,
        data={
            "nurses": [
                {"id": "a1", "name": "나이트킵", "night_months": {"2026-05": True}},
                {"id": "a2", "name": "정규", "night_months": {}},
            ],
            "schedule": {"a1": days_a1, "a2": days_a2},
        },
        name="5월 확정",
    )
    assert db.compute_prev_month_nights(2026, 6) == {"a2": 3}


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_fairness_offsets_shift_nights_to_low_cumulative(build_request, solver):
    """공정성 원장 오프셋: 누적 야간이 많은 간호사는 당월 야간을 적게 받아야 한다."""
    nurses = _mini_nurses(6)
    req = build_request(nurses=nurses, year=2026, month=3, days=7,
                        requirements=_mini_requirements(1, 1, 2))
    req.scoring_rules = [ScoringRule(name="야간 공정", rule_type="night_fairness",
                                     score=-100)]
    # a0는 직전 달들 누적 야간 10회, 나머지는 0 — a0가 당월 최소를 받아야 함
    req.fairness_offsets = {"a0": 10}
    result = make_limited(req, days=7, solver=solver).solve()
    assert result["success"], result.get("message")
    night_codes = {"N", "NC"}
    counts = {n.id: sum(1 for v in result["schedule"][n.id].values()
                        if v in night_codes) for n in nurses}
    assert counts["a0"] == min(counts.values()), counts
    assert counts["a0"] < max(counts.values()), counts


def test_build_wish_report_marks_off_wish_filled_by_leave():
    """OFF 위시를 OF가 아니라 V(연차)로 채우면 '반영'이지만 연차가 소진된다 —
    리포트는 이를 구분해 보여줘야 한다 (M6 F5). 반영 집계 자체는 종전과 같다."""
    from server.api import _build_wish_report
    from server.models import Nurse, Requirements

    nurses = [Nurse(id="a0", name="*간호0", group="A", gender="female",
                    capable_shifts=["D", "E", "N"], seniority=0,
                    wishes={"2026-03-02": "OFF", "2026-03-03": "OFF", "2026-03-04": "D"})]
    req = GenerateRequest(year=2026, month=3, nurses=nurses,
                          requirements=Requirements(), rules=Rules())
    result = {"success": True, "schedule": {"a0": {
        "2026-03-02": "V",      # OFF 위시 → 연차로 충족 (반영이지만 소진)
        "2026-03-03": "OF",     # OFF 위시 → OF
        "2026-03-04": "E",      # D 위시 → 미반영
    }}}
    wr = _build_wish_report(req, result)
    row = wr["per_nurse"][0]
    assert (row["requested"], row["granted"]) == (3, 2)
    assert row["leave_filled"] == 1 and row["leave_filled_dates"] == ["2026-03-02"]
    assert wr["total_leave_filled"] == 1
    assert [u["date"] for u in row["unmet"]] == ["2026-03-04"]
