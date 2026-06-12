"""2026-06 전수 분석에서 확정된 버그들의 회귀 테스트.

대상:
- profiles: 비밀번호 변경 데이터 전손 2경로, 빈 스텁 재암호화, 경로 조작 ID
- solver: 완화+잠금 금지전환 누락, 홀짝월 음수 RHS, 전월 overflow V 사전입력
"""
from __future__ import annotations

import os
import sqlite3
from datetime import date, timedelta

import pytest

from server.models import GenerateRequest, Rules
from tests.conftest import _mini_nurses, _mini_requirements, _juhu_prev, make_limited


# ── 프로필/암호화 ──────────────────────────────────────────────────────────────

@pytest.fixture
def prof_env(tmp_path, monkeypatch):
    """프로필 모듈이 임시 디렉터리를 데이터 폴더로 쓰게 한다."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import profiles as prof
    return prof, tmp_path


def test_change_password_closed_profile_preserves_data(prof_env):
    """닫힌(암호화된) 프로필의 비밀번호 변경 후에도 새 비밀번호로 복호화 가능해야 한다.
    (수정 전: enc_salt만 재생성되고 재암호화가 생략되어 영구 복호화 불능)"""
    prof, tmp = prof_env
    r = prof.create_profile("ward_a", "병동A", password="oldpw")
    assert r["ok"]
    enc = tmp / "NurseScheduler" / "ward_a.db.enc"
    db = tmp / "NurseScheduler" / "ward_a.db"
    assert enc.exists() and not db.exists()  # 생성 직후 암호화 상태

    r = prof.change_password("ward_a", "oldpw", "newpw")
    assert r["ok"], r

    r = prof.open_profile("ward_a", "newpw")
    assert r["ok"], r
    # 복호화된 평문이 유효한 SQLite DB여야 한다
    conn = sqlite3.connect(r["db_path"])
    tables = [row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")]
    conn.close()
    assert "nurses" in tables


def test_change_password_wrong_old_password_keeps_salt(prof_env):
    """틀린 기존 비밀번호로는 변경이 거부되고 기존 비밀번호로 계속 열 수 있어야 한다."""
    prof, tmp = prof_env
    prof.create_profile("ward_b", "병동B", password="oldpw")
    r = prof.change_password("ward_b", "WRONG", "newpw")
    assert not r["ok"]
    assert prof.open_profile("ward_b", "oldpw")["ok"]


def test_change_password_open_profile_restores_plaintext(prof_env):
    """열린 프로필의 비밀번호 변경 후 평문 DB가 복원되어 세션이 계속 동작해야 한다.
    (수정 전: 평문이 삭제된 채 세션 유지 → 빈 스텁 생성 → close 시 전손)"""
    prof, tmp = prof_env
    prof.create_profile("ward_c", "병동C", password="oldpw")
    r = prof.open_profile("ward_c", "oldpw")
    assert r["ok"]
    db = tmp / "NurseScheduler" / "ward_c.db"
    assert db.exists()

    r = prof.change_password("ward_c", "oldpw", "newpw", is_open=True)
    assert r["ok"]
    assert db.exists(), "열린 프로필은 변경 후에도 평문이 복원되어야 한다"

    # close → 재오픈 (새 비밀번호) 라운드트립
    prof.close_profile("ward_c", "newpw")
    assert not db.exists()
    assert prof.open_profile("ward_c", "newpw")["ok"]


def test_encrypt_db_refuses_empty_stub(prof_env):
    """0바이트 스텁 DB가 정상 .db.enc를 덮어쓰지 않아야 한다."""
    prof, tmp = prof_env
    prof.create_profile("ward_d", "병동D", password="pw")
    enc = tmp / "NurseScheduler" / "ward_d.db.enc"
    good = enc.read_bytes()

    stub = tmp / "NurseScheduler" / "ward_d.db"
    stub.write_bytes(b"")  # sqlite3.connect가 만드는 빈 스텁 시뮬레이션
    prof._encrypt_db("ward_d", "pw")

    assert enc.read_bytes() == good, "빈 스텁으로 암호화본이 덮어써지면 안 된다"
    assert not stub.exists()


def test_profile_id_path_traversal_rejected(prof_env):
    prof, _ = prof_env
    for bad in ("../evil", "a/b", "a\\b", "..", ""):
        r = prof.create_profile(bad, "이름", password="")
        assert not r["ok"], f"경로 조작 ID가 통과됨: {bad!r}"


def test_open_failure_then_close_does_not_wipe(prof_env):
    """열기 실패(비밀번호 오류) 후에도 원 프로필 데이터가 보존되어야 한다."""
    prof, tmp = prof_env
    prof.create_profile("ward_e", "병동E", password="pw")
    r = prof.open_profile("ward_e", "WRONG")
    assert not r["ok"]
    assert prof.open_profile("ward_e", "pw")["ok"]


# ── 솔버: 완화+잠금 금지전환 ──────────────────────────────────────────────────

FORBIDDEN_AFTER_E = {"D", "DC", "D1", "중"}


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_locked_evening_blocks_next_day_morning_in_relax(build_request, solver):
    """완화 모드에서 잠긴 E 다음날 D 계열 배정이 금지되어야 한다.
    (수정 전: 잠긴 셀=정수 상수가 금지전환 제약 생성에서 통째로 스킵됨)"""
    nurses = _mini_nurses(6)
    year, month, days = 2026, 3, 7
    prev = _juhu_prev(nurses, year, month, days)
    # a1: 3/3 E 잠금 + 3/4 D 사전입력 — E→D 자체가 strict infeasible 트리거이며,
    # 완화에서 잠긴 E는 유지되고 D는 옮겨져야 한다.
    # (E=2 필요: E=1이면 그 슬롯이 차지(EC) 전용이라 일반 E 잠금이 풀 수 없는 모순)
    prev.setdefault("a1", {})["2026-03-03"] = "E"
    prev["a1"]["2026-03-04"] = "D"

    req = build_request(nurses=nurses, prev_schedule=prev, year=year,
                        month=month, days=days,
                        requirements=_mini_requirements(1, 2, 1))
    req.allow_pre_relax = True
    req.locked_cells = {"a1": {"2026-03-03": True}}

    result = make_limited(req, days=days, solver=solver).solve()
    assert result["success"], result.get("message")
    sched = result["schedule"]
    assert sched["a1"]["2026-03-03"] == "E", "잠긴 셀은 완화에서도 고정"
    assert sched["a1"]["2026-03-04"] not in FORBIDDEN_AFTER_E, (
        f"잠긴 E 다음날 금지 전환 위반: {sched['a1']['2026-03-04']}")


# ── 솔버: 홀짝월 합산 음수 RHS ───────────────────────────────────────────────

@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_two_month_night_excess_prev_count_clamped(build_request, solver):
    """전월 야간 14회(야간전담→일반 전환)여도 모델이 infeasible이 되지 않고
    해당 간호사 당월 야간 0회로 처리되어야 한다. (수정 전: RHS 음수 → 전체 실패)"""
    nurses = _mini_nurses(6)
    rules = Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1,
                  maxNightTwoMonth=True, maxNightTwoMonthCount=11)
    req = build_request(nurses=nurses, rules=rules, days=7)
    req.prev_month_nights = {"a1": 14}

    result = make_limited(req, days=7, solver=solver).solve()
    assert result["success"], result.get("message")
    a1_nights = sum(1 for v in result["schedule"]["a1"].values() if v in ("N", "NC"))
    assert a1_nights == 0, "전월 한도 초과 간호사는 당월 야간 0회여야 함"


# ── 솔버: 전월 overflow V 사전입력 ────────────────────────────────────────────

@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_overflow_prev_month_v_prefill_not_infeasible(solver):
    """전달이월로 들어온 전월 말 V 사전입력이 생성을 무조건 실패시키면 안 된다.
    (수정 전: overflow V==0 강제가 1일1근무와 모순 → 즉시 infeasible)
    전체 날짜 범위(전월 tail 포함)가 필요해 윈도잉 없이 실행한다."""
    nurses = _mini_nurses(6)
    year, month = 2026, 4  # 범위 3/29~5/2 (전월 tail 3일)
    prev = _juhu_prev(nurses, year, month, 30)
    prev.setdefault("a1", {})["2026-03-30"] = "V"  # 전월 확정 연차 기록

    req = GenerateRequest(
        year=year, month=month, nurses=nurses,
        requirements=_mini_requirements(),
        rules=Rules(maxConsecutiveWorkDays=6, maxVPerMonth=1),
        prev_schedule=prev,
        time_limit=120,
    )
    if solver == "highs":
        from server.scheduler import NurseScheduler
        result = NurseScheduler(req).solve()
    else:
        from server.scheduler_cpsat import CpSatScheduler
        result = CpSatScheduler(req).solve()
    assert result["success"], result.get("message")
    assert result["extended_schedule"]["a1"].get("2026-03-30") == "V" or \
        result["schedule"]["a1"].get("2026-03-30") == "V", "전월 V 기록이 보존되어야 함"
