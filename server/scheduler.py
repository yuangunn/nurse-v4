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
from .scheduler_base import _SchedulerBase, timeoff_class, _FIXED_DATE_LEAVE
from .scheduler_highs_constraints import _HighsConstraintsMixin
from .scheduler_highs_diagnosis import _HighsDiagnosisMixin


# ── 상수 ────────────────────────────────────────────────────────────────────
# 기본 근무 목록·요일 키는 scheduler_base 한 곳에 둔다 (여기 있던 사본은 쓰이지 않았다)
from .scheduler_base import WEEKDAY_KEYS, _DEFAULT_SHIFTS  # noqa: E402,F401 (하위호환)


class _WarmHiGHS(pulp.HiGHS):
    """이어 찾기 — 앞 실행이 낸 표를 MIP 시작해로 넘기는 HiGHS (결정 1-50).

    pulp.HiGHS 엔 warmStart 가 없다. buildSolverModel 이 변수 번호(index)를 단 뒤, 풀기 직전에 setSolution 으로
    근무표 칸만 준다 — HiGHS 가 나머지 변수를 채워 그 표에서 출발한다 (실제 11월: 0.6초, 'MIP start solution is feasible').
    시작해가 이 모델에 맞지 않으면 HiGHS 가 버리고 처음부터 푼다."""

    def __init__(self, start=None, **kw):
        super().__init__(**kw)
        self._start = start or []

    def callSolver(self, lp):
        # 모델에 실린 변수만 (buildSolverModel 이 index 를 단다 — 어떤 제약에도 안 든 변수는 모델에 없다)
        start = [(v.index, b) for v, b in self._start if getattr(v, "index", None) is not None]
        if start:
            import numpy as np
            idx = np.array([i for i, _ in start], dtype=np.int32)
            val = np.array([float(b) for _, b in start], dtype=np.float64)
            lp.solverModel.setSolution(len(idx), idx, val)
        super().callSolver(lp)


def highs_fingerprint(h) -> str:
    """HiGHS 모델 지문 — 비용·변수/제약 범위·계수가 같으면 같다. 이어 찾기가 앞 실행의 하한을 이어 써도 되는지 가른다."""
    import hashlib
    import numpy as np
    lp = h.getLp()
    m = lp.a_matrix_
    hs = hashlib.sha1()
    for arr in (lp.col_cost_, lp.col_lower_, lp.col_upper_, lp.row_lower_, lp.row_upper_, m.start_, m.index_, m.value_):
        hs.update(np.asarray(arr, dtype=float).tobytes())
    return hs.hexdigest()[:16]


class NurseScheduler(_HighsConstraintsMixin, _HighsDiagnosisMixin, _SchedulerBase):

    @staticmethod
    def _highs_info(prob) -> dict:
        """풀이 뒤 목적값·하한(감점 점수 — pulp 의 최대화를 HiGHS 는 부호를 바꿔 최소화한다, 낮을수록 좋다)과 모델 지문.
        이어 찾기가 앞 표와 견주고 하한을 이어 쓴다 (결정 1-50)."""
        import math
        h = getattr(prob, "solverModel", None)
        if h is None:
            return {}
        out = {"engine": "HiGHS"}
        try:
            info = h.getInfo()
            # 해 없이 멈춘 풀이면 목적값 inf, 루트 LP 전에 멈추면 하한 -inf — JSON 이 못 실어 500 이 났다 (리뷰 2026-10-19)
            vals = {"objective": float(info.objective_function_value), "mip_dual_bound": float(info.mip_dual_bound),
                    "mip_gap_percent": round(float(info.mip_gap) * 100, 2)}
            if math.isfinite(vals["objective"]):
                out.update({k: v for k, v in vals.items() if math.isfinite(v)})
        except Exception:
            return out
        try:
            out["model_fingerprint"] = highs_fingerprint(h)
        except Exception:
            pass
        return out

    @staticmethod
    def _highs_no_solution(prob) -> bool:
        """마지막 HiGHS 풀이에 해가 없다고 확실할 때만 True — 중지(kInterrupt)를 pulp 가 못 읽으면 prob.status 가 앞 단계
        (완화 1단계)의 'Optimal' 로 남고 변수값이 0 이라, 그대로 두면 빈 근무표가 '성공'으로 나갔다 (리뷰 2026-10-19)."""
        h = getattr(prob, "solverModel", None)
        try:
            return h is not None and h.getInfo().primal_solution_status != 2   # 2 = kSolutionStatusFeasible
        except Exception:
            return False

    @staticmethod
    def _stopped_result() -> Dict:
        """중지 요청으로 표 없이 끝남 — '제한 시간 안에 못 만들었다'·원인 진단이 아니다."""
        return {"success": False, "schedule": {}, "extended_schedule": {},
                "message": "중지 요청으로 멈췄습니다 — 그때까지 찾은 표가 없습니다."}

    def _warm_highs(self, x, **kw) -> "_WarmHiGHS":
        """HiGHS 솔버 — 이어 찾기면 앞 표를 시작해로 (없으면 보통 pulp.HiGHS 와 같다)."""
        start = self._mip_start_pairs(x, lambda v: isinstance(v, pulp.LpVariable)) if self.warm_start else None
        return _WarmHiGHS(start=start, msg=False, **kw)

    def _c_juhu_block_dow(self, prob, x):
        """주휴를 재배치할 때도 **한 블록(4주기) 안에서는 같은 요일**을 지킨다.

        병동 관행: 1~4주기 동안 주휴 요일이 같고, 4주기→1주기로 넘어갈 때만 바뀐다.
        allow_juhu_relax 만 켜면 주당 ≤1 만 걸려서 주마다 요일이 흩어질 수 있었다.
        juhu_block_lock=False('주휴 이동 제한 풀기')면 걸지 않는다.
        달이 블록 중간에서 시작하면 그 블록은 지난달 요일 그대로 (_juhu_anchor, 결정 1-37).
        """
        self._juhu_anchor_dev = []
        if not (self.allow_juhu_relax and self.juhu_block_lock):
            return
        if "주" not in self.ALL_SHIFTS:
            return
        for nurse in self.nurses:
            nid = nurse["id"]   # 나이트킵의 날은 _juhu_block_items 가 날짜마다 뺀다 (결정 1-33)
            blocks = self._juhu_block_items(
                nurse, x, lambda t: isinstance(t, pulp.LpVariable))
            anchor = self._juhu_anchor(nurse)
            for blk, items in blocks.items():
                dows = sorted({wd for _, wd, _ in items})
                # 지난달 요일에 옮길 칸이 없으면(잠근 근무·재적 밖) 어느 요일이든 같은 감점이라 잇지 않는다
                anchored = bool(anchor) and blk == anchor[0] and anchor[1] in dows
                if len(dows) <= 1:
                    continue
                y = {wd: pulp.LpVariable(f"juhudow_{nid}_{blk}_{wd}", cat="Binary")
                     for wd in dows}
                prob += (pulp.lpSum(y.values()) <= 1, f"juhu_blk_one_{nid}_{blk}")
                for d, wd, t in items:
                    prob += (t <= y[wd], f"juhu_blk_{nid}_{blk}_{d}")
                if anchored:   # 지난달에 시작한 블록 — 지난달 요일이 아니면 감점 (완화 1단계)
                    self._juhu_anchor_dev += [y[wd] for wd in dows if wd != anchor[1]]
    def solve(self) -> Dict:
        if not self.nurses:
            return {"success": False, "message": "간호사가 등록되지 않았습니다.", "schedule": {}}

        nurse_ids = [n["id"] for n in self.nurses]
        self._pre_soft = False  # strict 모드 — 사전입력은 변수 도메인으로 고정
        self._build_pin_index()  # 사실-클램프: 확정 셀 인덱스 (완화 요청 시 빈 dict)
        prob = pulp.LpProblem("nurse_schedule", pulp.LpMaximize)

        # 변수 생성: x[nurse_id][day_idx][shift] ∈ {0,1} 또는 상수 0
        # 성능 최적화: 항상 0인 변수는 LpVariable 대신 정수 0 사용
        x: Dict[str, Dict[int, Dict[str, object]]] = {}
        _free_vars: list = []  # has_solution 스캔용 (Finding 5)
        for nurse in self.nurses:
            nid = nurse["id"]
            x[nid] = {}
            is_male = nurse.get("gender") != "female"
            for d in range(self.T):
                dt = self.all_dates[d]
                dt_str = dt.strftime("%Y-%m-%d")
                x[nid][d] = {}
                pre = self.prev.get(nid, {}).get(dt_str)
                is_holiday = dt_str in self.holidays
                is_night = self._keeper_on(nurse, dt)   # 날짜가 속한 달의 나이트킵 (다음 달 며칠 포함)
                # 유효 사전입력 (공휴일 OF 드롭[일반 간호사] + 모성보호 드롭 — 공용 헬퍼)
                pre = self._effective_pre(nurse, dt, pre, is_holiday)
                pre_flex = self._PRE_FLEX.get(pre, {pre} if pre else set())
                # 사실-클램프: 날 전체가 확정이면 문자 그대로 (차지 승격 여지도 불필요 —
                # 인원/차지 제약이 스킵되므로 플렉스를 남기면 임의 승격이 생긴다)
                if pre and self._pin and self._day_all_pinned(d, dt):
                    pre_flex = {pre}
                # 전입/전출일 범위 밖: 모든 shift 0으로 고정
                if not self._nurse_active_on(nurse, dt):
                    for s in self.ALL_SHIFTS:
                        x[nid][d][s] = 0
                    continue
                for s in self.ALL_SHIFTS:
                    # OF는 공휴일에 배정 불가 (하드 제약) — 일반 간호사만. 야간전담은 법 대신 OF
                    if s == "OF" and self._holiday_of_banned(nurse, is_holiday, dt):
                        x[nid][d][s] = 0
                        continue
                    # 임산부 모성보호 게이팅 (P1 구간 외/야간 제외/생 면제 → 0 고정)
                    if self._preg_forbids(nurse, dt, s, pre):
                        x[nid][d][s] = 0
                        continue
                    # 다음 달 나이트킵: 생성 달 뒤 며칠에도 야간 외 근무 금지 (사전입력은 사실)
                    if self._keeper_forbids(nurse, dt, s, pre):
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
        self._apply_flex_wishes(x)                     # 원티드 D/E·N제외 — 허용 근무만

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
        self._c_pregnancy_p1_weekly(prob, x)           # 임산부 P1 주1회 (모성보호)
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

        from . import solver_progress as _sp
        try:
            _sp.record_event("model", engine="HiGHS",
                             vars=prob.numVariables(), cons=prob.numConstraints())
        except Exception:
            pass
        solver = self._warm_highs(x, timeLimit=self.time_limit, mip_rel_gap=self.mip_gap)
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
        if (status_str in ("Optimal", "Feasible") or has_solution) and self._highs_no_solution(prob):
            status_str, has_solution = "Not Solved", False

        if status_str in ("Optimal", "Feasible") or (has_solution and status_str != "Infeasible"):
            schedule, extended = self._extract_solution(x, lambda v: pulp.value(v))
            nurse_scores, nurse_score_details = self._compute_nurse_scores(schedule)
            label = "중지" if status_str not in ("Optimal", "Feasible") else status_str
            return self._attach_pin_notes({
                "success": True,
                "schedule": schedule,
                "extended_schedule": extended,
                "nurse_scores": nurse_scores,
                "nurse_score_details": nurse_score_details,
                "message": f"근무표가 생성되었습니다. (상태: {label})",
                "estimated_seconds": self.estimate_seconds(),
                **self._highs_info(prob),
            })
        elif status_str == "Infeasible":
            # ── 사전입력 완화 재시도 ────────────────────────────────────
            if self.allow_pre_relax and self._has_pre():
                relax_result = self._solve_with_relaxed_pre()
                if relax_result:
                    return relax_result
            # ── 완전 확정 표: 검증 거부 대신 그대로 확정 (+규칙 차이 안내) ──
            if self._fully_pinned():
                return self._confirm_pinned_result()
            from . import solver_progress
            if solver_progress.is_cancelled():       # 완화 중 멈춤 — 진단을 돌리지 않는다
                return self._stopped_result()
            if getattr(self, "_relax_timed_out", False):
                return self._relax_timeout_result()
            # 즉시 판정된 Infeasible → 진단 실행 (각 단계 10초 이내)
            diagnosis = self._diagnose_infeasibility()
            return {
                "success": False,
                "schedule": {},
                "extended_schedule": {},
                "message": diagnosis,
                # 진단이 짚은 셀 좌표 — 프론트 '충돌 위치로 이동' 칩 재사용
                "anchored": getattr(self, "_diagnosis_anchors", []),
            }
        else:
            # Not Solved = 타임아웃 또는 해 없이 중단.
            # 사용자 '중지' 또는 레이스 패자 취소(cancel_all) 후에는 완화 재시도를
            # 시작하지 않는다 — 취소를 무시하고 최대 time_limit짜리 새 솔브를
            # (등록 불가 상태로) 도는 셈이 된다.
            from . import solver_progress
            if (self.allow_pre_relax and self._has_pre()
                    and not solver_progress.is_cancelled()
                    and not solver_progress.was_cancel_all()):
                relax_result = self._solve_with_relaxed_pre()
                if relax_result:
                    return relax_result
            if self._fully_pinned():
                return self._confirm_pinned_result()
            if solver_progress.is_cancelled():
                return self._stopped_result()
            if getattr(self, "_relax_timed_out", False):
                return self._relax_timeout_result()
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
        from . import solver_progress as _sp
        _sp.record_event("relax_start", engine="HiGHS")
        # 제약 함수(시니어리티 게이팅 등)에 '사전입력=소프트' 모드임을 알린다 —
        # 완화 모드에서 원본 prev로 게이팅하면 하드 제약이 통째로 사라진다.
        self._pre_soft = True
        self._pin = {}  # 사실-클램프 비활성 — 완화 모드에선 제약이 온전히 걸려야 함
        pre_bonus_terms = []
        # 최소 침습 차등 보너스(높을수록 보호 → 늦게 완화). 휴무는 간호사 개인의 시간이라
        # 강하게 보호: 근무 < OFF < 연차류. 주휴(주)는 기본 하드 고정(allow_juhu_relax 시에만).
        PRE_BONUS_LEAVE = getattr(self.rules, 'preBonusLeave', 5000)   # 연차/생리/특/공/법/병/경가/조가/산전
        PRE_BONUS_OFF   = getattr(self.rules, 'preBonusOff', 3000)     # OFF 휴식 (보호)
        PRE_BONUS_WORK  = getattr(self.rules, 'preBonusWork', 500)     # 근무 (먼저 완화)
        PRE_BONUS_REST  = getattr(self.rules, 'preBonusRest', 300)     # 주휴 — allow_juhu_relax 시
        # 날이 정해진 휴가(경가·조가·공·특·병·산전)는 오프특근보다 먼저 지킨다 (결정 1-35)
        PRE_BONUS_FIXED = self._relax_fixed_leave_bonus(PRE_BONUS_LEAVE, PRE_BONUS_OFF, PRE_BONUS_WORK)

        def _pre_bonus_for(code: str, nid: str = "") -> int:
            if code in _FIXED_DATE_LEAVE:
                return PRE_BONUS_FIXED
            cls = timeoff_class(code)
            if cls == "juhu":
                return PRE_BONUS_REST      # 주휴는 개인 요청이 아니라 법정 요일 — 보정 없음
            base = PRE_BONUS_LEAVE if cls == "leave" else PRE_BONUS_OFF if cls == "off" else PRE_BONUS_WORK
            # 완화 이력 보정: 지난달들에 원티드가 뒤집힌 사람은 이번 달 더 강하게 지킨다
            return int(round(base * float(self.relax_boosts.get(nid, 1.0))))

        x: Dict[str, Dict[int, Dict[str, object]]] = {}
        _free_vars_r: list = []
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            x[nid] = {}
            is_male = nurse.get("gender") != "female"
            for d in range(self.T):
                dt = self.all_dates[d]
                dt_str = dt.strftime("%Y-%m-%d")
                x[nid][d] = {}
                pre = self.prev.get(nid, {}).get(dt_str)
                is_holiday = dt_str in self.holidays
                is_night = self._keeper_on(nurse, dt)   # 날짜가 속한 달의 나이트킵 (다음 달 며칠 포함)
                # 유효 사전입력 (공휴일 OF 드롭[일반 간호사] + 모성보호 드롭 — 공용 헬퍼)
                pre = self._effective_pre(nurse, dt, pre, is_holiday)
                # 전입/전출일 범위 밖: 모든 shift 0으로 고정
                if not self._nurse_active_on(nurse, dt):
                    for s in self.ALL_SHIFTS:
                        x[nid][d][s] = 0
                    continue
                # 잠긴 셀 + 전월(역사) 기록: 완화 모드에서도 하드 고정 —
                # 전월 기록을 변수로 두면 완화가 이미 일어난 과거를 '변조'한다
                is_locked = bool(self.locked_cells.get(nid, {}).get(dt_str)) \
                    or dt < first_of_month
                if is_locked and pre:
                    keep = self._locked_domain(nurse, dt, pre)   # 잠긴 D·E·N 은 차지로 올릴 수 있다
                    for s in self.ALL_SHIFTS:
                        if s in keep and len(keep) > 1:
                            v = pulp.LpVariable(f"r_{nid}_{d}_{s}", cat="Binary")
                            x[nid][d][s] = v
                            _free_vars_r.append(v)
                        else:
                            x[nid][d][s] = 1 if s == pre else 0
                    continue
                for s in self.ALL_SHIFTS:
                    # OF는 공휴일에 배정 불가 (하드 제약, 완화 모드 포함) — 일반 간호사만. 야간전담은 법 대신 OF
                    if s == "OF" and self._holiday_of_banned(nurse, is_holiday, dt):
                        x[nid][d][s] = 0
                        continue
                    # 임산부 모성보호 게이팅 (P1 구간 외/야간 제외/생 면제 → 0 고정)
                    if self._preg_forbids(nurse, dt, s, pre):
                        x[nid][d][s] = 0
                        continue
                    # 다음 달 나이트킵: 생성 달 뒤 며칠에도 야간 외 근무 금지 (원티드도 — 잠긴 칸은 위에서 고정)
                    if self._keeper_forbids(nurse, dt, s):
                        x[nid][d][s] = 0
                        continue
                    # 주휴 처리
                    if pre == "주":
                        if self.allow_juhu_relax:
                            # 주휴 무시: 주 유지 or 근무 전환 허용, 단 주→OF 금지(무의미).
                            # 일반 게이팅(법 공휴일 한정·생 성별·사전입력 전용 코드 차단)도
                            # 동일 적용 — 없으면 남성 생리휴가·비공휴일 법·특/공/병 같은
                            # 코드가 자유 배정될 수 있다.
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
                    elif s == "주" and self.allow_juhu_relax and self._relax_juhu_free_ok(nurse, d):
                        # 주휴 재배치 — 나이트킵의 날엔 그 주에 미리 넣은 주휴를 옮길 때만 (제1원칙 10)
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
                    bonus_amount = _pre_bonus_for(pre, nid)
                    for s in pre_flex:
                        v = x[nid][d].get(s)
                        if isinstance(v, pulp.LpVariable):
                            pre_bonus_terms.append(bonus_amount * v)
        # 원티드 D/E·N제외: 허용 근무 중 하나면 근무 원티드를 지킨 것 (잠긴 칸·지난달은 하드)
        for nid, d, code, terms in self._apply_flex_wishes(x, soft=True):
            bonus_amount = _pre_bonus_for(code, nid)
            pre_bonus_terms.extend(bonus_amount * v for v in terms)

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
        self._c_pregnancy_p1_weekly(prob, x)           # 임산부 P1 주1회 (모성보호)
        self._c_juhu_block_dow(prob, x)
        # 주휴 재배치: 주당 주휴 최대 1개 하드 제약 (나이트킵의 날·일반의 날 각각)
        # + 사전입력 주휴가 있던 주는 주휴를 옮길 수는 있어도 없애지 않는다 — 주휴는 오프특근 때도
        #   깎이지 않는 최소한의 휴무다 (제1원칙 3). 유지 보너스(300)만으로는 오프특근(5100)을
        #   피하려고 주휴를 지웠다. 없애면 _relax_juhu_drop_pen(기본 14900)만큼 깎는다 —
        #   오프특근 < 주휴 없애기 < 날이 정해진 휴가 (결정 1-36)
        # 나이트킵도 건다 — 빼면 미리 넣은 주휴가 근무로 바뀌거나(다음 달 며칠엔 일반 간호사인데도)
        #   한 주에 주휴가 여럿 생겼다. 근무일 수는 14일로 정해져 있어 어느 쉬는 날이 주휴인지만 정한다.
        _juhu_drop: list = []
        if self.allow_juhu_relax and "주" in self.ALL_SHIFTS:
            for nurse in self.nurses:
                nid = nurse["id"]
                for ws, we in self.weeks:
                    week_days = [d for d in range(ws, we + 1)
                                 if self.all_dates[d] >= first_of_month]
                    if not week_days:
                        continue
                    # 나이트킵의 날과 일반의 날은 따로 — 상한도 바닥도 묶음마다 (_juhu_week_segments)
                    for seg in self._juhu_week_segments(nurse, week_days):
                        juhu_terms = [x[nid][d]["주"] for d in seg]
                        seg_vars = [t for t in juhu_terms if isinstance(t, pulp.LpVariable)]
                        const_sum = sum(t for t in juhu_terms
                                        if not isinstance(t, pulp.LpVariable))
                        # 사용자 고정(잠금 주휴) 존중: 상수 합이 한도를 넘어도 모순
                        # 제약(2<=1)을 만들지 않고, 솔버 자유 변수만 잔여 한도로 제한
                        # (CP-SAT 쪽과 동일 의미로 통일).
                        if seg_vars:
                            prob += (
                                pulp.lpSum(seg_vars) <= max(0, 1 - const_sum),
                                f"weekly_juhu_{nid}_{seg[0]}"
                            )
                        # 그 칸이 엔진이 실제로 옮길 수 있는 주휴일 때만 — 재적 밖(전입 전·전출 뒤)에 남은 주는 없는 칸
                        if const_sum >= 1:
                            continue
                        if seg_vars and any(
                                self.prev.get(nid, {}).get(self.all_dates[d].strftime("%Y-%m-%d")) == "주"
                                and isinstance(x[nid][d]["주"], pulp.LpVariable)
                                for d in seg):
                            u = pulp.LpVariable(f"juhu_drop_{nid}_{seg[0]}", cat="Binary")
                            prob += (pulp.lpSum(seg_vars) + u >= 1, f"weekly_juhu_floor_{nid}_{seg[0]}")
                            _juhu_drop.append(u)
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
            # ── 2단계 사전순 솔브 ────────────────────────────────────────────
            # 1단계: '사전입력 유지 보너스'만 최대화(gap 0) → 최소 침습 수준을
            #         정확히 확정.
            # 2단계: 그 수준을 하드 제약으로 고정하고 배점을 사용자 gap으로 최적화.
            # → dom 가중 단일 솔브의 '거대 계수 + 상대 갭에 의한 보존 희생' 문제를
            #   모두 제거. 1단계가 시간 내 증명 안 되면 가중 방식(gap 0)으로 폴백.
            bonus_expr = pulp.lpSum(pre_bonus_terms)
            # 파트장 확인 마지막 수단(제1원칙 13)도 1단계에서 원티드와 맞바꾼다 —
            # 근무 원티드(500) 하나를 지키려고 6일 연속(1500~3000)을 만들지 않게.
            # 오프특근도 같이 넣는다 — 빠지면 6일 연속 대신 오프특근을 공짜로 고른다 (원티드보다 나중).
            lr = self._last_resort_terms() + self._relax_off_teukgeun_terms(
                PRE_BONUS_LEAVE, PRE_BONUS_OFF, PRE_BONUS_WORK)
            # 주휴 없애기 — 오프특근보다 나중, 날이 정해진 휴가보다 먼저 (유지 보너스까지 더해도 그 휴가 한 칸보다 작게)
            _juhu_drop_pen = self._relax_juhu_drop_pen(
                PRE_BONUS_REST, PRE_BONUS_LEAVE, PRE_BONUS_OFF, PRE_BONUS_WORK)
            lr += [(_juhu_drop_pen, u) for u in _juhu_drop]
            # 지난달에 시작한 블록의 요일 어기기 (결정 1-37)
            _anchor_pen = self._juhu_anchor_pen(PRE_BONUS_OFF, PRE_BONUS_LEAVE)
            lr += [(_anchor_pen, y) for y in getattr(self, "_juhu_anchor_dev", [])]
            if lr:
                bonus_expr = bonus_expr - pulp.lpSum(pen * sl for pen, sl in lr)
            prob.setObjective(bonus_expr)
            stage1 = self._warm_highs(x, timeLimit=max(30, int(self.time_limit) // 3), mip_rel_gap=0.0)
            try:
                prob.solve(stage1)
            except Exception:
                pass
            s1_status = pulp.constants.LpStatus.get(prob.status, "Unknown")
            if s1_status == "Infeasible":
                self._pre_soft = False
                self._relax_timed_out = False
                return None
            if s1_status == "Optimal":
                best_keep = int(round(pulp.value(bonus_expr) or 0))
                prob += bonus_expr >= best_keep, "keep_bonus_floor"
                prob.setObjective(obj)
                solver = self._warm_highs(x, timeLimit=self.time_limit, mip_rel_gap=self.mip_gap)
            else:
                # 폴백: dom 가중 단일 솔브 — 사전순 지배 스케일.
                # 배점 상한: 이진 변수는 |계수|, 정수 보조변수(night_range·v2/v3
                # 등, 값 상한 ≤ T)는 |계수|×T. 이진성은 bounds로 판정(pulp는
                # cat="Binary"를 'Integer'로 정규화해 저장).
                scoring_bound = 0
                for var, coef in obj.items():
                    is_bin = (getattr(var, "lowBound", None) == 0
                              and getattr(var, "upBound", None) == 1)
                    span = 1 if is_bin else max(1, self.T)
                    scoring_bound += abs(coef) * span
                # 보너스 '조합 차'의 최솟값은 gcd — 예: 휴가 1건(5000) vs
                # 주휴3+근무8(4900)의 차는 100.
                import math
                bonus_gcd = 0
                for b in (PRE_BONUS_LEAVE, PRE_BONUS_OFF, PRE_BONUS_WORK, PRE_BONUS_REST,
                          PRE_BONUS_FIXED, *(pen for pen, _ in lr)):
                    if b > 0:
                        bonus_gcd = math.gcd(bonus_gcd, int(b))
                dom = int(scoring_bound // max(1, bonus_gcd)) + 2
                prob.setObjective(obj + dom * bonus_expr)
                # 가중 방식에선 gap=0 필수 — 상대 갭만큼 보존이 희생될 수 있음
                solver = self._warm_highs(x, timeLimit=self.time_limit, mip_rel_gap=0.0)
        else:
            prob.setObjective(obj)
            solver = self._warm_highs(x, timeLimit=self.time_limit, mip_rel_gap=self.mip_gap)
        try:
            prob.solve(solver)
        except Exception:
            pass
        finally:
            # 플래그 누수 방지 — 이후 진단(_diagnose_infeasibility)이 soft 게이팅
            # 으로 빌드되면 strict 모델과 다른 모델을 진단하게 된다
            self._pre_soft = False

        status_str = pulp.constants.LpStatus.get(prob.status, "Unknown")
        has_solution = any(
            v.varValue is not None and v.varValue > 0.5
            for v in _free_vars_r
        )
        # 1단계와 같은 prob — 2단계가 첫 해 전에 멈추면 1단계의 'Optimal' 이 남는다. 마지막 풀이에 해가 있을 때만 결과로 쓴다
        if (status_str in ("Optimal", "Feasible") or has_solution) and self._highs_no_solution(prob):
            status_str, has_solution = "Not Solved", False


        if status_str in ("Optimal", "Feasible") or (has_solution and status_str != "Infeasible"):
            schedule, extended = self._extract_solution(x, lambda v: pulp.value(v))
            nurse_scores, nurse_score_details = self._compute_nurse_scores(schedule)

            # 사전입력과 다르게 배정된 셀 찾기 (PRE_FLEX 내 변환은 승격으로 분리 집계)
            relaxed_cells: Dict[str, Dict[str, Dict[str, object]]] = {}
            timeoff_changed = 0
            charge_promotions = 0
            for nid, days in self.prev.items():
                for dt_str, pre_shift in days.items():
                    assigned = schedule.get(nid, {}).get(dt_str)
                    if assigned and assigned != pre_shift:
                        pre_flex = self._PRE_FLEX.get(pre_shift, {pre_shift})
                        if assigned not in pre_flex:
                            is_timeoff = timeoff_class(pre_shift) != "work"
                            if is_timeoff:
                                timeoff_changed += 1
                            relaxed_cells.setdefault(nid, {})[dt_str] = {
                                "original": pre_shift,
                                "assigned": assigned,
                                "is_timeoff": is_timeoff,
                            }
                        else:
                            # D→DC, E→EC 차지 자동승격 — 변경은 아니지만 표가
                            # 입력과 달라지므로 별도 집계해 사용자에게 알린다
                            charge_promotions += 1
            self._flex_relaxed(schedule, relaxed_cells)    # 못 지킨 원티드 D/E·N제외 (근무)

            label = "중지" if status_str not in ("Optimal", "Feasible") else status_str
            relax_count = sum(len(v) for v in relaxed_cells.values())
            work_changed = relax_count - timeoff_changed
            # 투명성: 무엇을 얼마나 바꿨는지 + 휴무(OFF·연차류) 변경은 별도 경고
            if relax_count == 0:
                relax_msg = "사전입력을 그대로 유지했습니다."
            else:
                relax_msg = f"⚠ 최소 침습 완화: 근무 {work_changed}건 조정"
                if timeoff_changed:
                    relax_msg += f" · ⚠ 휴무 {timeoff_changed}건 변경(불가피 — 인원 추가/수요 감축 검토 권장)"
                relax_msg += "."
            if charge_promotions:
                relax_msg += f" (차지 자동승격 {charge_promotions}건: D→DC·E→EC 등)"
            return self._attach_reports({
                "success": True,
                "schedule": schedule,
                "extended_schedule": extended,
                "nurse_scores": nurse_scores,
                "nurse_score_details": nurse_score_details,
                "relaxed_cells": relaxed_cells,
                "timeoff_relaxed_count": timeoff_changed,
                "charge_promotions": charge_promotions,
                "message": f"근무표가 생성되었습니다. (상태: {label})\n{relax_msg}",
                "estimated_seconds": self.estimate_seconds(),
                **self._highs_info(prob),
            })
        # 완화해도 해를 못 찾음 — 시간이 모자랐는지(진단 대신 시간 안내) 정말 안 되는지
        self._relax_timed_out = (status_str != "Infeasible" and not _sp.is_cancelled()
                                 and not _sp.was_cancel_all())
        return None

    # ── 결과 추출 ────────────────────────────────────────────────────────────
