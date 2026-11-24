"""합쳐 푸는 풀이의 점수 — 배점만 떼어 보인다 (결정 1-106).

완화 1단계(사전입력 지키기)가 제 시간에 최적을 증명하지 못하면 '배점 + 큰 수 × 사전입력 지키기'를 한 번에 푼다.
그 목적값(천억 단위)을 그대로 보이면 '가능한 최고 점수 111,556,164,000'·'차이 0.67%'처럼 뜻 없는 숫자가 나온다.
눈금(큰 수 × 지키기 점수의 최소 단위)으로 배점만 떼어 낸다. 이어 찾기가 쓰는 objective·mip_dual_bound 는 그대로 둔다.
"""
from __future__ import annotations

from server import solver_progress as sp

from .conftest import make_limited

UNIT = 79_733_000.0       # 눈금 — 큰 수 × 지키기 값의 최소 걸음. 배점이 낼 수 있는 가장 큰 차이보다 크다


def test_takes_the_keep_part_out_of_the_combined_objective():
    keep = 81_293                                                          # 그 표의 사전입력 지키기 값
    primal, dual = -(18902 + keep * UNIT), -(19500 + keep * UNIT)          # 배점 18,902점 · 최고 19,500점
    s, b, g = sp.score_view(primal, dual, UNIT, keep * UNIT)
    assert (s, b, g) == (-18902, -19500, round(598 / 18902 * 100, 2))
    assert abs(primal - dual) / abs(primal) * 100 < 0.001, "합친 값으로 재면 차이가 0 에 가깝게 보인다"
    # 배점이 음수(감점이 더 큼)여도 같다
    assert sp.score_view(-(-700 + 5 * UNIT), -(-300 + 5 * UNIT), UNIT, 5 * UNIT) == (700, 300, round(400 / 700 * 100, 2))
    # 하한이 '사전입력을 한 단위 더 지킬 수 있다'고 하면 배점만의 하한·차이는 말할 수 없다
    assert sp.score_view(primal, -(100 + (keep + 1) * UNIT), UNIT, keep * UNIT) == (-18902, None, None)


def test_progress_hides_the_combined_numbers_and_the_result_carries_the_score(build_request):
    sp.set_score_unit(UNIT)
    try:
        p = sp._carry({"has_solution": True, "primal": -(18902 + 3 * UNIT), "dual": -(19000 + 3 * UNIT), "gap_percent": 0.0})
        assert (p["unit"], p["score"], p["score_bound"], p["gap_percent"]) == (UNIT, None, None, None), "푸는 동안에는 지키기 값을 모른다"
    finally:
        sp.set_score_unit(None)
    assert "unit" not in sp._carry({"has_solution": True, "primal": -100.0, "dual": -110.0, "gap_percent": 9.1})
    import pulp
    s = make_limited(build_request(days=7), days=7)
    info = {"objective": -(18902 + 3 * UNIT), "mip_dual_bound": -(19000 + 3 * UNIT), "mip_gap_percent": 0.0, "model_fingerprint": "f"}
    s._score_unit = None
    assert s._score_fields(info) == info, "보통 풀이는 그대로"
    s._score_stage = "keep"
    assert s._score_fields(info)["mip_gap_percent"] is None, "사전입력 지키기 단계에서 멈춘 표의 차이는 싣지 않는다"
    s._score_stage = "score"
    k = pulp.LpVariable("k", lowBound=300, upBound=300); k.varValue = 300      # 지키기 값 300 = 걸음(100) 셋
    s._score_unit, s._score_keep = UNIT, (UNIT / 100, pulp.lpSum([k]))
    got = s._score_fields(info)
    assert (got["objective"], got["mip_dual_bound"]) == (info["objective"], info["mip_dual_bound"]), "이어 찾기가 쓰는 값은 그대로"
    assert (got["score_unit"], got["score_offset"], got["score_objective"], got["score_bound"], got["mip_gap_percent"]) == (UNIT, 3 * UNIT, -18902, -19000, round(98 / 18902 * 100, 2))


def test_keep_stage_progress_carries_no_gap():
    """사전입력 지키기 단계의 차이(43% → 2% → 0%)는 '얼마나 지킬 수 있나'다 — 표의 품질처럼 보이지 않게 싣지 않는다."""
    sp.set_stage("keep")
    try:
        p = sp._carry({"has_solution": True, "primal": -136800.0, "dual": -138307.0, "gap_percent": 1.1})
        assert (p["stage"], p["gap_percent"]) == ("keep", None)
    finally:
        sp.set_stage(None)
    p = sp._carry({"has_solution": True, "primal": 10533.0, "dual": -27529.0, "gap_percent": 361.36})
    assert "stage" not in p and p["gap_percent"] == 361.36

