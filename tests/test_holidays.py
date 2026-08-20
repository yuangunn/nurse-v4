"""한국 공휴일 자동계산(프론트 misc-features.js) 검증.

실제 프론트엔드 코드의 _computeKRHolidays()가 KASI(한국천문연구원) 기준
골든셋과 일치하는지 node 샌드박스로 직접 로드해 확인한다.
node가 없는 환경(일부 CI)에서는 skip.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "tests" / "fixtures" / "kr_holidays_golden.json"
VERIFY = ROOT / "scripts" / "verify_holidays.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node 미설치 — 프론트 검증 skip")
def test_kr_holidays_match_kasi_golden():
    """misc-features.js _computeKRHolidays 출력이 2025~2050 골든셋과 정확히 일치."""
    result = subprocess.run(
        ["node", str(VERIFY)], capture_output=True, text=True, cwd=str(ROOT)
    )
    assert result.returncode == 0, f"공휴일 검증 실패:\n{result.stdout}\n{result.stderr}"


def test_golden_fixture_sane():
    """골든셋이 존재하고 핵심 공휴일(설날·추석 연휴, 신정·성탄)을 담고 있는지 기본 점검."""
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert len(golden) >= 20
    y2025 = golden["2025"]
    # 신정·성탄절은 매년 고정
    assert "2025-01-01" in y2025 and "2025-12-25" in y2025
    # 2025 설날 연휴(1/28~30) + 추석 연휴(10/5~7) + 대체(10/8)
    for d in ("2025-01-28", "2025-01-29", "2025-01-30", "2025-10-06", "2025-10-08"):
        assert d in y2025, f"{d} 누락"


def test_holiday_scope_is_generation_cycle_not_month():
    """공휴일 인정 범위 = 생성 주기(전월 말·익월 초 패딩 포함).

    당월 프리픽스로 자르면 월경계 주에 걸린 익월 공휴일(신정·설날·삼일절)을
    못 봐서 ① 그 날에 OF/V/생이 배정되고 ② 오프특근 판정도 어긋난다.
    2027-01 주기는 2026-12-27~2027-02-06 — 마지막 주에 설날(2/6)이 들어온다.
    """
    from datetime import date

    from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules
    from server.scheduler_cpsat import CpSatScheduler

    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=2, E=0, N=0))
    nurses = [Nurse(id=f"a{i}", name=f"*간호{i}", group="A", gender="female",
                    capable_shifts=["DC", "D", "EC", "E", "NC", "N"], seniority=i)
              for i in range(3)]
    s = CpSatScheduler(GenerateRequest(
        year=2027, month=1, nurses=nurses, requirements=req, rules=Rules(),
        holidays=["2026-12-25",        # 주기 밖(앞) — 버려야 함
                  "2027-01-01",        # 당월
                  "2027-02-06",        # 익월 패딩 — 살아야 함 (설날)
                  "2027-03-01"],       # 주기 밖(뒤) — 버려야 함
    ))
    assert s.all_dates[0] == date(2026, 12, 27) and s.all_dates[-1] == date(2027, 2, 6)
    assert s.holidays == {"2027-01-01", "2027-02-06"}
    # 마지막 주(1/31~2/6)가 '공휴일 낀 주'로 인식돼야 오프특근 판정이 성립한다
    ws, we = s.weeks[-1]
    assert s._week_has_holiday(range(ws, we + 1))
    # 법휴 부여가 없으면 면제는 안 된다 (제1원칙 3)
    assert not s._week_off_exempt(s.nurses[0], list(range(ws, we + 1)))
