"""찾는 도중의 표 (결정 1-97) — HiGHS 가 더 나은 답을 파일에 덧붙일 때마다 근무표로 바꿔 SSE 로 보낸다.

콜백이 주는 답은 줄인 문제의 값이라 쓸 수 없고(highspy 1.8.1), mip_improving_solution_file 의 답만 원래 변수 차례다.
"""
from __future__ import annotations

import os
import time

from server import api, solver_progress
from server.models import GenerateRequest, Rules
from tests.conftest import _mini_nurses, _mini_requirements, make_limited


class _FakeHighs:
    def __init__(self, ncol):
        self.ncol, self.opts = ncol, {}

    def setOptionValue(self, k, v):
        self.opts[k] = v

    def getNumCol(self):
        return self.ncol


def _drain():
    out = []
    while not solver_progress.log_queue.empty():
        out.append(solver_progress.log_queue.get_nowait())
    return [e for e in out if e.get("type") == "table"]


def _block(obj, vals):
    return f"Objective {obj}\n# Columns {len(vals)}\n" + "".join(f"C{i} {v}\n" for i, v in enumerate(vals))


def test_watch_emits_a_table_for_each_complete_solution(monkeypatch):
    monkeypatch.setattr(solver_progress, "PARTIAL_MIN_GAP_SEC", 0.0)
    solver_progress.begin()
    try:
        h = _FakeHighs(3)
        finish = api._start_partial_watch(h, lambda vals: {"vals": list(vals)}, {"gap": 0.25})
        path = h.opts["mip_improving_solution_file"]
        assert os.path.exists(path)
        with open(path, "a") as f:
            f.write(_block(-120, [0, 1, 0]))
        time.sleep(1.2)
        got = _drain()
        assert [e["table"]["vals"] for e in got] == [[0.0, 1.0, 0.0]]
        assert got[0]["table"]["objective"] == -120 and got[0]["table"]["mip_gap_percent"] == 25.0
        # 둘째 답이 아직 적히는 중이면 내보내지 않는다 — 다 적힌 뒤에 나간다
        with open(path, "a") as f:
            f.write("Objective -130\n# Columns 3\nC0 1\n")
        time.sleep(1.0)
        assert _drain() == []
        with open(path, "a") as f:
            f.write("C1 0\nC2 1\n")
        time.sleep(1.2)
        assert [e["table"]["vals"] for e in _drain()] == [[1.0, 0.0, 1.0]]
        finish()
        assert not os.path.exists(path), "끝나면 파일을 지운다"
    finally:
        solver_progress.end()


def test_watch_does_nothing_without_a_builder():
    h = _FakeHighs(3)
    api._start_partial_watch(h, None, {})()
    assert h.opts == {}, "표를 만들 함수를 맡기지 않은 풀이(진단·레이스)는 파일도 만들지 않는다"


def test_tables_are_not_sent_too_often(monkeypatch):
    monkeypatch.setattr(solver_progress, "PARTIAL_MIN_GAP_SEC", 30.0)
    solver_progress.begin()
    try:
        h = _FakeHighs(2)
        finish = api._start_partial_watch(h, lambda vals: {"vals": list(vals)}, {})
        path = h.opts["mip_improving_solution_file"]
        with open(path, "a") as f:
            f.write(_block(-1, [1, 0]))
        time.sleep(1.2)
        with open(path, "a") as f:
            f.write(_block(-2, [0, 1]))
        time.sleep(1.2)
        got = _drain()
        assert len(got) == 1 and got[0]["table"]["mip_gap_percent"] is None    # 차이를 모르면 비워 둔다
        finish()
    finally:
        solver_progress.end()


def test_table_from_solution_values_equals_the_final_table(monkeypatch):
    """끝난 풀이의 답(변수 번호 차례의 값)을 그 함수에 넣으면 끝난 표와 같은 표가 나온다 — 풀린 칸도 같다."""
    seen = {}

    def spy(h, builder, snap):
        seen["h"], seen["builder"] = h, builder
        return lambda: None

    monkeypatch.setattr(api, "_start_partial_watch", spy)
    pre = {"a1": {"2026-12-08": "D", "2026-12-09": "D"}, "a2": {"2026-12-08": "D", "2026-12-09": "D"}, "a3": {"2026-12-08": "D"}}
    req = GenerateRequest(year=2026, month=12, nurses=_mini_nurses(6), requirements=_mini_requirements(), rules=Rules(),
                          prev_schedule=pre, allow_pre_relax=True, time_limit=20)
    solver_progress.begin()
    try:
        r = make_limited(req, days=7).solve()
    finally:
        solver_progress.end()
    assert r["success"] and seen.get("builder"), r.get("message")
    t = seen["builder"](list(seen["h"].getSolution().col_value))
    assert t["partial"] is True and t["schedule"] == r["schedule"]
    assert t["relaxed_cells"] == r.get("relaxed_cells", {})
    assert t["nurse_scores"] == r["nurse_scores"]


def test_race_threads_do_not_hand_over_a_builder():
    solver_progress.begin()
    try:
        solver_progress.set_partial_builder(lambda v: {})
        assert solver_progress.take_partial_builder() is not None
        assert solver_progress.take_partial_builder() is None, "한 번만 가져간다"
        solver_progress.bind_thread()
        solver_progress.set_partial_builder(lambda v: {})
        assert solver_progress.take_partial_builder() is None
    finally:
        solver_progress._tls.gen = None
        del solver_progress._tls.gen
        solver_progress.end()
