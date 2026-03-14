"""
스케줄러 테스트베드
- NurseScheduler를 서브클래스로 상속해 날짜 범위를 7/14일로 제한
- 수간호사(charge only), 주휴 사전 고정으로 대칭성 감소
"""
import time
from datetime import date, timedelta
from typing import Optional

from server.models import GenerateRequest, Nurse, Requirements, Rules, DayRequirement
from server.scheduler import NurseScheduler


# ── 날짜 범위 제한 서브클래스 ─────────────────────────────────────────────────

class LimitedScheduler(NurseScheduler):
    """테스트용: 월 전체 대신 최대 max_days 일만 커버하는 스케줄러"""
    def __init__(self, request: GenerateRequest, max_days: int = 7):
        self._max_days = max_days
        super().__init__(request)

    def _build_date_range(self):
        super()._build_date_range()
        # 대상 월 1일부터 max_days일만 사용 (인접 월 날짜 제외)
        first_of_month = date(self.year, self.month, 1)
        cutoff = first_of_month + timedelta(days=self._max_days)

        self.all_dates = [d for d in self.all_dates
                          if first_of_month <= d < cutoff]
        self.T = len(self.all_dates)
        self.date_to_idx = {d: i for i, d in enumerate(self.all_dates)}
        # 완전한 주(7일)만 유지
        self.weeks = [(ws, we) for ws, we in self.weeks if we < self.T]


# ── 테스트 데이터 구성 ────────────────────────────────────────────────────────

def make_nurses():
    """
    18명 간호사 (임시 이름에 * 접두어):
    - 1그룹(A): 6명 (여4 + 남2), DC/EC/NC 가능 포함
    - 2그룹(B): 6명 (여4 + 남2)
    - 3그룹(C): 6명 (여4 + 남2)
    각 그룹 내 seniority=0인 수간호사 1명이 charge 전담 (DC/EC/NC만 가능)
    """
    # (id, name, group, gender, seniority)
    # 모든 간호사가 DC/D/EC/E/NC/N 가능 - 시니어 순으로 charge 자연 배정
    data = [
        # ── 1그룹 A ──────────────────────────────────────────────────────
        ("a0", "*김지현", "A", "female", 0),
        ("a1", "*이수진", "A", "female", 1),
        ("a2", "*박민지", "A", "female", 2),
        ("a3", "*정수아", "A", "female", 3),
        ("a4", "*김준혁", "A", "male",   4),
        ("a5", "*이민준", "A", "male",   5),
        # ── 2그룹 B ──────────────────────────────────────────────────────
        ("b0", "*최은혜", "B", "female", 6),
        ("b1", "*강혜진", "B", "female", 7),
        ("b2", "*조나연", "B", "female", 8),
        ("b3", "*윤예진", "B", "female", 9),
        ("b4", "*박정호", "B", "male",   10),
        ("b5", "*최현우", "B", "male",   11),
        # ── 3그룹 C ──────────────────────────────────────────────────────
        ("c0", "*장소연", "C", "female", 12),
        ("c1", "*임유진", "C", "female", 13),
        ("c2", "*한지원", "C", "female", 14),
        ("c3", "*신하은", "C", "female", 15),
        ("c4", "*정성민", "C", "male",   16),
        ("c5", "*강동현", "C", "male",   17),
    ]
    return [
        Nurse(id=nid, name=name, group=grp, gender=gen,
              capable_shifts=["DC","D","EC","E","NC","N"], seniority=sen)
        for nid, name, grp, gen, sen in data
    ]


def make_prev_schedule_with_joo(nurses, year, month, max_days,
                                 add_v_requests: bool = False):
    """
    주휴(주)를 간호사별로 사전 고정 → 대칭성 파괴
    nurse i는 (i % 7)번째 요일에 주휴 배정
    add_v_requests=True: 현실 시뮬레이션 - 간호사마다 V 2~3일 추가 고정
    """
    import random
    rng = random.Random(42)  # 재현 가능한 시드

    prev: dict[str, dict[str, str]] = {}
    first = date(year, month, 1)

    all_days = [first + timedelta(days=i) for i in range(max_days)]

    for nurse in nurses:
        nid = nurse.id
        idx = int(nid[1:]) if nid[1:].isdigit() else ord(nid[0]) % 7
        joo_weekday = idx % 7
        prev[nid] = {}

        # 주휴 고정
        for d in all_days:
            if d.weekday() == joo_weekday:
                prev[nid][d.strftime("%Y-%m-%d")] = "주"

        # V 요청 시뮬레이션 (주휴가 아닌 날 중 2~3일 랜덤)
        if add_v_requests:
            v_count = rng.randint(2, 3)
            free_days = [d for d in all_days
                         if d.strftime("%Y-%m-%d") not in prev[nid]]
            v_days = rng.sample(free_days, min(v_count, len(free_days)))
            for d in v_days:
                prev[nid][d.strftime("%Y-%m-%d")] = "V"

    return prev


def make_requirements():
    """
    요일별 근무 인원 (D/E/N 시간대 총 인원, charge 포함).
    18명 기준: 평일 D5/E5/N5, 주말 D4/E4/N4
    """
    req = Requirements()
    req.mon = DayRequirement(D=4, E=5, N=3)
    req.tue = DayRequirement(D=5, E=5, N=3)
    req.wed = DayRequirement(D=5, E=5, N=3)
    req.thu = DayRequirement(D=5, E=5, N=3)
    req.fri = DayRequirement(D=5, E=4, N=3)
    req.sat = DayRequirement(D=3, E=3, N=2)
    req.sun = DayRequirement(D=3, E=4, N=3)
    return req


# ── 검증 함수 ─────────────────────────────────────────────────────────────────

def validate(schedule: dict, nurses: list) -> None:
    nurse_map = {n.id: n.name for n in nurses}
    errors = []

    for nid, days in schedule.items():
        sd = sorted(days.items())
        for i in range(len(sd) - 1):
            s1, s2 = sd[i][1], sd[i+1][1]
            pair = f"{s1}→{s2}"
            if (s1 in ["E","EC"] and s2 in ["D","DC"]) or \
               (s1 in ["N","NC"] and s2 in ["E","EC"]) or \
               (s1 in ["N","NC"] and s2 in ["D","DC"]):
                errors.append(f"[역순전환] {nurse_map.get(nid,nid)}: {sd[i][0]} {pair}")

        v_count = sum(1 for s in days.values() if s == "V")
        if v_count > 1:
            errors.append(f"[V초과] {nurse_map.get(nid,nid)}: {v_count}회")

    if errors:
        print("[FAIL] 위반 발견:")
        for e in errors:
            print("  ", e)
    else:
        print("[OK] 역순 전환 없음 / V 초과 없음")

    # 야간 분포
    night_counts = {
        nurse_map.get(nid, nid): sum(1 for s in days.values() if s in ["N","NC"])
        for nid, days in schedule.items()
    }
    print(f"야간 분포: min={min(night_counts.values())} max={max(night_counts.values())}")
    print("  ", dict(sorted(night_counts.items(), key=lambda x: x[1], reverse=True)))


def print_grid(schedule: dict, nurses: list) -> None:
    """간단한 ASCII 스케줄 출력"""
    nurse_map = {n.id: n.name for n in nurses}
    all_dates = sorted({d for days in schedule.values() for d in days})
    header = f"{'이름':8}" + "".join(f"{d[8:]:4}" for d in all_dates)
    print(header)
    print("-" * len(header))
    for nurse in nurses:
        nid = nurse.id
        if nid not in schedule:
            continue
        row = f"{nurse.name:8}" + "".join(
            f"{schedule[nid].get(d, '-'):4}" for d in all_dates
        )
        print(row)


# ── 메인 테스트 ───────────────────────────────────────────────────────────────

def run_test(max_days: int = 7, year: int = 2025, month: int = 3,
             add_v: bool = False):
    label = f"{max_days}일" + (" + V요청 사전입력" if add_v else "")
    print(f"\n{'='*60}")
    print(f"테스트: {year}년 {month}월, {label}")
    print("="*60)

    nurses = make_nurses()
    prev   = make_prev_schedule_with_joo(nurses, year, month, max_days,
                                          add_v_requests=add_v)
    req    = make_requirements()
    rules  = Rules(
        maxConsecutiveWorkDays=6,
        maxConsecutiveNightDays=3,
        maxVPerMonth=3 if add_v else 1,  # V 시뮬레이션 시 maxV 완화
    )

    request = GenerateRequest(
        year=year, month=month,
        nurses=nurses,
        requirements=req,
        rules=rules,
        prev_schedule=prev,
    )

    scheduler = LimitedScheduler(request, max_days=max_days)
    print(f"계획 기간: {scheduler.all_dates[0]} ~ {scheduler.all_dates[-1]} ({scheduler.T}일)")
    print(f"완전한 주 수: {len(scheduler.weeks)}")
    total_fixed = sum(len(v) for v in prev.values())
    print(f"사전 고정 총 {total_fixed}개 (주휴 + V 요청)")

    t0 = time.time()
    result = scheduler.solve()
    elapsed = time.time() - t0

    print(f"\n풀이 시간: {elapsed:.1f}초")
    print(f"결과: {'[성공]' if result['success'] else '[실패]'}")
    print(f"메시지: {result['message']}")

    if result["success"]:
        validate(result["schedule"], nurses)
        print()
        print_grid(result["schedule"], nurses)

    return result


if __name__ == "__main__":
    # 31일: 주휴만 사전 고정
    run_test(max_days=31, add_v=False)
    # 31일: 주휴 + V 요청 사전 고정 (현실 시뮬레이션)
    run_test(max_days=31, add_v=True)
