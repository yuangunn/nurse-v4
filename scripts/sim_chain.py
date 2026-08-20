"""12개월 연속(이월 체인) 근무 생성 시뮬레이션 — 사용자 시나리오 (2026-08-19).

2026-08-20 사용자 정정 반영 완료 (CLAUDE.md 제1원칙 대조):
  · 명절 주휴-이동 분기 제거 — 공휴일 몰린 주는 엔진 오프특근 규칙(OF ≤1)이 처리.
  · 18명 유지 (PREG_END_DATE=None), 요일표 토 4/3/2.
  이전 리포트(주휴 드리프트 12개월)는 정정 전 가정의 수치임에 유의.

구성: 간호사 18명 (임산부 1 · 야간전담 2 매달 교대 · 차지가능 9/불가 9 · 남 2/여 16)
사전입력: 주휴(앱 추천과 동일한 전역 4주기 -1 시프트 공식) + 인당 랜덤 OFF 2개
체인: 전월 '생성된' 당월 셀을 그대로 다음달 prev_schedule에 넣고 이어서 생성.
관찰: 주휴 요일 드리프트(주말 몰림 → 평일 몰림)가 생성 가능성에 미치는 영향.

실행: cd /home/user/nurse-v4 && python3 <this file> [months] [engine]
"""
from __future__ import annotations

import json
import random
import sys
import time
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.models import GenerateRequest, Nurse, Requirements, Rules, ShiftDef  # noqa: E402

import os
OUT_DIR = Path(os.environ.get("SIM_OUT", ROOT / "dist" / "sim_out"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

CYCLE_REF = date(2026, 3, 1)  # 앱 주기 기준일 (scheduler_base._CYCLE_REF)
KO_DOW = ["일", "월", "화", "수", "목", "금", "토"]  # 사용자/JS dow 코드 0=일

# 실서비스(DB 시드) 17종 근무 — tests의 PROD_SHIFTS와 동일
PROD_SHIFTS = [
    ShiftDef(code="DC", name="Day Charge", period="day", is_charge=True),
    ShiftDef(code="D", name="Day", period="day"),
    ShiftDef(code="D1", name="Day1", period="day1", auto_assign=False),
    ShiftDef(code="EC", name="Evening Charge", period="evening", is_charge=True),
    ShiftDef(code="E", name="Evening", period="evening"),
    ShiftDef(code="중", name="중간번", period="middle", auto_assign=False),
    ShiftDef(code="NC", name="Night Charge", period="night", is_charge=True),
    ShiftDef(code="N", name="Night", period="night"),
    ShiftDef(code="OF", name="Off", period="rest"),
    ShiftDef(code="주", name="주휴", period="rest", auto_assign=False),
    ShiftDef(code="P1", name="임부휴무", period="rest"),
    ShiftDef(code="V", name="연차", period="leave"),
    ShiftDef(code="생", name="생리휴가", period="leave"),
    ShiftDef(code="특", name="특별휴가", period="leave", auto_assign=False),
    ShiftDef(code="공", name="공적업무", period="leave", auto_assign=False),
    ShiftDef(code="법", name="법정공휴일", period="leave"),
    ShiftDef(code="병", name="병가", period="leave", auto_assign=False),
]

SEED_SCORING = [  # DB 시드와 동일 — V 페널티 -500·생 보상 +80 등 (없으면 솔버가 V/생 무차별!)
    ("D→N 전환 페널티", "transition", {"from": "day", "to": "night"}, -30),
    ("N→공 전환 페널티", "transition", {"from": "night", "to": "specific:공"}, -40),
    ("V(연차) 사용 페널티", "specific_shift", {"shift_code": "V", "condition": "all"}, -500),
    ("생리휴가 보상", "specific_shift", {"shift_code": "생", "condition": "female_only"}, 80),
    ("D→E 순방향 보상", "transition", {"from": "day", "to": "evening"}, 20),
    ("E→N 순방향 보상", "transition", {"from": "evening", "to": "night"}, 20),
    ("연속 동일 낮 근무 보상", "consecutive_same", {"period": "day"}, 15),
    ("연속 동일 저녁 근무 보상", "consecutive_same", {"period": "evening"}, 15),
    ("연속 동일 야간 근무 보상", "consecutive_same", {"period": "night"}, 15),
    ("연속 휴일 보상", "consecutive_same", {"period": "rest"}, 30),
    ("희망 근무 반영 보상", "wish", {}, 50),
    ("야간 근무 공평성", "night_fairness", {}, -50),
    ("퐁당퐁당 회피", "pattern", {"pattern": ["work", "rest_leave", "work"]}, -20),
    ("법정공휴일 휴가 보상", "specific_shift", {"shift_code": "법", "condition": "all"}, 30),
    ("공휴일 근무 보상", "holiday_work", {}, 20),
    ("주말 경감근무 보상", "weekend_work", {"slots": [{"weekday": 5, "periods": ["evening", "night"]}, {"weekday": 6, "periods": ["day"]}]}, 20),
    ("공휴일 OFF 페널티", "holiday_off", {}, -500),
]


def seed_scoring_rules():
    from server.models import ScoringRule
    return [ScoringRule(id=i, name=n, rule_type=rt, params=pr, score=s, enabled=True,
                        sort_order=i)
            for i, (n, rt, pr, s) in enumerate(SEED_SCORING)]


def ward_requirements() -> Requirements:
    """실서비스 DB 시드 기본 요일표 (Requirements() 파이덴틱 기본값 3/3/3과 다름!)."""
    from server.models import DayRequirement
    vals = {"mon": (4, 5, 3), "tue": (5, 5, 3), "wed": (5, 5, 3), "thu": (5, 5, 3),
            "fri": (5, 4, 3), "sat": (4, 3, 2), "sun": (3, 4, 3)}  # 토 4/3/2 (제1원칙 4)
    return Requirements(**{k: DayRequirement(D=d, E=e, N=n) for k, (d, e, n) in vals.items()})


WARD_REQ_BY_JSDOW = {0: 10, 1: 12, 2: 13, 3: 13, 4: 13, 5: 12, 6: 9}  # 총 근무 인원


HOLIDAYS = sorted(
    d
    for year, days in json.load(open(Path(__file__).resolve().parent.parent
                                     / "tests" / "fixtures" / "kr_holidays_golden.json")).items()
    if year in ("2026", "2027")
    for d in days
)
HOLIDAY_SET = set(HOLIDAYS)


def js_dow(d: date) -> int:
    """JS getDay() / 사용자 요일 코드: 0=일 … 6=토."""
    return (d.weekday() + 1) % 7


def week_idx(d: date) -> int:
    return (d - CYCLE_REF).days // 7


def period_idx(d: date) -> int:
    return week_idx(d) // 4


def month_days(y: int, m: int):
    d = date(y, m, 1)
    while d.month == m:
        yield d
        d += timedelta(days=1)


def juhu_day_for(desired_dow_in_sep: int) -> int:
    """2026-09 첫 4주기(period 6)에서 원하는 요일이 나오도록 juhu_day 역산.
    effective = (juhu_day - periodIdx) % 7  →  juhu_day = (desired + periodIdx) % 7."""
    p0 = period_idx(date(2026, 9, 1))
    return (desired_dow_in_sep + p0) % 7


# ── 간호사 18명 ────────────────────────────────────────────────────────────────
# 차지 가능 n00~n08 / 불가 n09~n17. 남성 4명. 임산부 n10 (여·차지불가).
# 주휴 시작 요일(9월 기준): 토 4명(n00,n04,n09,n13) 일 4명(n01,n05,n10,n14)
#                          월(n02,n11) 화(n03,n12) 수(n06,n15) 목(n07,n16) 금(n08,n17)
JUHU_START = {  # nid → 9월에 보일 요일 (사용자 코드)
    "n00": 6, "n04": 6, "n09": 6, "n13": 6,
    "n01": 0, "n05": 0, "n10": 0, "n14": 0,
    "n02": 1, "n11": 1, "n03": 2, "n12": 2,
    "n06": 3, "n15": 3, "n07": 4, "n16": 4,
    "n08": 5, "n17": 5,
}
MALE = {"n03", "n07"}  # 남 2 · 여 16 (2026-08-20 사용자 지정)
PREGNANT = "n10"
PREG = {
    "early": {"start": "2026-09-01", "end": "2026-10-31"},
    "late": {"start": "2027-03-01", "end": "2027-04-30"},
}
PREG_END_DATE = None  # 18명 유지 (제1원칙 4) — 전출 시나리오는 값 지정 시에만


def build_nurses(ym: str) -> list[Nurse]:
    nurses = []
    for i in range(18):
        nid = f"n{i:02d}"
        charge = i <= 8
        nurses.append(Nurse(
            id=nid,
            name=f"간호{i:02d}" + ("C" if charge else ""),
            group="A" if charge else "B",
            gender="male" if nid in MALE else "female",
            capable_shifts=(["DC", "D", "EC", "E", "NC", "N"] if charge else ["D", "E", "N"]),
            seniority=i,
            juhu_day=juhu_day_for(JUHU_START[nid]),
            juhu_auto_rotate=True,
            is_pregnant=(nid == PREGNANT),
            pregnancy=(PREG if nid == PREGNANT else {}),
            end_date=(PREG_END_DATE if nid == PREGNANT else None),
        ))
    return nurses


def night_pair(month_seq: int) -> tuple[str, str]:
    """매달 바뀌는 야간전담 2명 — 임산부 제외 17명을 순서대로 순환."""
    elig = [f"n{i:02d}" for i in range(18) if f"n{i:02d}" != PREGNANT]
    a = elig[(2 * month_seq) % len(elig)]
    b = elig[(2 * month_seq + 1) % len(elig)]
    return a, b


def active_on(nid: str, d: date) -> bool:
    if nid == PREGNANT and PREG_END_DATE and d > date.fromisoformat(PREG_END_DATE):
        return False
    return True


def juhu_pins(y: int, m: int, taken: dict | None = None) -> dict[str, dict[str, str]]:
    """앱 분석탭 추천(2단계: juhu_day 고정 + 전역 4주기 -1 시프트)과 동일한
    순수 공식으로 당월 날짜에 주휴 핀 생성 (요일제).

    주휴를 공휴일로 몰아주는 관행은 없다 (제1원칙 5 — 주휴·공휴 중복은 중복수당
    으로 보상). 휴무 자리가 모자란 주는 엔진이 오프특근으로 흡수한다 (제1원칙 3)."""
    pins: dict[str, dict[str, str]] = defaultdict(dict)
    taken = taken or {}
    first, last = date(y, m, 1), max(month_days(y, m))
    w0, w1 = week_idx(first), week_idx(last)
    used = Counter()  # dk → 배치된 휴무 수. 일별 휴무 캐파(18-요구)-1 안에서만 배치
    #                   (앱 분석탭 추천의 여유도 게이팅과 같은 취지)
    REST = ("OF", "주", "P1", "V", "생", "법", "특", "공", "병")
    for nid, cells in taken.items():  # 전월 패딩으로 이미 확정된 당월 셀 반영
        for dk, c in cells.items():
            if dk.startswith(f"{y:04d}-{m:02d}") and c in REST:
                used[dk] += 1

    def remaining(d: date) -> int:
        return (18 - WARD_REQ_BY_JSDOW[js_dow(d)]) - used[d.isoformat()]

    for nid, _ in JUHU_START.items():
        jd = juhu_day_for(JUHU_START[nid])
        for w in range(w0, w1 + 1):
            ws = CYCLE_REF + timedelta(days=7 * w)
            eff = ((jd - (w // 4)) % 7 + 7) % 7
            full_week = [ws + timedelta(days=k) for k in range(7)]
            # 월경계 걸침 주: 전월 쪽에 이미 확정된 주휴가 있으면 이 주는 완료
            if any(taken.get(nid, {}).get(d.isoformat()) == "주" for d in full_week):
                continue
            week = [d for d in full_week
                    if d.month == m and d.year == y and active_on(nid, d)
                    and d.isoformat() not in taken.get(nid, {})]
            if not week:
                continue
            # 명절 주간 주휴-이동 분기는 제거됨(존재하지 않는 관행 — 제1원칙 5).
            # 공휴일 몰린 주는 엔진의 오프특근 규칙(공휴일 포함 주 OF ≤1)이 처리한다.
            target = None
            if target is None:
                effd = next((d for d in week if js_dow(d) == eff), None)
                if effd is not None and remaining(effd) > 1:
                    target = effd
                else:  # 원래 요일이 만석이면 그 주에서 가장 여유 있는 날로 (요일 변경)
                    best = max(week, key=remaining)
                    # 그 주의 당월 날짜가 전부 만석이면 미배치 — 월경계 걸침 주는
                    # 다음달 쪽 날짜가 주휴를 받는다 (다음달 juhu_pins가 처리)
                    target = best if remaining(best) > 1 else None
            if target is not None:
                pins[nid][target.isoformat()] = "주"
                used[target.isoformat()] += 1
    return pins


def wish_offs(y: int, m: int, pins, rng, taken: dict | None = None) -> dict[str, dict[str, str]]:
    """인당 2개 랜덤 OFF — 주휴 핀·공휴일(OF 금지)·확정 셀 회피 + 일별 캐파 가드.
    (그 날 쉬는 자리가 이미 꽉 찼으면 수간호사가 다른 날로 반려하는 관행)"""
    taken = taken or {}
    used = Counter()  # dk → 핀된 휴무 수 (주휴 + 확정된 신청 OFF + 전월 패딩 휴무)
    REST = ("OF", "주", "P1", "V", "생", "법", "특", "공", "병")
    for nid, cells in taken.items():
        for dk, c in cells.items():
            if dk.startswith(f"{y:04d}-{m:02d}") and c in REST:
                used[dk] += 1
    for cells in pins.values():
        for dk in cells:
            used[dk] += 1
    cap = {d.isoformat(): 18 - WARD_REQ_BY_JSDOW[js_dow(d)] for d in month_days(y, m)}
    out: dict[str, dict[str, str]] = defaultdict(dict)
    for i in range(18):
        nid = f"n{i:02d}"
        got = 0
        cand = [d.isoformat() for d in month_days(y, m)
                if d.isoformat() not in pins.get(nid, {})
                and d.isoformat() not in taken.get(nid, {})
                and d.isoformat() not in HOLIDAY_SET
                and active_on(nid, d)]
        rng.shuffle(cand)
        for dk in cand:
            if got >= 2:
                break
            if used[dk] + 1 < cap[dk]:  # 자리 1개는 남겨둔다 (야간전담 휴식·OF 의무 여지)
                out[nid][dk] = "OF"
                used[dk] += 1
                got += 1
    return out


def summarize(y, m, res, pins, confirmed_prev):
    days = list(month_days(y, m))
    sched = res.get("schedule") or {}
    juhu_by_dow = Counter()
    rest_slack = {}
    req = ward_requirements().model_dump()
    wk = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    per_nurse = defaultdict(Counter)
    for d in days:
        dk = d.isoformat()
        resters = 0
        active = 0
        for nid, cells in sched.items():
            c = cells.get(dk)
            if not c:
                continue
            active += 1
            per_nurse[nid][c] += 1
            if c == "주":
                juhu_by_dow[KO_DOW[js_dow(d)]] += 1
            if c in ("OF", "주", "P1", "V", "생", "법", "특", "공", "병"):
                resters += 1
        r = req[wk[d.weekday()]]
        need = (r["D"] or 0) + (r["E"] or 0) + (r["N"] or 0)
        rest_slack[dk] = active - need - resters  # 0이면 딱 맞음(여유 0)
    v_total = sum(c["V"] for c in per_nurse.values() if "V" in c)
    saeng = sum(c["생"] for c in per_nurse.values() if "생" in c)
    return {
        "juhu_by_dow": dict(juhu_by_dow),
        "min_slack": min(rest_slack.values()) if rest_slack else None,
        "v_total": v_total, "saeng_total": saeng,
        "nights": {nid: sum(v for k, v in c.items() if k in ("N", "NC"))
                   for nid, c in per_nurse.items()},
    }


def run(months: int = 12, engine: str = "cpsat", time_limit: int = 180):
    if engine == "cpsat":
        from server.scheduler_cpsat import CpSatScheduler as Engine
    else:
        from server.scheduler import NurseScheduler as Engine

    results = []
    confirmed: dict[str, dict[str, str]] = defaultdict(dict)  # 체인: 확정된 전월 셀
    prev_month_nights: dict[str, int] = {}
    y, m = 2026, 9
    for seq in range(months):
        ym = f"{y:04d}-{m:02d}"
        rng = random.Random(f"sim-{ym}")
        pins = juhu_pins(y, m, taken=confirmed)
        na, nb = night_pair(seq)
        offs = wish_offs(y, m, pins, rng, taken=confirmed)

        prev: dict[str, dict[str, str]] = defaultdict(dict)
        # 전월 확정분 + 전월 솔브가 이미 정한 당월 초 패딩(주기 걸침) 이월
        py, pm = (y, m - 1) if m > 1 else (y - 1, 12)
        lo = f"{py:04d}-{pm:02d}-01"
        for nid, cells in confirmed.items():
            for dk, c in cells.items():
                if dk >= lo:
                    prev[nid][dk] = c
        for nid, cells in pins.items():
            prev[nid].update(cells)
        for nid, cells in offs.items():
            prev[nid].update(cells)

        nurses = build_nurses(ym)
        for n in nurses:
            n.night_months = {ym: True} if n.id in (na, nb) else {}

        req = GenerateRequest(
            year=y, month=m, nurses=nurses, requirements=ward_requirements(),
            rules=Rules(), prev_schedule=dict(prev), shifts=PROD_SHIFTS,
            holidays=HOLIDAYS, prev_month_nights=prev_month_nights,
            scoring_rules=seed_scoring_rules(),
            time_limit=time_limit, solver=engine,
        )
        t0 = time.time()
        res = Engine(req).solve()
        elapsed = time.time() - t0
        mode = "strict"
        if not res.get("success"):
            # 병동 현실: 안 풀리면 완화로 재시도
            req2 = req.model_copy(update={"allow_pre_relax": True})
            t1 = time.time()
            res2 = Engine(req2).solve()
            elapsed += time.time() - t1
            if res2.get("success"):
                res, mode = res2, "relaxed"
            else:
                mode = "failed"

        entry = {
            "ym": ym, "mode": mode, "elapsed": round(elapsed, 1),
            "night_pair": [na, nb],
            "pinned_notes": len(res.get("pinned_notes") or []),
            "relaxed_cells": len(res.get("relaxed_cells") or []),
        }
        if res.get("success"):
            entry.update(summarize(y, m, res, pins, confirmed))
            # 체인 갱신: 당월 + 익월 초 패딩(주기 걸침)까지 확정으로 편입
            # (병동 현실: 번표는 주기 단위로 이어붙는다 — 경계 재풀이 불일치 방지)
            nights = defaultdict(int)
            first_cur = f"{ym}-01"
            for nid, cells in res["schedule"].items():
                for dk, c in cells.items():
                    if dk >= first_cur:
                        confirmed[nid][dk] = c
                        if dk.startswith(ym) and c in ("N", "NC"):
                            nights[nid] += 1
            prev_month_nights = dict(nights)
            (OUT_DIR / f"sched_{ym}.json").write_text(
                json.dumps(res["schedule"], ensure_ascii=False))
        else:
            entry["message"] = (res.get("message") or "")[:4000]

        results.append(entry)
        (OUT_DIR / "summary.json").write_text(
            json.dumps(results, ensure_ascii=False, indent=1))
        line = (f"[{ym}] {mode} {elapsed:.0f}s 야간전담={na},{nb} "
                f"주휴분포={entry.get('juhu_by_dow')} 최소여유={entry.get('min_slack')} "
                f"V={entry.get('v_total')} notes={entry['pinned_notes']} relax={entry['relaxed_cells']}")
        print(line, flush=True)
        if mode == "failed":
            print("  ── 진단 메시지 앞부분 ──", flush=True)
            print("  " + (res.get("message") or "")[:1500].replace("\n", "\n  "), flush=True)
            print("  (체인 중단 — 이 달을 넘길 수 없음)", flush=True)
            break
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)

    print("DONE", flush=True)


if __name__ == "__main__":
    months = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    engine = sys.argv[2] if len(sys.argv) > 2 else "cpsat"
    run(months, engine)
