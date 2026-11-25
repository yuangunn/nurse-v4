"""채점표(scripts/scorecard.py) — 세는 법이 맞는지. 이름은 가명, 자료는 모두 지어낸 것."""
from __future__ import annotations

import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("scorecard", Path(__file__).resolve().parent.parent / "scripts" / "scorecard.py")
scorecard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scorecard)

SHIFTS = [{"code": c, "period": p} for c, p in (("D", "day"), ("E", "evening"), ("N", "night"), ("OF", "rest"), ("주", "rest"),
                                              ("V", "leave"), ("생", "leave"))]


def _row(codes: str, start: int = 1) -> dict:
    return {f"2026-12-{start + i:02d}": c for i, c in enumerate(codes.split())}


def test_counts_every_item():
    nurses = [{"id": "a", "name": "간호01", "gender": "female", "capable_shifts": ["D", "E", "N"]},
              {"id": "b", "name": "간호02", "gender": "female", "capable_shifts": ["D", "E", "N"]},
              {"id": "c", "name": "간호03", "gender": "male", "capable_shifts": ["D", "E"]}]
    payload = {"year": 2026, "month": 12, "shifts": SHIFTS, "nurses": nurses,
               "prev_schedule": {"a": {"2026-11-30": "D", "2026-12-20": "V"}}}
    sched = {
        # 12/1~: D OF D(1오프) · 12/3~7 D 다섯(같은 근무 5일) · 주(근무 사이 — 1오프) · N(단독 야간) · OF(N→쉼→E 역방향, 1오프) · E OF D(역방향, 1오프) · 생 · V(사전입력)
        "a": _row("D OF D D D D D 주 N OF E OF D 생 OF OF OF OF OF V"),
        "b": _row("N N OF OF D D E E OF 주 D D OF OF N N N OF OF OF"),
        "c": _row("D E D OF OF D D OF OF V OF OF OF OF OF OF OF OF OF OF"),          # D E D = 하루짜리 근무 셋
    }
    m = scorecard.metrics(payload, {"schedule": sched, "relaxed_cells": {"a": ["2026-12-03"], "b": ["2026-12-05", "2026-12-06"]}})
    assert m["relaxed"] == 3
    assert m["one"][0] == 4 and m["one_sum"] == 4 and m["one_max"] == 4      # 12/2 · 12/8(주) · 12/10 · 12/12 — 주휴도 앞뒤가 근무면 하루짜리 휴무다
    assert m["six_run"] == 0 and m["five_same"] == 1                          # 12/3~7 은 닷새 — 12/2 OF 로 끊겨 엿새가 아니다
    assert m["single_night"] == 1 and m["back_rest"] == 2
    assert m["no_saeng"] == 1 and m["no_saeng_rows"] == [2], "b 는 생휴가 없고 c 는 남성"
    assert m["v_auto"] == 1, "a 의 V 는 사전입력, c 의 V 만 자동"
    assert m["nights"] == {1: 1, 2: 5} and m["night_range"] == 4, "c 는 야간을 못 서 대상이 아니다"
    assert m["lone_work"] >= 3
    # 낮·저녁 치우침 — a: 낮 7·저녁 1 → 6, b: 낮 4·저녁 2 → 2, c: 낮 4·저녁 1 → 3 (야간을 못 서도 낮·저녁은 둘 다 선다)
    assert m["de_skew_rows"] == {1: 6, 2: 2, 3: 3} and (m["de_skew"], m["de_skew_max"]) == (11, 6)
    # 셋 다 서는 a·b 만 낮·저녁·야간을 평균과 견준다 — a (7,1,1) · b (4,2,5) → 평균 (5.5, 1.5, 3)
    assert m["den_rows"] == {1: [7, 1, 1], 2: [4, 2, 5]} and m["den_avg"] == [5.5, 1.5, 3.0] and m["den_skew"] == 8.0
    assert m["back_direct"] == 1, "c 의 D E D — 저녁 다음 날 낮"
    assert m["week_no_rest"] == 0 and m["group_over"] == 0


def test_groups_and_weeks_without_a_day_off():
    nurses = [{"id": i, "name": f"간호0{k}", "gender": "male", "capable_shifts": ["D", "E", "N"]} for k, i in enumerate("ab", 1)]
    payload = {"year": 2026, "month": 12, "shifts": SHIFTS, "nurses": nurses, "prev_schedule": {},
               "rules": {"nurseGroups": [{"id": "g", "name": "묶음", "members": ["a", "b"], "maxPerShift": 1}]}}
    # 12/6(일)~12/12(토): a 는 주휴도 OFF 도 없이 V 하나뿐 · b 는 주휴가 있다. 둘이 같은 낮인 날 = 12/1·12/2·12/7·12/8
    sched = {"a": _row("D D OF OF OF D D D V E E E OF OF"), "b": _row("D D OF OF OF 주 D D OF N N OF OF OF")}
    m = scorecard.metrics(payload, {"schedule": sched})
    assert m["week_no_rest"] == 1 and m["group_over"] == 4
    # 나쁜 모양은 사람마다 — a 는 D V E 의 하루 휴가(1오프) 하나, b 는 D OF N 의 1오프 하나
    assert m["bad_rows"] == {1: 1, 2: 1} and m["bad_max"] == 1 and m["bad_gap"] == 0
    # a 의 V 를 사전입력으로 넣으면 그 1오프는 엔진이 만든 것이 아니다
    pre = dict(payload, prev_schedule={"a": {"2026-12-09": "V"}})
    assert m["free_rows"] == {1: 1, 2: 1} and scorecard.metrics(pre, {"schedule": sched})["free_rows"] == {1: 0, 2: 1}


def test_six_run_spans_the_month_start():
    """지난달 끝에서 이어진 6일 연속 근무도 센다 — 그 달 칸에 걸쳤을 때만."""
    payload = {"year": 2026, "month": 12, "shifts": SHIFTS, "nurses": [{"id": "a", "name": "간호01", "gender": "male", "capable_shifts": ["D"]}],
               "prev_schedule": {"a": {"2026-11-27": "D", "2026-11-28": "D", "2026-11-29": "D", "2026-11-30": "D"}}}
    m = scorecard.metrics(payload, {"schedule": {"a": _row("D D OF D D D D D OF")}})
    assert m["six_run"] == 1 and m["five_same"] == 3, "11/27~12/2 여섯 날 · 같은 근무 5일은 12/1·12/2·12/8 로 끝나는 창"


def test_compare_marks_what_got_worse(tmp_path):
    a = {"label": "기준", "ok": True, "relaxed": 3, "one_sum": 40, "six_run": 1, "sec_first_table": 20, "night_min": 2, "night_max": 6, "gap": 1.9}
    b = {**a, "label": "새것", "one_sum": 38, "six_run": 7, "sec_first_table": 380}
    for c in (a, b):
        (tmp_path / f"{c['label']}.json").write_text(__import__("json").dumps(c, ensure_ascii=False), encoding="utf-8")
    out = scorecard.compare([str(tmp_path / "기준.json"), str(tmp_path / "새것.json")])
    assert "6일 연속 근무 | 1 | 7 ▲나빠짐" in out and "1오프 합 | 40 | 38 ▽나아짐" in out and "첫 표까지(초) | 20 | 380 ▲나빠짐" in out
