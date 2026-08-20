"""12개월 연속(이월 체인) 근무 생성 시뮬레이션 — 사용자 시나리오 (2026-08-19).

⚠️ 2026-08-20 사용자 정정 — 이 버전의 가정 중 오류 (CLAUDE.md 제1원칙 참조):
  · "명절 주간 주휴를 공휴일에 배치"(juhu_pins의 hols 분기)는 **존재하지 않는
    관행** — 실제 기전은 오프특근(공휴일 몰린 주 + 법휴 부여 시 OF 면제).
  · 17명 체제(임산부 전출) 구간은 임의 가정 — 실제는 18명 유지 전제.
  · 요일표는 사용자 기준 토 4/3/2 (여기선 DB 시드 3/3/2 사용).
  재모델링 전까지 결과 해석 주의. 재실행 전 제1원칙과 대조할 것.

구성: 간호사 18명 (임산부 1 · 야간전담 2 매달 교대 · 차지가능 9/불가 9)
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

def ward_requirements() -> Requirements:
    """실서비스 DB 시드 기본 요일표 (Requirements() 파이덴틱 기본값 3/3/3과 다름!)."""
    from server.models import DayRequirement
    vals = {"mon": (4, 5, 3), "tue": (5, 5, 3), "wed": (5, 5, 3), "thu": (5, 5, 3),
            "fri": (5, 4, 3), "sat": (3, 3, 2), "sun": (3, 4, 3)}
    return Requirements(**{k: DayRequirement(D=d, E=e, N=n) for k, (d, e, n) in vals.items()})


WARD_REQ_BY_JSDOW = {0: 10, 1: 12, 2: 13, 3: 13, 4: 13, 5: 12, 6: 8}  # 총 근무 인원


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
MALE = {"n03", "n07", "n12", "n16"}
PREGNANT = "n10"
PREG = {
    "early": {"start": "2026-09-01", "end": "2026-10-31"},
    "late": {"start": "2027-03-01", "end": "2027-04-30"},
}
PREG_END_DATE = "2027-04-30"  # 출산휴가 → 전출 처리 (이후 17명 체제)


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
    if nid == PREGNANT and d > date.fromisoformat(PREG_END_DATE):
        return False
    return True


def juhu_pins(y: int, m: int, taken: dict | None = None) -> dict[str, dict[str, str]]:
    """앱 분석탭 추천(2단계: juhu_day 고정 + 전역 4주기 -1 시프트)과 동일한
    순수 공식으로 당월 날짜에 주휴 핀 생성 (요일제).

    명절 주간 관행 반영: 공휴일이 낀 주에는 그 주의 주휴를 공휴일 날짜로 이동
    (공휴일 OF 금지 탓에 비공휴일 캐파가 주휴+전원 OF로 만석이 되는 교착 —
    2026-09 추석 주간에서 재현·확정 — 을 병동이 실제로 푸는 방식)."""
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
            hols = [d for d in week if d.isoformat() in HOLIDAY_SET]
            target = None
            if hols:  # ⚠️ 가정 오류(2026-08-20 정정): 이런 관행 없음 — 재모델링 대기
                best = max(hols, key=remaining)
                if remaining(best) > 1:
                    target = best
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
        offs = wish_offs(y, m, pins, rng, taken=confirmed)
        na, nb = night_pair(seq)

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
