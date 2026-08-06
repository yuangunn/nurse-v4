"""핀포인트 수정 반영 재조정 — 프론트 '수정 반영 재조정' 흐름의 서버 측 동작 검증.

흐름: 완성된 스케줄 전체를 prev_schedule(유지 보너스)로, 사용자가 고친 칸을
locked_cells로, 원본 스케줄의 일별 인원을 per_day_requirements로 되먹여 재풀이.
검증: ①고친 칸 유지 ②완화 모드에서도 유지 ③변경 칸 수가 최소(파급만).
"""
from __future__ import annotations

import pytest

from tests.conftest import _mini_requirements, make_limited

DAYS = 7


def _solve(request, days=DAYS):
    sched = make_limited(request, days=days)
    result = sched.solve()
    assert result["success"], result.get("message", "")
    return result["schedule"]


def _flat(schedule):
    return {(nid, dk): v for nid, days in schedule.items() for dk, v in days.items()}


def _day_counts(schedule):
    per = {}
    period = {"DC": "D", "D": "D", "EC": "E", "E": "E", "NC": "N", "N": "N"}
    for days in schedule.values():
        for dk, code in days.items():
            p = period.get(code)
            if p:
                per.setdefault(dk, {"D": 0, "E": 0, "N": 0})
                per[dk][p] += 1
    return per


def _pick_edit(schedule):
    """일반 D 근무 셀 하나를 골라 OF로 바꾼다("이날 쉬게 해줘" — 가장 흔한
    핀포인트 수정). 그날 D가 비고 그 주 OF가 2개가 되므로, 재조정이
    대체 인력 투입 + 기존 OF 재배치를 최소 파급으로 해내야 한다."""
    for nid, days in sorted(schedule.items()):
        for dk, code in sorted(days.items()):
            if code == "D":
                return nid, dk, "OF"
    pytest.fail("일반 D 셀이 없음")


def test_readjust_keeps_pins_and_minimal_change(build_request):
    # D=2 → 차지(DC) 1 + 일반 D 1 — 일반 근무 셀이 있어야 핀 수정 시나리오가 성립
    base_req = build_request(days=DAYS, requirements=_mini_requirements(d=2, e=1, n=1))
    original = _solve(base_req)

    nid, dk, new_code = _pick_edit(original)
    edited = {n: dict(d) for n, d in original.items()}
    edited[nid][dk] = new_code

    # 프론트 readjustSchedule()과 동일한 페이로드 — 수정으로 인원이 어긋난
    # 사전입력은 완화로만 풀리므로 재조정은 항상 allow_pre_relax=True.
    readj_req = build_request(days=DAYS, prev_schedule=edited, add_juhu=False,
                              requirements=_mini_requirements(d=2, e=1, n=1))
    readj_req.locked_cells = {nid: {dk: True}}
    readj_req.per_day_requirements = _day_counts(original)
    readj_req.allow_pre_relax = True

    readjusted = _solve(readj_req)

    # ① 고친 칸은 그대로 (잠금은 완화 모드에서도 정확 고정)
    assert readjusted[nid][dk] == new_code

    # ② 일별 인원은 원본 기준 그대로 충족
    assert _day_counts(readjusted) == _day_counts(original)

    # ③ 최소 변경 — 고친 칸의 파급만. 6명×7일=42칸 중 한 자리 스왑이므로
    #    사용자 수정 1 + 파급 소수(그날 D/E 교대 + 전환 규칙 여파)여야 한다.
    diff = {
        k for k in set(_flat(edited)) | set(_flat(readjusted))
        if _flat(edited).get(k) != _flat(readjusted).get(k)
    }
    assert diff, "재조정이 아무 것도 바꾸지 않으면 인원이 안 맞아야 정상"
    assert len(diff) <= 8, f"파급이 과함: {len(diff)}칸 {sorted(diff)}"
    # 사전입력 유지 보너스가 지배 — 절반 이상이 뒤집히면 회귀
    assert len(diff) < 42 // 2
