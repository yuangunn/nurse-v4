"""연차(V) 자동 배정 설명 리포트 (M6 P4, 제1원칙 8) — 왜 V가 나왔는지 주 단위 산술."""
from __future__ import annotations

import pytest

from server.models import ShiftDef
from tests.conftest import _mini_nurses, _mini_requirements, _juhu_prev, make_limited


def _ward_shifts():
    """병동 시드와 같은 근무 정의 — 공·특·법·병·주·D1·중은 사전입력 전용(auto_assign=False).
    테스트 기본 정의는 공을 자동으로 열어 두어 잉여가 V 대신 공으로 흐른다."""
    rows = [("DC","day",True,True),("D","day",False,True),("D1","day1",False,False),
            ("EC","evening",True,True),("E","evening",False,True),("중","middle",False,False),
            ("NC","night",True,True),("N","night",False,True),("OF","rest",False,True),
            ("주","rest",False,False),("P1","rest",False,True),("V","leave",False,True),
            ("생","leave",False,True),("특","leave",False,False),("공","leave",False,False),
            ("법","leave",False,False),("병","leave",False,False)]
    return [ShiftDef(code=c, name=c, period=p, is_charge=ch, sort_order=i, auto_assign=a)
            for i, (c, p, ch, a) in enumerate(rows)]


@pytest.mark.parametrize("solver", ["highs", "cpsat"])
def test_v_report_counts_auto_v_and_explains_week(build_request, solver):
    """6명×7일=42칸, 근무 21칸 → 쉬어야 할 칸 21 = 주휴 6 + OF 6 + 나머지 9(V·생).
    리포트의 산술이 결과 표와 정확히 맞고, 사전입력 V가 아닌 것만 센다. 양 엔진 공용 헬퍼."""
    nurses = _mini_nurses(6)
    req = build_request(nurses=nurses, year=2026, month=3, days=7,
                        requirements=_mini_requirements(1, 1, 1))
    req.shifts = _ward_shifts()
    result = make_limited(req, days=7, solver=solver).solve()
    assert result["success"], result.get("message")
    auto_v = sum(1 for n in nurses for v in result["schedule"][n.id].values() if v == "V")
    assert auto_v >= 5, auto_v          # 여성 4명의 생 4개로는 9칸을 못 채운다
    vr = result.get("v_report")
    assert vr and vr["total"] == auto_v
    assert "연차(V) 자동 배정" in result["message"]
    w = vr["weeks"][0]
    assert (w["cells"], w["work"], w["rest_need"]) == (42, 21, 21)
    assert (w["juhu"], w["off"]) == (6, 6)
    assert w["juhu"] + w["off"] + w["leave_pinned"] + w["saeng"] + w["other_auto"] + w["v"] == w["rest_need"]
    assert w["missing_juhu"] == []
    assert len(w["cells_v"]) == auto_v and all(c["date"].startswith("2026-03-") for c in w["cells_v"])
    assert any("주간 총량" in h for h in w["hints"])     # 주휴 이동은 총량을 못 줄인다는 안내
    assert "V " + str(auto_v) + "건" in w["summary"]


def test_v_report_flags_nurse_without_juhu(build_request):
    """주휴가 없는 사람이 있으면 그 이름을 짚고 '주휴를 넣으면 준다'고 안내한다."""
    nurses = _mini_nurses(6)
    prev = _juhu_prev(nurses, 2026, 3, 7)
    prev["a3"] = {}                     # a3 만 주휴 없음
    req = build_request(nurses=nurses, year=2026, month=3, days=7,
                        requirements=_mini_requirements(1, 1, 1), prev_schedule=prev)
    req.shifts = _ward_shifts()
    result = make_limited(req, days=7).solve()
    assert result["success"], result.get("message")
    vr = result.get("v_report")
    assert vr and vr["weeks"][0]["missing_juhu"] == ["*간호3"]
    assert vr["weeks"][0]["juhu"] == 5
    assert any("주휴가 없는 *간호3" in h for h in vr["weeks"][0]["hints"])


def test_v_report_ignores_pinned_v(build_request):
    """사전입력으로 넣은 V는 사람이 정한 것 — 자동 배정 수에 넣지 않고 '사전입력 휴가'로 센다."""
    nurses = _mini_nurses(6)
    prev = _juhu_prev(nurses, 2026, 3, 7)
    prev["a0"]["2026-03-04"] = "V"
    req = build_request(nurses=nurses, year=2026, month=3, days=7,
                        requirements=_mini_requirements(1, 1, 1), prev_schedule=prev)
    req.shifts = _ward_shifts()
    result = make_limited(req, days=7).solve()
    assert result["success"], result.get("message")
    assert result["schedule"]["a0"]["2026-03-04"] == "V"
    vr = result["v_report"]
    w = vr["weeks"][0]
    assert w["leave_pinned"] >= 1
    assert all(not (c["nurse_id"] == "a0" and c["date"] == "2026-03-04") for c in w["cells_v"])
