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
from .scheduler_base import WEEKDAY_KEYS, timeoff_class, is_protected_timeoff


class _ConflictAnalyzer(CpSatScheduler):
    """CpSatScheduler의 _build_vars + 데이터 상속, 게이팅 모델로 충돌 분석."""

    def _gated_model(self):
        """게이팅 모델 구성 (model, lits) — analyze(MUS 최소화)와 probe(신호등)가 공유."""
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
        self._g_pregnancy_p1(model, x, gate)
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
        return model, lits

    def probe(self, time_limit: float = 5.0) -> Dict:
        """하드 제약 신호등 — 사전입력 실시간 피드백용 (MUS 최소화 없음).
        1단계: 게이팅 없는 순수 하드 모델(빠름)로 feasible/infeasible 판정.
        2단계: infeasible일 때만 게이팅 모델 1회 풀이 → SufficientAssumptions
        라벨을 '대략적 원인'으로 반환 (비최소 집합 — 정밀 원인은 analyze() 담당).
        게이팅+assumption 모델은 feasible 증명이 수 배 느려서(presolve 축소 불가)
        흔한 경로(입력 중 '가능')를 순수 모델로 먼저 판정한다."""
        if not self.nurses:
            return {"status": "unknown", "conflicts": [], "message": "간호사가 없습니다."}
        out = {"estimated_seconds": self.estimate_seconds()}
        # 사실-클램프 동기화 (결정 1-15): 신호등은 '생성이 되는가'의 판정자이므로
        # 엔진과 같은 의미론(확정 셀 = 주어진 사실)으로 본다. 클램프 없이 보면
        # 엔진이 수용하는 입력(예: 확정 OF 2회 주)에 거짓 빨강이 뜬다.
        # analyze()/suggest_correction()은 의도적으로 클램프 없이 전수 설명 유지.
        self._build_pin_index()
        model = cp_model.CpModel()
        x = self._build_vars(model)
        self._apply_hard_constraints(model, x)
        s = cp_model.CpSolver()
        s.parameters.max_time_in_seconds = time_limit
        st = s.Solve(model)
        if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return {**out, "status": "feasible", "conflicts": []}
        if st != cp_model.INFEASIBLE:
            return {**out, "status": "unknown", "conflicts": []}

        gmodel, lits = self._gated_model()
        gmodel.AddAssumptions(lits)
        s2 = cp_model.CpSolver()
        # 라벨 추출은 부가 정보 — 공급과잉처럼 라벨링이 오래 걸리는 케이스에서
        # 신호등 응답을 붙잡지 않도록 더 짧게 캡 (빈 라벨이면 메시지로 안내)
        s2.parameters.max_time_in_seconds = min(3.0, time_limit)
        st2 = s2.Solve(gmodel)
        labels, seen = [], set()
        if st2 == cp_model.INFEASIBLE:
            for i in s2.SufficientAssumptionsForInfeasibility():
                lab = self._labels.get(i)
                if lab and lab not in seen:
                    seen.add(lab)
                    labels.append(lab)
        anchored = [{"label": c, **(self._anchor_by_label.get(c)
                                    or {"nurse_id": None, "date": None})}
                    for c in labels]
        res = {**out, "status": "infeasible", "conflicts": labels, "anchored": anchored}
        if not labels:
            res["message"] = ("원인 자동 추출 시간 초과 — 흔한 원인은 인원 대비 수요 불일치"
                              "(일별 필요 인원은 '정확히 일치'라 남는 인원도 배치 불가)입니다. "
                              "주휴/휴가 사전입력으로 균형을 맞추거나 '정밀 분석'을 실행하세요."
                              if st2 != cp_model.INFEASIBLE else
                              "구조 제약(1일 1근무·근무 자격·알 수 없는 코드)만으로 "
                              "충돌합니다. 사전입력 코드와 간호사 자격을 확인하세요.")
        return res

    def analyze(self) -> Dict:
        if not self.nurses:
            return {"conflicts": [], "message": "간호사가 없습니다."}

        model, lits = self._gated_model()

        if not lits:
            return {"conflicts": [], "message": "분석할 완화 가능 제약이 없습니다."}

        lit_by_idx = {l.Index(): l for l in lits}

        # 분석 전체 wall-clock 예산 — probe당 8초 캡만 있으면 MUS 최소화 반복으로
        # 총 시간이 분~수십 분까지 늘어날 수 있고(generate 응답 지연), '중지'도
        # 듣지 않는다. 예산 초과·취소 시 probe는 '미결'로 처리되어 부분 결과 반환.
        import time as _time
        _deadline = _time.monotonic() + 60.0
        from . import solver_progress as _sp

        def infeasible_with(assumed_idx):
            """assumed_idx 리터럴만 가정하고 풀이 → INFEASIBLE이면 sufficient idx 집합."""
            if _time.monotonic() > _deadline or _sp.is_cancelled():
                return False  # 예산 초과/중지 — 미결 처리
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
        if first == []:
            # 가정 리터럴 없이도 infeasible — 완화 대상이 아닌 구조 제약끼리 충돌
            return {"conflicts": [], "muses": [],
                    "message": "완화 가능한 제약과 무관하게 구조 제약(1일 1근무·근무 자격·"
                               "알 수 없는 코드 등)만으로 충돌합니다. 사전입력 코드와 "
                               "간호사 자격 설정을 확인하세요."}

        _mus_uncertain = [False]

        def minimize_mus(suff):
            """#1 삭제 필터: 각 리터럴을 빼도 여전히 infeasible이면 불필요 → 최소 MUS."""
            mus = list(suff)
            i = 0
            while i < len(mus):
                trial = mus[:i] + mus[i + 1:]
                res = infeasible_with(trial) if trial else None
                if trial and res:
                    mus = trial  # i번째는 불필요
                else:
                    if res is False:
                        # 타임아웃 — 이 리터럴이 정말 필요한지 미확정인 채 유지됨
                        _mus_uncertain[0] = True
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
        if _mus_uncertain[0]:
            msg += ("\n⚠ 일부 항목은 시간 제한으로 최소성 검증을 마치지 못했습니다 — "
                    "목록에 실제 원인이 아닌 제약이 포함돼 있을 수 있습니다.")
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
                if period not in day_req:
                    continue
                req = max(0, int(day_req.get(period) or 0))
                # 명시적 0도 게이팅 — 솔버는 ==0을 강제하므로 빠지면 '0명 요구일
                # 사전입력 근무' 충돌을 '충돌 없음'으로 오진한다
                exprs = [x[n["id"]][d][s] for n in self.nurses for s in shifts]
                if not any(not isinstance(e, int) for e in exprs):
                    continue
                label = (f"{self._fmt_date(dt)} {period} 필요 인원 {req}명" if req > 0
                         else f"{self._fmt_date(dt)} {period} 0명(배정 금지)")
                lit = gate(label, dt=dt)
                model.Add(sum(exprs) == req).OnlyEnforceIf(lit)

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
                    # 오프특근(제1원칙 3): OF 주 1회는 슬랙으로 양보되므로 생성 실패의
                    # 원인이 될 수 없다 — 상한(주 2회 금지)만 게이팅한다.
                    of_sum = sum(x[nid][d]["OF"] for d in week_days)
                    lit = gate(f"{self._fmt_nurse_label(nurse)} {wi+1}주차 OF 2회 이상 금지", nid=nid)
                    model.Add(of_sum <= 1).OnlyEnforceIf(lit)

    def _g_pregnancy_p1(self, model, x, gate):
        """임산부 P1 주1회 — 게이팅 (충돌 시 라벨 핀포인트). 야간 제외·생 면제는 변수 도메인 처리."""
        if "P1" not in self.ALL_SHIFTS:
            return
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            if not nurse.get("is_pregnant"):
                continue
            nid = nurse["id"]
            for wi, (ws, we) in enumerate(self.weeks):
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
                full_week = (we - ws + 1) == len(win_days)
                if full_week and len(win_days) >= 7:
                    lit = gate(f"{self._fmt_nurse_label(nurse)} {wi+1}주차 P1(임부휴무) 1회 의무", nid=nid)
                    model.Add(sum(p1_vars) == 1).OnlyEnforceIf(lit)

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
        month_days = calendar.monthrange(self.year, self.month)[1]
        month_idxs = [d for d, dt in enumerate(self.all_dates)
                      if dt.month == self.month and dt.year == self.year]
        if not month_idxs:
            return
        for nurse in self.nurses:
            if not nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            # 솔버와 동일하게 재적일수·N 가용일 기반 (공용 헬퍼) — 미반영 시
            # 월중 전입/전출 야간전담에 허위 충돌을 보고한다
            active_days, target = self._night_dedicated_quota(nurse, month_idxs, month_days)
            if active_days <= 0:
                continue
            lit = gate(f"{self._fmt_nurse_label(nurse)} 야간전담 당월 {target}일", nid=nid)
            model.Add(sum(x[nid][d][s] for d in month_idxs for s in self.NIGHT_SHIFTS) == target).OnlyEnforceIf(lit)

    def _g_menstrual(self, model, x, gate):
        if "생" not in self.ALL_SHIFTS:
            return
        import calendar
        month_days = calendar.monthrange(self.year, self.month)[1]
        month_idxs = [d for d, dt in enumerate(self.all_dates)
                      if dt.month == self.month and dt.year == self.year]
        for nurse in self.nurses:
            nid = nurse["id"]
            # 모든 여성: 당월 생 ≤1 (솔버 하드 제약과 패리티 — 빠지면 생 2회
            # 사전입력이 실제로는 infeasible인데 '충돌 없음'으로 오진)
            if nurse.get("gender") == "female":
                m_terms = [x[nid][d]["생"] for d in month_idxs]
                if any(not isinstance(t, int) for t in m_terms):
                    lit = gate(f"{self._fmt_nurse_label(nurse)} 생리휴가 월 1회 한도", nid=nid)
                    model.Add(sum(m_terms) <= 1).OnlyEnforceIf(lit)
            # (야간전담 '여성+31일달 생 정확히 1회' 게이트는 제거 — 생휴는 보장이
            #  아니라는 사용자 원칙. 솔버에서도 같은 강제를 제거함 — 패리티)

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
        nurse_by_id = {n["id"]: n for n in self.nurses}
        for d, dt in enumerate(self.all_dates):
            if dt.month != self.month:
                continue
            dt_str = dt.strftime("%Y-%m-%d")
            is_holiday = dt_str in self.holidays
            day_lit = None
            for nid_i, nid_j, charge_s, regulars in eligible_pairs:
                # 솔버와 동일한 '유효 사전입력' 게이팅 (공용 헬퍼)
                jf = self._seniority_jfixed(nurse_by_id[nid_j], dt, dt_str, is_holiday)
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
                # 솔버와 동일한 클램프 (공용 헬퍼) — 미클램프 시 자체 모순 리터럴이
                # 항상 단독 MUS로 검출돼 실제 원인을 가린다
                rhs = self._two_month_rhs(nid)
                py, pm = ((self.year - 1, 12) if self.month == 1
                          else (self.year, self.month - 1))
                if self._night_dedicated_in(nid, py, pm):
                    # 나이트킵 달의 야간은 수면오프와 무관 — 합산에서 제외됨
                    label = (f"{self._fmt_nurse_label(nurse)} 홀짝월 합산 야간 ≤{max_n}회"
                             f" (전월 나이트킵은 합산 제외)")
                elif rhs > 0:
                    label = f"{self._fmt_nurse_label(nurse)} 홀짝월 합산 야간 ≤{max_n}회(전월 {prev_count})"
                else:
                    label = f"{self._fmt_nurse_label(nurse)} 전월 야간 {prev_count}회로 상한 초과 — 당월 야간 0회"
                lit = gate(label, nid=nid)
                model.Add(sum(night_vars) <= rhs).OnlyEnforceIf(lit)


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
                # 유효 사전입력 (공휴일 OF 드롭 + 모성보호 드롭 — 공용 헬퍼)
                pre = self._effective_pre(nurse, dt, pre, is_holiday)
                pre_flex = self._PRE_FLEX.get(pre, {pre} if pre else set())
                active = self._nurse_active_on(nurse, dt)
                # 잠긴 셀: 완화·진단 경로와 동일하게 절대 고정 — keep 리터럴을 만들지
                # 않아 '잠긴 셀 제거'가 처방으로 제시되는 일을 차단한다.
                if active and pre and self.locked_cells.get(nid, {}).get(dt_str):
                    for s in self.ALL_SHIFTS:
                        x[nid][d][s] = 1 if s == pre else 0
                    continue
                free_ok = {}
                for s in self.ALL_SHIFTS:
                    if not active:
                        free_ok[s] = False
                    elif s == "OF" and is_holiday:
                        free_ok[s] = False
                    elif self._preg_forbids(nurse, dt, s, pre):
                        free_ok[s] = False   # 임산부 모성보호 (P1 구간 외/야간 제외/생 면제)
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
        # MCS 도메인은 사전입력이 keep 리터럴로 제거 가능한 '완화형' 모델 —
        # 시니어리티 게이팅도 완화 경로와 동일하게(잠긴 셀만 고정) 동작해야
        # '처방 적용 후 재생성이 다시 실패'하는 구멍이 없다
        self._pre_soft = True
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
        self._cs_pregnancy_p1_weekly(model, x)         # 임산부 P1 주1회 (모성보호)
        self._cs_max_v_per_month(model, x)
        if self.rules.maxNightPerMonth:
            self._cs_max_night_per_month(model, x)
        # 실제 솔버 경로(_apply_hard_constraints)와 동일 집합 보장 — 빠지면
        # '수정 없이 생성 가능'이 거짓이 되거나 처방을 적용해도 여전히 실패한다.
        if getattr(self.rules, "restAfterNight", False):
            self._cs_rest_after_night(model, x)
        if self.rules.maxNightTwoMonth:
            self._cs_max_night_two_month(model, x)
        self._cs_menstrual_leave(model, x)
        self._cs_night_shift_nurses(model, x)
        self._cs_charge_seniority(model, x)

        cost_terms = []
        SHORT_COST = 10
        # 최소 침습(minimally invasive): 사전입력 제거 비용을 보호 등급별로 차등한다.
        # 사전입력의 '휴무'(OFF·연차·생리·특·공·법·병)는 간호사 개인의 인생 시간 → 강하게 보호.
        # 근무(1) < 인원부족 보고(10) < 휴무 OFF(30) < 연차류(60) < 주휴(100).
        # → 근무만 싸게 완화하고, 휴무를 뺄 바엔 '인원 추가/수요 감축'을 먼저 제시한다.
        _RM_COST = {"work": 1, "off": 30, "leave": 60, "juhu": 100}
        for keep, nurse, d, pre in pre_keeps:
            cost_terms.append(_RM_COST[timeoff_class(pre)] * (1 - keep))
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
                if period not in day_req:
                    continue
                req = max(0, int(day_req.get(period) or 0))
                # 명시적 0도 모델링 (assigned <= 0) — 빠지면 '0명 요구일의
                # 사전입력 근무' 충돌에 대해 '수정 없이 가능' 거짓 처방이 나간다.
                # 0요구일 사전입력은 keep 리터럴로 제거 가능하므로 처방으로 잡힌다.
                exprs = [x[n["id"]][d][s] for n in self.nurses for s in shifts]
                if not any(not isinstance(e, int) for e in exprs):
                    continue
                assigned = sum(exprs)
                model.Add(assigned <= req)
                if req > 0:
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

        # 최소 침습 프레이밍: 근무 조정 → 인원 부족(휴무 무손실 대안) → ⚠휴무 제거(최후)
        work_rm = [r for r in removed if timeoff_class(r[4]) == "work"]
        timeoff_rm = [r for r in removed if timeoff_class(r[4]) != "work"]
        lines = []
        if work_rm:
            lines.append(f"■ 근무 사전입력 {len(work_rm)}건 조정으로 충원:")
            for nid, label, iso, ds, pre in work_rm[:15]:
                lines.append(f"  · {label} {ds} '{pre}' 제거")
            if len(work_rm) > 15:
                lines.append(f"  · … 외 {len(work_rm)-15}건")
        if short_list:
            lines.append(f"■ 인원이 부족합니다 — 인원 추가 또는 수요 감축 권장 ({len(short_list)}건):")
            for kind, dt, code, v in short_list[:15]:
                if kind == "charge":
                    lines.append(f"  · {self._fmt_date(dt)} {code} 차지 배치 불가")
                else:
                    lines.append(f"  · {self._fmt_date(dt)} {code} {v}명 부족")
            if len(short_list) > 15:
                lines.append(f"  · … 외 {len(short_list)-15}건")
        if timeoff_rm:
            lines.append(f"⚠ 휴무 {len(timeoff_rm)}건 제거가 불가피합니다 — 가능하면 위의 인원 추가/수요 감축을 먼저 검토하세요:")
            for nid, label, iso, ds, pre in timeoff_rm[:15]:
                lines.append(f"  · {label} {ds} '{pre}' (휴무)")
            if len(timeoff_rm) > 15:
                lines.append(f"  · … 외 {len(timeoff_rm)-15}건")
        if not removed and not short_list:
            return {"fixable": True, "removals": [], "shortfalls": [],
                    "message": "수정 없이 생성 가능합니다 (현재 하드 제약상 충돌 없음)."}
        # 시간 제한 내 OPTIMAL 미도달이면 '최소' 보장이 없음을 명시
        approx_note = ""
        if status != cp_model.OPTIMAL:
            approx_note = ("\n⚠ 시간 제한으로 근사 처방입니다 — 최소 수정임이 보장되지 "
                           "않으며, 더 적은 수정으로도 풀릴 수 있습니다.")
        return {
            "fixable": True,
            "is_optimal": status == cp_model.OPTIMAL,
            "removals": [{"nurse_id": nid, "nurse": l, "date_iso": iso, "date": ds, "pre": p,
                          "is_timeoff": timeoff_class(p) != "work"}
                          for nid, l, iso, ds, p in removed],
            "shortfalls": [{"kind": k, "date": dt.strftime("%Y-%m-%d"), "code": c, "amount": v}
                           for k, dt, c, v in short_list],
            "message": "이렇게 수정하면 생성 가능합니다:\n" + "\n".join(lines) + approx_note,
        }


def analyze_conflicts(request: GenerateRequest) -> Dict:
    """충돌 분석 진입점. {conflicts: [라벨], message: str} 반환."""
    return _ConflictAnalyzer(request).analyze()


def suggest_correction(request: GenerateRequest) -> Dict:
    """최소 수정 처방(MCS) 진입점. {fixable, removals, shortfalls, message} 반환."""
    return _ConflictAnalyzer(request).suggest_correction()


def check_feasibility(request: GenerateRequest, time_limit: float = 5.0) -> Dict:
    """실시간 신호등 진입점 — 하드 제약 1회 풀이.
    {status: feasible|infeasible|unknown, conflicts, anchored?, estimated_seconds} 반환."""
    return _ConflictAnalyzer(request).probe(time_limit)
