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
from .scheduler_base import _SchedulerBase
from .scheduler_highs_constraints import _HighsConstraintsMixin
from .scheduler_highs_diagnosis import _HighsDiagnosisMixin


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



class NurseScheduler(_HighsConstraintsMixin, _HighsDiagnosisMixin, _SchedulerBase):
    def solve(self) -> Dict:
        if not self.nurses:
            return {"success": False, "message": "간호사가 등록되지 않았습니다.", "schedule": {}}

        nurse_ids = [n["id"] for n in self.nurses]
        prob = pulp.LpProblem("nurse_schedule", pulp.LpMaximize)

        # 변수 생성: x[nurse_id][day_idx][shift] ∈ {0,1} 또는 상수 0
        # 성능 최적화: 항상 0인 변수는 LpVariable 대신 정수 0 사용
        x: Dict[str, Dict[int, Dict[str, object]]] = {}
        _free_vars: list = []  # has_solution 스캔용 (Finding 5)
        for nurse in self.nurses:
            nid = nurse["id"]
            x[nid] = {}
            is_night = nurse.get("is_night_shift")
            is_male = nurse.get("gender") != "female"
            for d in range(self.T):
                dt = self.all_dates[d]
                dt_str = dt.strftime("%Y-%m-%d")
                x[nid][d] = {}
                pre = self.prev.get(nid, {}).get(dt_str)
                is_holiday = dt_str in self.holidays
                # 공휴일에 OF 사전입력은 무시 — 솔버가 유효한 근무(법/근무 등) 선택
                if pre == "OF" and is_holiday:
                    pre = None
                pre_flex = self._PRE_FLEX.get(pre, {pre} if pre else set())
                # 전입/전출일 범위 밖: 모든 shift 0으로 고정
                if not self._nurse_active_on(nurse, dt):
                    for s in self.ALL_SHIFTS:
                        x[nid][d][s] = 0
                    continue
                for s in self.ALL_SHIFTS:
                    # OF는 공휴일에 배정 불가 (하드 제약)
                    if s == "OF" and is_holiday:
                        x[nid][d][s] = 0
                        continue
                    if pre:
                        if s in pre_flex:
                            v = pulp.LpVariable(f"x_{nid}_{d}_{s}", cat="Binary")
                            x[nid][d][s] = v
                            _free_vars.append(v)
                        else:
                            x[nid][d][s] = 0
                    elif s == "법" and is_night:
                        x[nid][d][s] = 0
                    elif s == "법" and not is_holiday:
                        x[nid][d][s] = 0
                    elif s == "법" and is_holiday:
                        v = pulp.LpVariable(f"x_{nid}_{d}_{s}", cat="Binary")
                        x[nid][d][s] = v
                        _free_vars.append(v)
                    elif s in ("생", "V") and is_holiday and not is_night:
                        x[nid][d][s] = 0
                    elif s not in self.SOLVER_SHIFTS:
                        x[nid][d][s] = 0
                    elif s == "생" and is_male:
                        x[nid][d][s] = 0
                    else:
                        v = pulp.LpVariable(f"x_{nid}_{d}_{s}", cat="Binary")
                        x[nid][d][s] = v
                        _free_vars.append(v)

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
        if getattr(self.rules, 'restAfterNight', False):
            self._c_rest_after_night(prob, x)           # 연속야간 후 휴무 보장
        self._c_max_v_per_month(prob, x)               # V 월 최대 횟수
        if self.rules.maxNightPerMonth:
            self._c_max_night_per_month(prob, x)       # 월 최대 야간 횟수
        if self.rules.maxNightTwoMonth:
            self._c_max_night_two_month(prob, x)       # 홀짝월 합산 야간
        self._c_menstrual_leave(prob, x)
        self._c_night_shift_nurses(prob, x)            # 야간전담 전용 규칙

        # ── Objective (Soft Constraints) ─────────────────────────────────────

        obj = self._build_objective(prob, x)
        prob += obj

        # ── Solve ─────────────────────────────────────────────────────────────

        solver = pulp.HiGHS(
            timeLimit=self.time_limit,
            mip_rel_gap=self.mip_gap,
            msg=False,
        )
        try:
            status = prob.solve(solver)
        except Exception:
            # kInterrupt 등 PuLP가 매핑 못하는 상태 → status를 직접 확인
            pass

        status_str = pulp.constants.LpStatus.get(prob.status, "Unknown")

        # feasible solution 존재 여부 (최적화: free 변수만 스캔)
        has_solution = any(
            v.varValue is not None and v.varValue > 0.5
            for v in _free_vars
        )

        if status_str in ("Optimal", "Feasible") or (has_solution and status_str != "Infeasible"):
            schedule, extended = self._extract_solution(x, lambda v: pulp.value(v))
            nurse_scores, nurse_score_details = self._compute_nurse_scores(schedule)
            label = "중지" if status_str not in ("Optimal", "Feasible") else status_str
            return {
                "success": True,
                "schedule": schedule,
                "extended_schedule": extended,
                "nurse_scores": nurse_scores,
                "nurse_score_details": nurse_score_details,
                "message": f"근무표가 생성되었습니다. (상태: {label})",
                "estimated_seconds": self.estimate_seconds(),
            }
        elif status_str == "Infeasible":
            # ── 사전입력 완화 재시도 ────────────────────────────────────
            if self.allow_pre_relax and self.prev:
                relax_result = self._solve_with_relaxed_pre()
                if relax_result:
                    return relax_result
            # 즉시 판정된 Infeasible → 진단 실행 (각 단계 10초 이내)
            diagnosis = self._diagnose_infeasibility()
            return {
                "success": False,
                "schedule": {},
                "extended_schedule": {},
                "message": diagnosis,
            }
        else:
            # Not Solved = 타임아웃 또는 해 없이 중단
            if self.allow_pre_relax and self.prev:
                relax_result = self._solve_with_relaxed_pre()
                if relax_result:
                    return relax_result
            return {
                "success": False,
                "schedule": {},
                "extended_schedule": {},
                "message": (
                    f"제한 시간({self.time_limit//60}분) 내에 근무표를 완성하지 못했습니다.\n"
                    "힌트:\n"
                    "  · 간호사를 추가하거나 요일별 필요 인원을 줄여보세요.\n"
                    "  · 연속 근무/야간 일수 제한을 완화해보세요.\n"
                    "  · 사전 고정된 V/생 요청이 특정 날짜에 몰려 있지 않은지 확인하세요."
                ),
            }

    # ── 사전입력 완화 재시도 ──────────────────────────────────────────────────

    def _solve_with_relaxed_pre(self) -> Optional[Dict]:
        """
        사전입력을 소프트 제약(큰 보너스)으로 전환하여 재시도.
        성공 시 relaxed_cells 포함 결과 반환, 실패 시 None.
        """
        prob = pulp.LpProblem("nurse_schedule_relaxed", pulp.LpMaximize)
        pre_bonus_terms = []
        # 차등 보너스: 휴가(V/생/...)는 높게, 근무는 중간, 쉬는 날은 낮게
        PRE_BONUS_LEAVE = getattr(self.rules, 'preBonusLeave', 5000)
        PRE_BONUS_WORK = getattr(self.rules, 'preBonusWork', 500)
        PRE_BONUS_REST = getattr(self.rules, 'preBonusRest', 300)
        LEAVE_CODES = {"V", "생", "특", "공", "법", "병"}
        REST_CODES = {"OF", "주"}

        def _pre_bonus_for(code: str) -> int:
            if code in LEAVE_CODES:
                return PRE_BONUS_LEAVE
            if code in REST_CODES:
                return PRE_BONUS_REST
            return PRE_BONUS_WORK

        x: Dict[str, Dict[int, Dict[str, object]]] = {}
        _free_vars_r: list = []
        for nurse in self.nurses:
            nid = nurse["id"]
            x[nid] = {}
            is_night = nurse.get("is_night_shift")
            is_male = nurse.get("gender") != "female"
            for d in range(self.T):
                dt = self.all_dates[d]
                dt_str = dt.strftime("%Y-%m-%d")
                x[nid][d] = {}
                pre = self.prev.get(nid, {}).get(dt_str)
                is_holiday = dt_str in self.holidays
                # 공휴일에 OF 사전입력은 무시 — 완화 모드에서도 OF 재배치 대상
                if pre == "OF" and is_holiday:
                    pre = None
                # 전입/전출일 범위 밖: 모든 shift 0으로 고정
                if not self._nurse_active_on(nurse, dt):
                    for s in self.ALL_SHIFTS:
                        x[nid][d][s] = 0
                    continue
                # 잠긴 셀: 완화 모드에서도 사전입력 하드 고정 (보수교육 등)
                is_locked = bool(self.locked_cells.get(nid, {}).get(dt_str))
                if is_locked and pre:
                    for s in self.ALL_SHIFTS:
                        x[nid][d][s] = 1 if s == pre else 0
                    continue
                for s in self.ALL_SHIFTS:
                    # OF는 공휴일에 배정 불가 (하드 제약, 완화 모드 포함)
                    if s == "OF" and is_holiday:
                        x[nid][d][s] = 0
                        continue
                    # 주휴 처리
                    if pre == "주":
                        if self.allow_juhu_relax:
                            # 주휴 무시: 주 유지 or 근무 전환 허용, 단 주→OF 금지 (무의미)
                            if s == "OF":
                                x[nid][d][s] = 0
                            else:
                                v = pulp.LpVariable(f"r_{nid}_{d}_{s}", cat="Binary")
                                x[nid][d][s] = v
                                _free_vars_r.append(v)
                            continue
                        else:
                            x[nid][d][s] = 1 if s == "주" else 0
                            continue
                    # 법/생/V/성별/auto_assign 차단
                    if s == "법" and is_night:
                        x[nid][d][s] = 0
                    elif s == "법" and not is_holiday:
                        x[nid][d][s] = 0
                    elif s == "법" and is_holiday:
                        v = pulp.LpVariable(f"r_{nid}_{d}_{s}", cat="Binary")
                        x[nid][d][s] = v
                        _free_vars_r.append(v)
                    elif s in ("생", "V") and is_holiday and not is_night:
                        x[nid][d][s] = 0
                    elif s == "주" and self.allow_juhu_relax:
                        v = pulp.LpVariable(f"r_{nid}_{d}_{s}", cat="Binary")
                        x[nid][d][s] = v
                        _free_vars_r.append(v)
                    elif s not in self.SOLVER_SHIFTS and s != "법":
                        if pre and s == pre:
                            v = pulp.LpVariable(f"r_{nid}_{d}_{s}", cat="Binary")
                            x[nid][d][s] = v
                            _free_vars_r.append(v)
                        else:
                            x[nid][d][s] = 0
                    elif s == "생" and is_male:
                        x[nid][d][s] = 0
                    else:
                        v = pulp.LpVariable(f"r_{nid}_{d}_{s}", cat="Binary")
                        x[nid][d][s] = v
                        _free_vars_r.append(v)

                # 사전입력 보너스 (소프트: 유지하면 +종류별 차등 보너스)
                if pre:
                    pre_flex = self._PRE_FLEX.get(pre, {pre})
                    bonus_amount = _pre_bonus_for(pre)
                    for s in pre_flex:
                        v = x[nid][d].get(s)
                        if isinstance(v, pulp.LpVariable):
                            pre_bonus_terms.append(bonus_amount * v)

        # 제약 (동일)
        self._c_one_shift_per_day(prob, x)
        self._c_shift_eligibility(prob, x)
        self._c_daily_requirements(prob, x)
        self._c_charge_requirements(prob, x)
        self._c_charge_seniority(prob, x)
        self._c_forbidden_transitions(prob, x)
        if self.rules.noNOD:
            self._c_nod_pattern(prob, x)
        if self.rules.weeklyOff:
            self._c_weekly_off(prob, x)
        # 주휴 재배치: 주당 주휴 정확히 1개 하드 제약
        if self.allow_juhu_relax and "주" in self.ALL_SHIFTS:
            first_of_month = date(self.year, self.month, 1)
            for nurse in self.nurses:
                nid = nurse["id"]
                if nurse.get("is_night_shift"):
                    continue
                for ws, we in self.weeks:
                    week_days = [d for d in range(ws, we + 1)
                                 if self.all_dates[d] >= first_of_month]
                    if not week_days:
                        continue
                    if "주" in x[nid][week_days[0]]:
                        prob += (
                            pulp.lpSum(x[nid][d]["주"] for d in week_days) <= 1,
                            f"weekly_juhu_{nid}_{ws}"
                        )
        if self.rules.maxConsecutiveWork:
            self._c_max_consecutive_work(prob, x, self.rules.maxConsecutiveWorkDays)
        if self.rules.maxConsecutiveNight:
            self._c_max_consecutive_night(prob, x, self.rules.maxConsecutiveNightDays)
        if getattr(self.rules, 'restAfterNight', False):
            self._c_rest_after_night(prob, x)
        self._c_max_v_per_month(prob, x)
        if self.rules.maxNightPerMonth:
            self._c_max_night_per_month(prob, x)
        if self.rules.maxNightTwoMonth:
            self._c_max_night_two_month(prob, x)
        self._c_menstrual_leave(prob, x)
        self._c_night_shift_nurses(prob, x)

        # 목적함수: 기본 배점 + 사전입력 유지 보너스
        # 최소 침습(minimally invasive): 유지 보너스가 배점(scoring)을 '사전순(lexicographic)'으로
        # 지배하도록 스케일한다. 가장 작은 보너스(보통 휴식)조차 배점 총합을 넘게 만들어, 솔버가
        # '점수를 더 따려고' 사전입력을 바꾸는 일을 원천 차단한다. → 사전입력 변경은 오직
        # 실현가능성에 꼭 필요할 때만, 그리고 그때도 휴식<근무<휴가 순으로 최소한만 일어난다.
        obj = self._build_objective(prob, x)
        if pre_bonus_terms:
            scoring_bound = sum(abs(c) for c in obj.values())
            raw_min = min(PRE_BONUS_LEAVE, PRE_BONUS_WORK, PRE_BONUS_REST)
            dom = int(scoring_bound // max(1, raw_min)) + 2   # dom*raw_min > scoring_bound 보장
            prob += obj + dom * pulp.lpSum(pre_bonus_terms)
        else:
            prob += obj

        solver = pulp.HiGHS(timeLimit=self.time_limit, mip_rel_gap=self.mip_gap, msg=False)
        try:
            prob.solve(solver)
        except Exception:
            pass

        status_str = pulp.constants.LpStatus.get(prob.status, "Unknown")
        has_solution = any(
            v.varValue is not None and v.varValue > 0.5
            for v in _free_vars_r
        )


        if status_str in ("Optimal", "Feasible") or (has_solution and status_str != "Infeasible"):
            schedule, extended = self._extract_solution(x, lambda v: pulp.value(v))
            nurse_scores, nurse_score_details = self._compute_nurse_scores(schedule)

            # 사전입력과 다르게 배정된 셀 찾기 (PRE_FLEX 내 변환은 제외)
            relaxed_cells: Dict[str, Dict[str, Dict[str, object]]] = {}
            leave_changed = 0
            for nid, days in self.prev.items():
                for dt_str, pre_shift in days.items():
                    assigned = schedule.get(nid, {}).get(dt_str)
                    if assigned and assigned != pre_shift:
                        pre_flex = self._PRE_FLEX.get(pre_shift, {pre_shift})
                        if assigned not in pre_flex:
                            is_leave = pre_shift in LEAVE_CODES
                            if is_leave:
                                leave_changed += 1
                            relaxed_cells.setdefault(nid, {})[dt_str] = {
                                "original": pre_shift,
                                "assigned": assigned,
                                "is_leave": is_leave,
                            }

            label = "중지" if status_str not in ("Optimal", "Feasible") else status_str
            relax_count = sum(len(v) for v in relaxed_cells.values())
            other_changed = relax_count - leave_changed
            # 투명성: 무엇을 얼마나 바꿨는지 + 휴가 변경은 별도 경고
            if relax_count == 0:
                relax_msg = "사전입력을 그대로 유지했습니다."
            else:
                relax_msg = f"⚠ 최소 침습 완화: 휴식/근무 {other_changed}건 조정"
                if leave_changed:
                    relax_msg += f" · ⚠ 휴가 {leave_changed}건 변경(불가피 — 인원 추가/수요 감축 검토 권장)"
                relax_msg += "."
            return {
                "success": True,
                "schedule": schedule,
                "extended_schedule": extended,
                "nurse_scores": nurse_scores,
                "nurse_score_details": nurse_score_details,
                "relaxed_cells": relaxed_cells,
                "leave_relaxed_count": leave_changed,
                "message": f"근무표가 생성되었습니다. (상태: {label})\n{relax_msg}",
                "estimated_seconds": self.estimate_seconds(),
            }
        return None

    # ── 결과 추출 ────────────────────────────────────────────────────────────
