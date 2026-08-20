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
        self.solver = None  # cancel() 시 즉시 stop_search 호출용

    def cancel(self):
        self.cancelled = True
        # 콜백은 '개선 incumbent'에서만 호출되므로 그것만으로는 해 개선이 없는
        # 구간에서 중지가 무시된다 — solver.stop_search()로 즉시 중단을 요청한다.
        s = self.solver
        if s is not None:
            try:
                stop = getattr(s, "stop_search", None) or getattr(s, "StopSearch", None)
                if stop:
                    stop()
            except Exception:
                pass

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
        try:
            from . import solver_progress
            solver_progress.record_event("incumbent", engine="CP-SAT",
                                         obj=ov, gap=self._p.gap_percent)
        except Exception:
            pass
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
        self._pre_soft = False  # strict 모드 — 사전입력은 변수 도메인으로 고정
        self._build_pin_index()  # 사실-클램프: 확정 셀 인덱스 (완화 요청 시 빈 dict)
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
        try:
            proto = model.Proto()
            solver_progress.record_event("model", engine="CP-SAT",
                                         vars=len(proto.variables),
                                         cons=len(proto.constraints))
        except Exception:
            pass
        cb = _CpSatCb(prog, _log_sink)
        prog.solver = solver  # cancel() → stop_search() 즉시 중단 경로
        solver_progress.register(prog)
        # 모델 빌드 중 눌린 중지는 register가 cancel()로 전달하지만, Solve 시작
        # 전의 stop_search()는 no-op이므로 여기서 플래그를 직접 확인한다
        if prog.cancelled:
            solver_progress.unregister(prog)
            return {"success": False, "schedule": {}, "extended_schedule": {},
                    "message": "중지 요청으로 생성이 취소되었습니다."}
        try:
            status = solver.Solve(model, cb)
        finally:
            solver_progress.unregister(prog)

        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            schedule, extended = self._extract_solution(x, lambda v: solver.Value(v))
            nurse_scores, nurse_score_details = self._compute_nurse_scores(schedule)
            label = "Optimal" if status == cp_model.OPTIMAL else "Feasible"
            return self._attach_pin_notes({
                "success": True,
                "schedule": schedule,
                "extended_schedule": extended,
                "nurse_scores": nurse_scores,
                "nurse_score_details": nurse_score_details,
                "mip_gap_percent": prog.gap_percent if prog.gap_percent is not None else 0.0,
                "message": f"근무표가 생성되었습니다. (CP-SAT 상태: {label})",
                "estimated_seconds": self.estimate_seconds(),
            })
        if status == cp_model.INFEASIBLE:
            # 사전입력 완화 재시도 (HiGHS 패리티 — 최소 침습).
            # 취소(사용자 중지·레이스 패자)면 후속 솔브를 시작하지 않는다.
            cancelled_now = (prog.cancelled or solver_progress.is_cancelled()
                             or solver_progress.was_cancel_all())
            if self.allow_pre_relax and self.prev and not cancelled_now:
                relaxed = self._solve_relaxed()
                if relaxed:
                    return relaxed
            # 완전 확정 표: 검증 거부 대신 그대로 확정 (HiGHS 패리티)
            if self._fully_pinned():
                return self._confirm_pinned_result()
            msg = "CP-SAT: 제약을 모두 만족하는 근무표가 없습니다 (infeasible)."
            # 인라인 정밀분석은 단독 CP-SAT 모드에서만 — 레이스 패자의 분석은
            # 결과가 폐기되는데 분~수십 분 CPU를 태울 수 있고 취소도 안 된다.
            in_race = getattr(self._request, "solver", "") == "race"
            if not in_race and not cancelled_now:
                try:
                    from .conflict_analyzer import analyze_conflicts
                    diag = analyze_conflicts(self._request)
                    if diag.get("conflicts"):
                        msg += "\n\n[정밀 충돌 분석]\n" + diag["message"]
                except Exception:
                    pass
            return {"success": False, "schedule": {}, "extended_schedule": {}, "message": msg}
        # UNKNOWN(타임아웃·중단) — HiGHS의 'Not Solved' 완화 재시도와 패리티.
        # 사용자 중지·레이스 패자 취소면 제외 (취소 무시하고 새 솔브를 도는 셈).
        if (self.allow_pre_relax and self.prev
                and not solver_progress.is_cancelled() and not prog.cancelled
                and not solver_progress.was_cancel_all()):
            relaxed = self._solve_relaxed()
            if relaxed:
                return relaxed
        if self._fully_pinned():
            return self._confirm_pinned_result()
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
                # 유효 사전입력 (공휴일 OF 드롭 + 모성보호 드롭 — 공용 헬퍼)
                pre = self._effective_pre(nurse, dt, pre, is_holiday)
                active = self._nurse_active_on(nurse, dt)
                # 잠긴 셀 + 전월(역사) 기록은 완화에서도 하드 고정 — 전월 기록을
                # 변수로 두면 완화가 이미 일어난 과거를 '변조'한다 (HiGHS 패리티)
                locked = bool(self.locked_cells.get(nid, {}).get(dt_str)) \
                    or dt < date(self.year, self.month, 1)
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
                    elif pre == "주" and self.allow_juhu_relax:
                        # 주휴 무시(HiGHS 패리티): 주 유지 or 근무 전환 허용,
                        # 단 주→OF 금지(무의미) + 일반 게이팅 동일 적용
                        if s == "OF":
                            x[nid][d][s] = 0
                        elif s == "법" and (is_night or not is_holiday):
                            x[nid][d][s] = 0
                        elif s in ("생", "V") and is_holiday and not is_night:
                            x[nid][d][s] = 0
                        elif s == "생" and is_male:
                            x[nid][d][s] = 0
                        elif s != "주" and s != "법" and s not in self.SOLVER_SHIFTS:
                            x[nid][d][s] = 0
                        else:
                            x[nid][d][s] = model.NewBoolVar(f"rx_{nid}_{d}_{s}")
                    elif s == "법" and is_night:
                        x[nid][d][s] = 0
                    elif s == "법" and not is_holiday:
                        x[nid][d][s] = 0
                    elif s == "법" and is_holiday:
                        x[nid][d][s] = model.NewBoolVar(f"rx_{nid}_{d}_{s}")
                    elif s in ("생", "V") and is_holiday and not is_night:
                        x[nid][d][s] = 0
                    elif s not in self.SOLVER_SHIFTS and s != "법" and pre and s == pre:
                        # 사전입력 전용 코드 유지 변수 — 생(남성) 차단보다 먼저
                        # 평가해 HiGHS 분기 순서와 동일하게 (최소 침습: 유지 우선)
                        x[nid][d][s] = model.NewBoolVar(f"rx_{nid}_{d}_{s}")
                    elif s == "생" and is_male:
                        x[nid][d][s] = 0
                    elif s == "주" and self.allow_juhu_relax:
                        # 주휴 재배치: 임의 날짜에 '주' 배치 가능 (HiGHS 패리티)
                        x[nid][d][s] = model.NewBoolVar(f"rx_{nid}_{d}_{s}")
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
        from . import solver_progress as _sp0
        _sp0.record_event("relax_start", engine="CP-SAT")
        # 제약 함수(시니어리티 게이팅 등)에 '사전입력=소프트' 모드임을 알림
        self._pre_soft = True
        self._pin = {}  # 사실-클램프 비활성 — 완화 모드에선 제약이 온전히 걸려야 함
        x, pre_keeps = self._build_vars_relaxed(model)
        self._apply_hard_constraints(model, x)
        # 주휴 재배치 시 주당 주휴 ≤1 (HiGHS weekly_juhu 패리티 — 야간전담 제외)
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
                    juhu_terms = [x[nid][d].get("주", 0) for d in week_days]
                    var_terms = [t for t in juhu_terms if not isinstance(t, int)]
                    const_sum = sum(t for t in juhu_terms if isinstance(t, int))
                    # 사용자 고정(잠금 주휴) 존중 — 자유 변수만 잔여 한도로 제한
                    if var_terms:
                        model.Add(sum(var_terms) <= max(0, 1 - const_sum))
        obj_terms = self._build_objective_cpsat(model, x)
        # 사전순 지배 유지보너스 — 근무 < OFF < 연차류. 사용자 설정(preBonus*)을
        # HiGHS와 동일 소스에서 읽는다 (하드코딩 시 엔진별 완화 결과가 달라짐).
        _BONUS = {
            "work": int(getattr(self.rules, "preBonusWork", 500) or 0),
            "off": int(getattr(self.rules, "preBonusOff", 3000) or 0),
            "leave": int(getattr(self.rules, "preBonusLeave", 5000) or 0),
            "juhu": int(getattr(self.rules, "preBonusRest", 300) or 0),
        }
        keep_terms = []
        for nid, d, pre, flex_vars in pre_keeps:
            b = _BONUS[timeoff_class(pre)]
            for v in flex_vars:
                keep_terms.append(b * v)
        # ── 2단계 사전순 솔브 (HiGHS 완화 경로와 동일 정책) ───────────────────
        # 1단계: 유지 보너스만 최대화(gap 0) → 최소 침습 수준 확정.
        # 2단계: 그 수준을 하드로 고정하고 배점을 사용자 gap으로 최적화.
        # 1단계 미증명 시 dom 가중 단일 솔브(gap 0)로 폴백.
        stage2_gap = 0.0
        if keep_terms:
            model.Maximize(sum(keep_terms))
            s1 = cp_model.CpSolver()
            s1.parameters.max_time_in_seconds = max(30.0, float(self.time_limit) / 3)
            s1.parameters.relative_gap_limit = 0.0
            s1.parameters.num_workers = max(1, min(8, os.cpu_count() or 4))
            s1.parameters.random_seed = 1
            st1 = s1.Solve(model)
            if st1 == cp_model.INFEASIBLE:
                self._pre_soft = False
                return None
            if st1 == cp_model.OPTIMAL:
                best_keep = int(round(s1.ObjectiveValue()))
                model.Add(sum(keep_terms) >= best_keep)
                model.Maximize(sum(obj_terms) if obj_terms else 0)
                stage2_gap = float(self.mip_gap)
            else:
                max_score = max((abs(int(round(getattr(r, "score", 0)))) for r in self.scoring_rules), default=100)
                coarse = max_score * max(1, len(self.nurses)) * max(1, self.T) * max(1, len(self.scoring_rules)) + 1
                # scoring_rules와 무관한 상시 페널티항(이후달 V -500, v2/v3,
                # m2 -20100)까지 보수적 상한 가산 — 지배 붕괴 방지
                coarse += 25100 * max(1, self.T) * max(1, len(self.nurses))
                # 지배 분모는 보너스 조합 차의 최솟값인 gcd
                import math
                bonus_gcd = 0
                for b in _BONUS.values():
                    if b > 0:
                        bonus_gcd = math.gcd(bonus_gcd, b)
                dom = coarse // max(1, bonus_gcd) + 2
                model.Maximize(sum(obj_terms) + dom * sum(keep_terms))
        else:
            model.Maximize(sum(obj_terms) if obj_terms else 0)
            stage2_gap = float(self.mip_gap)
        from . import solver_progress
        prog = _CpSatProgress()
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = float(self.time_limit)
        solver.parameters.relative_gap_limit = stage2_gap
        solver.parameters.num_workers = max(1, min(8, os.cpu_count() or 4))
        solver.parameters.random_seed = 1
        def _relax_log_sink(item):
            # 완화 구간 incumbent도 SSE 로그로 — 기존엔 None이라 곡선 공백
            try:
                from . import api
                api._log_queue.put(item)
            except Exception:
                pass
        cb = _CpSatCb(prog, _relax_log_sink)
        prog.solver = solver
        solver_progress.register(prog)
        if prog.cancelled:
            solver_progress.unregister(prog)
            self._pre_soft = False
            return None
        try:
            status = solver.Solve(model, cb)
        finally:
            solver_progress.unregister(prog)
            self._pre_soft = False  # 플래그 누수 방지 (후속 분석 경로 보호)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return None
        schedule, extended = self._extract_solution(x, lambda v: solver.Value(v))
        nurse_scores, nurse_score_details = self._compute_nurse_scores(schedule)
        relaxed_cells = {}
        timeoff_changed = 0
        charge_promotions = 0
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
                    else:
                        charge_promotions += 1  # D→DC 등 차지 자동승격 (HiGHS 패리티)
        relax_count = sum(len(v) for v in relaxed_cells.values())
        work_changed = relax_count - timeoff_changed
        if relax_count == 0:
            relax_msg = "사전입력을 그대로 유지했습니다."
        else:
            relax_msg = f"⚠ 최소 침습 완화: 근무 {work_changed}건 조정"
            if timeoff_changed:
                relax_msg += f" · ⚠ 휴무 {timeoff_changed}건 변경(불가피 — 인원 추가/수요 감축 검토 권장)"
            relax_msg += "."
        if charge_promotions:
            relax_msg += f" (차지 자동승격 {charge_promotions}건: D→DC·E→EC 등)"
        return {
            "success": True,
            "schedule": schedule,
            "extended_schedule": extended,
            "nurse_scores": nurse_scores,
            "nurse_score_details": nurse_score_details,
            "relaxed_cells": relaxed_cells,
            "timeoff_relaxed_count": timeoff_changed,
            "charge_promotions": charge_promotions,
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
                # 유효 사전입력 (공휴일 OF 드롭 + 모성보호 드롭 — 공용 헬퍼)
                pre = self._effective_pre(nurse, dt, pre, is_holiday)
                pre_flex = self._PRE_FLEX.get(pre, {pre} if pre else set())
                # 사실-클램프: 날 전체 확정이면 문자 그대로 (HiGHS 패리티)
                if pre and self._pin and self._day_all_pinned(d, dt):
                    pre_flex = {pre}
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
                if self._pin.get((nid, d)):
                    continue  # 사실-클램프: 확정 셀 자격 소급 검증 안 함
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
            if self._day_all_pinned(d, dt):
                continue  # 사실-클램프: 확정된 날은 인원 검증 스킵 (HiGHS 패리티)
            for period, shifts in period_map.items():
                if period not in day_req:
                    continue
                required = max(0, int(day_req.get(period) or 0))
                required = max(required, self._pin_day_period_count(d, shifts))
                # 명시적 0도 == 제약으로 강제 ('정확히 일치' 사양 — HiGHS 패리티)
                exprs = [x[n["id"]][d][s] for n in self.nurses for s in shifts]
                if any(not isinstance(e, int) for e in exprs):
                    model.Add(sum(exprs) == required)
                elif sum(exprs) != required:
                    model.AddBoolOr([])  # 전부 고정인데 요구와 모순 — 명시적 infeasible

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
            if self._day_all_pinned(d, dt):
                continue  # 사실-클램프: 확정된 날의 차지 구성은 표 그대로
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
                if all(self._pin.get((nid, d)) for d in week_days):
                    continue  # 사실-클램프: 주 전체 확정
                bound = max(1, self._pin_nurse_count(nid, week_days, ("OF",)))
                of_sum = sum(x[nid][d][of_code] for d in week_days)
                # 오프특근(제1원칙 3): 공휴일 포함 주는 OF를 뺄 수 있다 → ≤ bound
                if len(week_days) >= 7 and not self._week_has_holiday(week_days):
                    model.Add(of_sum == bound)
                else:
                    model.Add(of_sum <= bound)

    def _cs_pregnancy_p1_weekly(self, model, x):
        """임산부: P1 구간 완전 포함 주마다 P1 정확히 1회 (부분 주 ≤1).
        HiGHS _c_pregnancy_p1_weekly 대응. 야간 제외·생 면제는 변수 게이팅으로 처리."""
        if "P1" not in self.ALL_SHIFTS:
            return
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            if not nurse.get("is_pregnant"):
                continue
            nid = nurse["id"]
            for ws, we in self.weeks:
                # 전월(역사) 날짜 제외 — 빈 과거 칸에 P1 '날조' 배치 방지
                win_days = [d for d in range(ws, we + 1)
                            if self.all_dates[d] >= first_of_month
                            and self._nurse_active_idx(nurse, d)
                            and self._preg_window_on(nid, self.all_dates[d])]
                if not win_days:
                    continue
                p1_vars = [x[nid][d]["P1"] for d in win_days
                           if not isinstance(x[nid][d].get("P1"), int)]
                if not p1_vars:
                    continue
                if all(self._pin.get((nid, d)) for d in win_days):
                    continue  # 사실-클램프
                bound = max(1, self._pin_nurse_count(nid, win_days, ("P1",)))
                full_week = (we - ws + 1) == len(win_days)
                if full_week and len(win_days) >= 7:
                    model.Add(sum(p1_vars) == bound)
                else:
                    model.Add(sum(p1_vars) <= bound)

    def _cs_max_v_per_month(self, model, x):
        max_v = self.rules.maxVPerMonth
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            if max_v > 0 and not self.unlimited_v:
                month_idx = [d for d, dt in enumerate(self.all_dates)
                             if dt.month == self.month and dt.year == self.year]
                v_vars = [x[nid][d]["V"] for d in month_idx]
                if v_vars:
                    cap = max(max_v, self._pin_nurse_count(nid, month_idx, ("V",)))
                    model.Add(sum(v_vars) <= cap)
            # 이전달 overflow: V 금지 — 사전입력으로 확정된 전월 기록은 존중
            # (무조건 금지하면 1일1근무와 모순돼 전체 infeasible)
            for d, dt in enumerate(self.all_dates):
                if dt < first_of_month and "V" in self.ALL_SHIFTS:
                    v = x[nid][d]["V"]
                    pre = self.prev.get(nid, {}).get(dt.strftime("%Y-%m-%d"))
                    if not isinstance(v, int) and pre != "V":
                        model.Add(v == 0)
            next_idx = [d for d, dt in enumerate(self.all_dates)
                        if (dt.month != self.month or dt.year != self.year) and dt >= first_of_month]
            next_v_vars = [x[nid][d]["V"] for d in next_idx]
            if next_v_vars:
                model.Add(sum(next_v_vars) <= max(1, self._pin_nurse_count(nid, next_idx, ("V",))))

    def _cs_max_night_per_month(self, model, x):
        max_n = self.rules.maxNightPerMonthCount
        for nurse in self.nurses:
            if nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            month_idx = [d for d, dt in enumerate(self.all_dates)
                         if dt.month == self.month and dt.year == self.year]
            night_vars = [x[nid][d][s] for d in month_idx for s in self.NIGHT_SHIFTS]
            if night_vars:
                cap = max(max_n, self._pin_nurse_count(nid, month_idx, self.NIGHT_SHIFTS))
                model.Add(sum(night_vars) <= cap)

    def _cs_max_night_two_month(self, model, x):
        max_n = self.rules.maxNightTwoMonthCount
        prev_nights = getattr(self, 'prev_month_nights', None) or {}
        for nurse in self.nurses:
            if nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            prev_count = prev_nights.get(nid, 0)
            month_idx = [d for d, dt in enumerate(self.all_dates)
                         if dt.month == self.month and dt.year == self.year]
            night_vars = [x[nid][d][s] for d in month_idx for s in self.NIGHT_SHIFTS]
            if night_vars:
                # RHS 음수 클램프 포함 (공용 헬퍼 — HiGHS 패리티) + 사실-클램프
                cap = max(self._two_month_rhs(nid),
                          self._pin_nurse_count(nid, month_idx, self.NIGHT_SHIFTS))
                model.Add(sum(night_vars) <= cap)

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
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T - 1):
                # 전월(역사) 내부 완결 쌍 제외 — 과거 기록에 현재 규칙 소급 금지
                if self.all_dates[d + 1] < first_of_month:
                    continue
                # 사실-클램프: 두 셀 모두 확정 = 사용자 사실 (HiGHS 패리티)
                if self._pin.get((nid, d)) and self._pin.get((nid, d + 1)):
                    continue
                for first_group, second_group in forbidden:
                    for s1 in first_group:
                        v1 = x[nid][d][s1]
                        v1_const = isinstance(v1, int)
                        # 상수 1(잠금/주휴 고정)은 식에 반영 — 건너뛰면 잠긴 셀 옆
                        # 자유 변수에 금지 전환이 안 걸린다 (HiGHS 패리티)
                        if v1_const and v1 != 1:
                            continue
                        for s2 in second_group:
                            v2 = x[nid][d + 1][s2]
                            v2_const = isinstance(v2, int)
                            if v2_const and v2 != 1:
                                continue
                            if v1_const and v2_const:
                                continue  # 둘 다 사용자 고정 — 사용자 입력 존중
                            model.Add(v1 + v2 <= 1)

    def _cs_nod_pattern(self, model, x):
        """N→휴무→D 금지 (vn+vr+vd<=2)."""
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T - 2):
                # 전월(역사) 내부 완결 윈도우 제외
                if self.all_dates[d + 2] < first_of_month:
                    continue
                if (self._pin.get((nid, d)) and self._pin.get((nid, d + 1))
                        and self._pin.get((nid, d + 2))):
                    continue  # 사실-클램프: 세 셀 모두 확정
                for ns in self.NIGHT_SHIFTS:
                    vn = x[nid][d][ns]
                    vn_const = isinstance(vn, int)
                    if vn_const and vn != 1:
                        continue
                    for rs in self.REST_SHIFTS:
                        vr = x[nid][d + 1][rs]
                        vr_const = isinstance(vr, int)
                        if vr_const and vr != 1:
                            continue
                        for ds in self.DAY_SHIFTS:
                            vd = x[nid][d + 2][ds]
                            vd_const = isinstance(vd, int)
                            if vd_const and vd != 1:
                                continue
                            if vn_const and vr_const and vd_const:
                                continue  # 전부 사용자 고정 — 사용자 입력 존중
                            model.Add(vn + vr + vd <= 2)

    def _cs_max_consecutive_work(self, model, x, max_days: int):
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            for start in range(self.T - max_days):
                if self.all_dates[start + max_days] < first_of_month:
                    continue  # 전월 내부 완결 윈도우 제외 (역사 소급 금지)
                window = range(start, start + max_days + 1)
                if all(self._pin.get((nid, d)) for d in window):
                    continue  # 사실-클램프
                model.Add(sum(x[nid][d][s] for d in window for s in self.WORK_SHIFTS) <= max_days)

    def _cs_max_consecutive_night(self, model, x, max_nights: int):
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            for start in range(self.T - max_nights):
                if self.all_dates[start + max_nights] < first_of_month:
                    continue  # 전월 내부 완결 윈도우 제외
                window = range(start, start + max_nights + 1)
                if all(self._pin.get((nid, d)) for d in window):
                    continue  # 사실-클램프
                model.Add(sum(x[nid][d][s] for d in window for s in self.NIGHT_SHIFTS) <= max_nights)

    def _cs_rest_after_night(self, model, x):
        """연속 야간(min_consec) 후 rest_days 일간 근무 불가.
        lhs = ΣN(d..d+mc-1) - ΣN(next) + ΣW(rest_d) <= min_consec (HiGHS _c_rest_after_night 대응)."""
        min_consec = getattr(self.rules, 'restAfterNightMinConsec', 2)
        rest_days = getattr(self.rules, 'restAfterNightDays', 2)
        first_of_month = date(self.year, self.month, 1)
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
                    if self.all_dates[rest_d] < first_of_month:
                        continue  # 전월(역사) 날짜에 휴식 강제 소급 금지
                    if self._pin.get((nid, rest_d)):
                        continue  # 사실-클램프: 확정된 휴식일 셀은 사용자 선택 그대로
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
        nurse_by_id = {n["id"]: n for n in self.nurses}
        for d, dt in enumerate(self.all_dates):
            if dt.month != self.month:
                continue
            dt_str = dt.strftime("%Y-%m-%d")
            is_holiday = dt_str in self.holidays
            for nid_i, nid_j, charge_s, regulars in eligible_pairs:
                # 사실-클램프: 두 셀 모두 확정이면 사용자 배치 그대로
                if self._pin.get((nid_i, d)) and self._pin.get((nid_j, d)):
                    continue
                # 선임 j의 '유효' 사전입력으로 게이팅 (공용 헬퍼 — HiGHS 패리티)
                j_fixed = self._seniority_jfixed(nurse_by_id[nid_j], dt, dt_str, is_holiday)
                if j_fixed and j_fixed != charge_s:
                    continue
                v_charge = x[nid_i][d][charge_s]
                vc_const = isinstance(v_charge, int)
                if vc_const and v_charge != 1:
                    continue
                for regular_s in regulars:
                    v_reg = x[nid_j][d][regular_s]
                    vr_const = isinstance(v_reg, int)
                    if vr_const and v_reg != 1:
                        continue
                    if vc_const and vr_const:
                        continue  # 둘 다 사용자 고정 — 사용자 입력 존중
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
            month_idx = [d for d, dt in enumerate(self.all_dates)
                         if dt.month == self.month and dt.year == self.year]
            month_vars = [x[nid][d]["생"] for d in month_idx]
            if month_vars:
                model.Add(sum(month_vars) <= max(1, self._pin_nurse_count(nid, month_idx, ("생",))))
            # 이전달 overflow: 생 금지 — 사전입력된 전월 확정 기록은 존중
            for d, dt in enumerate(self.all_dates):
                if dt < first_of_month:
                    v = x[nid][d]["생"]
                    pre = self.prev.get(nid, {}).get(dt.strftime("%Y-%m-%d"))
                    if not isinstance(v, int) and pre != "생":
                        model.Add(v == 0)
            next_idx = [d for d, dt in enumerate(self.all_dates)
                        if (dt.month != self.month or dt.year != self.year) and dt >= first_of_month]
            next_m = [x[nid][d]["생"] for d in next_idx]
            if next_m:
                model.Add(sum(next_m) <= max(1, self._pin_nurse_count(nid, next_idx, ("생",))))

    def _cs_night_shift_nurses(self, model, x):
        """야간전담: N/NC만, 5일 윈도우<=3, 당월 정확 14일. (생휴 강제 없음 — ≤1 상한만)"""
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
            active_days, night_target = self._night_dedicated_quota(
                nurse, month_idxs, month_days)
            if active_days <= 0:
                continue  # 당월 재적 없음 — ==14를 걸면 무조건 infeasible
            for d in month_idxs:
                if self._pin.get((nid, d)):
                    continue  # 사실-클램프: 확정 셀은 코드 그대로
                for s in non_night_work:
                    v = x[nid][d].get(s)
                    if v is not None and not isinstance(v, int):
                        model.Add(v == 0)
            # 5일 윈도우 ≤3 — 월 경계에 걸친 윈도우도 검사 (HiGHS 패리티)
            w_lo = max(0, month_idxs[0] - 4)
            w_hi = min(self.T - 5, month_idxs[-1])
            for start in range(w_lo, w_hi + 1):
                window = range(start, start + 5)
                if all(self._pin.get((nid, d)) for d in window):
                    continue  # 사실-클램프
                w_cap = max(3, self._pin_nurse_count(nid, window, self.NIGHT_SHIFTS))
                model.Add(sum(x[nid][d][s] for d in window
                              for s in self.NIGHT_SHIFTS) <= w_cap)
            # 야간 일수 — 재적 비례 + N 가용일 클램프 (공용 헬퍼, HiGHS 패리티)
            #   + 사실-클램프 (확정분 초과 시 실측 존중, 자유 일수 내 달성 가능치로)
            pin_n = self._pin_nurse_count(nid, month_idxs, self.NIGHT_SHIFTS)
            free_days = sum(1 for d in month_idxs
                            if self._nurse_active_idx(nurse, d) and not self._pin.get((nid, d)))
            eff_target = min(max(night_target, pin_n), pin_n + free_days)
            model.Add(sum(x[nid][d][s] for d in month_idxs for s in self.NIGHT_SHIFTS) == eff_target)
            # (과거 '여성+31일달 생 정확히 1회' 강제는 제거 — 생휴는 보장이 아님.
            #  월 ≤1 상한은 _cs_menstrual_leave가 담당. HiGHS 패리티)

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
                    # 위시 공정성 보정 (HiGHS 패리티)
                    wsc = int(round(sc * float(self.wish_boosts.get(nid, 1.0))))
                    for day_str, wish_shift in nurse.get("wishes", {}).items():
                        try:
                            ds = str(day_str)
                            # 일(day) 숫자 키와 'YYYY-MM-DD' 키 모두 허용
                            if "-" in ds:
                                wish_date = date.fromisoformat(ds)
                            else:
                                wish_date = date(self.year, self.month, int(ds))
                            if wish_date not in self.date_to_idx:
                                continue
                            d = self.date_to_idx[wish_date]
                            if wish_shift == "OFF":
                                terms.append(wsc * lin([x[nid][d][s] for s in self.REST_SHIFTS + self.LEAVE_SHIFTS]))
                            elif wish_shift in self.ALL_SHIFTS:
                                terms.append(wsc * x[nid][d][wish_shift])
                        except (ValueError, KeyError):
                            pass

            elif rt == "night_fairness":
                # 공정성 풀에서 야간전담(14 고정)·N 비자격·임산부 제외 — 포함 시
                # range가 상수화되어 일반 간호사 간 편차를 벌점하지 못한다 (HiGHS 패리티)
                # 야간 횟수가 구조적으로 고정된 간호사 제외 (공용 헬퍼, HiGHS 패리티)
                fairness_pool = self._night_fairness_pool()
                if len(fairness_pool) >= 2:
                    night_counts = {
                        nurse["id"]: lin([x[nurse["id"]][d][s] for d in month_days for s in self.NIGHT_SHIFTS])
                        for nurse in fairness_pool
                    }
                    max_off = max((int(self.fairness_offsets.get(n["id"], 0))
                                   for n in fairness_pool), default=0)
                    ub_fair = ub_nights + max_off
                    max_n = model.NewIntVar(0, ub_fair, f"max_nights_{rid}")
                    min_n = model.NewIntVar(0, ub_fair, f"min_nights_{rid}")
                    for nurse in fairness_pool:
                        nid = nurse["id"]
                        # 공정성 원장: (직전 달 누적 + 당월) 편차 최소화 (HiGHS 패리티)
                        off = int(self.fairness_offsets.get(nid, 0))
                        model.Add(max_n >= night_counts[nid] + off)
                        model.Add(min_n <= night_counts[nid] + off)
                    range_var = model.NewIntVar(0, ub_fair, f"night_range_{rid}")
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
