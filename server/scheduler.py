"""
간호사 스케줄러 v2 - HiGHS MIP 엔진
CP-SAT(OR-Tools) 대신 PuLP + HiGHS Mixed Integer Programming 사용
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

import pulp

from .models import GenerateRequest, Nurse, Requirements, Rules, ScoringRule


# ── 상수 ────────────────────────────────────────────────────────────────────

WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# 기본 근무 16종 (DB 없이 fallback 시 사용)
_DEFAULT_SHIFTS = [
    {"code": "DC", "period": "day",     "is_charge": True},
    {"code": "D",  "period": "day",     "is_charge": False},
    {"code": "D1", "period": "day1",    "is_charge": False},
    {"code": "EC", "period": "evening", "is_charge": True},
    {"code": "E",  "period": "evening", "is_charge": False},
    {"code": "중", "period": "middle",  "is_charge": False},
    {"code": "NC", "period": "night",   "is_charge": True},
    {"code": "N",  "period": "night",   "is_charge": False},
    {"code": "OF", "period": "rest",    "is_charge": False},
    {"code": "주", "period": "rest",    "is_charge": False},
    {"code": "V",  "period": "leave",   "is_charge": False},
    {"code": "생", "period": "leave",   "is_charge": False},
    {"code": "특", "period": "leave",   "is_charge": False},
    {"code": "공", "period": "leave",   "is_charge": False},
    {"code": "법", "period": "leave",   "is_charge": False},
    {"code": "병", "period": "leave",   "is_charge": False},
]



class NurseScheduler:
    def __init__(self, request: GenerateRequest):
        self.year  = request.year
        self.month = request.month
        self.nurses: List[Dict] = [n.model_dump() for n in request.nurses]
        self.req   = request.requirements
        self.rules = request.rules
        self.prev  = request.prev_schedule or {}
        self.per_day_req = request.per_day_requirements or {}

        # ── 근무 정의 → 카테고리 리스트 동적 구성 ─────────────────────────────
        shifts = [s.model_dump() for s in request.shifts] if request.shifts else []
        if not shifts:
            # fallback: 기본 16종 (DB 없이 임포트 시)
            shifts = _DEFAULT_SHIFTS

        self.DAY_SHIFTS     = [s["code"] for s in shifts if s["period"] == "day"]
        self.DAY1_SHIFTS    = [s["code"] for s in shifts if s["period"] == "day1"]
        self.EVENING_SHIFTS = [s["code"] for s in shifts if s["period"] == "evening"]
        self.MIDDLE_SHIFTS  = [s["code"] for s in shifts if s["period"] == "middle"]
        self.NIGHT_SHIFTS   = [s["code"] for s in shifts if s["period"] == "night"]
        self.CHARGE_SHIFTS  = [s["code"] for s in shifts if s["is_charge"]]
        self.REST_SHIFTS    = [s["code"] for s in shifts if s["period"] == "rest"]
        self.LEAVE_SHIFTS   = [s["code"] for s in shifts if s["period"] == "leave"]
        self.WORK_SHIFTS    = (self.DAY_SHIFTS + self.DAY1_SHIFTS +
                               self.EVENING_SHIFTS + self.MIDDLE_SHIFTS + self.NIGHT_SHIFTS)
        self.ALL_SHIFTS     = self.WORK_SHIFTS + self.REST_SHIFTS + self.LEAVE_SHIFTS
        self._shifts        = shifts   # 원본 리스트 (charge_seniority 등에서 사용)

        # 배점 규칙 (enabled만 필터링)
        self.scoring_rules: List[ScoringRule] = [
            r for r in request.scoring_rules if r.enabled
        ]

        self._build_date_range()

    # ── 날짜 범위 계산 ────────────────────────────────────────────────────────

    def _build_date_range(self):
        """대상 월을 포함하는 완전한 주(일~토) 범위 계산"""
        first = date(self.year, self.month, 1)
        if self.month == 12:
            last = date(self.year + 1, 1, 1) - timedelta(days=1)
        else:
            last = date(self.year, self.month + 1, 1) - timedelta(days=1)

        # 일요일(weekday=6)부터 시작, 토요일(weekday=5)로 끝
        days_to_sunday = first.weekday() + 1 if first.weekday() != 6 else 0
        if first.weekday() == 6:
            days_to_sunday = 0
        else:
            days_to_sunday = (first.weekday() + 1) % 7

        days_to_saturday = (5 - last.weekday()) % 7

        self.schedule_start = first - timedelta(days=days_to_sunday)
        self.schedule_end   = last  + timedelta(days=days_to_saturday)

        self.all_dates: List[date] = []
        cur = self.schedule_start
        while cur <= self.schedule_end:
            self.all_dates.append(cur)
            cur += timedelta(days=1)

        self.T = len(self.all_dates)
        self.date_to_idx = {d: i for i, d in enumerate(self.all_dates)}

        # 완전한 주 목록 [(week_start_idx, week_end_idx), ...]
        self.weeks: List[Tuple[int, int]] = []
        for i in range(0, self.T, 7):
            if i + 6 < self.T:
                self.weeks.append((i, i + 6))

    # ── 예상 소요시간 추정 ────────────────────────────────────────────────────

    def estimate_seconds(self) -> int:
        """
        LP 변수 수 기반 풀이 시간 추정.
        - 기본 변수: 간호사 × T × 근무종류
        - 소프트 제약 보조변수: 전환/연속/패턴 규칙별 간호사 × (T-1) 또는 (T-N+1)
        - 경험 계수: ~0.12초/변수 (실측 기반, HiGHS 성능 기준)
        - 타임리밋(1200초)을 넘지 않도록 클램프
        """
        N = len(self.nurses)
        T = self.T
        S = len(self.ALL_SHIFTS)

        # 고정 사전입력 셀 수 (자유 변수가 줄어드는 만큼 보정)
        pre_filled = sum(
            len(days) for days in self.prev.values()
        )
        free_cells = max(0, N * T - pre_filled)

        # 기본 변수 수
        base_vars = free_cells * S

        # 소프트 제약 보조변수 수 추정
        soft_vars = 0
        for rule in self.scoring_rules:
            rt = rule.rule_type
            if rt in ("transition", "consecutive_same"):
                soft_vars += N * (T - 1)
            elif rt == "pattern":
                n_steps = len(rule.params.get("pattern", []))
                if n_steps >= 2:
                    soft_vars += N * max(0, T - n_steps + 1)
            elif rt == "night_fairness":
                soft_vars += N + 2  # night_count per nurse + min/max vars

        total_vars = base_vars + soft_vars

        # 경험 계수: HiGHS 실측 기준 ~0.12초/변수
        estimated = total_vars * 0.12
        return int(min(1200, max(5, round(estimated))))

    # ── 메인 솔버 ────────────────────────────────────────────────────────────

    def solve(self) -> Dict:
        if not self.nurses:
            return {"success": False, "message": "간호사가 등록되지 않았습니다.", "schedule": {}}

        nurse_ids = [n["id"] for n in self.nurses]
        prob = pulp.LpProblem("nurse_schedule", pulp.LpMaximize)

        # 변수 생성: x[nurse_id][day_idx][shift] ∈ {0,1}
        x: Dict[str, Dict[int, Dict[str, pulp.LpVariable]]] = {}
        for nurse in self.nurses:
            nid = nurse["id"]
            x[nid] = {}
            for d in range(self.T):
                dt = self.all_dates[d]
                dt_str = dt.strftime("%Y-%m-%d")
                x[nid][d] = {}
                pre = self.prev.get(nid, {}).get(dt_str)
                for s in self.ALL_SHIFTS:
                    if pre:
                        x[nid][d][s] = pulp.LpVariable(
                            f"x_{nid}_{d}_{s}",
                            lowBound=(1 if s == pre else 0),
                            upBound=(1 if s == pre else 0),
                            cat="Integer"
                        )
                    else:
                        x[nid][d][s] = pulp.LpVariable(f"x_{nid}_{d}_{s}", cat="Binary")

        # ── Hard Constraints ─────────────────────────────────────────────────

        self._c_one_shift_per_day(prob, x)
        self._c_shift_eligibility(prob, x)
        self._c_daily_requirements(prob, x)
        self._c_charge_requirements(prob, x)
        self._c_charge_seniority(prob, x)              # 선임이 charge 맡기
        self._c_forbidden_transitions(prob, x)         # E→D, N→E, N→D 항상 금지
        if self.rules.noNOD:
            self._c_nod_pattern(prob, x)               # N→OF→D 금지
        if self.rules.weeklyOff:
            self._c_weekly_off(prob, x)
        if self.rules.maxConsecutiveWork:
            self._c_max_consecutive_work(prob, x, self.rules.maxConsecutiveWorkDays)
        if self.rules.maxConsecutiveNight:
            self._c_max_consecutive_night(prob, x, self.rules.maxConsecutiveNightDays)
        self._c_max_v_per_month(prob, x)               # V 월 최대 횟수
        self._c_menstrual_leave(prob, x)
        self._c_night_shift_nurses(prob, x)            # 야간전담 전용 규칙

        # ── Objective (Soft Constraints) ─────────────────────────────────────

        obj = self._build_objective(prob, x)
        prob += obj

        # ── Solve ─────────────────────────────────────────────────────────────

        solver = pulp.HiGHS(
            timeLimit=1200,
            msg=False,
        )
        status = prob.solve(solver)

        if pulp.LpStatus[prob.status] in ("Optimal", "Feasible"):
            schedule, extended = self._extract_solution(x)
            nurse_scores = self._compute_nurse_scores(schedule)
            return {
                "success": True,
                "schedule": schedule,
                "extended_schedule": extended,
                "nurse_scores": nurse_scores,
                "message": f"근무표가 생성되었습니다. (상태: {pulp.LpStatus[prob.status]})",
                "estimated_seconds": self.estimate_seconds(),
            }
        elif pulp.LpStatus[prob.status] == "Infeasible":
            # 즉시 판정된 Infeasible → 진단 실행 (각 단계 10초 이내)
            diagnosis = self._diagnose_infeasibility()
            return {
                "success": False,
                "schedule": {},
                "extended_schedule": {},
                "message": diagnosis,
            }
        else:
            # Not Solved = 타임아웃 (600초 소진)
            return {
                "success": False,
                "schedule": {},
                "extended_schedule": {},
                "message": (
                    "제한 시간(10분) 내에 근무표를 완성하지 못했습니다.\n"
                    "힌트:\n"
                    "  · 간호사를 추가하거나 요일별 필요 인원을 줄여보세요.\n"
                    "  · 연속 근무/야간 일수 제한을 완화해보세요.\n"
                    "  · 사전 고정된 V/생 요청이 특정 날짜에 몰려 있지 않은지 확인하세요."
                ),
            }

    # ── Hard Constraint 구현 ──────────────────────────────────────────────────

    def _c_one_shift_per_day(self, prob, x):
        """하루에 정확히 1개의 근무/휴무"""
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T):
                prob += pulp.lpSum(x[nid][d][s] for s in self.ALL_SHIFTS) == 1, f"one_{nid}_{d}"

    def _c_shift_eligibility(self, prob, x):
        """간호사별 가능한 근무만 배정.
        자격 체크는 day/evening/night period 근무에만 적용.
        day1(상근)·middle(중간번)은 누구나 배정 가능 — UI에 체크박스 없음.
        """
        # 자격 체크 대상: day1·middle 제외한 근무 시프트
        eligible_check = [
            s["code"] for s in self._shifts
            if s["period"] in ("day", "evening", "night")
        ]
        for nurse in self.nurses:
            nid = nurse["id"]
            capable = set(nurse.get("capable_shifts", self.WORK_SHIFTS))
            impossible = [s for s in eligible_check if s not in capable]
            for d in range(self.T):
                for s in impossible:
                    prob += x[nid][d][s] == 0, f"elig_{nid}_{d}_{s}"

    def _c_daily_requirements(self, prob, x):
        """
        일별 시프트 인원 충족.
        요구사항은 D/E/N 시간대 총 인원 (charge 포함).
          D=3 → DC+D 합계 >= 3
          E=3 → EC+E 합계 >= 3
          N=3 → NC+N 합계 >= 3
        """
        req_dict = self.req.model_dump()
        period_map = {
            "D": self.DAY_SHIFTS + self.DAY1_SHIFTS,
            "E": self.EVENING_SHIFTS + self.MIDDLE_SHIFTS,
            "N": self.NIGHT_SHIFTS,
        }
        for d, dt in enumerate(self.all_dates):
            if dt.month != self.month:
                continue
            date_key = dt.strftime('%Y-%m-%d')
            weekday_key = WEEKDAY_KEYS[dt.weekday()]
            day_req = self.per_day_req.get(date_key) or req_dict.get(weekday_key, {})
            for period, shifts in period_map.items():
                required = day_req.get(period, 0)
                if required <= 0:
                    continue
                prob += (
                    pulp.lpSum(x[n["id"]][d][s] for n in self.nurses for s in shifts) >= required,
                    f"req_{d}_{period}"
                )

    def _c_charge_requirements(self, prob, x):
        """
        Charge 근무 정확히 1명 배정.
        D/E/N 인원이 필요한 날이면 해당 period의 charge shift도 정확히 1명 자동 배정.
        """
        req_dict = self.req.model_dump()
        # period → 요구사항 키 매핑 (day/day1 모두 "D" 요구사항에 포함)
        period_to_req = {"day": "D", "evening": "E", "night": "N"}
        charge_shifts = [s for s in self._shifts if s["is_charge"]]
        for d, dt in enumerate(self.all_dates):
            if dt.month != self.month:
                continue
            date_key = dt.strftime('%Y-%m-%d')
            weekday_key = WEEKDAY_KEYS[dt.weekday()]
            day_req = self.per_day_req.get(date_key) or req_dict.get(weekday_key, {})
            for s in charge_shifts:
                req_key = period_to_req.get(s["period"])
                if req_key and day_req.get(req_key, 0) > 0:
                    prob += (
                        pulp.lpSum(x[n["id"]][d][s["code"]] for n in self.nurses) == 1,
                        f"charge_{d}_{s['code']}"
                    )

    def _c_charge_seniority(self, prob, x):
        """
        Charge 간호사는 해당 시간대 근무자 중 가장 선임이어야 함.
        seniority 숫자가 낮을수록 선임.
        후임(seniority 높음) i 가 Charge 일 때, 선임(seniority 낮음) j 가
        같은 시간대 일반 근무 배정되는 경우를 금지:
          x[i][d][charge] + x[j][d][regular] <= 1
        """
        # period → 같은 시간대로 보는 period 집합
        # day charge는 day/day1 일반 근무자에 대해 제약
        period_peers = {
            "day":     ("day",),
            "evening": ("evening",),
            "night":   ("night",),
        }
        # charge shift → 같은 시간대 일반 근무 코드 목록
        charge_regular_map = {}
        for s in self._shifts:
            if not s["is_charge"]:
                continue
            peers = period_peers.get(s["period"], (s["period"],))
            regulars = [r["code"] for r in self._shifts
                        if r["period"] in peers and not r["is_charge"]]
            charge_regular_map[s["code"]] = regulars

        for d, dt in enumerate(self.all_dates):
            if dt.month != self.month:
                continue
            dt_str = dt.strftime("%Y-%m-%d")
            for i_nurse in self.nurses:
                for j_nurse in self.nurses:
                    if i_nurse["id"] == j_nurse["id"]:
                        continue
                    if i_nurse.get("seniority", 0) <= j_nurse.get("seniority", 0):
                        continue
                    nid_i = i_nurse["id"]
                    nid_j = j_nurse["id"]
                    j_capable = set(j_nurse.get("capable_shifts", []))
                    # 선임(j)의 당일 사전입력 고정 근무
                    j_fixed = self.prev.get(nid_j, {}).get(dt_str)
                    for charge_s, regulars in charge_regular_map.items():
                        # 선임(j)이 charge를 수행할 수 없으면 제약 불필요
                        if charge_s not in j_capable:
                            continue
                        # 선임(j)이 다른 근무로 사전입력 고정되어 있으면
                        # j는 charge를 맡을 수 없으므로 제약 불필요
                        if j_fixed and j_fixed != charge_s:
                            continue
                        for regular_s in regulars:
                            prob += (
                                x[nid_i][d][charge_s] + x[nid_j][d][regular_s] <= 1,
                                f"seniority_{nid_i}_{nid_j}_{d}_{charge_s}_{regular_s}"
                            )

    def _c_forbidden_transitions(self, prob, x):
        """
        물리적으로 불가능한 근무 전환 - 항상 금지 (토글 없음)
        E→D, N→E, N→D
        a + b <= 1  (두 변수 동시에 1이 될 수 없음)
        """
        forbidden = [
            (self.EVENING_SHIFTS, self.DAY_SHIFTS),
            (self.EVENING_SHIFTS, self.DAY1_SHIFTS),
            (self.NIGHT_SHIFTS,   self.EVENING_SHIFTS),
            (self.NIGHT_SHIFTS,   self.DAY_SHIFTS),
            (self.NIGHT_SHIFTS,   self.DAY1_SHIFTS),
            (self.NIGHT_SHIFTS,   self.MIDDLE_SHIFTS),
        ]
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T - 1):
                for first_group, second_group in forbidden:
                    for s1 in first_group:
                        for s2 in second_group:
                            prob += (
                                x[nid][d][s1] + x[nid][d + 1][s2] <= 1,
                                f"forbid_{nid}_{d}_{s1}_{s2}"
                            )

    def _c_nod_pattern(self, prob, x):
        """N→OF→D 금지: x[N/NC][d] + x[OF][d+1] + x[D/DC][d+2] <= 2"""
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T - 2):
                for ns in self.NIGHT_SHIFTS:
                    for ds in self.DAY_SHIFTS:
                        prob += (
                            x[nid][d][ns] + x[nid][d + 1]["OF"] + x[nid][d + 2][ds] <= 2,
                            f"nod_{nid}_{d}_{ns}_{ds}"
                        )

    def _c_weekly_off(self, prob, x):
        """
        각 완전한 주에 주휴 1개 + OF 1개.
        야간전담 간호사는 주휴만 적용, OF는 무제한.
        """
        for nurse in self.nurses:
            nid = nurse["id"]
            is_night = nurse.get("is_night_shift", False)
            for ws, we in self.weeks:
                prob += (
                    pulp.lpSum(x[nid][d]["주"] for d in range(ws, we + 1)) == 1,
                    f"weekly_joo_{nid}_{ws}"
                )
                if not is_night:
                    prob += (
                        pulp.lpSum(x[nid][d]["OF"] for d in range(ws, we + 1)) == 1,
                        f"weekly_of_{nid}_{ws}"
                    )

    def _c_max_consecutive_work(self, prob, x, max_days: int):
        """최대 연속 근무일 제한"""
        for nurse in self.nurses:
            nid = nurse["id"]
            for start in range(self.T - max_days):
                window = range(start, start + max_days + 1)
                prob += (
                    pulp.lpSum(x[nid][d][s] for d in window for s in self.WORK_SHIFTS) <= max_days,
                    f"consec_work_{nid}_{start}"
                )

    def _c_max_consecutive_night(self, prob, x, max_nights: int):
        """최대 연속 야간 근무 제한"""
        for nurse in self.nurses:
            nid = nurse["id"]
            for start in range(self.T - max_nights):
                window = range(start, start + max_nights + 1)
                prob += (
                    pulp.lpSum(x[nid][d][s] for d in window for s in self.NIGHT_SHIFTS) <= max_nights,
                    f"consec_night_{nid}_{start}"
                )

    def _c_max_v_per_month(self, prob, x):
        """V(연차) 당월 최대 사용 횟수 (hard constraint)"""
        max_v = self.rules.maxVPerMonth
        if max_v <= 0:
            return
        for nurse in self.nurses:
            nid = nurse["id"]
            v_vars = [
                x[nid][d]["V"]
                for d, dt in enumerate(self.all_dates)
                if dt.month == self.month and dt.year == self.year
            ]
            if v_vars:
                prob += pulp.lpSum(v_vars) <= max_v, f"max_v_{nid}"

    def _c_menstrual_leave(self, prob, x):
        """생리휴가: 여성 간호사당 전체 기간 최대 1회 (코드 '생'이 있을 때만)"""
        if "생" not in self.ALL_SHIFTS:
            return
        for nurse in self.nurses:
            if nurse.get("gender") != "female":
                continue
            nid = nurse["id"]
            menstrual_vars = [x[nid][d]["생"] for d in range(self.T)]
            prob += pulp.lpSum(menstrual_vars) <= 1, f"menstrual_{nid}"

    def _c_night_shift_nurses(self, prob, x):
        """
        야간전담 간호사 전용 제약 (is_night_shift=True):
          1. N/NC만 배정 (낮·저녁·중간번·상근 모두 금지)
          2. 5일 윈도우 내 근무 <= 3 → 3일 연속 후 2일 휴무 자동 보장
          3. 당월 정확히 14일 근무 (N+NC)
          4. 여성 간호사 + 31일 달 → 생리휴가 정확히 1회 (hard)
        주휴는 _c_weekly_off 에서 일반과 동일하게 처리.
        OF는 _c_weekly_off 에서 야간전담은 제외 → 무제한.
        """
        night_nurses = [n for n in self.nurses if n.get("is_night_shift")]
        if not night_nurses:
            return

        import calendar
        month_days = calendar.monthrange(self.year, self.month)[1]
        month_idxs = [d for d, dt in enumerate(self.all_dates) if dt.month == self.month]

        # 야간 제외 근무 코드 목록 (휴무·휴가 제외, 근무 shift만)
        non_night_work = [
            s["code"] for s in self._shifts
            if s["period"] not in ("night", "rest", "leave")
        ]

        for nurse in night_nurses:
            nid = nurse["id"]

            # ── 1. N/NC 외 모든 근무 금지 ─────────────────────────────────
            for d in range(self.T):
                for s in non_night_work:
                    if s in x[nid][d]:
                        prob += x[nid][d][s] == 0, f"night_only_{nid}_{d}_{s}"

            # ── 2. 5일 윈도우 <= 3 (3연속+2휴무 보장) ────────────────────
            for start in range(self.T - 4):
                prob += (
                    pulp.lpSum(
                        x[nid][d][s]
                        for d in range(start, start + 5)
                        for s in self.NIGHT_SHIFTS
                    ) <= 3,
                    f"night_5day_{nid}_{start}",
                )

            # ── 3. 당월 야간 근무 횟수 정확히 14일 ──────────────────────
            night_sum = pulp.lpSum(
                x[nid][d][s]
                for d in month_idxs
                for s in self.NIGHT_SHIFTS
            )
            prob += (night_sum == 14, f"night_monthly_{nid}")

            # ── 4. 31일 달 + 여성 → 생리휴가 정확히 1회 ─────────────────
            if month_days == 31 and nurse.get("gender") == "female" and "생" in self.ALL_SHIFTS:
                prob += (
                    pulp.lpSum(x[nid][d]["생"] for d in month_idxs) == 1,
                    f"night_menstrual_{nid}",
                )

    # ── period 그룹 → shift 코드 목록 해석 ──────────────────────────────────

    def _resolve_group(self, group: str) -> List[str]:
        """period 그룹명을 실제 shift 코드 목록으로 변환"""
        mapping = {
            "work":       self.WORK_SHIFTS,
            "day":        self.DAY_SHIFTS + self.DAY1_SHIFTS,
            "evening":    self.EVENING_SHIFTS + self.MIDDLE_SHIFTS,
            "night":      self.NIGHT_SHIFTS,
            "rest":       self.REST_SHIFTS,
            "leave":      self.LEAVE_SHIFTS,
            "rest_leave": self.REST_SHIFTS + self.LEAVE_SHIFTS,
            "any":        self.ALL_SHIFTS,
        }
        if group.startswith("specific:"):
            code = group.split(":", 1)[1]
            return [code] if code in self.ALL_SHIFTS else []
        return list(mapping.get(group, []))

    # ── 목적함수 (Soft Constraints) ──────────────────────────────────────────

    def _build_objective(self, prob, x) -> pulp.LpAffineExpression:
        """
        최대화 목적함수 구성 — scoring_rules 기반 동적 생성.
        소프트 제약 보조변수는 당월 날짜 쌍에만 적용 (인접 월 제외) → 문제 크기 최소화.
        """
        terms = []

        # 당월 날짜 인덱스 목록
        month_days = [d for d, dt in enumerate(self.all_dates)
                      if dt.month == self.month and dt.year == self.year]
        month_day_pairs = [(month_days[i], month_days[i+1])
                           for i in range(len(month_days) - 1)
                           if month_days[i+1] == month_days[i] + 1]

        for rule in self.scoring_rules:
            rt  = rule.rule_type
            p   = rule.params
            sc  = rule.score
            rid = rule.id if rule.id is not None else rule.sort_order  # unique prefix

            if rt == "specific_shift":
                code = p.get("shift_code", "")
                cond = p.get("condition", "all")
                if code not in self.ALL_SHIFTS:
                    continue
                for nurse in self.nurses:
                    nid = nurse["id"]
                    if cond == "female_only" and nurse.get("gender") != "female":
                        continue
                    for d in month_days:
                        terms.append(sc * x[nid][d][code])

            elif rt == "transition":
                from_shifts = self._resolve_group(p.get("from", ""))
                to_shifts   = self._resolve_group(p.get("to", ""))
                if not from_shifts or not to_shifts:
                    continue
                for nurse in self.nurses:
                    nid = nurse["id"]
                    for d, d1 in month_day_pairs:
                        f_sum = pulp.lpSum(x[nid][d][s]  for s in from_shifts if s in self.ALL_SHIFTS)
                        t_sum = pulp.lpSum(x[nid][d1][s] for s in to_shifts   if s in self.ALL_SHIFTS)
                        tag = f"tr{rid}_{nid}_{d}"
                        v = pulp.LpVariable(tag, cat="Binary")
                        prob += v <= f_sum,               f"{tag}_a"
                        prob += v <= t_sum,               f"{tag}_b"
                        prob += v >= f_sum + t_sum - 1,   f"{tag}_c"
                        terms.append(sc * v)

            elif rt == "consecutive_same":
                period_shifts = self._resolve_group(p.get("period", ""))
                if not period_shifts:
                    continue
                for nurse in self.nurses:
                    nid = nurse["id"]
                    for d, d1 in month_day_pairs:
                        g1 = pulp.lpSum(x[nid][d][s]  for s in period_shifts if s in self.ALL_SHIFTS)
                        g2 = pulp.lpSum(x[nid][d1][s] for s in period_shifts if s in self.ALL_SHIFTS)
                        tag = f"cs{rid}_{nid}_{d}"
                        v = pulp.LpVariable(tag, cat="Binary")
                        prob += v <= g1,           f"{tag}_a"
                        prob += v <= g2,           f"{tag}_b"
                        prob += v >= g1 + g2 - 1,  f"{tag}_c"
                        terms.append(sc * v)

            elif rt == "pattern":
                pattern = p.get("pattern", [])
                n_steps = len(pattern)
                if n_steps < 2:
                    continue
                groups = [self._resolve_group(g) for g in pattern]
                if any(not g for g in groups):
                    continue
                for nurse in self.nurses:
                    nid = nurse["id"]
                    for start_d in month_days:
                        # 연속 n_steps 날짜가 모두 당월 연속일인지 확인
                        window = [start_d + k for k in range(n_steps)]
                        if any(w >= len(self.all_dates) for w in window):
                            continue
                        if any(w not in month_days for w in window):
                            continue
                        if window[-1] != window[0] + n_steps - 1:
                            continue
                        sums = [
                            pulp.lpSum(x[nid][window[k]][s]
                                       for s in groups[k] if s in self.ALL_SHIFTS)
                            for k in range(n_steps)
                        ]
                        tag = f"pat{rid}_{nid}_{start_d}"
                        v = pulp.LpVariable(tag, cat="Binary")
                        for k, s_expr in enumerate(sums):
                            prob += v <= s_expr,           f"{tag}_le{k}"
                        prob += v >= pulp.lpSum(sums) - (n_steps - 1), f"{tag}_ge"
                        terms.append(sc * v)

            elif rt == "wish":
                for nurse in self.nurses:
                    nid = nurse["id"]
                    for day_str, wish_shift in nurse.get("wishes", {}).items():
                        try:
                            wish_date = date(self.year, self.month, int(day_str))
                            if wish_date not in self.date_to_idx:
                                continue
                            d = self.date_to_idx[wish_date]
                            if wish_shift == "OFF":
                                terms.append(sc * pulp.lpSum(
                                    x[nid][d][s] for s in self.REST_SHIFTS + self.LEAVE_SHIFTS))
                            elif wish_shift in self.ALL_SHIFTS:
                                terms.append(sc * x[nid][d][wish_shift])
                        except (ValueError, KeyError):
                            pass

            elif rt == "night_fairness":
                if len(self.nurses) >= 2:
                    night_counts = {
                        nurse["id"]: pulp.lpSum(
                            x[nurse["id"]][d][s]
                            for d in month_days
                            for s in self.NIGHT_SHIFTS
                        )
                        for nurse in self.nurses
                    }
                    max_n = pulp.LpVariable(f"max_nights_{rid}", lowBound=0, cat="Integer")
                    min_n = pulp.LpVariable(f"min_nights_{rid}", lowBound=0, cat="Integer")
                    for nurse in self.nurses:
                        nid = nurse["id"]
                        prob += max_n >= night_counts[nid], f"max_n_{rid}_{nid}"
                        prob += min_n <= night_counts[nid], f"min_n_{rid}_{nid}"
                    range_var = pulp.LpVariable(f"night_range_{rid}", lowBound=0, cat="Integer")
                    prob += range_var >= max_n - min_n, f"night_range_def_{rid}"
                    terms.append(sc * range_var)

        return pulp.lpSum(terms)

    def _compute_nurse_scores(self, schedule: Dict) -> Dict[str, int]:
        """
        확정된 스케줄에서 간호사별 소프트 제약 점수를 계산.
        scoring_rules 기반 동적 계산. 높을수록 좋은 스케줄.
        """
        import calendar as _cal
        month_days_count = _cal.monthrange(self.year, self.month)[1]
        month_dates = [date(self.year, self.month, d) for d in range(1, month_days_count + 1)]
        dt_keys = [dt.strftime("%Y-%m-%d") for dt in month_dates]

        scores = {nurse["id"]: 0 for nurse in self.nurses}

        for rule in self.scoring_rules:
            rt = rule.rule_type
            p  = rule.params
            sc = rule.score

            if rt == "specific_shift":
                code = p.get("shift_code", "")
                cond = p.get("condition", "all")
                if code not in self.ALL_SHIFTS:
                    continue
                for nurse in self.nurses:
                    nid = nurse["id"]
                    if cond == "female_only" and nurse.get("gender") != "female":
                        continue
                    ns = schedule.get(nid, {})
                    for dk in dt_keys:
                        if ns.get(dk) == code:
                            scores[nid] += sc

            elif rt == "transition":
                from_shifts = set(self._resolve_group(p.get("from", "")))
                to_shifts   = set(self._resolve_group(p.get("to", "")))
                if not from_shifts or not to_shifts:
                    continue
                for nurse in self.nurses:
                    nid = nurse["id"]
                    ns = schedule.get(nid, {})
                    for i in range(len(dt_keys) - 1):
                        s1 = ns.get(dt_keys[i], "")
                        s2 = ns.get(dt_keys[i + 1], "")
                        if s1 in from_shifts and s2 in to_shifts:
                            scores[nid] += sc

            elif rt == "consecutive_same":
                period_shifts = set(self._resolve_group(p.get("period", "")))
                if not period_shifts:
                    continue
                for nurse in self.nurses:
                    nid = nurse["id"]
                    ns = schedule.get(nid, {})
                    for i in range(len(dt_keys) - 1):
                        s1 = ns.get(dt_keys[i], "")
                        s2 = ns.get(dt_keys[i + 1], "")
                        if s1 in period_shifts and s2 in period_shifts:
                            scores[nid] += sc

            elif rt == "pattern":
                pattern = p.get("pattern", [])
                n_steps = len(pattern)
                if n_steps < 2:
                    continue
                groups = [set(self._resolve_group(g)) for g in pattern]
                if any(not g for g in groups):
                    continue
                for nurse in self.nurses:
                    nid = nurse["id"]
                    ns = schedule.get(nid, {})
                    for i in range(len(dt_keys) - n_steps + 1):
                        window_shifts = [ns.get(dt_keys[i + k], "") for k in range(n_steps)]
                        if all(window_shifts[k] in groups[k] for k in range(n_steps)):
                            scores[nid] += sc

            elif rt == "wish":
                for nurse in self.nurses:
                    nid = nurse["id"]
                    ns = schedule.get(nid, {})
                    for day_str, wish_shift in nurse.get("wishes", {}).items():
                        try:
                            day_num = int(day_str)
                            dk = date(self.year, self.month, day_num).strftime("%Y-%m-%d")
                            if dk not in dt_keys:
                                continue
                            s = ns.get(dk, "")
                            if wish_shift == "OFF" and s in self.REST_SHIFTS + self.LEAVE_SHIFTS:
                                scores[nid] += sc
                            elif s == wish_shift:
                                scores[nid] += sc
                        except (ValueError, KeyError):
                            pass
            # night_fairness는 개인 점수에 미포함 (전체 지표)

        return scores

    # ── Infeasible 진단 ──────────────────────────────────────────────────────

    def _diagnose_infeasibility(self) -> str:
        """
        제약을 단계적으로 추가하면서 어느 조건이 Infeasible을 만드는지 찾아 반환.
        빠른 진단을 위해 각 단계는 timeLimit=10초만 사용.
        """
        QUICK = pulp.HiGHS(timeLimit=10, msg=False)
        N = len(self.nurses)
        req_dict = self.req.model_dump()

        def _try(prob) -> bool:
            prob.solve(QUICK)
            return pulp.LpStatus[prob.status] in ("Optimal", "Feasible")

        def _fresh_x():
            """prev_schedule 적용한 변수 재생성"""
            xx = {}
            for nurse in self.nurses:
                nid = nurse["id"]
                xx[nid] = {}
                for d in range(self.T):
                    dt_str = self.all_dates[d].strftime("%Y-%m-%d")
                    pre = self.prev.get(nid, {}).get(dt_str)
                    xx[nid][d] = {}
                    for s in self.ALL_SHIFTS:
                        if pre:
                            xx[nid][d][s] = pulp.LpVariable(
                                f"dx_{nid}_{d}_{s}",
                                lowBound=(1 if s == pre else 0),
                                upBound=(1 if s == pre else 0),
                                cat="Integer",
                            )
                        else:
                            xx[nid][d][s] = pulp.LpVariable(f"dx_{nid}_{d}_{s}", cat="Binary")
            return xx

        lines = ["근무표 생성 실패 - 원인 진단 결과:"]

        # ── Phase 1: 기본 (1근무/일 + 자격) ─────────────────────────────────
        p = pulp.LpProblem("diag1", pulp.LpMinimize)
        x = _fresh_x()
        self._c_one_shift_per_day(p, x)
        self._c_shift_eligibility(p, x)
        p += 0
        if not _try(p):
            lines.append("  [원인] prev_schedule에 알 수 없는 근무 코드가 포함되어 있습니다.")
            known = set(self.ALL_SHIFTS)
            bad = []
            for nurse in self.nurses:
                nid = nurse["id"]
                nname = nurse["name"]
                for d in range(self.T):
                    dt = self.all_dates[d]
                    if dt.month != self.month:
                        continue
                    dt_str = dt.strftime("%Y-%m-%d")
                    pre = self.prev.get(nid, {}).get(dt_str)
                    if pre and pre not in known:
                        bad.append(f"    · {nname}({nid}) {dt_str}: \"{pre}\" (현재 근무 목록에 없음)")
            if bad:
                lines.append("  문제가 된 항목:")
                lines.extend(bad[:10])
                if len(bad) > 10:
                    lines.append(f"    ... 외 {len(bad)-10}건")
            else:
                # 코드는 유효하지만 근무 자격(capable_shifts) 충돌 확인
                # day1·middle은 자격 체크 제외 (UI에 체크박스 없어 capable_shifts에 없어도 됨)
                eligible_check_set = set(
                    s["code"] for s in self._shifts
                    if s["period"] in ("day", "evening", "night")
                )
                cap_bad = []
                for nurse in self.nurses:
                    nid = nurse["id"]
                    nname = nurse["name"]
                    capable = set(nurse.get("capable_shifts", self.WORK_SHIFTS))
                    for d in range(self.T):
                        dt = self.all_dates[d]
                        if dt.month != self.month:
                            continue
                        dt_str = dt.strftime("%Y-%m-%d")
                        pre = self.prev.get(nid, {}).get(dt_str)
                        if pre and pre in eligible_check_set and pre not in capable:
                            cap_bad.append(
                                f"    · {nname}({nid}) {dt_str}: \"{pre}\" "
                                f"(해당 간호사의 가능 근무 목록에 없음)"
                            )
                if cap_bad:
                    lines[-1] = "  [원인] 사전입력 근무가 간호사 자격과 충돌합니다."
                    lines.append("  문제가 된 항목:")
                    lines.extend(cap_bad[:10])
                    if len(cap_bad) > 10:
                        lines.append(f"    ... 외 {len(cap_bad)-10}건")
                else:
                    lines.append("  (원인 불명: 사전입력을 초기화하거나 간호사/규칙 설정을 확인해 주세요.)")
            return "\n".join(lines)

        # ── Phase 2: 일별 인원 요구사항 ──────────────────────────────────────
        p = pulp.LpProblem("diag2", pulp.LpMinimize)
        x = _fresh_x()
        self._c_one_shift_per_day(p, x)
        self._c_shift_eligibility(p, x)
        self._c_daily_requirements(p, x)
        p += 0
        if not _try(p):
            # 어느 날짜가 문제인지 찾기
            short_days = []
            for d, dt in enumerate(self.all_dates):
                if dt.month != self.month:
                    continue
                wk = WEEKDAY_KEYS[dt.weekday()]
                day_req = req_dict.get(wk, {})
                # prev_schedule로 사용 불가한 인원 계산
                fixed_rest = sum(
                    1 for nurse in self.nurses
                    if self.prev.get(nurse["id"], {}).get(dt.strftime("%Y-%m-%d"), "")
                    in (self.LEAVE_SHIFTS + self.REST_SHIFTS)
                )
                avail = N - fixed_rest
                needed = sum(day_req.get(p_, 0) for p_ in ["D", "E", "N"])
                if avail < needed:
                    short_days.append(
                        f"    {dt.strftime('%m/%d')}({['월','화','수','목','금','토','일'][dt.weekday()]}): "
                        f"필요 {needed}명, 가용 {avail}명"
                    )
            lines.append("  [원인] 일별 인원 부족 - 다음 날짜에 근무 가능 인원이 부족합니다:")
            lines.extend(short_days[:5])
            if len(short_days) > 5:
                lines.append(f"    ... 외 {len(short_days)-5}일")
            return "\n".join(lines)

        # ── Phase 3: Charge 요구사항 ─────────────────────────────────────────
        p = pulp.LpProblem("diag3", pulp.LpMinimize)
        x = _fresh_x()
        self._c_one_shift_per_day(p, x)
        self._c_shift_eligibility(p, x)
        self._c_daily_requirements(p, x)
        self._c_charge_requirements(p, x)
        p += 0
        if not _try(p):
            lines.append("  [원인] Charge 인원 부족 - DC/EC/NC 배정 가능한 간호사가 일부 날짜에 부족합니다.")
            lines.append("    해결: 더 많은 간호사에게 DC/EC/NC 근무 자격을 부여하세요.")
            return "\n".join(lines)

        # ── Phase 4: 역순 전환 금지 ──────────────────────────────────────────
        p = pulp.LpProblem("diag4", pulp.LpMinimize)
        x = _fresh_x()
        self._c_one_shift_per_day(p, x)
        self._c_shift_eligibility(p, x)
        self._c_daily_requirements(p, x)
        self._c_charge_requirements(p, x)
        self._c_forbidden_transitions(p, x)
        p += 0
        if not _try(p):
            lines.append("  [원인] prev_schedule에 E→D, N→E 또는 N→D 역순 전환이 포함되어 있습니다.")
            lines.append("    해결: 사전 고정된 근무 중 역순 패턴을 수정하세요.")
            return "\n".join(lines)

        # ── Phase 5: 주휴/OF ─────────────────────────────────────────────────
        p = pulp.LpProblem("diag5", pulp.LpMinimize)
        x = _fresh_x()
        self._c_one_shift_per_day(p, x)
        self._c_shift_eligibility(p, x)
        self._c_daily_requirements(p, x)
        self._c_charge_requirements(p, x)
        self._c_forbidden_transitions(p, x)
        if self.rules.weeklyOff:
            self._c_weekly_off(p, x)
        p += 0
        if not _try(p):
            lines.append("  [원인] 주휴/OF 배정과 인원 요구사항이 충돌합니다.")
            DAY_KR = ["월", "화", "수", "목", "금", "토", "일"]

            # ── 원인 1: 같은 주에 OF 또는 주휴 중복 사전입력 ─────────────────
            dup_found = []
            for wi, (ws, we) in enumerate(self.weeks):
                week_dates = [self.all_dates[d].strftime("%Y-%m-%d") for d in range(ws, we + 1)]
                for nurse in self.nurses:
                    nid, nname = nurse["id"], nurse["name"]
                    prev_week = {dt: self.prev.get(nid, {}).get(dt, "") for dt in week_dates}
                    of_days  = [dt for dt, s in prev_week.items() if s == "OF"]
                    joo_days = [dt for dt, s in prev_week.items() if s == "주"]
                    if len(of_days) >= 2:
                        dup_found.append(
                            f"    · {nname}({nid}) {wi+1}주차: OF가 {len(of_days)}회 "
                            f"({', '.join(of_days)})"
                        )
                    if len(joo_days) >= 2:
                        dup_found.append(
                            f"    · {nname}({nid}) {wi+1}주차: 주휴가 {len(joo_days)}회 "
                            f"({', '.join(joo_days)})"
                        )
            if dup_found:
                lines.append("  [세부 원인] 같은 주에 OF 또는 주휴가 2회 이상 사전입력되었습니다.")
                lines.extend(dup_found[:10])
                lines.append("  → 해결: 해당 사전입력을 수정하세요.")
                return "\n".join(lines)

            # ── 원인 2: 휴가 + OF + 주휴 → 주 내 off가 너무 많아 슬랙 부족 ──
            lines.append("  [주차별 분석]")
            for wi, (ws, we) in enumerate(self.weeks):
                week_slots_needed = 0
                day_details = []
                total_extra_leave = 0  # 휴가(leave)로 고정된 슬롯 수
                for d in range(ws, we + 1):
                    dt = self.all_dates[d]
                    dt_str = dt.strftime("%Y-%m-%d")
                    is_cur_month = (dt.month == self.month)
                    wk = WEEKDAY_KEYS[dt.weekday()]
                    day_req = req_dict.get(wk, {})
                    needed = sum(day_req.get(pp, 0) for pp in ["D", "E", "N"]) if is_cur_month else 0
                    fixed_rest = sum(
                        1 for nurse in self.nurses
                        if self.prev.get(nurse["id"], {}).get(dt_str, "")
                        in (self.REST_SHIFTS + self.LEAVE_SHIFTS)
                    )
                    fixed_leave = sum(
                        1 for nurse in self.nurses
                        if self.prev.get(nurse["id"], {}).get(dt_str, "")
                        in self.LEAVE_SHIFTS
                    )
                    if is_cur_month:
                        week_slots_needed += needed
                        day_details.append((dt, needed, fixed_rest))
                    total_extra_leave += fixed_leave

                month_days_in_week = len(day_details)
                if month_days_in_week == 0:
                    continue

                # 가용 슬롯: 일수 비율로 OF+주휴 차감
                expected_off = N * 2 * month_days_in_week / 7
                week_avail = max(0, round(N * month_days_in_week - expected_off))

                # 휴가 고정으로 실제 슬랙이 줄어드는 효과 반영
                effective_avail = max(0, week_avail - total_extra_leave)
                tight = " ★빡빡" if week_slots_needed > effective_avail else ""

                start_dt = self.all_dates[ws]
                end_dt = self.all_dates[min(we, len(self.all_dates)-1)]
                leave_note = f", 휴가고정 {total_extra_leave}건" if total_extra_leave else ""
                lines.append(
                    f"    {wi+1}주차 ({start_dt.strftime('%m/%d')}~{end_dt.strftime('%m/%d')}): "
                    f"필요 {week_slots_needed}슬롯 / 가용 {effective_avail}슬롯{leave_note}{tight}"
                )
                # 해당 주에서 가장 빡빡한 날 상위 3개
                day_details_sorted = sorted(day_details, key=lambda x: x[1] - (N - x[2]), reverse=True)
                for dt, needed, fixed_off in day_details_sorted[:3]:
                    avail_day = N - fixed_off
                    flag = " ←부족" if needed > avail_day else ""
                    lines.append(
                        f"      {dt.strftime('%m/%d')}({DAY_KR[dt.weekday()]}): "
                        f"필요 {needed}명 / 가용 {avail_day}명{flag}"
                    )
            lines.append("  → 해결: 간호사를 늘리거나 요일별 필요 인원을 줄이세요.")
            return "\n".join(lines)

        # ── Phase 6: 연속 근무/야간 제한 ────────────────────────────────────
        p = pulp.LpProblem("diag6", pulp.LpMinimize)
        x = _fresh_x()
        self._c_one_shift_per_day(p, x)
        self._c_shift_eligibility(p, x)
        self._c_daily_requirements(p, x)
        self._c_charge_requirements(p, x)
        self._c_forbidden_transitions(p, x)
        if self.rules.weeklyOff:
            self._c_weekly_off(p, x)
        if self.rules.maxConsecutiveWork:
            self._c_max_consecutive_work(p, x, self.rules.maxConsecutiveWorkDays)
        if self.rules.maxConsecutiveNight:
            self._c_max_consecutive_night(p, x, self.rules.maxConsecutiveNightDays)
        p += 0
        if not _try(p):
            lines.append(
                f"  [원인] 연속 근무 제한이 너무 엄격합니다.\n"
                f"    현재 설정: 연속 근무 최대 {self.rules.maxConsecutiveWorkDays}일, "
                f"연속 야간 최대 {self.rules.maxConsecutiveNightDays}일\n"
                "    해결: 규칙 설정에서 연속 근무 일수를 늘리세요."
            )
            return "\n".join(lines)

        # ── Phase 7: V 월 최대 횟수 ─────────────────────────────────────────
        p = pulp.LpProblem("diag7", pulp.LpMinimize)
        x = _fresh_x()
        self._c_one_shift_per_day(p, x)
        self._c_shift_eligibility(p, x)
        self._c_daily_requirements(p, x)
        self._c_charge_requirements(p, x)
        self._c_forbidden_transitions(p, x)
        if self.rules.weeklyOff:
            self._c_weekly_off(p, x)
        if self.rules.maxConsecutiveWork:
            self._c_max_consecutive_work(p, x, self.rules.maxConsecutiveWorkDays)
        if self.rules.maxConsecutiveNight:
            self._c_max_consecutive_night(p, x, self.rules.maxConsecutiveNightDays)
        self._c_max_v_per_month(p, x)
        p += 0
        if not _try(p):
            over_v = [
                nurse["id"]
                for nurse in self.nurses
                if sum(
                    1 for dt in self.all_dates
                    if dt.month == self.month
                    and self.prev.get(nurse["id"], {}).get(dt.strftime("%Y-%m-%d")) == "V"
                ) > self.rules.maxVPerMonth
            ]
            lines.append(
                f"  [원인] V(연차) 초과 - 월 최대 {self.rules.maxVPerMonth}회 설정 초과.\n"
                + (f"    초과 간호사: {', '.join(over_v)}\n" if over_v else "")
                + "    해결: V 월 최대 횟수를 늘리거나 V 요청을 줄이세요."
            )
            return "\n".join(lines)

        # ── Phase 8: 야간전담 전용 제약 ─────────────────────────────────────
        night_nurses = [n for n in self.nurses if n.get("is_night_shift")]
        if night_nurses:
            p = pulp.LpProblem("diag8", pulp.LpMinimize)
            x = _fresh_x()
            self._c_one_shift_per_day(p, x)
            self._c_shift_eligibility(p, x)
            self._c_daily_requirements(p, x)
            self._c_charge_requirements(p, x)
            self._c_forbidden_transitions(p, x)
            if self.rules.weeklyOff:
                self._c_weekly_off(p, x)
            if self.rules.maxConsecutiveWork:
                self._c_max_consecutive_work(p, x, self.rules.maxConsecutiveWorkDays)
            if self.rules.maxConsecutiveNight:
                self._c_max_consecutive_night(p, x, self.rules.maxConsecutiveNightDays)
            self._c_max_v_per_month(p, x)
            self._c_night_shift_nurses(p, x)
            p += 0
            if not _try(p):
                import calendar
                month_days = calendar.monthrange(self.year, self.month)[1]
                lines.append("  [원인] 야간전담 간호사 제약 충돌")
                lines.append(f"    야간전담 간호사 {len(night_nurses)}명: "
                             f"{', '.join(n['name'] for n in night_nurses)}")
                lines.append(f"    이 간호사들은 N/NC만 배정되므로, 나머지 {N - len(night_nurses)}명이")
                lines.append("    모든 D/E 시간대를 커버해야 합니다.")

                # ── 일별 D/E 부족 분석 ────────────────────────────────────
                regular_nurses = [n for n in self.nurses if not n.get("is_night_shift")]
                off_shifts = self.LEAVE_SHIFTS + self.REST_SHIFTS
                DAY_KR = ["월", "화", "수", "목", "금", "토", "일"]
                short_days = []
                for d, dt in enumerate(self.all_dates):
                    if dt.month != self.month:
                        continue
                    dt_str = dt.strftime("%Y-%m-%d")
                    wk = WEEKDAY_KEYS[dt.weekday()]
                    day_req = (self.per_day_req.get(dt_str) or req_dict.get(wk, {}))
                    d_req = day_req.get("D", 0)
                    e_req = day_req.get("E", 0)
                    de_req = d_req + e_req
                    if de_req == 0:
                        continue
                    # 정규 간호사 중 당일 휴가/휴무 사전고정된 인원 제외
                    fixed_off = sum(
                        1 for n in regular_nurses
                        if self.prev.get(n["id"], {}).get(dt_str, "") in off_shifts
                    )
                    avail = len(regular_nurses) - fixed_off
                    if avail < de_req:
                        short_days.append((dt, DAY_KR[dt.weekday()], d_req, e_req, de_req, avail))

                if short_days:
                    lines.append(f"    [D/E 인원 부족 날짜 — {len(short_days)}일]")
                    for dt, kr, d_req, e_req, de_req, avail in short_days[:10]:
                        lines.append(
                            f"      {dt.strftime('%m/%d')}({kr}): "
                            f"D={d_req}+E={e_req}={de_req}명 필요 / 정규간호사 가용 {avail}명 "
                            f"(부족 {de_req - avail}명)"
                        )
                    if len(short_days) > 10:
                        lines.append(f"      ... 외 {len(short_days)-10}일")
                else:
                    lines.append("    (단순 인원 부족이 아닌 복합 제약 충돌일 수 있습니다)")

                lines.append("    해결 방법:")
                lines.append("      1. 야간전담이 아닌 간호사를 추가하세요.")
                lines.append("      2. 부족한 날짜의 D/E 필요 인원을 줄이세요 (사전입력 탭 D/E 행 활용).")
                lines.append(f"      3. 현재 {month_days}일 달 — 야간전담 근무 범위(12~16일)를 확인하세요.")
                return "\n".join(lines)

        # ── Phase 9: Charge 시니어리티 ──────────────────────────────────────
        def _make_full_prob(name):
            pp = pulp.LpProblem(name, pulp.LpMinimize)
            xx = _fresh_x()
            self._c_one_shift_per_day(pp, xx)
            self._c_shift_eligibility(pp, xx)
            self._c_daily_requirements(pp, xx)
            self._c_charge_requirements(pp, xx)
            self._c_forbidden_transitions(pp, xx)
            if self.rules.weeklyOff:
                self._c_weekly_off(pp, xx)
            if self.rules.maxConsecutiveWork:
                self._c_max_consecutive_work(pp, xx, self.rules.maxConsecutiveWorkDays)
            if self.rules.maxConsecutiveNight:
                self._c_max_consecutive_night(pp, xx, self.rules.maxConsecutiveNightDays)
            self._c_max_v_per_month(pp, xx)
            self._c_night_shift_nurses(pp, xx)
            return pp, xx

        p, x = _make_full_prob("diag9")
        self._c_charge_seniority(p, x)
        p += 0
        if not _try(p):
            lines.append("  [원인] Charge 시니어리티 제약 충돌")
            lines.append("    야간전담 간호사의 seniority 순서와 NC 배정이 충돌합니다.")
            lines.append("    해결: 간호사 설정에서 seniority 값을 확인하거나 야간전담 간호사 설정을 검토하세요.")
            return "\n".join(lines)

        # ── Phase 10: N→OF→D 금지 ────────────────────────────────────────────
        if self.rules.noNOD:
            p, x = _make_full_prob("diag10")
            self._c_charge_seniority(p, x)
            self._c_nod_pattern(p, x)
            p += 0
            if not _try(p):
                # 사전입력 중 N→OF→D 패턴 탐색
                nod_found = []
                for nurse in self.nurses:
                    nid = nurse["id"]
                    prev_nurse = self.prev.get(nid, {})
                    dates_sorted = sorted(prev_nurse.keys())
                    for i in range(len(dates_sorted) - 2):
                        d0, d1, d2 = dates_sorted[i], dates_sorted[i+1], dates_sorted[i+2]
                        s0, s1, s2 = prev_nurse[d0], prev_nurse[d1], prev_nurse[d2]
                        if (s0 in self.NIGHT_SHIFTS and
                                s1 in self.REST_SHIFTS and
                                s2 in self.DAY_SHIFTS + self.DAY1_SHIFTS):
                            nod_found.append(f"    · {nurse['name']}: {d0}({s0}) → {d1}({s1}) → {d2}({s2})")
                lines.append("  [원인] N→OF→D 금지 규칙 충돌 (야간전담 + 일반 간호사 패턴)")
                if nod_found:
                    lines.append("  사전입력에서 발견된 N→OF→D 패턴:")
                    lines.extend(nod_found[:5])
                else:
                    lines.append("  야간전담 간호사의 야간 후 휴무 패턴이 일반 간호사 D 배정과 충돌합니다.")
                    lines.append("  해결: 규칙 설정에서 'N→OF→D 금지' 를 해제해보세요.")
                return "\n".join(lines)

        # ── Phase 11: 생리휴가 ───────────────────────────────────────────────
        p, x = _make_full_prob("diag11")
        self._c_charge_seniority(p, x)
        if self.rules.noNOD:
            self._c_nod_pattern(p, x)
        self._c_menstrual_leave(p, x)
        p += 0
        if not _try(p):
            lines.append("  [원인] 생리휴가 제약 충돌")
            lines.append("  해결: 사전입력에서 생리휴가(생) 입력을 확인하거나 규칙을 검토하세요.")
            return "\n".join(lines)

        # ── 원인 불명 ────────────────────────────────────────────────────────
        lines.append("  [원인 불명] 개별 제약은 통과하지만 전체 조합이 Infeasible입니다.")
        lines.append("    시간이 지나도 해를 찾지 못했을 수 있습니다 (타임아웃).")
        lines.append("    해결: 간호사를 추가하거나 일부 제약을 완화해보세요.")
        return "\n".join(lines)

    # ── 결과 추출 ────────────────────────────────────────────────────────────

    def _extract_solution(
        self, x: Dict
    ) -> Tuple[Dict[str, Dict[str, str]], Dict[str, Dict[str, str]]]:
        """
        Returns:
            schedule: {nurse_id: {YYYY-MM-DD: shift}} 당월만
            extended: {nurse_id: {YYYY-MM-DD: shift}} 전체 (인접 월 포함)
        """
        schedule: Dict[str, Dict[str, str]] = defaultdict(dict)
        extended: Dict[str, Dict[str, str]] = defaultdict(dict)

        for nurse in self.nurses:
            nid = nurse["id"]
            for d, dt in enumerate(self.all_dates):
                dt_str = dt.strftime("%Y-%m-%d")
                assigned = self.REST_SHIFTS[0] if self.REST_SHIFTS else "OF"
                for s in self.ALL_SHIFTS:
                    val = pulp.value(x[nid][d][s])
                    if val is not None and round(val) == 1:
                        assigned = s
                        break
                extended[nid][dt_str] = assigned
                if dt.month == self.month and dt.year == self.year:
                    schedule[nid][dt_str] = assigned

        return dict(schedule), dict(extended)
