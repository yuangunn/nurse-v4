"""
충돌 분석 서비스 (CP-SAT assumptions) — 엔진 독립.

infeasible일 때 "어느 제약이 동시 충족 불가인지"를 1회 호출로 짚는다. HiGHS·CP-SAT
어느 엔진으로 생성하다 막혀도 호출 가능 (POST /api/diagnose).

핵심 차이(Phase 4의 CpSatScheduler와): CpSatScheduler는 제약을 무조건(model.Add)
걸지만, 여기서는 각 하드 제약 그룹을 enforce 리터럴로 게이팅(.OnlyEnforceIf(lit))하고
모든 리터럴을 assumption으로 추가한다. INFEASIBLE이면
solver.SufficientAssumptionsForInfeasibility()가 충돌 리터럴 집합을 반환하고,
역매핑 테이블로 한국어 메시지를 만든다.

구조 제약(1일1근무·자격)은 게이팅하지 않는다(완화 불가한 도메인 규칙).
게이팅 대상(완화 가능 충돌원): 일별 인원·charge·주휴/OF·V월한도·야간전담·생리휴가·
사전입력 금지전환.
"""
from __future__ import annotations

from datetime import date
from typing import Dict, List

from ortools.sat.python import cp_model

from .models import GenerateRequest
from .scheduler_cpsat import CpSatScheduler
from .scheduler_base import WEEKDAY_KEYS


class _ConflictAnalyzer(CpSatScheduler):
    """CpSatScheduler의 _build_vars + 데이터 상속, 게이팅 모델로 충돌 분석."""

    def analyze(self) -> Dict:
        if not self.nurses:
            return {"conflicts": [], "message": "간호사가 없습니다."}

        model = cp_model.CpModel()
        x = self._build_vars(model)
        self._labels: Dict[int, str] = {}   # lit.Index() → 한국어 라벨
        lits: List = []

        def gate(label: str):
            lit = model.NewBoolVar(f"assume_{len(lits)}")
            self._labels[lit.Index()] = label
            lits.append(lit)
            return lit

        # 구조 제약 (게이팅 X)
        self._cs_one_shift_per_day(model, x)
        self._cs_shift_eligibility(model, x)

        # 게이팅 대상
        self._g_daily_requirements(model, x, gate)
        self._g_charge_requirements(model, x, gate)
        if self.rules.weeklyOff:
            self._g_weekly_off(model, x, gate)
        self._g_max_v(model, x, gate)
        self._g_night_dedicated(model, x, gate)
        self._g_menstrual(model, x, gate)
        self._g_forbidden(model, x, gate)

        if not lits:
            return {"conflicts": [], "message": "분석할 완화 가능 제약이 없습니다."}

        model.AddAssumptions(lits)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 20.0
        status = solver.Solve(model)

        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return {"conflicts": [],
                    "message": "하드 제약만으로는 실현 가능합니다 (충돌 없음). "
                               "충돌은 소프트/완화 조합 또는 솔버 타임아웃일 수 있습니다."}
        if status != cp_model.INFEASIBLE:
            return {"conflicts": [],
                    "message": f"충돌 분석 미완료 (CP-SAT 상태: {solver.StatusName(status)})."}

        idxs = solver.SufficientAssumptionsForInfeasibility()
        conflicts = []
        seen = set()
        for i in idxs:
            lab = self._labels.get(i)
            if lab and lab not in seen:
                seen.add(lab)
                conflicts.append(lab)

        if not conflicts:
            msg = "충돌이 감지되었으나 구체 제약을 특정하지 못했습니다."
        else:
            msg = ("다음 제약들이 동시에 충족될 수 없습니다 "
                   f"(충돌 {len(conflicts)}건):\n" + "\n".join(f"  · {c}" for c in conflicts))
        return {"conflicts": conflicts, "message": msg}

    # ── 게이팅 제약 (라벨 = 한국어 핀포인트) ──────────────────────────────────
    def _cur_day_req(self, dt):
        date_key = dt.strftime('%Y-%m-%d')
        req_dict = self.req.model_dump()
        base = req_dict.get(WEEKDAY_KEYS[dt.weekday()], {})
        is_cur = (dt.month == self.month and dt.year == self.year)
        ovr = self.per_day_req.get(date_key, {}) if is_cur else {}
        return {**base, **ovr} if ovr else base

    def _g_daily_requirements(self, model, x, gate):
        period_map = {"D": self.DAY_SHIFTS, "E": self.EVENING_SHIFTS, "N": self.NIGHT_SHIFTS}
        first = date(self.year, self.month, 1)
        for d, dt in enumerate(self.all_dates):
            if dt < first:
                continue
            day_req = self._cur_day_req(dt)
            for period, shifts in period_map.items():
                req = day_req.get(period, 0)
                if req <= 0:
                    continue
                lit = gate(f"{self._fmt_date(dt)} {period} 필요 인원 {req}명")
                model.Add(sum(x[n["id"]][d][s] for n in self.nurses for s in shifts) == req).OnlyEnforceIf(lit)

    def _g_charge_requirements(self, model, x, gate):
        period_to_req = {"day": "D", "evening": "E", "night": "N"}
        charge_shifts = [s for s in self._shifts if s["is_charge"]]
        first = date(self.year, self.month, 1)
        for d, dt in enumerate(self.all_dates):
            if dt < first:
                continue
            day_req = self._cur_day_req(dt)
            for s in charge_shifts:
                rk = period_to_req.get(s["period"])
                if rk and day_req.get(rk, 0) > 0:
                    lit = gate(f"{self._fmt_date(dt)} {s['code']} 차지 1명 필요")
                    model.Add(sum(x[n["id"]][d][s["code"]] for n in self.nurses) == 1).OnlyEnforceIf(lit)

    def _g_weekly_off(self, model, x, gate):
        if "OF" not in self.SOLVER_SHIFTS:
            return
        first = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            if nurse.get("is_night_shift", False):
                continue
            for wi, (ws, we) in enumerate(self.weeks):
                week_days = [d for d in range(ws, we + 1)
                             if self.all_dates[d] >= first and self._nurse_active_idx(nurse, d)]
                if len(week_days) >= 7:
                    lit = gate(f"{self._fmt_nurse_label(nurse)} {wi+1}주차 OF 1회 의무")
                    model.Add(sum(x[nid][d]["OF"] for d in week_days) == 1).OnlyEnforceIf(lit)

    def _g_max_v(self, model, x, gate):
        max_v = self.rules.maxVPerMonth
        if max_v <= 0 or self.unlimited_v:
            return
        for nurse in self.nurses:
            nid = nurse["id"]
            v_vars = [x[nid][d]["V"] for d, dt in enumerate(self.all_dates)
                      if dt.month == self.month and dt.year == self.year]
            if v_vars:
                lit = gate(f"{self._fmt_nurse_label(nurse)} V(연차) 월 {max_v}회 이하")
                model.Add(sum(v_vars) <= max_v).OnlyEnforceIf(lit)

    def _g_night_dedicated(self, model, x, gate):
        import calendar
        month_idxs = [d for d, dt in enumerate(self.all_dates)
                      if dt.month == self.month and dt.year == self.year]
        if not month_idxs:
            return
        for nurse in self.nurses:
            if not nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            lit = gate(f"{self._fmt_nurse_label(nurse)} 야간전담 당월 정확히 14일")
            model.Add(sum(x[nid][d][s] for d in month_idxs for s in self.NIGHT_SHIFTS) == 14).OnlyEnforceIf(lit)

    def _g_menstrual(self, model, x, gate):
        if "생" not in self.ALL_SHIFTS:
            return
        import calendar
        month_days = calendar.monthrange(self.year, self.month)[1]
        month_idxs = [d for d, dt in enumerate(self.all_dates)
                      if dt.month == self.month and dt.year == self.year]
        for nurse in self.nurses:
            if nurse.get("is_night_shift") and month_days == 31 and nurse.get("gender") == "female":
                nid = nurse["id"]
                lit = gate(f"{self._fmt_nurse_label(nurse)} 야간전담 생리휴가 1회(31일달)")
                model.Add(sum(x[nid][d]["생"] for d in month_idxs) == 1).OnlyEnforceIf(lit)

    def _g_forbidden(self, model, x, gate):
        """사전입력으로 고정된 금지 전환은 별도 라벨 (가장 흔한 사전입력 충돌)."""
        forbidden = [
            ("E→D", self.EVENING_SHIFTS, self.DAY_SHIFTS),
            ("N→E", self.NIGHT_SHIFTS, self.EVENING_SHIFTS),
            ("N→D", self.NIGHT_SHIFTS, self.DAY_SHIFTS),
            ("중→D", self.MIDDLE_SHIFTS, self.DAY_SHIFTS),
        ]
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T - 1):
                for tag, g1, g2 in forbidden:
                    for s1 in g1:
                        v1 = x[nid][d][s1]
                        if isinstance(v1, int):
                            continue
                        for s2 in g2:
                            v2 = x[nid][d + 1][s2]
                            if isinstance(v2, int):
                                continue
                            lit = gate(f"{self._fmt_nurse_label(nurse)} "
                                       f"{self._fmt_date(self.all_dates[d])}→{self._fmt_date(self.all_dates[d+1])} {tag} 금지")
                            model.Add(v1 + v2 <= 1).OnlyEnforceIf(lit)


def analyze_conflicts(request: GenerateRequest) -> Dict:
    """충돌 분석 진입점. {conflicts: [라벨], message: str} 반환."""
    return _ConflictAnalyzer(request).analyze()
