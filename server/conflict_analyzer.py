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
        self._anchor_by_label: Dict[str, dict] = {}  # 라벨 → {nurse_id, date} 셀 점프
        lits: List = []

        def gate(label: str, nid=None, dt=None):
            lit = model.NewBoolVar(f"assume_{len(lits)}")
            self._labels[lit.Index()] = label
            if nid is not None or dt is not None:
                self._anchor_by_label[label] = {
                    "nurse_id": nid,
                    "date": dt.strftime("%Y-%m-%d") if dt is not None else None,
                }
            lits.append(lit)
            return lit

        # 구조 제약 (게이팅 X)
        self._cs_one_shift_per_day(model, x)
        self._cs_shift_eligibility(model, x)

        # 게이팅 대상
        self._g_daily_requirements(model, x, gate)
        self._g_charge_requirements(model, x, gate)
        self._g_charge_seniority(model, x, gate)
        if self.rules.weeklyOff:
            self._g_weekly_off(model, x, gate)
        self._g_max_v(model, x, gate)
        self._g_night_dedicated(model, x, gate)
        self._g_menstrual(model, x, gate)
        self._g_forbidden(model, x, gate)
        if self.rules.noNOD:
            self._g_nod(model, x, gate)
        if self.rules.maxConsecutiveWork:
            self._g_consecutive_work(model, x, gate)
        if self.rules.maxConsecutiveNight:
            self._g_consecutive_night(model, x, gate)
        if getattr(self.rules, 'restAfterNight', False):
            self._g_rest_after_night(model, x, gate)
        if self.rules.maxNightPerMonth:
            self._g_max_night_per_month(model, x, gate)
        if self.rules.maxNightTwoMonth:
            self._g_max_night_two_month(model, x, gate)

        if not lits:
            return {"conflicts": [], "message": "분석할 완화 가능 제약이 없습니다."}

        lit_by_idx = {l.Index(): l for l in lits}

        def infeasible_with(assumed_idx):
            """assumed_idx 리터럴만 가정하고 풀이 → INFEASIBLE이면 sufficient idx 집합."""
            model.ClearAssumptions()
            model.AddAssumptions([lit_by_idx[i] for i in assumed_idx])
            s = cp_model.CpSolver()
            s.parameters.max_time_in_seconds = 8.0
            st = s.Solve(model)
            if st == cp_model.INFEASIBLE:
                return list(s.SufficientAssumptionsForInfeasibility())
            if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                return None
            return False  # 미결(타임아웃 등)

        all_idx = [l.Index() for l in lits]
        first = infeasible_with(all_idx)
        if first is None:
            return {"conflicts": [], "muses": [],
                    "message": "하드 제약만으로는 실현 가능합니다 (충돌 없음). "
                               "충돌은 소프트/완화 조합 또는 솔버 타임아웃일 수 있습니다."}
        if first is False:
            return {"conflicts": [], "muses": [], "message": "충돌 분석 미완료 (타임아웃)."}

        def minimize_mus(suff):
            """#1 삭제 필터: 각 리터럴을 빼도 여전히 infeasible이면 불필요 → 최소 MUS."""
            mus = list(suff)
            i = 0
            while i < len(mus):
                trial = mus[:i] + mus[i + 1:]
                if trial and infeasible_with(trial):
                    mus = trial  # i번째는 불필요
                else:
                    i += 1
            return mus

        # #2 여러 충돌 열거: 찾은 MUS를 가정에서 제외하고 재탐색 (최대 5개)
        muses = []
        excused = set()
        suff = first
        for _ in range(5):
            mus = minimize_mus(suff)
            labels = []
            seen = set()
            for i in mus:
                lab = self._labels.get(i)
                if lab and lab not in seen:
                    seen.add(lab)
                    labels.append(lab)
            if labels:
                muses.append(labels)
            excused.update(mus)
            remaining = [i for i in all_idx if i not in excused]
            if not remaining:
                break
            nxt = infeasible_with(remaining)
            if not nxt:  # None(feasible) or False(timeout) → 더 없음
                break
            suff = nxt

        flat = []
        for m in muses:
            for lab in m:
                if lab not in flat:
                    flat.append(lab)
        if len(muses) <= 1:
            msg = ("다음 제약들이 동시에 충족될 수 없습니다 "
                   f"(충돌 {len(flat)}건):\n" + "\n".join(f"  · {c}" for c in flat))
        else:
            parts = [f"독립적인 충돌 {len(muses)}개를 발견했습니다 (각각 따로 해결 필요):"]
            for gi, m in enumerate(muses, 1):
                parts.append(f"[충돌 {gi}] 이 제약들이 동시 충족 불가:")
                parts.extend(f"  · {c}" for c in m)
            msg = "\n".join(parts)
        anchored = [{"label": c, **(self._anchor_by_label.get(c) or {"nurse_id": None, "date": None})}
                    for c in flat]
        return {"conflicts": flat, "anchored": anchored, "muses": muses, "message": msg}

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
                lit = gate(f"{self._fmt_date(dt)} {period} 필요 인원 {req}명", dt=dt)
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
                    lit = gate(f"{self._fmt_date(dt)} {s['code']} 차지 1명 필요", dt=dt)
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
                    lit = gate(f"{self._fmt_nurse_label(nurse)} {wi+1}주차 OF 1회 의무", nid=nid)
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
                lit = gate(f"{self._fmt_nurse_label(nurse)} V(연차) 월 {max_v}회 이하", nid=nid)
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
            lit = gate(f"{self._fmt_nurse_label(nurse)} 야간전담 당월 정확히 14일", nid=nid)
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
                lit = gate(f"{self._fmt_nurse_label(nurse)} 야간전담 생리휴가 1회(31일달)", nid=nid)
                model.Add(sum(x[nid][d]["생"] for d in month_idxs) == 1).OnlyEnforceIf(lit)

    def _g_forbidden(self, model, x, gate):
        """9개 금지 전환 전체 (가장 흔한 사전입력 충돌). per (nurse, date-pair)."""
        forbidden = [
            ("E→D", self.EVENING_SHIFTS, self.DAY_SHIFTS),
            ("E→D1", self.EVENING_SHIFTS, self.DAY1_SHIFTS),
            ("E→중", self.EVENING_SHIFTS, self.MIDDLE_SHIFTS),
            ("N→E", self.NIGHT_SHIFTS, self.EVENING_SHIFTS),
            ("N→D", self.NIGHT_SHIFTS, self.DAY_SHIFTS),
            ("N→D1", self.NIGHT_SHIFTS, self.DAY1_SHIFTS),
            ("N→중", self.NIGHT_SHIFTS, self.MIDDLE_SHIFTS),
            ("중→D", self.MIDDLE_SHIFTS, self.DAY_SHIFTS),
            ("중→D1", self.MIDDLE_SHIFTS, self.DAY1_SHIFTS),
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
                                       f"{self._fmt_date(self.all_dates[d])}→{self._fmt_date(self.all_dates[d+1])} {tag} 금지", nid=nid, dt=self.all_dates[d])
                            model.Add(v1 + v2 <= 1).OnlyEnforceIf(lit)

    def _g_charge_seniority(self, model, x, gate):
        """charge 시니어리티 — 날짜 단위 1 리터럴(그날 모든 선임/후임 쌍 묶음)."""
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
                    if charge_s in j_capable:
                        eligible_pairs.append((i_nurse["id"], j_nurse["id"], charge_s, regulars))
        for d, dt in enumerate(self.all_dates):
            if dt.month != self.month:
                continue
            dt_str = dt.strftime("%Y-%m-%d")
            day_lit = None
            for nid_i, nid_j, charge_s, regulars in eligible_pairs:
                jf = self.prev.get(nid_j, {}).get(dt_str)
                if jf and jf != charge_s:
                    continue
                vc = x[nid_i][d][charge_s]
                if isinstance(vc, int):
                    continue
                for rs in regulars:
                    vr = x[nid_j][d][rs]
                    if isinstance(vr, int):
                        continue
                    if day_lit is None:
                        day_lit = gate(f"{self._fmt_date(dt)} charge 시니어리티(선임이 차지)", dt=dt)
                    model.Add(vc + vr <= 1).OnlyEnforceIf(day_lit)

    def _g_nod(self, model, x, gate):
        """N→OF→D 금지 — per nurse 1 리터럴."""
        for nurse in self.nurses:
            nid = nurse["id"]
            lit = None
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
                            if lit is None:
                                lit = gate(f"{self._fmt_nurse_label(nurse)} N→휴무→D 금지", nid=nid)
                            model.Add(vn + vr + vd <= 2).OnlyEnforceIf(lit)

    def _g_consecutive_work(self, model, x, gate):
        """최대 연속 근무 — per nurse 1 리터럴."""
        max_days = self.rules.maxConsecutiveWorkDays
        for nurse in self.nurses:
            nid = nurse["id"]
            if self.T <= max_days:
                continue
            lit = gate(f"{self._fmt_nurse_label(nurse)} 연속근무 ≤{max_days}일", nid=nid)
            for start in range(self.T - max_days):
                window = range(start, start + max_days + 1)
                model.Add(sum(x[nid][d][s] for d in window for s in self.WORK_SHIFTS) <= max_days).OnlyEnforceIf(lit)

    def _g_consecutive_night(self, model, x, gate):
        """최대 연속 야간 — per nurse 1 리터럴."""
        max_n = self.rules.maxConsecutiveNightDays
        for nurse in self.nurses:
            nid = nurse["id"]
            if self.T <= max_n:
                continue
            lit = gate(f"{self._fmt_nurse_label(nurse)} 연속야간 ≤{max_n}일", nid=nid)
            for start in range(self.T - max_n):
                window = range(start, start + max_n + 1)
                model.Add(sum(x[nid][d][s] for d in window for s in self.NIGHT_SHIFTS) <= max_n).OnlyEnforceIf(lit)

    def _g_rest_after_night(self, model, x, gate):
        """연속야간 후 휴무 — per nurse 1 리터럴."""
        min_consec = getattr(self.rules, 'restAfterNightMinConsec', 2)
        rest_days = getattr(self.rules, 'restAfterNightDays', 2)
        for nurse in self.nurses:
            nid = nurse["id"]
            if nurse.get("is_night_shift"):
                continue
            lit = None
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
                    if lit is None:
                        lit = gate(f"{self._fmt_nurse_label(nurse)} 연속야간 후 휴무 보장", nid=nid)
                    lhs = sum(night_terms) + night_fixed
                    lhs = lhs - (sum(night_next) if night_next else night_next_fixed)
                    lhs = lhs + sum(work_vars)
                    model.Add(lhs <= min_consec).OnlyEnforceIf(lit)

    def _g_max_night_per_month(self, model, x, gate):
        """월 최대 야간 — per nurse 1 리터럴 (야간전담 제외)."""
        max_n = self.rules.maxNightPerMonthCount
        for nurse in self.nurses:
            if nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            night_vars = [x[nid][d][s] for d, dt in enumerate(self.all_dates)
                          if dt.month == self.month and dt.year == self.year
                          for s in self.NIGHT_SHIFTS]
            if night_vars:
                lit = gate(f"{self._fmt_nurse_label(nurse)} 월 야간 ≤{max_n}회", nid=nid)
                model.Add(sum(night_vars) <= max_n).OnlyEnforceIf(lit)

    def _g_max_night_two_month(self, model, x, gate):
        """홀짝월 합산 야간 — per nurse 1 리터럴 (야간전담 제외)."""
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
                lit = gate(f"{self._fmt_nurse_label(nurse)} 홀짝월 합산 야간 ≤{max_n}회(전월 {prev_count})", nid=nid)
                model.Add(sum(night_vars) <= max_n - prev_count).OnlyEnforceIf(lit)


    # ── #3 MCS (최소 수정집합) — "이것만 빼면/줄이면 풀린다" 처방 ──────────────
    def _build_vars_mcs(self, model):
        """MCS용 변수: 사전입력 셀도 자유화(제거 가능) + keep 리터럴. 비-pre는 자유 도메인."""
        x = {}
        pre_keeps = []  # (keep_var, nurse, d, pre_code)
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
                pre_flex = self._PRE_FLEX.get(pre, {pre} if pre else set())
                active = self._nurse_active_on(nurse, dt)
                free_ok = {}
                for s in self.ALL_SHIFTS:
                    if not active:
                        free_ok[s] = False
                    elif s == "OF" and is_holiday:
                        free_ok[s] = False
                    elif s == "법":
                        free_ok[s] = (is_holiday and not is_night)
                    elif s in ("생", "V") and is_holiday and not is_night:
                        free_ok[s] = False
                    elif s not in self.SOLVER_SHIFTS:
                        free_ok[s] = False
                    elif s == "생" and is_male:
                        free_ok[s] = False
                    else:
                        free_ok[s] = True
                for s in self.ALL_SHIFTS:
                    if active and (free_ok[s] or s in pre_flex):
                        x[nid][d][s] = model.NewBoolVar(f"m_{nid}_{d}_{s}")
                    else:
                        x[nid][d][s] = 0
                if active and pre:
                    flex_vars = [x[nid][d][s] for s in pre_flex if not isinstance(x[nid][d][s], int)]
                    if flex_vars:
                        keep = model.NewBoolVar(f"keep_{nid}_{d}")
                        model.Add(sum(flex_vars) == 1).OnlyEnforceIf(keep)
                        # pre 제거(¬keep) 시 자유 도메인 아닌 pre 전용 코드(주·특·공 등)는 사용 불가
                        for s in pre_flex:
                            v = x[nid][d][s]
                            if not isinstance(v, int) and not free_ok[s]:
                                model.Add(v == 0).OnlyEnforceIf(keep.Not())
                        pre_keeps.append((keep, nurse, d, pre))
        return x, pre_keeps

    def suggest_correction(self) -> Dict:
        """최소 수정집합: 사전입력 제거 + 미충원(수요 감축)을 최소 비용으로.
        사전입력 제거는 싸게(1), 미충원은 비싸게(10) → 먼저 사전입력을 빼서 충원하고,
        그래도 모자라면 잔여 부족(=정량 슬랙, 인원 추가 필요)을 보고."""
        if not self.nurses:
            return {"fixable": False, "message": "간호사가 없습니다."}
        model = cp_model.CpModel()
        x, pre_keeps = self._build_vars_mcs(model)

        # 하드 유지: 구조·행동 제약 (daily/charge만 soft 레버)
        self._cs_one_shift_per_day(model, x)
        self._cs_shift_eligibility(model, x)
        self._cs_forbidden_transitions(model, x)
        if self.rules.noNOD:
            self._cs_nod_pattern(model, x)
        if self.rules.maxConsecutiveWork:
            self._cs_max_consecutive_work(model, x, self.rules.maxConsecutiveWorkDays)
        if self.rules.maxConsecutiveNight:
            self._cs_max_consecutive_night(model, x, self.rules.maxConsecutiveNightDays)
        if self.rules.weeklyOff:
            self._cs_weekly_off(model, x)
        self._cs_max_v_per_month(model, x)
        if self.rules.maxNightPerMonth:
            self._cs_max_night_per_month(model, x)
        self._cs_menstrual_leave(model, x)
        self._cs_night_shift_nurses(model, x)
        self._cs_charge_seniority(model, x)

        cost_terms = []
        PRE_COST, SHORT_COST = 1, 10
        # 사전입력 제거 비용
        for keep, nurse, d, pre in pre_keeps:
            cost_terms.append(PRE_COST * (1 - keep))
        # 일별 D/E/N 미충원 (soft) + charge 미배치 (soft)
        period_map = {"D": self.DAY_SHIFTS, "E": self.EVENING_SHIFTS, "N": self.NIGHT_SHIFTS}
        period_to_req = {"day": "D", "evening": "E", "night": "N"}
        charge_shifts = [s for s in self._shifts if s["is_charge"]]
        first = date(self.year, self.month, 1)
        shortfalls = []   # (kind, date, period_or_code, var, required)
        for d, dt in enumerate(self.all_dates):
            if dt < first:
                continue
            day_req = self._cur_day_req(dt)
            for period, shifts in period_map.items():
                req = day_req.get(period, 0)
                if req <= 0:
                    continue
                assigned = sum(x[n["id"]][d][s] for n in self.nurses for s in shifts)
                model.Add(assigned <= req)
                short = model.NewIntVar(0, req, f"short_{d}_{period}")
                model.Add(short >= req - assigned)
                cost_terms.append(SHORT_COST * short)
                shortfalls.append(("staff", dt, period, short, req))
            for s in charge_shifts:
                rk = period_to_req.get(s["period"])
                if rk and day_req.get(rk, 0) > 0:
                    csum = sum(x[n["id"]][d][s["code"]] for n in self.nurses)
                    model.Add(csum <= 1)
                    cshort = model.NewIntVar(0, 1, f"cshort_{d}_{s['code']}")
                    model.Add(cshort >= 1 - csum)
                    cost_terms.append(SHORT_COST * cshort)
                    shortfalls.append(("charge", dt, s["code"], cshort, 1))

        model.Minimize(sum(cost_terms))
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 25.0
        status = solver.Solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return {"fixable": False,
                    "message": "최소 수정 처방을 계산하지 못했습니다 "
                               "(행동 제약 자체의 충돌일 수 있음 — 정밀 충돌 분석 참고)."}

        removed = [(n["id"], self._fmt_nurse_label(n),
                    self.all_dates[d].strftime("%Y-%m-%d"), self._fmt_date(self.all_dates[d]), pre)
                   for keep, n, d, pre in pre_keeps if solver.Value(keep) == 0]
        short_list = []
        for kind, dt, code, var, req in shortfalls:
            v = solver.Value(var)
            if v > 0:
                short_list.append((kind, dt, code, v))

        lines = []
        if removed:
            lines.append(f"■ 사전입력 {len(removed)}건 제거하면 충원 가능:")
            for nid, label, iso, ds, pre in removed[:15]:
                lines.append(f"  · {label} {ds} '{pre}' 제거")
            if len(removed) > 15:
                lines.append(f"  · … 외 {len(removed)-15}건")
        if short_list:
            lines.append(f"■ 그래도 부족 — 인원 추가 필요 ({len(short_list)}건):")
            for kind, dt, code, v in short_list[:15]:
                if kind == "charge":
                    lines.append(f"  · {self._fmt_date(dt)} {code} 차지 배치 불가")
                else:
                    lines.append(f"  · {self._fmt_date(dt)} {code} {v}명 부족")
            if len(short_list) > 15:
                lines.append(f"  · … 외 {len(short_list)-15}건")
        if not removed and not short_list:
            return {"fixable": True, "removals": [], "shortfalls": [],
                    "message": "수정 없이 생성 가능합니다 (현재 하드 제약상 충돌 없음)."}
        return {
            "fixable": True,
            "removals": [{"nurse_id": nid, "nurse": l, "date_iso": iso, "date": ds, "pre": p}
                          for nid, l, iso, ds, p in removed],
            "shortfalls": [{"kind": k, "date": dt.strftime("%Y-%m-%d"), "code": c, "amount": v}
                           for k, dt, c, v in short_list],
            "message": "이렇게 수정하면 생성 가능합니다:\n" + "\n".join(lines),
        }


def analyze_conflicts(request: GenerateRequest) -> Dict:
    """충돌 분석 진입점. {conflicts: [라벨], message: str} 반환."""
    return _ConflictAnalyzer(request).analyze()


def suggest_correction(request: GenerateRequest) -> Dict:
    """최소 수정 처방(MCS) 진입점. {fixable, removals, shortfalls, message} 반환."""
    return _ConflictAnalyzer(request).suggest_correction()
