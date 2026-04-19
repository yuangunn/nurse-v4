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
        all_nurses: List[Dict] = [n.model_dump() for n in request.nurses]
        # 트레이니 분리: 종료일이 당월 1일 이전이면 자동 전환 (일반 간호사 취급)
        first_of_month = date(self.year, self.month, 1)
        self._all_nurses = all_nurses
        self._trainees = []
        self.nurses: List[Dict] = []
        for n in all_nurses:
            if not n.get("is_trainee"):
                self.nurses.append(n)
            else:
                end_str = n.get("training_end_date")
                if end_str:
                    try:
                        end_dt = date.fromisoformat(end_str)
                        if end_dt < first_of_month:
                            # 트레이닝 이미 종료 → 일반 간호사로 전환
                            self.nurses.append(n)
                            continue
                    except (ValueError, TypeError):
                        pass
                self._trainees.append(n)
        # 월별 야간전담: night_months에 설정이 있으면 해당 월만 사용, 없으면 is_night_shift 폴백
        month_key = f"{self.year}-{self.month:02d}"
        for nurse in self.nurses:
            nm = nurse.get("night_months", {})
            if nm:  # night_months에 하나라도 있으면 해당 월 기준
                nurse["is_night_shift"] = bool(nm.get(month_key, False))
            # nm이 비어있으면 기존 is_night_shift 유지
        self.req   = request.requirements
        self.rules = request.rules
        self.prev  = request.prev_schedule or {}
        self.per_day_req = request.per_day_requirements or {}
        self.prev_month_nights = request.prev_month_nights or {}
        self.locked_cells = request.locked_cells or {}  # {nurse_id: {date_str: true}} — 완화 시에도 고정
        self.mip_gap = request.mip_gap
        self.time_limit = request.time_limit
        # 법정공휴일: 당월 날짜만 필터링 (다른 달 공휴일은 무시)
        month_prefix = f"{self.year}-{self.month:02d}-"
        self.holidays = set(h for h in (request.holidays or []) if h.startswith(month_prefix))
        self.allow_pre_relax = request.allow_pre_relax
        self.allow_juhu_relax = request.allow_juhu_relax
        self.unlimited_v = request.unlimited_v

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
        # 솔버가 자유롭게 배정 가능한 근무 코드 집합 (auto_assign=True인 것만)
        self.SOLVER_SHIFTS  = set(s["code"] for s in shifts if s.get("auto_assign", True))

        # 배점 규칙 (enabled만 필터링)
        self.scoring_rules: List[ScoringRule] = [
            r for r in request.scoring_rules if r.enabled
        ]

        self._build_date_range()

        # prev_schedule 정규화:
        #  1) 유효한 nurse_id (현 간호사 목록 + 트레이니)만 통과 — 삭제된 간호사(유령) 제거
        #  2) 당월 날짜 범위만 통과 — 범위 밖 날짜 무시
        #  3) "/" 접두어는 트레이니 표시용이라 스트립 (프리셉터 근무가 자동 적용)
        valid_dates = set(dt.strftime("%Y-%m-%d") for dt in self.all_dates)
        valid_nurse_ids = set(n["id"] for n in self._all_nurses)
        def _normalize_pre(s: str) -> str:
            if not s:
                return s
            if s.startswith("/"):
                return ""
            return s
        self.prev = {
            nid: {dt: _normalize_pre(s) for dt, s in days.items()
                  if dt in valid_dates and _normalize_pre(s)}
            for nid, days in self.prev.items()
            if nid in valid_nurse_ids
        }
        # locked_cells도 동일하게 정규화 (유령 + 범위 밖 날짜 제거)
        self.locked_cells = {
            nid: {dt: v for dt, v in cells.items() if dt in valid_dates and v}
            for nid, cells in self.locked_cells.items()
            if nid in valid_nurse_ids
        }

    # ── 날짜 범위 계산 ────────────────────────────────────────────────────────

    # 주기 기준일 (2026-03-01 = 1주기 시작)
    _CYCLE_REF = date(2026, 3, 1)

    # 사전입력 유연화: D→D/DC, E→E/EC, N→N/NC (Charge 자동 배정 허용)
    _PRE_FLEX = {
        "D":  {"D", "DC"},
        "DC": {"D", "DC"},
        "E":  {"E", "EC"},
        "EC": {"E", "EC"},
        "N":  {"N", "NC"},
        "NC": {"N", "NC"},
    }

    def _cycle_day_offset(self, d: date) -> int:
        """기준일로부터의 일수 (주기 계산용)"""
        return (d - self._CYCLE_REF).days

    def _build_date_range(self):
        """대상 월을 포함하되 주기(7일 블록) 단위로 완성하는 범위 계산.
        - 시작: 1일이 속한 주기의 첫째 날
        - 종료: 말일이 속한 주기의 마지막 날
        예) 2026-03: 3/1(1주기 1일) ~ 4/4(5주기 7일)
        """
        first = date(self.year, self.month, 1)
        if self.month == 12:
            last = date(self.year + 1, 1, 1) - timedelta(days=1)
        else:
            last = date(self.year, self.month + 1, 1) - timedelta(days=1)

        # 주기 블록 시작으로 정렬 (7일 단위, _CYCLE_REF 기준)
        first_offset = self._cycle_day_offset(first)
        start_offset = first_offset - (first_offset % 7)
        self.schedule_start = self._CYCLE_REF + timedelta(days=start_offset)

        last_offset = self._cycle_day_offset(last)
        end_offset = last_offset + (6 - last_offset % 7)
        self.schedule_end = self._CYCLE_REF + timedelta(days=end_offset)

        self.all_dates: List[date] = []
        cur = self.schedule_start
        while cur <= self.schedule_end:
            self.all_dates.append(cur)
            cur += timedelta(days=1)

        self.T = len(self.all_dates)
        self.date_to_idx = {d: i for i, d in enumerate(self.all_dates)}

        # 완전한 주(주기) 목록 [(week_start_idx, week_end_idx), ...]
        self.weeks: List[Tuple[int, int]] = []
        for i in range(0, self.T, 7):
            if i + 6 < self.T:
                self.weeks.append((i, i + 6))

    # ── 전입/전출일 유틸리티 ─────────────────────────────────────────────────
    def _nurse_active_on(self, nurse: dict, dt: date) -> bool:
        """해당 날짜에 간호사가 재적 중인지 (전입일 ≤ dt ≤ 전출일)"""
        sd = nurse.get("start_date")
        ed = nurse.get("end_date")
        if sd:
            try:
                start = date.fromisoformat(sd)
                if dt < start:
                    return False
            except (ValueError, TypeError):
                pass
        if ed:
            try:
                end = date.fromisoformat(ed)
                if dt > end:
                    return False
            except (ValueError, TypeError):
                pass
        return True

    def _nurse_active_idx(self, nurse: dict, d: int) -> bool:
        """인덱스로 재적 여부 확인"""
        return self._nurse_active_on(nurse, self.all_dates[d])

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
        return int(min(self.time_limit, max(5, round(estimated))))

    # ── 메인 솔버 ────────────────────────────────────────────────────────────

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
            schedule, extended = self._extract_solution(x)
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
        obj = self._build_objective(prob, x)
        prob += obj + pulp.lpSum(pre_bonus_terms)

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
            schedule, extended = self._extract_solution(x)
            nurse_scores, nurse_score_details = self._compute_nurse_scores(schedule)

            # 사전입력과 다르게 배정된 셀 찾기
            relaxed_cells: Dict[str, Dict[str, Dict[str, str]]] = {}
            for nid, days in self.prev.items():
                for dt_str, pre_shift in days.items():
                    assigned = schedule.get(nid, {}).get(dt_str)
                    if assigned and assigned != pre_shift:
                        # D→DC 등 PRE_FLEX 내 변환은 relaxed로 안 봄
                        pre_flex = self._PRE_FLEX.get(pre_shift, {pre_shift})
                        if assigned not in pre_flex:
                            if nid not in relaxed_cells:
                                relaxed_cells[nid] = {}
                            relaxed_cells[nid][dt_str] = {
                                "original": pre_shift,
                                "assigned": assigned,
                            }

            label = "중지" if status_str not in ("Optimal", "Feasible") else status_str
            relax_count = sum(len(v) for v in relaxed_cells.values())
            return {
                "success": True,
                "schedule": schedule,
                "extended_schedule": extended,
                "nurse_scores": nurse_scores,
                "nurse_score_details": nurse_score_details,
                "relaxed_cells": relaxed_cells,
                "message": (
                    f"근무표가 생성되었습니다. (상태: {label})\n"
                    f"⚠ 사전입력 완화: {relax_count}건의 사전입력이 변경되었습니다."
                ),
                "estimated_seconds": self.estimate_seconds(),
            }
        return None

    # ── Hard Constraint 구현 ──────────────────────────────────────────────────

    def _c_one_shift_per_day(self, prob, x):
        """하루에 정확히 1개의 근무/휴무 (전입/전출 범위 밖은 제외)"""
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T):
                if not self._nurse_active_idx(nurse, d):
                    continue  # 재적 중 아님 → 제약 없음 (모든 변수 이미 0)
                prob += pulp.lpSum(x[nid][d][s] for s in self.ALL_SHIFTS) == 1, f"one_{nid}_{d}"

    def _add_weekly_juhu(self, prob, x):
        """주휴 재배치 시 주당 주휴 정확히 1개"""
        if not self.allow_juhu_relax or "주" not in self.ALL_SHIFTS:
            return
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
                        f"wj2_{nid}_{ws}"
                    )

    def _c_shift_eligibility(self, prob, x):
        """간호사별 가능한 근무만 배정.
        자격 체크는 day/evening/night period 근무에만 적용.
        day1(상근)·middle(중간번)은 누구나 배정 가능 — UI에 체크박스 없음.
        """
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
                    v = x[nid][d][s]
                    if isinstance(v, pulp.LpVariable):
                        prob += v == 0, f"elig_{nid}_{d}_{s}"

    def _c_daily_requirements(self, prob, x):
        """
        일별 시프트 인원 충족.
        요구사항은 D/E/N 시간대 총 인원 (charge 포함) + 추가 자동배정 근무.
          D=3 → DC+D 합계 == 3
          E=3 → EC+E 합계 == 3
          N=3 → NC+N 합계 == 3
          중=1 → 중 합계 == 1 (auto_assign이고 별도 코드인 경우)
        """
        req_dict = self.req.model_dump()
        # 기본 D/E/N 그룹
        period_map = {
            "D": self.DAY_SHIFTS,      # DC, D
            "E": self.EVENING_SHIFTS,   # EC, E
            "N": self.NIGHT_SHIFTS,     # NC, N
        }
        # auto_assign이고 D/E/N 그룹에 속하지 않는 근무 코드 → 개별 제약
        grouped_codes = set()
        for shifts in period_map.values():
            grouped_codes.update(shifts)
        for s in self._shifts:
            code = s["code"]
            if s.get("auto_assign", True) and code in self.SOLVER_SHIFTS and code not in grouped_codes:
                period_map[code] = [code]  # 예: 중 → [중]

        first_of_month = date(self.year, self.month, 1)
        for d, dt in enumerate(self.all_dates):
            if dt < first_of_month:
                continue
            date_key = dt.strftime('%Y-%m-%d')
            weekday_key = WEEKDAY_KEYS[dt.weekday()]
            base_req = req_dict.get(weekday_key, {})
            is_cur = (dt.month == self.month and dt.year == self.year)
            override = self.per_day_req.get(date_key, {}) if is_cur else {}
            day_req = {**base_req, **override} if override else base_req
            for period, shifts in period_map.items():
                required = day_req.get(period, 0)
                if required <= 0:
                    continue
                prob += (
                    pulp.lpSum(x[n["id"]][d][s] for n in self.nurses for s in shifts) == required,
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
        first_of_month = date(self.year, self.month, 1)
        for d, dt in enumerate(self.all_dates):
            # 이전달 overflow는 charge 제약 skip
            if dt < first_of_month:
                continue
            date_key = dt.strftime('%Y-%m-%d')
            weekday_key = WEEKDAY_KEYS[dt.weekday()]
            base_req = req_dict.get(weekday_key, {})
            is_cur = (dt.month == self.month and dt.year == self.year)
            override = self.per_day_req.get(date_key, {}) if is_cur else {}
            day_req = {**base_req, **override} if override else base_req
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

        # 성능 최적화: eligible pairs를 미리 계산 (O(N²) → 1회)
        eligible_pairs = []
        for i_nurse in self.nurses:
            for j_nurse in self.nurses:
                if i_nurse["id"] == j_nurse["id"]:
                    continue
                if i_nurse.get("seniority", 0) <= j_nurse.get("seniority", 0):
                    continue
                nid_i = i_nurse["id"]
                nid_j = j_nurse["id"]
                j_capable = set(j_nurse.get("capable_shifts", []))
                for charge_s, regulars in charge_regular_map.items():
                    if charge_s not in j_capable:
                        continue
                    eligible_pairs.append((nid_i, nid_j, charge_s, regulars))

        for d, dt in enumerate(self.all_dates):
            if dt.month != self.month:
                continue
            dt_str = dt.strftime("%Y-%m-%d")
            for nid_i, nid_j, charge_s, regulars in eligible_pairs:
                j_fixed = self.prev.get(nid_j, {}).get(dt_str)
                if j_fixed and j_fixed != charge_s:
                    continue
                v_charge = x[nid_i][d][charge_s]
                if not isinstance(v_charge, pulp.LpVariable):
                    continue
                for regular_s in regulars:
                    v_reg = x[nid_j][d][regular_s]
                    if not isinstance(v_reg, pulp.LpVariable):
                        continue
                    prob += (
                        v_charge + v_reg <= 1,
                        f"seniority_{nid_i}_{nid_j}_{d}_{charge_s}_{regular_s}"
                    )

    def _c_forbidden_transitions(self, prob, x):
        """
        물리적으로 불가능한 근무 전환 - 항상 금지 (토글 없음)
        E→D, N→E, N→D
        a + b <= 1  (두 변수 동시에 1이 될 수 없음)
        """
        forbidden = [
            (self.EVENING_SHIFTS, self.DAY_SHIFTS),     # E→D 금지 (22:00→06:00 = 8h)
            (self.EVENING_SHIFTS, self.DAY1_SHIFTS),     # E→D1 금지
            (self.EVENING_SHIFTS, self.MIDDLE_SHIFTS),   # E→중 금지 (22:00→11:00 = 13h)
            (self.NIGHT_SHIFTS,   self.EVENING_SHIFTS),  # N→E 금지
            (self.NIGHT_SHIFTS,   self.DAY_SHIFTS),      # N→D 금지
            (self.NIGHT_SHIFTS,   self.DAY1_SHIFTS),     # N→D1 금지
            (self.NIGHT_SHIFTS,   self.MIDDLE_SHIFTS),   # N→중 금지
            (self.MIDDLE_SHIFTS,  self.DAY_SHIFTS),      # 중→D 금지 (19:00→06:00 = 11h)
            (self.MIDDLE_SHIFTS,  self.DAY1_SHIFTS),     # 중→D1 금지 (19:00→08:30 = 13.5h)
        ]
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T - 1):
                for first_group, second_group in forbidden:
                    for s1 in first_group:
                        v1 = x[nid][d][s1]
                        if not isinstance(v1, pulp.LpVariable):
                            continue
                        for s2 in second_group:
                            v2 = x[nid][d + 1][s2]
                            if not isinstance(v2, pulp.LpVariable):
                                continue
                            prob += (
                                v1 + v2 <= 1,
                                f"forbid_{nid}_{d}_{s1}_{s2}"
                            )

    def _c_nod_pattern(self, prob, x):
        """N→휴무→D 금지: N/NC 다음날 REST_SHIFTS(OF, 주 등) 중 하나, 그 다음날 D/DC 금지"""
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T - 2):
                for ns in self.NIGHT_SHIFTS:
                    vn = x[nid][d][ns]
                    if not isinstance(vn, pulp.LpVariable):
                        continue
                    for rs in self.REST_SHIFTS:
                        vr = x[nid][d + 1][rs]
                        if not isinstance(vr, pulp.LpVariable):
                            continue
                        for ds in self.DAY_SHIFTS:
                            vd = x[nid][d + 2][ds]
                            if not isinstance(vd, pulp.LpVariable):
                                continue
                            prob += (
                                vn + vr + vd <= 2,
                                f"nod_{nid}_{d}_{ns}_{rs}_{ds}"
                            )

    def _c_weekly_off(self, prob, x):
        """
        각 완전한 주에 OF 1개.
        주휴(주)는 사전입력 전용이므로 솔버 제약 없음.
        야간전담 간호사는 OF 무제한.
        이전달 overflow 날짜는 제외 (다른 달 야간전담 상태의 사전입력이 있을 수 있음).
        """
        of_code = "OF"
        if of_code not in self.SOLVER_SHIFTS:
            return
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            is_night = nurse.get("is_night_shift", False)
            if is_night:
                continue
            for ws, we in self.weeks:
                # 이전달 overflow 제외 + 전입/전출 범위 밖 제외
                week_days = [d for d in range(ws, we + 1)
                             if self.all_dates[d] >= first_of_month
                             and self._nurse_active_idx(nurse, d)]
                if not week_days:
                    continue
                # 재적 기간이 일주일 전체가 아니면 OF 강제 안 함 (<=1로 완화)
                full_week = (we - ws + 1) == len(week_days) and ws >= 0
                if len(week_days) >= 7:
                    prob += (
                        pulp.lpSum(x[nid][d][of_code] for d in week_days) == 1,
                        f"weekly_of_{nid}_{ws}"
                    )
                else:
                    prob += (
                        pulp.lpSum(x[nid][d][of_code] for d in week_days) <= 1,
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

    def _c_rest_after_night(self, prob, x):
        """연속 야간 후 연속 휴무 보장.
        min_consec 이상 연속 야간 근무 후, rest_days 일간 근무 불가.
        제약: sum_N(d) + sum_N(d+1) - sum_N(d+2) + sum_W(d+k) <= 2
        """
        min_consec = getattr(self.rules, 'restAfterNightMinConsec', 2)
        rest_days = getattr(self.rules, 'restAfterNightDays', 2)
        for nurse in self.nurses:
            nid = nurse["id"]
            if nurse.get("is_night_shift"):
                continue  # 야간전담은 제외
            for d in range(self.T - min_consec):
                # 연속 야간 min_consec일 체크 (마지막 야간 다음날이 야간 아닐 때)
                night_sum = [
                    x[nid][d + i][s]
                    for i in range(min_consec)
                    for s in self.NIGHT_SHIFTS
                    if not isinstance(x[nid][d + i][s], (int, float))
                ]
                night_sum_fixed = sum(
                    x[nid][d + i][s]
                    for i in range(min_consec)
                    for s in self.NIGHT_SHIFTS
                    if isinstance(x[nid][d + i][s], (int, float))
                )
                if not night_sum and night_sum_fixed < min_consec:
                    continue  # 모든 변수가 고정이고 야간이 아님 → 스킵

                next_d = d + min_consec  # 연속야간 바로 다음날
                if next_d >= self.T:
                    continue
                # next_d가 야간이면 아직 연속 중이므로 패스 (다음 d에서 처리)
                night_next = [
                    x[nid][next_d][s]
                    for s in self.NIGHT_SHIFTS
                    if not isinstance(x[nid][next_d][s], (int, float))
                ]

                for k in range(rest_days):
                    rest_d = next_d + k
                    if rest_d >= self.T:
                        break
                    work_vars = [
                        x[nid][rest_d][s]
                        for s in self.WORK_SHIFTS
                        if s not in self.NIGHT_SHIFTS
                        and not isinstance(x[nid][rest_d][s], (int, float))
                    ]
                    if not work_vars:
                        continue
                    # sum_N(d..d+min_consec-1) - sum_N(next_d) + sum_W(rest_d) <= min_consec
                    lhs = pulp.lpSum(night_sum) + night_sum_fixed
                    if night_next:
                        lhs -= pulp.lpSum(night_next)
                    else:
                        # night_next 고정값 빼기
                        lhs -= sum(
                            x[nid][next_d][s]
                            for s in self.NIGHT_SHIFTS
                            if isinstance(x[nid][next_d][s], (int, float))
                        )
                    lhs += pulp.lpSum(work_vars)
                    prob += (
                        lhs <= min_consec,
                        f"rest_after_night_{nid}_{d}_{k}"
                    )

    def _c_max_v_per_month(self, prob, x):
        """V(연차) 당월 최대 사용 횟수 (hard constraint) + 익월에서 V 사용 금지
        unlimited_v=True일 때는 당월 V 상한 제거 (목적함수 페널티로 대체)"""
        max_v = self.rules.maxVPerMonth
        for nurse in self.nurses:
            nid = nurse["id"]
            # 당월 V 제한 (unlimited_v면 상한 제거)
            if max_v > 0 and not self.unlimited_v:
                v_vars = [
                    x[nid][d]["V"]
                    for d, dt in enumerate(self.all_dates)
                    if dt.month == self.month and dt.year == self.year
                ]
                if v_vars:
                    prob += pulp.lpSum(v_vars) <= max_v, f"max_v_{nid}"
            # 이전달 overflow: V 금지
            first_of_month = date(self.year, self.month, 1)
            for d, dt in enumerate(self.all_dates):
                if dt < first_of_month:
                    if "V" in self.ALL_SHIFTS:
                        prob += x[nid][d]["V"] == 0, f"no_v_overflow_{nid}_{d}"
            # 이후달 overflow: V 최대 1회
            next_v_vars = [
                x[nid][d]["V"]
                for d, dt in enumerate(self.all_dates)
                if (dt.month != self.month or dt.year != self.year) and dt >= first_of_month
            ]
            if next_v_vars:
                prob += pulp.lpSum(next_v_vars) <= 1, f"max_v_next_{nid}"

    def _c_max_night_per_month(self, prob, x):
        """월 최대 야간 횟수 제한 (수면OFF 최소화) — 야간전담 제외"""
        max_n = self.rules.maxNightPerMonthCount
        for nurse in self.nurses:
            if nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            night_vars = [
                x[nid][d][s]
                for d, dt in enumerate(self.all_dates)
                if dt.month == self.month and dt.year == self.year
                for s in self.NIGHT_SHIFTS
            ]
            if night_vars:
                prob += pulp.lpSum(night_vars) <= max_n, f"max_night_month_{nid}"

    def _c_max_night_two_month(self, prob, x):
        """홀짝월 합산 야간 제한 (이전달 야간 + 당월 야간 <= maxNightTwoMonthCount) — 야간전담 제외"""
        max_n = self.rules.maxNightTwoMonthCount
        prev_nights = getattr(self, 'prev_month_nights', None) or {}
        for nurse in self.nurses:
            if nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            prev_count = prev_nights.get(nid, 0)
            night_vars = [
                x[nid][d][s]
                for d, dt in enumerate(self.all_dates)
                if dt.month == self.month and dt.year == self.year
                for s in self.NIGHT_SHIFTS
            ]
            if night_vars:
                prob += pulp.lpSum(night_vars) <= max_n - prev_count, f"max_night_2mo_{nid}"

    def _c_menstrual_leave(self, prob, x):
        """생리휴가: 여성 간호사당 당월 최대 1회 + 익월에서 사용 금지"""
        if "생" not in self.ALL_SHIFTS:
            return
        for nurse in self.nurses:
            nid = nurse["id"]
            if nurse.get("gender") != "female":
                continue
            # 당월만 최대 1회 (항상 하드 제약)
            month_vars = [x[nid][d]["생"] for d, dt in enumerate(self.all_dates)
                          if dt.month == self.month and dt.year == self.year]
            if month_vars:
                prob += pulp.lpSum(month_vars) <= 1, f"menstrual_{nid}"
            # 이전달 overflow: 생 금지
            first_of_month = date(self.year, self.month, 1)
            for d, dt in enumerate(self.all_dates):
                if dt < first_of_month:
                    prob += x[nid][d]["생"] == 0, f"no_menstrual_overflow_{nid}_{d}"
            # 이후달 overflow: 생 최대 1회
            next_m_vars = [
                x[nid][d]["생"]
                for d, dt in enumerate(self.all_dates)
                if (dt.month != self.month or dt.year != self.year) and dt >= first_of_month
            ]
            if next_m_vars:
                prob += pulp.lpSum(next_m_vars) <= 1, f"max_menstrual_next_{nid}"

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
        month_idxs = [d for d, dt in enumerate(self.all_dates)
                      if dt.month == self.month and dt.year == self.year]

        # 야간 제외 근무 코드 목록 (휴무·휴가 제외, 근무 shift만)
        non_night_work = [
            s["code"] for s in self._shifts
            if s["period"] not in ("night", "rest", "leave")
        ]

        for nurse in night_nurses:
            nid = nurse["id"]

            # ── 1. N/NC 외 모든 근무 금지 (당월만, overflow 제외) ──────────
            for d in month_idxs:
                for s in non_night_work:
                    v = x[nid][d].get(s)
                    if isinstance(v, pulp.LpVariable):
                        prob += v == 0, f"night_only_{nid}_{d}_{s}"

            # ── 2. 5일 윈도우 <= 3 (당월 범위만) ─────────────────────────
            for start in range(month_idxs[0], month_idxs[-1] - 3):
                prob += (
                    pulp.lpSum(
                        x[nid][d][s]
                        for d in range(start, start + 5)
                        if d < self.T
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

            elif rt == "holiday_work":
                # 법정공휴일 근무 보상: 공휴일에 근무(WORK_SHIFTS)하면 가점
                for nurse in self.nurses:
                    nid = nurse["id"]
                    for d in month_days:
                        dt = self.all_dates[d]
                        if dt.strftime("%Y-%m-%d") in self.holidays:
                            for s in self.WORK_SHIFTS:
                                terms.append(sc * x[nid][d][s])

            elif rt == "weekend_work":
                # 주말 특정 시간대 근무 보상
                # params.slots: [{"weekday": 5, "periods": ["evening","night"]}, ...]
                slots = p.get("slots", [])
                for nurse in self.nurses:
                    nid = nurse["id"]
                    for d in month_days:
                        dt = self.all_dates[d]
                        wd = dt.weekday()  # 0=월 ~ 6=일
                        for slot in slots:
                            if wd == slot.get("weekday"):
                                target_shifts = []
                                for period in slot.get("periods", []):
                                    target_shifts.extend(self._resolve_group(period))
                                for s in target_shifts:
                                    if s in self.ALL_SHIFTS:
                                        terms.append(sc * x[nid][d][s])

            elif rt == "holiday_off":
                # 공휴일에 OF 부여 시 페널티
                if "OF" in self.ALL_SHIFTS:
                    for nurse in self.nurses:
                        nid = nurse["id"]
                        if nurse.get("is_night_shift"):
                            continue
                        for d in month_days:
                            dt = self.all_dates[d]
                            if dt.strftime("%Y-%m-%d") in self.holidays:
                                terms.append(sc * x[nid][d]["OF"])

        # ── 이후달 overflow V 사용 페널티 (scoring_rules 무관, 항상 적용) ────
        first_of_month = date(self.year, self.month, 1)
        overflow_days = [d for d, dt in enumerate(self.all_dates)
                         if (dt.month != self.month or dt.year != self.year) and dt >= first_of_month]
        if overflow_days and "V" in self.ALL_SHIFTS:
            for nurse in self.nurses:
                nid = nurse["id"]
                for d in overflow_days:
                    terms.append(-500 * x[nid][d]["V"])

        # ── V 무제한 모드: 점진적 페널티 (1번째 -500, 2번째 -1000, 3번째+ -5000) ──
        if self.unlimited_v and "V" in self.ALL_SHIFTS:
            for nurse in self.nurses:
                nid = nurse["id"]
                v_month = [x[nid][d]["V"] for d, dt in enumerate(self.all_dates)
                           if dt.month == self.month and dt.year == self.year]
                if not v_month:
                    continue
                v_total = pulp.lpSum(v_month)
                # v2 = max(0, v_total - 1): 2번째 이상 V 수
                v2 = pulp.LpVariable(f"v2_{nid}", lowBound=0, cat="Integer")
                prob += v2 >= v_total - 1, f"v2_ge_{nid}"
                # v3 = max(0, v_total - 2): 3번째 이상 V 수
                v3 = pulp.LpVariable(f"v3_{nid}", lowBound=0, cat="Integer")
                prob += v3 >= v_total - 2, f"v3_ge_{nid}"
                # 1번째: -500 (기존 specific_shift 규칙에서 처리)
                # 2번째: 추가 -500 (총 -1000)
                terms.append(-500 * v2)
                # 3번째+: 추가 -4000 (총 -5000)
                terms.append(-4000 * v3)

        # ── 생리휴가 2회 이상 방지 페널티 (항상 적용, 하드제약 <= 1과 별개 안전장치) ──
        if "생" in self.ALL_SHIFTS:
            for nurse in self.nurses:
                if nurse.get("gender") != "female":
                    continue
                nid = nurse["id"]
                m_vars = [x[nid][d]["생"] for d, dt in enumerate(self.all_dates)
                          if dt.month == self.month and dt.year == self.year]
                if not m_vars:
                    continue
                m_total = pulp.lpSum(m_vars)
                m2 = pulp.LpVariable(f"m2_{nid}", lowBound=0, cat="Integer")
                prob += m2 >= m_total - 1, f"m2_ge_{nid}"
                # 2회부터: -20000 (1회 +100 보상 대비 압도적 감점)
                terms.append(-20100 * m2)

        return pulp.lpSum(terms)

    def _compute_nurse_scores(self, schedule: Dict):
        """
        확정된 스케줄에서 간호사별 소프트 제약 점수를 계산.
        scoring_rules 기반 동적 계산. 높을수록 좋은 스케줄.
        Returns (scores: {nid: int}, details: {nid: [{name, rule_type, count, score_per, total}]})
        """
        import calendar as _cal
        month_days_count = _cal.monthrange(self.year, self.month)[1]
        month_dates = [date(self.year, self.month, d) for d in range(1, month_days_count + 1)]
        dt_keys = [dt.strftime("%Y-%m-%d") for dt in month_dates]

        scores = {nurse["id"]: 0 for nurse in self.nurses}
        # details: {nid: [{name, rule_type, count, score_per, total}]}
        details: Dict[str, list] = {nurse["id"]: [] for nurse in self.nurses}

        for rule in self.scoring_rules:
            rt = rule.rule_type
            p  = rule.params
            sc = rule.score

            # per-nurse count accumulator for this rule
            counts: Dict[str, int] = {nurse["id"]: 0 for nurse in self.nurses}

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
                            counts[nid] += 1

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
                            counts[nid] += 1

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
                            counts[nid] += 1

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
                            counts[nid] += 1

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
                                counts[nid] += 1
                            elif s == wish_shift:
                                scores[nid] += sc
                                counts[nid] += 1
                        except (ValueError, KeyError):
                            pass
            elif rt == "holiday_work":
                # 법정공휴일 근무 보상
                work_set = set(self.WORK_SHIFTS)
                for nurse in self.nurses:
                    nid = nurse["id"]
                    ns = schedule.get(nid, {})
                    for dk in dt_keys:
                        if dk in self.holidays and ns.get(dk, "") in work_set:
                            scores[nid] += sc
                            counts[nid] += 1

            elif rt == "weekend_work":
                # 주말 특정 시간대 근무 보상
                slots = p.get("slots", [])
                for nurse in self.nurses:
                    nid = nurse["id"]
                    ns = schedule.get(nid, {})
                    for i, dk in enumerate(dt_keys):
                        dt = month_dates[i]
                        wd = dt.weekday()
                        assigned = ns.get(dk, "")
                        for slot in slots:
                            if wd == slot.get("weekday"):
                                target_shifts = set()
                                for period in slot.get("periods", []):
                                    target_shifts.update(self._resolve_group(period))
                                if assigned in target_shifts:
                                    scores[nid] += sc
                                    counts[nid] += 1

            elif rt == "holiday_off":
                # 공휴일에 OF 부여 시 페널티
                for nurse in self.nurses:
                    nid = nurse["id"]
                    if nurse.get("is_night_shift"):
                        continue
                    ns = schedule.get(nid, {})
                    for dk in dt_keys:
                        if dk in self.holidays and ns.get(dk, "") == "OF":
                            scores[nid] += sc
                            counts[nid] += 1

            # night_fairness는 개인 점수에 미포함 (전체 지표)
            else:
                continue

            # counts가 0이 아닌 간호사에게만 detail 추가
            for nurse in self.nurses:
                nid = nurse["id"]
                c = counts[nid]
                if c != 0:
                    details[nid].append({
                        "name": rule.name,
                        "rule_type": rt,
                        "count": c,
                        "score_per": sc,
                        "total": c * sc,
                    })

        return scores, details

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

        _phase_counter = [0]
        def _fresh_x():
            """prev_schedule 적용한 변수 재생성 (공휴일/성별 차단 포함, zero→상수 0)"""
            _phase_counter[0] += 1
            pfx = f"d{_phase_counter[0]}"
            xx = {}
            for nurse in self.nurses:
                nid = nurse["id"]
                xx[nid] = {}
                is_night = nurse.get("is_night_shift")
                is_male = nurse.get("gender") != "female"
                for d in range(self.T):
                    dt_str = self.all_dates[d].strftime("%Y-%m-%d")
                    pre = self.prev.get(nid, {}).get(dt_str)
                    is_holiday = dt_str in self.holidays
                    # 공휴일에 OF 사전입력은 무시 (진단도 동일 규칙)
                    if pre == "OF" and is_holiday:
                        pre = None
                    pre_flex = self._PRE_FLEX.get(pre, {pre} if pre else set())
                    xx[nid][d] = {}
                    for s in self.ALL_SHIFTS:
                        # OF는 공휴일에 배정 불가 (하드 제약)
                        if s == "OF" and is_holiday:
                            xx[nid][d][s] = 0
                            continue
                        if pre:
                            if s in pre_flex:
                                xx[nid][d][s] = pulp.LpVariable(f"{pfx}_{nid}_{d}_{s}", cat="Binary")
                            else:
                                xx[nid][d][s] = 0
                        elif s == "생" and is_male:
                            xx[nid][d][s] = 0
                        elif s == "법" and is_night:
                            xx[nid][d][s] = 0
                        elif s == "법" and not is_holiday:
                            xx[nid][d][s] = 0
                        elif s == "법" and is_holiday:
                            xx[nid][d][s] = pulp.LpVariable(f"{pfx}_{nid}_{d}_{s}", cat="Binary")
                        elif s in ("생", "V") and is_holiday and not is_night:
                            xx[nid][d][s] = 0
                        else:
                            xx[nid][d][s] = pulp.LpVariable(f"{pfx}_{nid}_{d}_{s}", cat="Binary")
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
                        hint = " — 트레이니 표시용 코드, 사전입력에서 제거 필요" if pre.startswith("/") else " (현재 근무 목록에 없음)"
                        bad.append(f"    · {nname}({nid}) {dt_str}: \"{pre}\"{hint}")
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
            if self.holidays:
                lines.append(f"    ※ 법정공휴일 {len(self.holidays)}일 지정됨 — 공휴일에는 OF/생/V 배정이 차단됩니다.")
            DAY_KR = ["월", "화", "수", "목", "금", "토", "일"]

            # ── 원인 1: 같은 주에 OF 또는 주휴 중복 사전입력 ─────────────────
            dup_found = []
            first_of_month = date(self.year, self.month, 1)
            for wi, (ws, we) in enumerate(self.weeks):
                # 이전달 overflow 제외
                week_dates = [self.all_dates[d].strftime("%Y-%m-%d")
                              for d in range(ws, we + 1)
                              if self.all_dates[d] >= first_of_month]
                if not week_dates:
                    continue
                for nurse in self.nurses:
                    # 야간전담은 OF 무제한이므로 skip
                    if nurse.get("is_night_shift"):
                        continue
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
                lines.append("  [원인] 솔버가 실제 시도 후 실패 — 야간전담 설정 + 복합 제약 충돌")
                lines.append("    (strict 모드 + 완화 모드 양쪽 다 infeasible. 아래는 strict 기준 분석)")
                lines.append(f"    야간전담 간호사 {len(night_nurses)}명: "
                             f"{', '.join(n['name'] for n in night_nurses)}")
                lines.append(f"    이 간호사들은 N/NC만 배정되므로, 나머지 {N - len(night_nurses)}명이")
                lines.append("    모든 D/E 시간대를 커버해야 합니다.")

                # ── 일별 D/E 부족/압박 분석 ────────────────────────────────
                # 사전입력을 카테고리별로 분류해서 D/E 가용 인원을 정확히 계산
                regular_nurses = [n for n in self.nurses if not n.get("is_night_shift")]
                day_cover = set(self.DAY_SHIFTS)            # D, DC — D 요구 커버
                evening_cover = set(self.EVENING_SHIFTS)     # E, EC — E 요구 커버
                # 사전배정되면 D/E에 쓸 수 없는 근무들 (N/NC/D1/중 + 모든 휴무/휴가)
                busy_shifts = (set(self.NIGHT_SHIFTS) | set(self.DAY1_SHIFTS)
                               | set(self.MIDDLE_SHIFTS)
                               | set(self.REST_SHIFTS) | set(self.LEAVE_SHIFTS))
                DAY_KR = ["월", "화", "수", "목", "금", "토", "일"]
                day_rows = []
                for d, dt in enumerate(self.all_dates):
                    if dt.month != self.month:
                        continue
                    dt_str = dt.strftime("%Y-%m-%d")
                    wk = WEEKDAY_KEYS[dt.weekday()]
                    base_r = req_dict.get(wk, {})
                    ovr = self.per_day_req.get(dt_str, {})
                    day_req = {**base_r, **ovr} if ovr else base_r
                    d_req = day_req.get("D", 0)
                    e_req = day_req.get("E", 0)
                    if d_req + e_req == 0:
                        continue
                    pre_d = pre_e = pre_busy = 0
                    pre_relaxable = 0  # 완화 시 D/E로 전환 가능한 사전배정 수
                    relaxable_codes = set(self.REST_SHIFTS) | set(self.NIGHT_SHIFTS) \
                                      | set(self.DAY1_SHIFTS) | set(self.MIDDLE_SHIFTS) \
                                      | {"V"}  # OF/주/N/NC/D1/중/V는 이동 가능
                    # 고정성 강한 pre: 법(공휴일 귀속), 생(생리휴가), 공(공적업무), 특, 병
                    active_count = 0
                    for n in regular_nurses:
                        if not self._nurse_active_idx(n, d):
                            continue  # 재적 중 아님 (전출/미전입) → 제외
                        active_count += 1
                        pre = self.prev.get(n["id"], {}).get(dt_str, "")
                        if pre in day_cover:
                            pre_d += 1
                        elif pre in evening_cover:
                            pre_e += 1
                        elif pre in busy_shifts:
                            pre_busy += 1
                            if pre in relaxable_codes:
                                pre_relaxable += 1
                    free = active_count - pre_d - pre_e - pre_busy
                    # 아직 채워야 할 D/E 인원
                    still_d = max(0, d_req - pre_d)
                    still_e = max(0, e_req - pre_e)
                    still_need = still_d + still_e
                    shortage = still_need - free  # >0이면 부족
                    day_rows.append((dt, DAY_KR[dt.weekday()], d_req, e_req,
                                     pre_d, pre_e, pre_busy, free, still_need, shortage,
                                     pre_relaxable))

                # 부족한 날짜 우선, 없으면 여유 적은 순으로 top 10
                day_rows.sort(key=lambda r: (-r[9], -(r[8] - r[7] if r[7] else 0)))
                shortage_days = [r for r in day_rows if r[9] > 0]
                if shortage_days:
                    lines.append(f"    [D/E 인원 부족 날짜 — {len(shortage_days)}일]")
                    top = shortage_days[:10]
                else:
                    lines.append("    [D/E 여유 가장 적은 날짜 (직접 부족은 없지만 다른 제약과 충돌 가능)]")
                    top = day_rows[:10]
                for dt, kr, d_req, e_req, pre_d, pre_e, pre_busy, free, still_need, shortage, pre_relaxable in top:
                    parts = [f"필요 D={d_req}/E={e_req}"]
                    if pre_d or pre_e:
                        parts.append(f"사전배정 D={pre_d}/E={pre_e}")
                    if pre_busy:
                        parts.append(f"타근무/휴무 {pre_busy}명(완화가능 {pre_relaxable})")
                    parts.append(f"가용 {free}명")
                    parts.append(f"남은필요 {still_need}명")
                    if shortage > 0:
                        parts.append(f"▲부족 {shortage}명")
                        # 완화 모드에서 해결 가능한지 힌트
                        if pre_relaxable >= shortage:
                            parts.append(f"(완화 시 {pre_relaxable}명 이동 가능, 다른 제약과 충돌해 infeasible)")
                    lines.append(f"      {dt.strftime('%m/%d')}({kr}): " + ", ".join(parts))
                if len(top) < len(shortage_days):
                    lines.append(f"      ... 외 {len(shortage_days)-len(top)}일")

                # ── 주간 총량 검산 (주휴 1 + OF 1 의무 반영, 전입/전출 고려) ─────
                # 정규간호사별 주간 D/E 커버 가능량:
                #   active_days - (pre가 OF/주/N/D1/중/휴가/V/생 등 D/E 아닌 근무) -
                #   (주휴+OF 의무 중 pre로 아직 못 채운 잔여)
                # 부분 주는 active_days가 그만큼 작으므로 자동 반영 (의무 OF는 proportional).
                rest_shifts_set = set(self.REST_SHIFTS)  # OF, 주
                first_of_month = date(self.year, self.month, 1)
                week_warnings = []
                for wi, (ws, we) in enumerate(self.weeks):
                    week_dates_idx = [d for d in range(ws, we + 1)
                                      if self.all_dates[d] >= first_of_month]
                    if not week_dates_idx:
                        continue
                    week_len = len(week_dates_idx)
                    # 주간 D+E 수요
                    week_de_need = 0
                    for d in week_dates_idx:
                        dt = self.all_dates[d]
                        dt_str = dt.strftime("%Y-%m-%d")
                        wk = WEEKDAY_KEYS[dt.weekday()]
                        base_r = req_dict.get(wk, {})
                        ovr = self.per_day_req.get(dt_str, {})
                        day_req = {**base_r, **ovr} if ovr else base_r
                        week_de_need += day_req.get("D", 0) + day_req.get("E", 0)
                    # 정규간호사별 D/E 공급 합산
                    total_supply = 0
                    active_nurse_count = 0
                    for n in regular_nurses:
                        nid = n["id"]
                        active_days = sum(
                            1 for d in week_dates_idx
                            if self._nurse_active_idx(n, d)
                        )
                        if active_days == 0:
                            continue  # 이 주에 재적 안 함 → 전출/미전입
                        active_nurse_count += 1
                        pre_de = pre_off = pre_busy_non_off = 0
                        for d in week_dates_idx:
                            if not self._nurse_active_idx(n, d):
                                continue
                            dt_str = self.all_dates[d].strftime("%Y-%m-%d")
                            pre = self.prev.get(nid, {}).get(dt_str, "")
                            if pre in day_cover or pre in evening_cover:
                                pre_de += 1
                            elif pre in rest_shifts_set:
                                pre_off += 1
                            elif pre in busy_shifts:  # N/NC/D1/중/휴가 (휴무 제외)
                                pre_busy_non_off += 1
                        # 의무 주휴+OF: 완전한 주일 때 2, 부분 주는 (active_days * 2 / 7) 올림 근사
                        required_off = 2 if active_days >= 7 else (active_days * 2 + 6) // 7
                        off_shortfall = max(0, required_off - pre_off)
                        free_days = active_days - pre_de - pre_off - pre_busy_non_off
                        # D/E 공급 = 이미 배정된 DE + (남은 자유일 - 아직 못 채운 off 의무)
                        de_capacity = pre_de + max(0, free_days - off_shortfall)
                        total_supply += de_capacity
                    if week_de_need > total_supply:
                        ws_dt = self.all_dates[week_dates_idx[0]]
                        we_dt = self.all_dates[week_dates_idx[-1]]
                        week_warnings.append(
                            f"      주{wi+1} ({ws_dt.strftime('%m/%d')}~{we_dt.strftime('%m/%d')}, "
                            f"{week_len}일, 재적 정규 {active_nurse_count}명): "
                            f"D+E 주간 수요 {week_de_need}명 > 공급 {total_supply}명 "
                            f"(부족 {week_de_need - total_supply}명)"
                        )
                if week_warnings:
                    lines.append("    [주간 총량 부족 (주휴+OF 의무 + 전입/전출 반영)]")
                    lines.extend(week_warnings)

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
                        # 실제 연속 3일인지 확인
                        try:
                            dt0 = date.fromisoformat(d0)
                            dt1 = date.fromisoformat(d1)
                            dt2 = date.fromisoformat(d2)
                        except (ValueError, TypeError):
                            continue
                        if (dt1 - dt0).days != 1 or (dt2 - dt1).days != 1:
                            continue
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

        # ── Phase 12: 월 최대 야간 ─────────────────────────────────────────────
        if self.rules.maxNightPerMonth:
            p, x = _make_full_prob("diag12")
            self._c_charge_seniority(p, x)
            if self.rules.noNOD:
                self._c_nod_pattern(p, x)
            self._c_menstrual_leave(p, x)
            self._c_max_night_per_month(p, x)
            p += 0
            if not _try(p):
                max_n = self.rules.maxNightPerMonthCount
                lines.append(f"  [원인] 월 최대 야간 {max_n}회 제약 충돌")
                lines.append(f"  총 야간 슬롯 대비 간호사×{max_n}회가 부족합니다.")
                lines.append(f"  해결: 월 최대 야간 횟수를 늘리거나, 야간 필요인원을 줄이세요.")
                return "\n".join(lines)

        # ── Phase 13: 홀짝월 합산 야간 ──────────────────────────────────────────
        if self.rules.maxNightTwoMonth:
            p, x = _make_full_prob("diag13")
            self._c_charge_seniority(p, x)
            if self.rules.noNOD:
                self._c_nod_pattern(p, x)
            self._c_menstrual_leave(p, x)
            if self.rules.maxNightPerMonth:
                self._c_max_night_per_month(p, x)
            self._c_max_night_two_month(p, x)
            p += 0
            if not _try(p):
                lines.append(f"  [원인] 홀짝월 합산 야간 {self.rules.maxNightTwoMonthCount}회 제약 충돌")
                lines.append("  이전달 야간 횟수가 너무 많아 당월 배정이 불가능합니다.")
                lines.append("  해결: 사전입력의 '전월N' 값을 확인하거나 합산 상한을 늘리세요.")
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
                # 재적 밖 날짜(전입 전/전출 후): 스케줄에서 빈 셀로 두어 "OF로 근무" 오인 방지
                if not self._nurse_active_on(nurse, dt):
                    continue
                assigned = None
                for s in self.ALL_SHIFTS:
                    v = x[nid][d][s]
                    if isinstance(v, (int, float)):
                        val = v
                    else:
                        val = pulp.value(v)
                    if val is not None and round(val) == 1:
                        assigned = s
                        break
                if assigned is None:
                    # 제약상 어떤 shift도 1이 아닌 경우 — 방어적 fallback
                    assigned = self.REST_SHIFTS[0] if self.REST_SHIFTS else "OF"
                extended[nid][dt_str] = assigned
                schedule[nid][dt_str] = assigned

        # 트레이니: 프리셉터 스케줄 복사 + /접두어
        for trainee in self._trainees:
            tid = trainee["id"]
            pid = trainee.get("preceptor_id")
            end_date_str = trainee.get("training_end_date")
            end_date = None
            if end_date_str:
                try:
                    end_date = date.fromisoformat(end_date_str)
                except (ValueError, TypeError):
                    pass

            schedule[tid] = {}
            extended[tid] = {}
            for dt in self.all_dates:
                dt_str = dt.strftime("%Y-%m-%d")
                if end_date and dt > end_date:
                    # 트레이닝 종료 후: 솔버에 포함 안 되었으므로 빈칸 (수동 배정 필요)
                    continue
                if pid and pid in schedule:
                    preceptor_shift = schedule[pid].get(dt_str, "")
                    if preceptor_shift:
                        schedule[tid][dt_str] = "/" + preceptor_shift
                        extended[tid][dt_str] = "/" + preceptor_shift

        return dict(schedule), dict(extended)
