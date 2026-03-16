"""
간호사 스케줄러 v2 - HiGHS MIP 엔진
CP-SAT(OR-Tools) 대신 PuLP + HiGHS Mixed Integer Programming 사용
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

import pulp

from .models import GenerateRequest, Nurse, Requirements, Rules


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

# 목적함수 가중치
W_DN_PENALTY      = 30   # D→N 연속 기피 (개인 선호 soft, 간격은 충분)
W_N_GONG_PENALTY  = 40   # N/NC → 공 전환 페널티 (공 전날 야간 배정 회피)
W_V_PENALTY       = 500  # V(연차) 사용 페널티
W_MENSTRUAL_REW   = 80   # 생리휴가 배정 보상 (여성 간호사 1회 권장)
W_FORWARD_REWARD  = 20   # 순방향 전환 보상 (D→E, E→N)
W_SAME_SHIFT_REW  = 15   # 연속 동일근무 보상
W_REST_PAIR_REW   = 30   # 연속 휴일 보상
W_WISH_REWARD     = 50   # 희망 근무 보상


class NurseScheduler:
    def __init__(self, request: GenerateRequest):
        self.year  = request.year
        self.month = request.month
        self.nurses: List[Dict] = [n.model_dump() for n in request.nurses]
        self.req   = request.requirements
        self.rules = request.rules
        self.prev  = request.prev_schedule or {}

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

        # ── Objective (Soft Constraints) ─────────────────────────────────────

        obj = self._build_objective(prob, x)
        prob += obj

        # ── Solve ─────────────────────────────────────────────────────────────

        solver = pulp.HiGHS(
            timeLimit=600,
            msg=False,
        )
        status = prob.solve(solver)

        if pulp.LpStatus[prob.status] in ("Optimal", "Feasible"):
            schedule, extended = self._extract_solution(x)
            return {
                "success": True,
                "schedule": schedule,
                "extended_schedule": extended,
                "message": f"근무표가 생성되었습니다. (상태: {pulp.LpStatus[prob.status]})",
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
        """간호사별 가능한 근무만 배정"""
        for nurse in self.nurses:
            nid = nurse["id"]
            capable = set(nurse.get("capable_shifts", self.WORK_SHIFTS))
            # 불가능한 근무는 0으로 고정
            impossible = [s for s in self.WORK_SHIFTS if s not in capable]
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
            weekday_key = WEEKDAY_KEYS[dt.weekday()]
            day_req = req_dict.get(weekday_key, {})
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
            weekday_key = WEEKDAY_KEYS[dt.weekday()]
            day_req = req_dict.get(weekday_key, {})
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
            "day":     ("day", "day1"),
            "evening": ("evening", "middle"),
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
            for i_nurse in self.nurses:
                for j_nurse in self.nurses:
                    if i_nurse["id"] == j_nurse["id"]:
                        continue
                    if i_nurse.get("seniority", 0) <= j_nurse.get("seniority", 0):
                        continue
                    nid_i = i_nurse["id"]
                    nid_j = j_nurse["id"]
                    for charge_s, regulars in charge_regular_map.items():
                        for regular_s in regulars:
                            prob += (
                                x[nid_i][d][charge_s] + x[nid_j][d][regular_s] <= 1,
                                f"seniority_{nid_i}_{nid_j}_{d}_{charge_s}"
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
        주휴 요일은 prev_schedule(사전입력)로 고정되며, 스케줄러는 '주 1회' 제약만 유지.
        """
        for nurse in self.nurses:
            nid = nurse["id"]
            for ws, we in self.weeks:
                prob += (
                    pulp.lpSum(x[nid][d]["주"] for d in range(ws, we + 1)) == 1,
                    f"weekly_joo_{nid}_{ws}"
                )
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

    # ── 목적함수 (Soft Constraints) ──────────────────────────────────────────

    def _build_objective(self, prob, x) -> pulp.LpAffineExpression:
        """
        최대화 목적함수 구성.
        소프트 제약 보조변수는 당월 날짜 쌍에만 적용 (인접 월 제외) → 문제 크기 최소화.
        """
        terms = []

        # 당월 날짜 인덱스 목록
        month_days = [d for d, dt in enumerate(self.all_dates)
                      if dt.month == self.month and dt.year == self.year]
        month_day_pairs = [(month_days[i], month_days[i+1])
                           for i in range(len(month_days) - 1)
                           if month_days[i+1] == month_days[i] + 1]  # 연속일만

        for nurse in self.nurses:
            nid = nurse["id"]

            # ── V 페널티 / 생리휴가 보상 (당월만) ──────────────────────────────
            for d in month_days:
                if "V" in self.ALL_SHIFTS:
                    terms.append(-W_V_PENALTY * x[nid][d]["V"])
                if "생" in self.ALL_SHIFTS and nurse.get("gender") == "female":
                    terms.append(+W_MENSTRUAL_REW * x[nid][d]["생"])

            # ── 소프트 전환 보조변수 (당월 연속일 쌍만) ──────────────────────
            for d, d1 in month_day_pairs:
                # N/NC → 공 전환 페널티 (공 전날 야간 배정 회피)
                night_sum_d  = pulp.lpSum(x[nid][d][s]  for s in self.NIGHT_SHIFTS)
                gong_next    = x[nid][d1]["공"] if "공" in self.ALL_SHIFTS else pulp.lpSum([])
                ng = pulp.LpVariable(f"ng_{nid}_{d}", cat="Binary")
                prob += ng <= night_sum_d,             f"ng_a_{nid}_{d}"
                prob += ng <= gong_next,               f"ng_b_{nid}_{d}"
                prob += ng >= night_sum_d + gong_next - 1, f"ng_c_{nid}_{d}"
                terms.append(-W_N_GONG_PENALTY * ng)

                # D→N 전환 페널티
                if self.rules.avoidDN:
                    day_sum   = pulp.lpSum(x[nid][d][s]  for s in self.DAY_SHIFTS)
                    night_sum = pulp.lpSum(x[nid][d1][s] for s in self.NIGHT_SHIFTS)
                    dn = pulp.LpVariable(f"dn_{nid}_{d}", cat="Binary")
                    prob += dn <= day_sum,               f"dn_a_{nid}_{d}"
                    prob += dn <= night_sum,              f"dn_b_{nid}_{d}"
                    prob += dn >= day_sum + night_sum - 1, f"dn_c_{nid}_{d}"
                    terms.append(-W_DN_PENALTY * dn)

                # 순방향 전환 보상 (D→E, E→N)
                if self.rules.patternOptimization:
                    for fg, sg, tag in [
                        (self.DAY_SHIFTS, self.EVENING_SHIFTS, "de"),
                        (self.EVENING_SHIFTS, self.NIGHT_SHIFTS, "en"),
                    ]:
                        f_sum = pulp.lpSum(x[nid][d][s]  for s in fg)
                        s_sum = pulp.lpSum(x[nid][d1][s] for s in sg)
                        fwd = pulp.LpVariable(f"fwd_{nid}_{d}_{tag}", cat="Binary")
                        prob += fwd <= f_sum,             f"fwd_a_{nid}_{d}_{tag}"
                        prob += fwd <= s_sum,             f"fwd_b_{nid}_{d}_{tag}"
                        prob += fwd >= f_sum + s_sum - 1, f"fwd_c_{nid}_{d}_{tag}"
                        terms.append(W_FORWARD_REWARD * fwd)

                    # 연속 동일 시간대 보상
                    for group, tag in [(self.DAY_SHIFTS,"d"),(self.EVENING_SHIFTS,"e"),(self.NIGHT_SHIFTS,"n")]:
                        g1 = pulp.lpSum(x[nid][d][s]  for s in group)
                        g2 = pulp.lpSum(x[nid][d1][s] for s in group)
                        same = pulp.LpVariable(f"same_{nid}_{d}_{tag}", cat="Binary")
                        prob += same <= g1,          f"same_a_{nid}_{d}_{tag}"
                        prob += same <= g2,          f"same_b_{nid}_{d}_{tag}"
                        prob += same >= g1 + g2 - 1, f"same_c_{nid}_{d}_{tag}"
                        terms.append(W_SAME_SHIFT_REW * same)

                # 연속 휴일 보상
                r1 = pulp.lpSum(x[nid][d][s]  for s in self.REST_SHIFTS)
                r2 = pulp.lpSum(x[nid][d1][s] for s in self.REST_SHIFTS)
                rp = pulp.LpVariable(f"rp_{nid}_{d}", cat="Binary")
                prob += rp <= r1,          f"rp_a_{nid}_{d}"
                prob += rp <= r2,          f"rp_b_{nid}_{d}"
                prob += rp >= r1 + r2 - 1, f"rp_c_{nid}_{d}"
                terms.append(W_REST_PAIR_REW * rp)

        # ── 야간 공정 배분: range(max - min) 최소화 ─────────────────────────
        if len(self.nurses) >= 2:
            night_counts = {
                nurse["id"]: pulp.lpSum(
                    x[nurse["id"]][d][s]
                    for d in month_days
                    for s in self.NIGHT_SHIFTS
                )
                for nurse in self.nurses
            }
            max_n = pulp.LpVariable("max_nights", lowBound=0, cat="Integer")
            min_n = pulp.LpVariable("min_nights", lowBound=0, cat="Integer")
            for nurse in self.nurses:
                nid = nurse["id"]
                prob += max_n >= night_counts[nid], f"max_n_{nid}"
                prob += min_n <= night_counts[nid], f"min_n_{nid}"
            range_var = pulp.LpVariable("night_range", lowBound=0, cat="Integer")
            prob += range_var >= max_n - min_n, "night_range_def"
            terms.append(-50 * range_var)

        # ── 희망 근무 반영 ───────────────────────────────────────────────────
        for nurse in self.nurses:
            nid = nurse["id"]
            for day_str, wish_shift in nurse.get("wishes", {}).items():
                try:
                    wish_date = date(self.year, self.month, int(day_str))
                    if wish_date not in self.date_to_idx:
                        continue
                    d = self.date_to_idx[wish_date]
                    if wish_shift == "OFF":
                        terms.append(W_WISH_REWARD * pulp.lpSum(
                            x[nid][d][s] for s in self.REST_SHIFTS + self.LEAVE_SHIFTS))
                    elif wish_shift in self.ALL_SHIFTS:
                        terms.append(W_WISH_REWARD * x[nid][d][wish_shift])
                except (ValueError, KeyError):
                    pass

        return pulp.lpSum(terms)

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
            lines.append("  [원인] prev_schedule 충돌: 같은 날에 두 가지 근무가 고정되었습니다.")
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
            total_work = sum(
                sum(day_req.get(pp, 0) for pp in ["D", "E", "N"])
                for wk in WEEKDAY_KEYS
                for day_req in [req_dict.get(wk, {})]
            )
            lines.append("  [원인] 주휴/OF 배정과 인원 요구사항이 충돌합니다.")
            lines.append(f"    현재 간호사: {N}명, 주당 평균 필요 근무: {total_work/7:.1f}명/일")
            lines.append(f"    주 2회 휴무 시 실제 가용: {N * 5/7:.1f}명/일")
            # ── 주차별 상세 분석 ──────────────────────────────────────────────
            lines.append("  [주차별 분석]")
            DAY_KR = ["월", "화", "수", "목", "금", "토", "일"]
            for wi, (ws, we) in enumerate(self.weeks):
                week_slots_needed = 0
                day_details = []
                for d in range(ws, we + 1):
                    dt = self.all_dates[d]
                    if dt.month != self.month:
                        continue
                    wk = WEEKDAY_KEYS[dt.weekday()]
                    day_req = req_dict.get(wk, {})
                    needed = sum(day_req.get(pp, 0) for pp in ["D", "E", "N"])
                    # 해당 날 고정 휴무/휴가 인원
                    fixed_off = sum(
                        1 for nurse in self.nurses
                        if self.prev.get(nurse["id"], {}).get(dt.strftime("%Y-%m-%d"), "")
                        in (self.REST_SHIFTS + self.LEAVE_SHIFTS)
                    )
                    week_slots_needed += needed
                    day_details.append((dt, needed, fixed_off))

                month_days_in_week = len(day_details)
                if month_days_in_week == 0:
                    continue
                # 주 2회 휴무 → 주당 총 가용 근무슬롯
                week_avail = N * month_days_in_week - N * 2
                tight = " ★빡빡" if week_slots_needed > week_avail else ""
                start_dt = self.all_dates[ws]
                end_dt = self.all_dates[min(we, len(self.all_dates)-1)]
                lines.append(
                    f"    {wi+1}주차 ({start_dt.strftime('%m/%d')}~{end_dt.strftime('%m/%d')}): "
                    f"필요 {week_slots_needed}슬롯 / 가용 {week_avail}슬롯{tight}"
                )
                # 해당 주에서 가장 빡빡한 날 상위 3개 표시
                day_details_sorted = sorted(day_details, key=lambda x: x[1] - (N - x[2]), reverse=True)
                for dt, needed, fixed_off in day_details_sorted[:3]:
                    avail_day = N - fixed_off
                    flag = " ←부족" if needed > avail_day else ""
                    lines.append(
                        f"      {dt.strftime('%m/%d')}({DAY_KR[dt.weekday()]}): "
                        f"필요 {needed}명 / 가용 {avail_day}명{flag}"
                    )
            lines.append("    해결: 간호사를 늘리거나 요일별 필요 인원을 줄이세요.")
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
