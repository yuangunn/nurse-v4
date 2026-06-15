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
