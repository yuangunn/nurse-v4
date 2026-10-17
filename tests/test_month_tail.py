"""달 끝에 걸친 주(11/29~12/05)와 1일 앞 지난달 칸 — 2026년 11월 (생성 범위 10/25~12/05).

병동 11월 번표는 11/1~12/5 이고 12월 번표는 12/6 부터다 — 끝에 붙은 다음 달 며칠도 이 근무표가 정한다.
사용자가 11월을 만들었더니 (2026-10-16):
  ① 12/1~12/5 에 주휴를 넣지 않은 채 만들었더니 엔진이 그 주 쉬는 칸을 12월 생으로 메웠다(15명).
     생은 달력 달마다 하나라 12/6~12/31 엔 생이 없다. 실제 번표의 꼬리 생은 2% 남짓이다.
  ② 11월 나이트킵이 12/1~12/5(그날은 일반 간호사, 결정 1-33)에 OF 를 둘·셋 받았다 — 주 OF 상한이
     생성 달 판정으로 그 사람을 주째로 뺐다. 실제 번표: 일반의 날 OF ≤ 1, 나이트킵의 날 OF 0~3.
  ③ 아무도 미리 알리지 않았다 — 쉴 코드 수급 산술은 달이 바뀌는 주를 건너뛰었다.
  ④ 10/25~10/31(지난달 칸)에 사전입력이 없는데도 엔진이 채운 D·OF 가 표에 깔렸다.

이름은 가명(간호01…), 자료는 모두 지어낸 것.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from server.models import DayRequirement, GenerateRequest, Nurse, Requirements, Rules
from server.scheduler import NurseScheduler
from server.scheduler_cpsat import CpSatScheduler

from .test_exact_fit_characterization import PROD_SHIFTS

CAPS = ["DC", "D", "EC", "E", "NC", "N"]
# 원인 격리 — 주 OF·전환 금지·V 한도·연속 근무(6)는 그대로
RULES = dict(noNOD=False, restAfterNight=False, maxConsecutiveNight=False,
             maxNightPerMonth=False, maxConsecutiveWorkDays=6)
TAIL = [f"2026-12-0{i}" for i in range(1, 6)]


def _iso(d: date) -> str:
    return d.strftime("%Y-%m-%d")


class _Window:
    """생성 범위(10/25~12/05) 중 일부 주만 푼다 — 주는 일요일에 시작하는 7일 (11/1 = 주기 첫날)."""
    WIN = (date(2026, 11, 29), date(2026, 12, 5))

    def _build_date_range(self):
        super()._build_date_range()
        lo, hi = self.WIN
        self.all_dates = [d for d in self.all_dates if lo <= d <= hi]
        self.T = len(self.all_dates)
        self.date_to_idx = {d: i for i, d in enumerate(self.all_dates)}
        self.weeks = [(i, i + 6) for i in range(0, self.T, 7)]


def _engine(name: str, lo: date, hi: date):
    base = NurseScheduler if name == "highs" else CpSatScheduler
    return type(f"_{name}_window", (_Window, base), {"WIN": (lo, hi)})


def _request(prev, n: int = 7, keeper: dict | None = None, **kw) -> GenerateRequest:
    """n명 · 매일 D2 E2 N1 (5명) — 7명이면 주당 쉬는 칸 14 = 주휴 7 + OF 7 로 딱 맞는다."""
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=2, E=2, N=1))
    nurses = [Nurse(id=f"a{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                    capable_shifts=CAPS, seniority=i,
                    night_months=(keeper or {}).get(f"a{i}", {}))
              for i in range(n)]
    return GenerateRequest(year=2026, month=11, nurses=nurses, requirements=req,
                           rules=Rules(**RULES), prev_schedule=prev, shifts=PROD_SHIFTS,
                           time_limit=60, **kw)


def _pinned(prev, nid, iso, code):
    return (prev.get(nid) or {}).get(iso) == code


# ── ① 꼬리 생은 쉬는 칸 메우기가 아니다 · ② 11월 나이트킵의 12월 날 OF ≤ 1 ──────────────

@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_tail_week_without_juhu_gets_no_new_saeng_and_keeper_of_capped(engine):
    """11/29~12/05 에 주휴는 11/29·11/30 둘뿐 (나머지 다섯은 12/1~12/5 칸을 안 넣음).
    간호07 은 11월 나이트킵 — 11/29·11/30 은 나이트킵, 12/1~12/5 는 일반 간호사.
    간호03 은 12/3 에 생을 미리 넣었다 (병동이 넣은 꼬리 생은 사실 — 다음 달 몫으로 받는다).

    예전엔 모자란 쉬는 칸을 12월 생(무료)과 나이트킵의 12월 OF(상한 없음)로 메웠다.
    이제 새 꼬리 생은 0, 나이트킵의 12월 날 OF ≤ 1 — 남는 칸은 V 로 가고 V 설명에 나온다."""
    prev = {"a0": {"2026-11-29": "주"}, "a1": {"2026-11-30": "주"}, "a2": {"2026-12-03": "생"}}
    cls = _engine(engine, date(2026, 11, 29), date(2026, 12, 5))
    r = cls(_request(prev, keeper={"a6": {"2026-11": True}})).solve()
    assert r["success"], r.get("message")
    sch = r["schedule"]
    new_saeng = [(nid, d) for nid, row in sch.items() for d, c in row.items()
                 if d in TAIL and c == "생" and not _pinned(prev, nid, d, "생")]
    assert new_saeng == [], new_saeng
    assert sch["a2"]["2026-12-03"] == "생"                       # 미리 넣은 꼬리 생은 그대로
    keeper_of = [d for d in TAIL if sch["a6"].get(d) == "OF"]
    assert len(keeper_of) <= 1, sch["a6"]                         # 12월 날은 일반 간호사
    for d in ("2026-11-29", "2026-11-30"):                       # 나이트킵의 날은 N·쉬는 것만
        assert sch["a6"][d] in ("N", "NC", "OF", "V", "생", "주"), (d, sch["a6"])
    # 모자란 칸은 V — 꼬리 며칠의 V 도 V 설명에 나온다
    tail_v = sum(1 for row in sch.values() for d in TAIL if row.get(d) == "V")
    assert tail_v >= 1, sch
    vr = r.get("v_report") or {}
    shown = {(c["nurse_id"], c["date"]) for w in vr.get("weeks", []) for c in w["cells_v"]}
    assert {(nid, d) for nid, row in sch.items() for d in TAIL if row.get(d) == "V"} <= shown, vr
    # 주휴가 빠진 주 안내 (생성은 그대로) — 이 창은 한 주라 '아직 하나도 없는 사람' 쪽에 모인다
    mj = r.get("missing_juhu") or {}
    listed = set(mj.get("none", [])) | {n for w in mj.get("weeks", []) for n in w["names"]}
    assert {"간호03", "간호04", "간호05", "간호06", "간호07"} <= listed, mj
    assert "간호01" not in listed and "간호02" not in listed, mj
    assert "주휴가 없는 주" in r["message"], r["message"][-400:]


# ── ③ 다음 달 나이트킵은 나이트킵의 날 OF 를 1회로 묶지 않는다 ────────────────────────

@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_next_month_keeper_is_not_held_to_one_of_on_keeper_days(engine):
    """간호07 은 12월 나이트킵 — 12/1~12/5 엔 N·쉬는 것만 받는다. 그 닷새 N 은 다른 사람이 미리
    넣어 자리가 없다(사실). 그러면 닷새 모두 쉬어야 하는데, 예전엔 그 주 전체에 OF == 1 이 걸려
    (11월 판정으로는 일반 간호사) 쉬는 칸이 모자라 생성이 실패했다. 실제 번표: 나이트킵의 날 OF 0~3."""
    prev = {
        "a0": {"2026-11-29": "주"}, "a1": {"2026-11-30": "주"}, "a2": {"2026-12-01": "주"},
        "a5": {"2026-12-01": "N", "2026-12-02": "N", "2026-12-03": "N"},
        "a4": {"2026-12-04": "N", "2026-12-05": "N"},
    }
    cls = _engine(engine, date(2026, 11, 29), date(2026, 12, 5))
    r = cls(_request(prev, keeper={"a6": {"2026-12": True}})).solve()
    assert r["success"], r.get("message")
    a6 = r["schedule"]["a6"]
    assert all(a6[d] in ("OF", "V", "생", "주") for d in TAIL), a6
    assert sum(1 for d in TAIL if a6[d] == "OF") >= 2, a6       # 나이트킵의 날은 OF 상한 없음
    assert sum(1 for d in ("2026-11-29", "2026-11-30") if a6[d] == "OF") <= 1, a6   # 일반의 날은 ≤ 1
    assert not [d for d in TAIL if a6[d] == "생"], a6             # 꼬리 생은 미리 넣은 것만


# ── ④ 1일 앞 지난달 칸은 사전입력이 있는 칸만 낸다 ────────────────────────────────────

@pytest.mark.parametrize("engine", ["highs", "cpsat"])
def test_padding_week_outputs_only_pre_input_cells(engine):
    """11/1 이 주기 첫날이라 범위 앞에 지난달 한 주(10/25~10/31)가 붙는다. 그 칸은 월 경계 규칙을
    잇는 변수일 뿐이라 사전입력(전달 이월)이 없는 칸은 표에 내지 않는다. 있는 칸은 그대로."""
    prev = {f"a{i}": {_iso(date(2026, 11, 1) + timedelta(days=i)): "주"} for i in range(7)}
    prev["a1"]["2026-10-31"] = "N"
    prev["a2"]["2026-10-30"] = "OF"
    cls = _engine(engine, date(2026, 10, 25), date(2026, 11, 7))
    s = cls(_request(prev))
    assert _iso(s.all_dates[0]) == "2026-10-25"
    r = s.solve()
    assert r["success"], r.get("message")
    for key in ("schedule", "extended_schedule"):
        before = {(nid, d) for nid, row in r[key].items() for d in row if d < "2026-11-01"}
        assert before == {("a1", "2026-10-31"), ("a2", "2026-10-30")}, (key, sorted(before))
        assert r[key]["a1"]["2026-10-31"] in ("N", "NC")
        assert r[key]["a2"]["2026-10-30"] == "OF"
    # 1일부터는 전부 나온다
    assert all(len([d for d in row if d >= "2026-11-01"]) == 7 for row in r["schedule"].values())
    # 지난달 N 기록은 그대로 월 경계 규칙에 이어진다 — 11/1 에 N→D·N→E 금지
    assert r["schedule"]["a1"]["2026-11-01"] not in ("D", "DC", "E", "EC"), r["schedule"]["a1"]


# ── ⑤ 쉴 코드 수급 산술이 달이 바뀌는 주를 본다 (솔버 없이) ───────────────────────────

def _full(prev, n=8, **kw):
    return NurseScheduler(_request(prev, n=n, **kw))


def _used_month_leave(prev, n):
    """11월 V·생을 이미 쓴 상태 — 11/3 생, 11/4 V (그 주 판정과는 무관한 산술용)."""
    for i in range(n):
        prev.setdefault(f"a{i}", {}).update({"2026-11-03": "생", "2026-11-04": "V"})
    return prev


def test_rest_supply_judges_the_boundary_week_and_tail_saeng_is_no_supply():
    """8명 · 매일 5명 근무 → 11/29~12/05 쉬어야 할 칸 56 − 35 = 21.
    주휴는 11/29·11/30 둘뿐, 11월 V·생은 이미 씀 → 놓을 수 있는 휴무 = 주휴 2 + 사람마다 (OF 1 + 12월 몫 V 1)
    = 18 → 부족 3. 꼬리 생을 공급으로 세면(예전 엔진 상한 max(1, 넣은 수)) 26 이 되어 이 부족을 못 본다."""
    prev = _used_month_leave({"a0": {"2026-11-29": "주"}, "a1": {"2026-11-30": "주"}}, 8)
    s = _full(prev)
    assert _iso(s.all_dates[-1]) == "2026-12-05"
    rows = [w for w in s.rest_supply_shortfall() if w["start"] == "2026-11-29"]
    assert rows, s.rest_supply_shortfall()
    w = rows[0]
    assert w["boundary"] is True and w["end"] == "2026-12-05", w
    assert (w["demand"], w["supply"], w["shortfall"]) == (21, 18, 3), w
    msg = s.rest_supply_message(rows)
    assert "끝에 붙은 다음 달" in msg and "분석 탭" in msg, msg

    # 꼬리 며칠에 주휴를 넣으면 부족이 사라진다 (병동 11월 번표처럼)
    tail_juhu = {"a2": "2026-12-01", "a3": "2026-12-02", "a4": "2026-12-03",
                 "a5": "2026-12-04", "a6": "2026-12-05", "a7": "2026-12-01"}
    for nid, d in tail_juhu.items():
        prev[nid][d] = "주"
    assert not [w for w in _full(prev).rest_supply_shortfall() if w["start"] == "2026-11-29"]


def test_rest_supply_boundary_week_counts_keeper_days_like_the_engine():
    """11월 나이트킵의 12월 날은 일반 간호사 칸으로 센다 (주 OF 상한도 그날만). 나이트킵의 날(11/29·11/30)은
    수급 양쪽에서 빼고, 거기 미리 넣은 근무만큼 일반 근무가 준다 — 산술은 엔진과 같은 날짜 판정을 쓴다."""
    prev = _used_month_leave({"a0": {"2026-11-29": "주"}, "a1": {"2026-11-30": "주"}}, 8)
    prev["a7"].update({"2026-11-29": "N", "2026-11-30": "N"})
    s = _full(prev, keeper={"a7": {"2026-11": True}})
    w = next(w for w in s.rest_supply_shortfall() if w["start"] == "2026-11-29")
    # 일반의 날 칸 = 7명×7 + 간호08 의 12월 닷새 = 54, 근무 35 − 나이트킵 확정 N 2 = 33 → 쉬어야 할 칸 21
    # 공급 = 주휴 2 + 7명×2 + 간호08(OF 1 + 12월 몫 V 1) = 18
    assert (w["demand"], w["supply"]) == (21, 18), w


def test_rest_supply_ignores_per_day_requirements_on_tail_days():
    """날짜별 인원은 생성 달 안에만 걸린다(인원 제약과 같다) — 끝에 붙은 며칠에 남은 값은 산술도 보지 않는다."""
    prev = _used_month_leave({"a0": {"2026-11-29": "주"}, "a1": {"2026-11-30": "주"}}, 8)
    base = next(w for w in _full(prev).rest_supply_shortfall() if w["start"] == "2026-11-29")
    odd = {d: {"D": 1, "E": 1, "N": 1} for d in TAIL}
    w = next(w for w in _full(prev, per_day_requirements=odd).rest_supply_shortfall()
             if w["start"] == "2026-11-29")
    assert w == base, (w, base)


# ── 주휴가 빠진 완전한 주 — 생성 결과 안내 (주마다 한 줄 · 아직 안 넣은 사람은 한 줄) ──────

def test_missing_juhu_notice_groups_by_week():
    s = _full({}, n=3)
    first = date(2026, 11, 1)
    sched = {f"a{i}": {_iso(first + timedelta(days=k)): "D" for k in range(35)} for i in range(3)}
    for wk in range(5):                       # 간호01: 다섯 주 모두 · 간호02: 11월 네 주만 · 간호03: 없음
        sched["a0"][_iso(first + timedelta(days=7 * wk + 2))] = "주"
        if wk < 4:
            sched["a1"][_iso(first + timedelta(days=7 * wk + 3))] = "주"
    sched["a0"]["2026-10-31"] = "D"           # 지난달 칸은 판정하지 않는다
    rep = s._missing_juhu_weeks(sched)
    assert [(w["start"], w["end"], w["cycle"], w["names"]) for w in rep["weeks"]] == [
        ("2026-11-29", "2026-12-05", 4, ["간호02"])], rep
    assert rep["none"] == ["간호03"], rep
    lines = s.missing_juhu_lines(rep)
    assert lines[0] == "4주기(11/29~12/05) 주휴 없음 1명: 간호02", lines
    assert lines[1].startswith("주휴가 아직 하나도 없는 사람 1명: 간호03"), lines


# ── ⑥ 신호등의 원인 찾기 모델도 끝 며칠에 엔진과 같은 상한을 건다 ─────────────────────────

def test_probe_names_tail_limits_like_the_engine():
    """2명 · 매일 D1(=DC) · 11/29~12/05. 간호02 가 12/3~12/5 DC 를 미리 넣어 간호01 은 그 사흘을 쉬어야 하는데
    쉴 코드는 그 주 OF 1 + 12월 몫 V 1 뿐 (꼬리 생은 미리 넣은 것만, 주휴는 사전입력 전용) → 생성 불가.
    주 단위 산술은 두 사람을 합쳐 보므로(쉬어야 할 7 ≤ 놓을 수 있는 8) 못 잡는다. 예전 원인 찾기 모델은
    꼬리 며칠의 V 를 묶지 않아(엔진은 1회) '가능한' 표를 찾았고, 신호등은 원인을 못 짚었다
    (11월 실제 사례: '규칙 하나로 짚이는 곳은 없어요' → 엉뚱한 '생리휴가 제약 충돌')."""
    from server.conflict_analyzer import _ConflictAnalyzer
    prev = {"a1": {d: "DC" for d in TAIL[2:]}}
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=1, E=0, N=0))
    nurses = [Nurse(id=f"a{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                    capable_shifts=CAPS, seniority=i) for i in range(2)]
    request = GenerateRequest(year=2026, month=11, nurses=nurses, requirements=req, rules=Rules(**RULES),
                              prev_schedule=prev, shifts=PROD_SHIFTS, time_limit=30)
    lo, hi = date(2026, 11, 29), date(2026, 12, 5)
    eng = _engine("cpsat", lo, hi)(request).solve()
    assert not eng["success"], eng.get("message")
    probe_cls = type("_probe_window", (_Window, _ConflictAnalyzer), {"WIN": (lo, hi)})
    p = probe_cls(request)
    assert p.rest_supply_shortfall() == []                    # 산술로는 안 잡히는 경우
    res = p.probe(time_limit=10)
    assert res["status"] == "infeasible", res
    assert "간호01(A) 12/01~12/05 V(연차) 1회 이하" in res["conflicts"], res["conflicts"]
    assert any("OF 주 1회 한도" in c and c.startswith("간호01") for c in res["conflicts"]), res["conflicts"]
    assert res.get("summary", "").startswith("간호01(A)"), res


def test_missing_juhu_notice_names_an_independent_trainee_once():
    """달 중간에 독립한 신규는 한 사람 — 독립한 날부터 재적하는 사본과 원래 기록 둘 다 있어도 이름은 한 번
    (2026-10-16 검토: '주휴 없음 2명: 신규01, 신규01')."""
    nurses = [Nurse(id=f"a{i}", name=f"간호{i + 1:02d}", group="A", gender="female",
                    capable_shifts=CAPS, seniority=i) for i in range(4)]
    nurses.append(Nurse(id="t1", name="신규01", group="A", gender="female", capable_shifts=CAPS, seniority=9,
                        is_trainee=True, training_end_date="2026-11-10", preceptor_id="a1"))
    req = Requirements()
    for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun"):
        setattr(req, day, DayRequirement(D=1, E=1, N=1))
    s = NurseScheduler(GenerateRequest(year=2026, month=11, nurses=nurses, requirements=req, rules=Rules(),
                                       shifts=PROD_SHIFTS, time_limit=10))
    assert "t1" in s._indep
    first = date(2026, 11, 1)
    sched = {}
    for n in ("a0", "a1", "a2", "a3", "t1"):
        sched[n] = {_iso(first + timedelta(days=k)): "D" for k in range(35)}
        if n != "t1":
            for wk in range(5):
                sched[n][_iso(first + timedelta(days=7 * wk + 1))] = "주"
    for k in range(10):
        sched["t1"][_iso(first + timedelta(days=k))] = "/D"
    sched["t1"]["2026-11-02"] = sched["t1"]["2026-11-09"] = "/주"
    rep = s._missing_juhu_weeks(sched)
    assert [w["names"] for w in rep["weeks"]] == [["신규01"]] * 3, rep
    for d in ("2026-11-02", "2026-11-09"):
        sched["t1"][d] = "/D"
    assert s._missing_juhu_weeks(sched)["none"] == ["신규01"]
