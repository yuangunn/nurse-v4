"""
간호사 스케줄러 — CP-SAT(OR-Tools) 엔진.

NurseScheduler(HiGHS)와 평행한 두 번째 생성 엔진. 공유 _SchedulerBase에서 데이터/
날짜/추출/점수 로직을 상속하고, 여기서는 cp_model 변수·제약·solve만 구현한다.
제약은 HiGHS의 _c_* 메서드와 1:1 대응 (의미 동일, 네이티브 표현).

Phase 4a: 변수 도메인 + 선형 하드 제약 + 피저빌리티 solve.
(목적함수=4d, 네이티브 조합제약=4b, 비자명 제약=4c, 콜백=6a)
"""
from __future__ import annotations

import os
from datetime import date
from typing import Dict

from ortools.sat.python import cp_model

from .models import GenerateRequest
from .scheduler_base import _SchedulerBase, WEEKDAY_KEYS, timeoff_class


class _CpSatProgress:
    """solver_progress 어댑터 — CP-SAT 진행/취소 상태."""
    def __init__(self):
        self.cancelled = False
        self.gap_percent = None
        self.nodes = 0
        self.has_solution = False

    def cancel(self):
        self.cancelled = True

    def progress(self) -> dict:
        return {"gap_percent": self.gap_percent, "nodes": self.nodes,
                "has_solution": self.has_solution, "is_running": True}


class _CpSatCb(cp_model.CpSolverSolutionCallback):
    """incumbent마다 진행 갱신·로그 push·취소 확인 (HiGHS 콜백 패리티).
    주의: 콜백은 개선 incumbent에서만 호출 → 취소 지연은 max_time_in_seconds가 백스톱."""
    def __init__(self, prog: _CpSatProgress, log_sink):
        super().__init__()
        self._p = prog
        self._log = log_sink

    def on_solution_callback(self):
        ov = self.ObjectiveValue()
        bound = self.BestObjectiveBound()
        self._p.has_solution = True
        denom = max(1.0, abs(ov))
        self._p.gap_percent = round(abs(bound - ov) / denom * 100, 2)
        self._p.nodes = int(self.NumBranches())
        if self._log:
            self._log({"type": "log",
                       "msg": f"[CP-SAT] incumbent {ov:.0f} · bound {bound:.0f} · branches {self._p.nodes}"})
        if self._p.cancelled:
            self.StopSearch()


class CpSatScheduler(_SchedulerBase):
    def solve(self) -> Dict:
        if not self.nurses:
            return {"success": False, "message": "간호사가 등록되지 않았습니다.", "schedule": {}}

        model = cp_model.CpModel()
        x = self._build_vars(model)
        self._apply_hard_constraints(model, x)

        # ── Objective (Soft Constraints) — 4d ────────────────────────────────
        obj_terms = self._build_objective_cpsat(model, x)
        if obj_terms:
            model.Maximize(sum(obj_terms))

        # ── Solve (진행/중지/로그 콜백 — HiGHS 패리티) ──────────────────────
        from . import solver_progress
        prog = _CpSatProgress()

        def _log_sink(item):
            try:
                from . import api  # 런타임 lazy (순환 import 회피)
                api._log_queue.put(item)
            except Exception:
                pass
        # 이전 로그 드레인
        try:
            from . import api as _api
            while not _api._log_queue.empty():
                _api._log_queue.get_nowait()
        except Exception:
            pass

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = float(self.time_limit)  # 취소 하드 백스톱
        solver.parameters.relative_gap_limit = float(self.mip_gap)
        solver.parameters.log_search_progress = False
        # ── 성능 튜닝 ───────────────────────────────────────────────────────
        # CP-SAT는 포트폴리오 병렬 탐색(여러 워커가 서로 다른 전략)으로 큰 이득.
        # 데스크톱 UI/Electron과 공존하므로 코어 전부를 점유하지 않고 8로 캡.
        _cores = os.cpu_count() or 4
        solver.parameters.num_workers = max(1, min(8, _cores))
        solver.parameters.random_seed = 1          # 재현성(병렬이어도 시드 고정)
        solver.parameters.use_lns_only = False     # 기본 포트폴리오 유지(LNS+완전탐색 혼합)
        cb = _CpSatCb(prog, _log_sink)
        solver_progress.register(prog)
        try:
            status = solver.Solve(model, cb)
        finally:
            solver_progress.unregister(prog)

        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            schedule, extended = self._extract_solution(x, lambda v: solver.Value(v))
            nurse_scores, nurse_score_details = self._compute_nurse_scores(schedule)
            label = "Optimal" if status == cp_model.OPTIMAL else "Feasible"
            return {
                "success": True,
                "schedule": schedule,
                "extended_schedule": extended,
                "nurse_scores": nurse_scores,
                "nurse_score_details": nurse_score_details,
                "mip_gap_percent": prog.gap_percent if prog.gap_percent is not None else 0.0,
                "message": f"근무표가 생성되었습니다. (CP-SAT 상태: {label})",
                "estimated_seconds": self.estimate_seconds(),
            }
        if status == cp_model.INFEASIBLE:
            # 사전입력 완화 재시도 (HiGHS 패리티 — 최소 침습)
            if self.allow_pre_relax and self.prev:
                relaxed = self._solve_relaxed()
                if relaxed:
                    return relaxed
            msg = "CP-SAT: 제약을 모두 만족하는 근무표가 없습니다 (infeasible)."
            try:
                from .conflict_analyzer import analyze_conflicts
                diag = analyze_conflicts(self._request)
                if diag.get("conflicts"):
                    msg += "\n\n[정밀 충돌 분석]\n" + diag["message"]
            except Exception:
                pass
            return {"success": False, "schedule": {}, "extended_schedule": {}, "message": msg}
        return {
            "success": False, "schedule": {}, "extended_schedule": {},
            "message": f"CP-SAT: 제한 시간 내에 해를 찾지 못했습니다 (상태: {solver.StatusName(status)}).",
        }

    def _apply_hard_constraints(self, model, x):
        """solve()/완화 공통 하드 제약 — 두 경로의 제약 동등성 보장."""
        self._cs_one_shift_per_day(model, x)
        self._cs_shift_eligibility(model, x)
        self._cs_daily_requirements(model, x)
        self._cs_charge_requirements(model, x)
        if self.rules.weeklyOff:
            self._cs_weekly_off(model, x)
        self._cs_pregnancy_p1_weekly(model, x)         # 임산부 P1 주1회 (모성보호)
        self._cs_max_v_per_month(model, x)
        if self.rules.maxNightPerMonth:
            self._cs_max_night_per_month(model, x)
        if self.rules.maxNightTwoMonth:
            self._cs_max_night_two_month(model, x)
        self._cs_forbidden_transitions(model, x)
        if self.rules.noNOD:
            self._cs_nod_pattern(model, x)
        if self.rules.maxConsecutiveWork:
            self._cs_max_consecutive_work(model, x, self.rules.maxConsecutiveWorkDays)
        if self.rules.maxConsecutiveNight:
            self._cs_max_consecutive_night(model, x, self.rules.maxConsecutiveNightDays)
        if getattr(self.rules, "restAfterNight", False):
            self._cs_rest_after_night(model, x)
        self._cs_charge_seniority(model, x)
        self._cs_menstrual_leave(model, x)
        self._cs_night_shift_nurses(model, x)

    # ── 사전입력 완화 (최소 침습 — HiGHS _solve_with_relaxed_pre 패리티) ──────
    def _build_vars_relaxed(self, model):
        """사전입력 셀을 자유화한 변수 + pre_keeps[(nid,d,pre,[flex_vars])].
        잠긴 셀/전입전출/공휴일OF/주휴(고정)는 solve()와 동일 규칙으로 보존."""
        x = {}
        pre_keeps = []
        for nurse in self.nurses:
            nid = nurse["id"]
            x[nid] = {}
            is_night = nurse.get("is_night_shift")
            is_male = nurse.get("gender") != "female"
            for d in range(self.T):
                dt = self.all_dates[d]
                dt_str = dt.strftime("%Y-%m-%d")
                x[nid][d] = {}
                is_holiday = dt_str in self.holidays
                pre = self.prev.get(nid, {}).get(dt_str)
                if pre == "OF" and is_holiday:
                    pre = None
                # 임산부 모성보호: 야간/생 사전입력은 무시 (솔버가 유효 근무 선택)
                pre = self._preg_effective_pre(nurse, dt, pre)
                active = self._nurse_active_on(nurse, dt)
                locked = bool(self.locked_cells.get(nid, {}).get(dt_str))
                fixed_to = None
                if active and pre and locked:
                    fixed_to = pre
                elif active and pre == "주" and not self.allow_juhu_relax:
                    fixed_to = "주"
                if fixed_to is not None:
                    for s in self.ALL_SHIFTS:
                        x[nid][d][s] = 1 if s == fixed_to else 0
                    continue
                if not active:
                    for s in self.ALL_SHIFTS:
                        x[nid][d][s] = 0
                    continue
                for s in self.ALL_SHIFTS:
                    if s == "OF" and is_holiday:
                        x[nid][d][s] = 0
                    elif self._preg_forbids(nurse, dt, s, pre):
                        x[nid][d][s] = 0   # 임산부 모성보호 (P1 구간 외/야간 제외/생 면제)
                    elif s == "법" and is_night:
                        x[nid][d][s] = 0
                    elif s == "법" and not is_holiday:
                        x[nid][d][s] = 0
                    elif s == "법" and is_holiday:
                        x[nid][d][s] = model.NewBoolVar(f"rx_{nid}_{d}_{s}")
                    elif s in ("생", "V") and is_holiday and not is_night:
                        x[nid][d][s] = 0
                    elif s == "생" and is_male:
                        x[nid][d][s] = 0
                    elif s in self.SOLVER_SHIFTS:
                        x[nid][d][s] = model.NewBoolVar(f"rx_{nid}_{d}_{s}")
                    elif pre and s == pre:
                        x[nid][d][s] = model.NewBoolVar(f"rx_{nid}_{d}_{s}")
                    else:
                        x[nid][d][s] = 0
                if pre:
                    flex = self._PRE_FLEX.get(pre, {pre})
                    flex_vars = [x[nid][d][s] for s in flex if not isinstance(x[nid][d][s], int)]
                    if flex_vars:
                        pre_keeps.append((nid, d, pre, flex_vars))
        return x, pre_keeps

    def _solve_relaxed(self):
        """INFEASIBLE 시 사전입력을 소프트로 풀어 최소 침습 완화 재시도. 성공 시 결과, 실패 시 None."""
        model = cp_model.CpModel()
        x, pre_keeps = self._build_vars_relaxed(model)
        self._apply_hard_constraints(model, x)
        obj_terms = self._build_objective_cpsat(model, x)
        # 사전순 지배 유지보너스 — 근무 < OFF < 연차류 (주휴 고정). 배점을 압도하도록 dom 스케일.
        _BONUS = {"work": 500, "off": 3000, "leave": 5000, "juhu": 300}
        keep_terms = []
        for nid, d, pre, flex_vars in pre_keeps:
            b = _BONUS[timeoff_class(pre)]
            for v in flex_vars:
                keep_terms.append(b * v)
        max_score = max((abs(int(round(getattr(r, "score", 0)))) for r in self.scoring_rules), default=100)
        coarse = max_score * max(1, len(self.nurses)) * max(1, self.T) * max(1, len(self.scoring_rules)) + 1
        dom = coarse // 500 + 2
        model.Maximize(sum(obj_terms) + dom * sum(keep_terms))
        from . import solver_progress
        prog = _CpSatProgress()
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = float(self.time_limit)
        solver.parameters.relative_gap_limit = float(self.mip_gap)
        solver.parameters.num_workers = max(1, min(8, os.cpu_count() or 4))
        solver.parameters.random_seed = 1
        cb = _CpSatCb(prog, None)
        solver_progress.register(prog)
        try:
            status = solver.Solve(model, cb)
        finally:
            solver_progress.unregister(prog)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return None
        schedule, extended = self._extract_solution(x, lambda v: solver.Value(v))
        nurse_scores, nurse_score_details = self._compute_nurse_scores(schedule)
        relaxed_cells = {}
        timeoff_changed = 0
        for nid, days in self.prev.items():
            for dt_str, pre_shift in days.items():
                assigned = schedule.get(nid, {}).get(dt_str)
                if assigned and assigned != pre_shift:
                    flex = self._PRE_FLEX.get(pre_shift, {pre_shift})
                    if assigned not in flex:
                        is_timeoff = timeoff_class(pre_shift) != "work"
                        if is_timeoff:
                            timeoff_changed += 1
                        relaxed_cells.setdefault(nid, {})[dt_str] = {
                            "original": pre_shift, "assigned": assigned, "is_timeoff": is_timeoff,
                        }
        relax_count = sum(len(v) for v in relaxed_cells.values())
        work_changed = relax_count - timeoff_changed
        if relax_count == 0:
            relax_msg = "사전입력을 그대로 유지했습니다."
        else:
            relax_msg = f"⚠ 최소 침습 완화: 근무 {work_changed}건 조정"
            if timeoff_changed:
                relax_msg += f" · ⚠ 휴무 {timeoff_changed}건 변경(불가피 — 인원 추가/수요 감축 검토 권장)"
            relax_msg += "."
        return {
            "success": True,
            "schedule": schedule,
            "extended_schedule": extended,
            "nurse_scores": nurse_scores,
            "nurse_score_details": nurse_score_details,
            "relaxed_cells": relaxed_cells,
            "timeoff_relaxed_count": timeoff_changed,
            "mip_gap_percent": prog.gap_percent if prog.gap_percent is not None else 0.0,
            "message": f"근무표가 생성되었습니다. (CP-SAT 완화)\n{relax_msg}",
            "estimated_seconds": self.estimate_seconds(),
        }

    # ── 변수 도메인 (HiGHS solve()의 변수 생성 블록과 동일 규칙) ──────────────
    def _build_vars(self, model) -> Dict[str, Dict[int, Dict[str, object]]]:
        """x[nid][d][shift] = BoolVar(자유) 또는 int 0(고정). HiGHS와 동일 도메인 규칙."""
        x: Dict[str, Dict[int, Dict[str, object]]] = {}
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
                if pre == "OF" and is_holiday:
                    pre = None
                # 임산부 모성보호: 야간/생 사전입력은 무시 (솔버가 유효 근무 선택)
                pre = self._preg_effective_pre(nurse, dt, pre)
                pre_flex = self._PRE_FLEX.get(pre, {pre} if pre else set())
                if not self._nurse_active_on(nurse, dt):
                    for s in self.ALL_SHIFTS:
                        x[nid][d][s] = 0
                    continue
                for s in self.ALL_SHIFTS:
                    if s == "OF" and is_holiday:
                        x[nid][d][s] = 0
                        continue
                    # 임산부 모성보호 게이팅 (P1 구간 외/야간 제외/생 면제 → 0 고정)
                    if self._preg_forbids(nurse, dt, s, pre):
                        x[nid][d][s] = 0
                        continue
                    if pre:
                        if s in pre_flex:
                            x[nid][d][s] = model.NewBoolVar(f"x_{nid}_{d}_{s}")
                        else:
                            x[nid][d][s] = 0
                    elif s == "법" and is_night:
                        x[nid][d][s] = 0
                    elif s == "법" and not is_holiday:
                        x[nid][d][s] = 0
                    elif s == "법" and is_holiday:
                        x[nid][d][s] = model.NewBoolVar(f"x_{nid}_{d}_{s}")
                    elif s in ("생", "V") and is_holiday and not is_night:
                        x[nid][d][s] = 0
                    elif s not in self.SOLVER_SHIFTS:
                        x[nid][d][s] = 0
                    elif s == "생" and is_male:
                        x[nid][d][s] = 0
                    else:
                        x[nid][d][s] = model.NewBoolVar(f"x_{nid}_{d}_{s}")
        return x

    # ── 선형 하드 제약 (각각 HiGHS _c_* 와 1:1) ──────────────────────────────
    def _cs_one_shift_per_day(self, model, x):
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T):
                if not self._nurse_active_idx(nurse, d):
                    continue
                model.Add(sum(x[nid][d][s] for s in self.ALL_SHIFTS) == 1)

    def _cs_shift_eligibility(self, model, x):
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
                    if not isinstance(v, int):
                        model.Add(v == 0)

    def _cs_daily_requirements(self, model, x):
        req_dict = self.req.model_dump()
        period_map = {"D": self.DAY_SHIFTS, "E": self.EVENING_SHIFTS, "N": self.NIGHT_SHIFTS}
        grouped_codes = set()
        for shifts in period_map.values():
            grouped_codes.update(shifts)
        for s in self._shifts:
            code = s["code"]
            if s.get("auto_assign", True) and code in self.SOLVER_SHIFTS and code not in grouped_codes:
                period_map[code] = [code]

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
                model.Add(sum(x[n["id"]][d][s] for n in self.nurses for s in shifts) == required)

    def _cs_charge_requirements(self, model, x):
        req_dict = self.req.model_dump()
        period_to_req = {"day": "D", "evening": "E", "night": "N"}
        charge_shifts = [s for s in self._shifts if s["is_charge"]]
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
            for s in charge_shifts:
                req_key = period_to_req.get(s["period"])
                if req_key and day_req.get(req_key, 0) > 0:
                    model.Add(sum(x[n["id"]][d][s["code"]] for n in self.nurses) == 1)

    def _cs_weekly_off(self, model, x):
        of_code = "OF"
        if of_code not in self.SOLVER_SHIFTS:
            return
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            if nurse.get("is_night_shift", False):
                continue
            for ws, we in self.weeks:
                week_days = [d for d in range(ws, we + 1)
                             if self.all_dates[d] >= first_of_month
                             and self._nurse_active_idx(nurse, d)]
                if not week_days:
                    continue
                of_sum = sum(x[nid][d][of_code] for d in week_days)
                if len(week_days) >= 7:
                    model.Add(of_sum == 1)
                else:
                    model.Add(of_sum <= 1)

    def _cs_pregnancy_p1_weekly(self, model, x):
        """임산부: P1 구간 완전 포함 주마다 P1 정확히 1회 (부분 주 ≤1).
        HiGHS _c_pregnancy_p1_weekly 대응. 야간 제외·생 면제는 변수 게이팅으로 처리."""
        if "P1" not in self.ALL_SHIFTS:
            return
        for nurse in self.nurses:
            if not nurse.get("is_pregnant"):
                continue
            nid = nurse["id"]
            for ws, we in self.weeks:
                win_days = [d for d in range(ws, we + 1)
                            if self._nurse_active_idx(nurse, d)
                            and self._preg_window_on(nid, self.all_dates[d])]
                if not win_days:
                    continue
                p1_vars = [x[nid][d]["P1"] for d in win_days
                           if not isinstance(x[nid][d].get("P1"), int)]
                if not p1_vars:
                    continue
                full_week = (we - ws + 1) == len(win_days)
                if full_week and len(win_days) >= 7:
                    model.Add(sum(p1_vars) == 1)
                else:
                    model.Add(sum(p1_vars) <= 1)

    def _cs_max_v_per_month(self, model, x):
        max_v = self.rules.maxVPerMonth
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            if max_v > 0 and not self.unlimited_v:
                v_vars = [x[nid][d]["V"] for d, dt in enumerate(self.all_dates)
                          if dt.month == self.month and dt.year == self.year]
                if v_vars:
                    model.Add(sum(v_vars) <= max_v)
            for d, dt in enumerate(self.all_dates):
                if dt < first_of_month and "V" in self.ALL_SHIFTS:
                    v = x[nid][d]["V"]
                    if not isinstance(v, int):
                        model.Add(v == 0)
            next_v_vars = [x[nid][d]["V"] for d, dt in enumerate(self.all_dates)
                           if (dt.month != self.month or dt.year != self.year) and dt >= first_of_month]
            if next_v_vars:
                model.Add(sum(next_v_vars) <= 1)

    def _cs_max_night_per_month(self, model, x):
        max_n = self.rules.maxNightPerMonthCount
        for nurse in self.nurses:
            if nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            night_vars = [x[nid][d][s] for d, dt in enumerate(self.all_dates)
                          if dt.month == self.month and dt.year == self.year
                          for s in self.NIGHT_SHIFTS]
            if night_vars:
                model.Add(sum(night_vars) <= max_n)

    def _cs_max_night_two_month(self, model, x):
        max_n = self.rules.maxNightTwoMonthCount
        prev_nights = getattr(self, 'prev_month_nights', None) or {}
        for nurse in self.nurses:
            if nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            prev_count = prev_nights.get(nid, 0)
            night_vars = [x[nid][d][s] for d, dt in enumerate(self.all_dates)
                          if dt.month == self.month and dt.year == self.year
                          for s in self.NIGHT_SHIFTS]
            if night_vars:
                model.Add(sum(night_vars) <= max_n - prev_count)

    # ── 조합/네이티브 하드 제약 (HiGHS _c_* 와 1:1) — 4b ─────────────────────
    def _cs_forbidden_transitions(self, model, x):
        """9개 물리 불가 전환 금지 (인접일 v1+v2<=1)."""
        forbidden = [
            (self.EVENING_SHIFTS, self.DAY_SHIFTS),
            (self.EVENING_SHIFTS, self.DAY1_SHIFTS),
            (self.EVENING_SHIFTS, self.MIDDLE_SHIFTS),
            (self.NIGHT_SHIFTS,   self.EVENING_SHIFTS),
            (self.NIGHT_SHIFTS,   self.DAY_SHIFTS),
            (self.NIGHT_SHIFTS,   self.DAY1_SHIFTS),
            (self.NIGHT_SHIFTS,   self.MIDDLE_SHIFTS),
            (self.MIDDLE_SHIFTS,  self.DAY_SHIFTS),
            (self.MIDDLE_SHIFTS,  self.DAY1_SHIFTS),
        ]
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T - 1):
                for first_group, second_group in forbidden:
                    for s1 in first_group:
                        v1 = x[nid][d][s1]
                        if isinstance(v1, int):
                            continue
                        for s2 in second_group:
                            v2 = x[nid][d + 1][s2]
                            if isinstance(v2, int):
                                continue
                            model.Add(v1 + v2 <= 1)

    def _cs_nod_pattern(self, model, x):
        """N→휴무→D 금지 (vn+vr+vd<=2)."""
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T - 2):
                for ns in self.NIGHT_SHIFTS:
                    vn = x[nid][d][ns]
                    if isinstance(vn, int):
                        continue
                    for rs in self.REST_SHIFTS:
                        vr = x[nid][d + 1][rs]
                        if isinstance(vr, int):
                            continue
                        for ds in self.DAY_SHIFTS:
                            vd = x[nid][d + 2][ds]
                            if isinstance(vd, int):
                                continue
                            model.Add(vn + vr + vd <= 2)

    def _cs_max_consecutive_work(self, model, x, max_days: int):
        for nurse in self.nurses:
            nid = nurse["id"]
            for start in range(self.T - max_days):
                window = range(start, start + max_days + 1)
                model.Add(sum(x[nid][d][s] for d in window for s in self.WORK_SHIFTS) <= max_days)

    def _cs_max_consecutive_night(self, model, x, max_nights: int):
        for nurse in self.nurses:
            nid = nurse["id"]
            for start in range(self.T - max_nights):
                window = range(start, start + max_nights + 1)
                model.Add(sum(x[nid][d][s] for d in window for s in self.NIGHT_SHIFTS) <= max_nights)

    def _cs_rest_after_night(self, model, x):
        """연속 야간(min_consec) 후 rest_days 일간 근무 불가.
        lhs = ΣN(d..d+mc-1) - ΣN(next) + ΣW(rest_d) <= min_consec (HiGHS _c_rest_after_night 대응)."""
        min_consec = getattr(self.rules, 'restAfterNightMinConsec', 2)
        rest_days = getattr(self.rules, 'restAfterNightDays', 2)
        for nurse in self.nurses:
            nid = nurse["id"]
            if nurse.get("is_night_shift"):
                continue
            for d in range(self.T - min_consec):
                night_terms = [x[nid][d + i][s] for i in range(min_consec)
                               for s in self.NIGHT_SHIFTS if not isinstance(x[nid][d + i][s], int)]
                night_fixed = sum(x[nid][d + i][s] for i in range(min_consec)
                                  for s in self.NIGHT_SHIFTS if isinstance(x[nid][d + i][s], int))
                if not night_terms and night_fixed < min_consec:
                    continue
                next_d = d + min_consec
                if next_d >= self.T:
                    continue
                night_next = [x[nid][next_d][s] for s in self.NIGHT_SHIFTS
                              if not isinstance(x[nid][next_d][s], int)]
                night_next_fixed = sum(x[nid][next_d][s] for s in self.NIGHT_SHIFTS
                                       if isinstance(x[nid][next_d][s], int))
                for k in range(rest_days):
                    rest_d = next_d + k
                    if rest_d >= self.T:
                        break
                    work_vars = [x[nid][rest_d][s] for s in self.WORK_SHIFTS
                                 if s not in self.NIGHT_SHIFTS and not isinstance(x[nid][rest_d][s], int)]
                    if not work_vars:
                        continue
                    lhs = sum(night_terms) + night_fixed
                    if night_next:
                        lhs = lhs - sum(night_next)
                    else:
                        lhs = lhs - night_next_fixed
                    lhs = lhs + sum(work_vars)
                    model.Add(lhs <= min_consec)

    # ── 비자명 하드 제약 (HiGHS _c_* 와 1:1) — 4c ────────────────────────────
    def _cs_charge_seniority(self, model, x):
        """Charge는 같은 듀티 최선임에게만 (후임 charge + 선임 일반 동시 금지)."""
        period_peers = {"day": ("day",), "evening": ("evening",), "night": ("night",)}
        charge_regular_map = {}
        for s in self._shifts:
            if not s["is_charge"]:
                continue
            peers = period_peers.get(s["period"], (s["period"],))
            charge_regular_map[s["code"]] = [
                r["code"] for r in self._shifts if r["period"] in peers and not r["is_charge"]
            ]
        eligible_pairs = []
        for i_nurse in self.nurses:
            for j_nurse in self.nurses:
                if i_nurse["id"] == j_nurse["id"]:
                    continue
                if i_nurse.get("seniority", 0) <= j_nurse.get("seniority", 0):
                    continue
                j_capable = set(j_nurse.get("capable_shifts", []))
                for charge_s, regulars in charge_regular_map.items():
                    if charge_s not in j_capable:
                        continue
                    eligible_pairs.append((i_nurse["id"], j_nurse["id"], charge_s, regulars))
        for d, dt in enumerate(self.all_dates):
            if dt.month != self.month:
                continue
            dt_str = dt.strftime("%Y-%m-%d")
            for nid_i, nid_j, charge_s, regulars in eligible_pairs:
                j_fixed = self.prev.get(nid_j, {}).get(dt_str)
                if j_fixed and j_fixed != charge_s:
                    continue
                v_charge = x[nid_i][d][charge_s]
                if isinstance(v_charge, int):
                    continue
                for regular_s in regulars:
                    v_reg = x[nid_j][d][regular_s]
                    if isinstance(v_reg, int):
                        continue
                    model.Add(v_charge + v_reg <= 1)

    def _cs_menstrual_leave(self, model, x):
        """생리휴가: 여성 당월 최대 1회 + overflow 처리."""
        if "생" not in self.ALL_SHIFTS:
            return
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            if nurse.get("gender") != "female":
                continue
            month_vars = [x[nid][d]["생"] for d, dt in enumerate(self.all_dates)
                          if dt.month == self.month and dt.year == self.year]
            if month_vars:
                model.Add(sum(month_vars) <= 1)
            for d, dt in enumerate(self.all_dates):
                if dt < first_of_month:
                    v = x[nid][d]["생"]
                    if not isinstance(v, int):
                        model.Add(v == 0)
            next_m = [x[nid][d]["생"] for d, dt in enumerate(self.all_dates)
                      if (dt.month != self.month or dt.year != self.year) and dt >= first_of_month]
            if next_m:
                model.Add(sum(next_m) <= 1)

    def _cs_night_shift_nurses(self, model, x):
        """야간전담: N/NC만, 5일 윈도우<=3, 당월 정확 14일, 여성·31일달 생 1회."""
        night_nurses = [n for n in self.nurses if n.get("is_night_shift")]
        if not night_nurses:
            return
        import calendar
        month_days = calendar.monthrange(self.year, self.month)[1]
        month_idxs = [d for d, dt in enumerate(self.all_dates)
                      if dt.month == self.month and dt.year == self.year]
        if not month_idxs:
            return
        non_night_work = [s["code"] for s in self._shifts
                          if s["period"] not in ("night", "rest", "leave")]
        for nurse in night_nurses:
            nid = nurse["id"]
            for d in month_idxs:
                for s in non_night_work:
                    v = x[nid][d].get(s)
                    if v is not None and not isinstance(v, int):
                        model.Add(v == 0)
            for start in range(month_idxs[0], month_idxs[-1] - 3):
                model.Add(sum(x[nid][d][s] for d in range(start, start + 5) if d < self.T
                              for s in self.NIGHT_SHIFTS) <= 3)
            model.Add(sum(x[nid][d][s] for d in month_idxs for s in self.NIGHT_SHIFTS) == 14)
            if month_days == 31 and nurse.get("gender") == "female" and "생" in self.ALL_SHIFTS:
                model.Add(sum(x[nid][d]["생"] for d in month_idxs) == 1)

    # ── 목적함수 (Soft Constraints, 정수 가중합) — 4d ─────────────────────────
    def _build_objective_cpsat(self, model, x) -> list:
        """HiGHS _build_objective와 1:1. 모든 가중치가 정수라 스케일 불필요.
        리피케이션(AND-of-k)·night_fairness range는 동일 선형 패턴, 보조변수는 cp_model."""
        terms = []
        month_days = [d for d, dt in enumerate(self.all_dates)
                      if dt.month == self.month and dt.year == self.year]
        month_day_pairs = [(month_days[i], month_days[i + 1])
                           for i in range(len(month_days) - 1)
                           if month_days[i + 1] == month_days[i] + 1]
        ub_nights = max(1, len(month_days))

        def lin(expr_list):
            return sum(expr_list) if expr_list else 0

        for rule in self.scoring_rules:
            rt, p = rule.rule_type, rule.params
            sc = int(round(rule.score))
            rid = rule.id if rule.id is not None else rule.sort_order

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
                to_shifts = self._resolve_group(p.get("to", ""))
                if not from_shifts or not to_shifts:
                    continue
                for nurse in self.nurses:
                    nid = nurse["id"]
                    for d, d1 in month_day_pairs:
                        f_sum = lin([x[nid][d][s] for s in from_shifts if s in self.ALL_SHIFTS])
                        t_sum = lin([x[nid][d1][s] for s in to_shifts if s in self.ALL_SHIFTS])
                        v = model.NewBoolVar(f"tr{rid}_{nid}_{d}")
                        model.Add(v <= f_sum)
                        model.Add(v <= t_sum)
                        model.Add(v >= f_sum + t_sum - 1)
                        terms.append(sc * v)

            elif rt == "consecutive_same":
                period_shifts = self._resolve_group(p.get("period", ""))
                if not period_shifts:
                    continue
                for nurse in self.nurses:
                    nid = nurse["id"]
                    for d, d1 in month_day_pairs:
                        g1 = lin([x[nid][d][s] for s in period_shifts if s in self.ALL_SHIFTS])
                        g2 = lin([x[nid][d1][s] for s in period_shifts if s in self.ALL_SHIFTS])
                        v = model.NewBoolVar(f"cs{rid}_{nid}_{d}")
                        model.Add(v <= g1)
                        model.Add(v <= g2)
                        model.Add(v >= g1 + g2 - 1)
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
                        window = [start_d + k for k in range(n_steps)]
                        if any(w >= len(self.all_dates) for w in window):
                            continue
                        if any(w not in month_days for w in window):
                            continue
                        if window[-1] != window[0] + n_steps - 1:
                            continue
                        sums = [lin([x[nid][window[k]][s] for s in groups[k] if s in self.ALL_SHIFTS])
                                for k in range(n_steps)]
                        v = model.NewBoolVar(f"pat{rid}_{nid}_{start_d}")
                        for s_expr in sums:
                            model.Add(v <= s_expr)
                        model.Add(v >= lin(sums) - (n_steps - 1))
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
                                terms.append(sc * lin([x[nid][d][s] for s in self.REST_SHIFTS + self.LEAVE_SHIFTS]))
                            elif wish_shift in self.ALL_SHIFTS:
                                terms.append(sc * x[nid][d][wish_shift])
                        except (ValueError, KeyError):
                            pass

            elif rt == "night_fairness":
                if len(self.nurses) >= 2:
                    night_counts = {
                        nurse["id"]: lin([x[nurse["id"]][d][s] for d in month_days for s in self.NIGHT_SHIFTS])
                        for nurse in self.nurses
                    }
                    max_n = model.NewIntVar(0, ub_nights, f"max_nights_{rid}")
                    min_n = model.NewIntVar(0, ub_nights, f"min_nights_{rid}")
                    for nurse in self.nurses:
                        nid = nurse["id"]
                        model.Add(max_n >= night_counts[nid])
                        model.Add(min_n <= night_counts[nid])
                    range_var = model.NewIntVar(0, ub_nights, f"night_range_{rid}")
                    model.Add(range_var >= max_n - min_n)
                    terms.append(sc * range_var)

            elif rt == "holiday_work":
                for nurse in self.nurses:
                    nid = nurse["id"]
                    for d in month_days:
                        if self.all_dates[d].strftime("%Y-%m-%d") in self.holidays:
                            for s in self.WORK_SHIFTS:
                                terms.append(sc * x[nid][d][s])

            elif rt == "weekend_work":
                slots = p.get("slots", [])
                for nurse in self.nurses:
                    nid = nurse["id"]
                    for d in month_days:
                        wd = self.all_dates[d].weekday()
                        for slot in slots:
                            if wd == slot.get("weekday"):
                                target = []
                                for period in slot.get("periods", []):
                                    target.extend(self._resolve_group(period))
                                for s in target:
                                    if s in self.ALL_SHIFTS:
                                        terms.append(sc * x[nid][d][s])

            elif rt == "holiday_off":
                if "OF" in self.ALL_SHIFTS:
                    for nurse in self.nurses:
                        nid = nurse["id"]
                        if nurse.get("is_night_shift"):
                            continue
                        for d in month_days:
                            if self.all_dates[d].strftime("%Y-%m-%d") in self.holidays:
                                terms.append(sc * x[nid][d]["OF"])

        # 이후달 overflow V 페널티 (항상)
        first_of_month = date(self.year, self.month, 1)
        overflow_days = [d for d, dt in enumerate(self.all_dates)
                         if (dt.month != self.month or dt.year != self.year) and dt >= first_of_month]
        if overflow_days and "V" in self.ALL_SHIFTS:
            for nurse in self.nurses:
                nid = nurse["id"]
                for d in overflow_days:
                    terms.append(-500 * x[nid][d]["V"])

        # V 무제한 모드 점진 페널티
        if self.unlimited_v and "V" in self.ALL_SHIFTS:
            for nurse in self.nurses:
                nid = nurse["id"]
                v_month = [x[nid][d]["V"] for d, dt in enumerate(self.all_dates)
                           if dt.month == self.month and dt.year == self.year]
                if not v_month:
                    continue
                v_total = lin(v_month)
                v2 = model.NewIntVar(0, ub_nights, f"v2_{nid}")
                model.Add(v2 >= v_total - 1)
                v3 = model.NewIntVar(0, ub_nights, f"v3_{nid}")
                model.Add(v3 >= v_total - 2)
                terms.append(-500 * v2)
                terms.append(-4000 * v3)

        # 생리휴가 2회+ 방지 페널티 (안전장치)
        if "생" in self.ALL_SHIFTS:
            for nurse in self.nurses:
                if nurse.get("gender") != "female":
                    continue
                nid = nurse["id"]
                m_vars = [x[nid][d]["생"] for d, dt in enumerate(self.all_dates)
                          if dt.month == self.month and dt.year == self.year]
                if not m_vars:
                    continue
                m2 = model.NewIntVar(0, ub_nights, f"m2_{nid}")
                model.Add(m2 >= lin(m_vars) - 1)
                terms.append(-20100 * m2)

        return terms
