"""
HiGHS 엔진 Infeasible 진단 믹스인 (scheduler.py NurseScheduler에서 분리).
사전입력 핀포인트 스캐너(_scan_pre_*) + 13-phase _diagnose_infeasibility.
모든 메서드는 self.*를 사용하며 NurseScheduler에 믹스인된다.
"""
from __future__ import annotations

from datetime import date

import pulp

from .scheduler_base import WEEKDAY_KEYS


class _HighsDiagnosisMixin:
    # ── Infeasible 진단 헬퍼: 사전입력 핀포인트 ──────────────────────────────
    # 솔버가 Infeasible을 토할 때, 단순히 "어떤 제약 충돌"이 아니라
    # "몇월 며칠의 어떤 사전입력 때문인지" 사용자에게 정확히 짚어주기 위한 스캐너들.

    def _scan_pre_forbidden_transitions(self) -> list:
        """사전입력만으로 발생한 9개 금지 전환을 모두 찾아 반환.
        Returns: [{'nurse', 'd1','wk1','shift1','d2','wk2','shift2','rule'}, ...]
        """
        rules = [
            ("E→D",   set(self.EVENING_SHIFTS), set(self.DAY_SHIFTS)),
            ("E→D1",  set(self.EVENING_SHIFTS), set(self.DAY1_SHIFTS)),
            ("E→중",  set(self.EVENING_SHIFTS), set(self.MIDDLE_SHIFTS)),
            ("N→E",   set(self.NIGHT_SHIFTS),   set(self.EVENING_SHIFTS)),
            ("N→D",   set(self.NIGHT_SHIFTS),   set(self.DAY_SHIFTS)),
            ("N→D1",  set(self.NIGHT_SHIFTS),   set(self.DAY1_SHIFTS)),
            ("N→중",  set(self.NIGHT_SHIFTS),   set(self.MIDDLE_SHIFTS)),
            ("중→D",  set(self.MIDDLE_SHIFTS),  set(self.DAY_SHIFTS)),
            ("중→D1", set(self.MIDDLE_SHIFTS),  set(self.DAY1_SHIFTS)),
        ]
        found = []
        for nurse in self.nurses:
            nid = nurse["id"]
            prev = self.prev.get(nid, {})
            for d in range(self.T - 1):
                dt1 = self.all_dates[d]
                dt2 = self.all_dates[d + 1]
                # 적어도 하나는 당월에 속해야 의미 있음
                if dt1.month != self.month and dt2.month != self.month:
                    continue
                s1 = prev.get(dt1.strftime("%Y-%m-%d"))
                s2 = prev.get(dt2.strftime("%Y-%m-%d"))
                if not s1 or not s2:
                    continue
                for label, g1, g2 in rules:
                    if s1 in g1 and s2 in g2:
                        found.append({
                            "nurse_id": nid,
                            "nurse_label": self._fmt_nurse_label(nurse),
                            "date1": self._fmt_date(dt1),
                            "date1_iso": dt1.strftime("%Y-%m-%d"),
                            "shift1": s1,
                            "date2": self._fmt_date(dt2),
                            "date2_iso": dt2.strftime("%Y-%m-%d"),
                            "shift2": s2,
                            "rule": label,
                        })
                        break  # 한 페어당 하나만 기록
        return found

    def _scan_pre_consecutive_runs(self) -> dict:
        """사전입력만으로 이미 연속 근무/야간 한도를 초과한 런(run)을 찾는다.
        Returns: {'work_runs': [...], 'night_runs': [...]}.
        run = {'nurse_label', 'days': [(date_str, wk, shift), ...], 'len'}
        """
        work_set = set(self.WORK_SHIFTS)
        night_set = set(self.NIGHT_SHIFTS)
        max_w = self.rules.maxConsecutiveWorkDays
        max_n = self.rules.maxConsecutiveNightDays
        work_runs, night_runs = [], []

        def _flush_w(label, run):
            if run and len(run) > max_w and self.rules.maxConsecutiveWork:
                work_runs.append({"nurse_label": label, "days": run, "len": len(run)})

        def _flush_n(label, run):
            if run and len(run) > max_n and self.rules.maxConsecutiveNight:
                night_runs.append({"nurse_label": label, "days": run, "len": len(run)})

        for nurse in self.nurses:
            nid = nurse["id"]
            label = self._fmt_nurse_label(nurse)
            prev = self.prev.get(nid, {})
            run_w, run_n = [], []
            for d in range(self.T):
                dt = self.all_dates[d]
                s = prev.get(dt.strftime("%Y-%m-%d"))
                wk = self._DAY_KR[dt.weekday()]
                if s in work_set:
                    run_w.append((dt.strftime("%m/%d"), wk, s))
                    if s in night_set:
                        run_n.append((dt.strftime("%m/%d"), wk, s))
                    else:
                        _flush_n(label, run_n)
                        run_n = []
                else:
                    _flush_w(label, run_w)
                    run_w = []
                    _flush_n(label, run_n)
                    run_n = []
            _flush_w(label, run_w)
            _flush_n(label, run_n)
        return {"work_runs": work_runs, "night_runs": night_runs}

    def _scan_pre_code_excess(self, code: str, limit: int) -> list:
        """당월 사전입력에서 특정 코드(예: 'V', '생')가 limit을 초과한 간호사 리스트.
        Returns: [{'nurse_label', 'dates': [str], 'count', 'limit'}, ...]
        """
        out = []
        for nurse in self.nurses:
            nid = nurse["id"]
            dates = []
            for dt in self.all_dates:
                if dt.month != self.month:
                    continue
                if self.prev.get(nid, {}).get(dt.strftime("%Y-%m-%d")) == code:
                    dates.append(self._fmt_date(dt))
            if len(dates) > limit:
                out.append({
                    "nurse_label": self._fmt_nurse_label(nurse),
                    "dates": dates,
                    "count": len(dates),
                    "limit": limit,
                })
        return out

    def _scan_pre_night_excess(self, limit: int) -> list:
        """사전입력에 야간(N/NC) 코드가 당월 limit을 초과한 정규 간호사 리스트.
        야간전담은 별도 규칙이므로 제외."""
        night_set = set(self.NIGHT_SHIFTS)
        out = []
        for nurse in self.nurses:
            if nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            entries = []
            for dt in self.all_dates:
                if dt.month != self.month:
                    continue
                s = self.prev.get(nid, {}).get(dt.strftime("%Y-%m-%d"))
                if s in night_set:
                    entries.append(f"{self._fmt_date(dt)} {s}")
            if len(entries) > limit:
                out.append({
                    "nurse_label": self._fmt_nurse_label(nurse),
                    "entries": entries,
                    "count": len(entries),
                    "limit": limit,
                })
        return out

    def _scan_pre_two_month_night_excess(self, limit: int) -> list:
        """전월 야간 + 당월 사전입력 야간이 limit을 초과한 정규 간호사."""
        night_set = set(self.NIGHT_SHIFTS)
        out = []
        for nurse in self.nurses:
            if nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            prev_n = int(self.prev_month_nights.get(nid, 0) or 0)
            cur_dates = []
            for dt in self.all_dates:
                if dt.month != self.month:
                    continue
                s = self.prev.get(nid, {}).get(dt.strftime("%Y-%m-%d"))
                if s in night_set:
                    cur_dates.append(f"{self._fmt_date(dt)} {s}")
            total = prev_n + len(cur_dates)
            if total > limit:
                out.append({
                    "nurse_label": self._fmt_nurse_label(nurse),
                    "prev_month": prev_n,
                    "cur_dates": cur_dates,
                    "total": total,
                    "limit": limit,
                })
        return out

    def _scan_pre_menstrual_issues(self) -> list:
        """생리휴가(생) 사전입력에서 명백히 충돌하는 항목.
        - 남성에게 생휴 입력
        - 공휴일에 생휴 입력 (야간전담 아닌 경우)
        - 같은 달에 2회 이상 (월 1회 한도)
        """
        out = []
        for nurse in self.nurses:
            nid = nurse["id"]
            is_male = nurse.get("gender") != "female"
            is_night = bool(nurse.get("is_night_shift"))
            entries = []
            sd_dates = []
            for dt in self.all_dates:
                if dt.month != self.month:
                    continue
                dt_str = dt.strftime("%Y-%m-%d")
                if self.prev.get(nid, {}).get(dt_str) != "생":
                    continue
                fmt = self._fmt_date(dt)
                if is_male:
                    entries.append(f"{fmt}: 남성 간호사에 '생' 입력")
                elif (dt_str in self.holidays) and not is_night:
                    entries.append(f"{fmt}: 공휴일에 '생' 입력 (일반 간호사 차단)")
                else:
                    sd_dates.append(fmt)
            if len(sd_dates) > 1:
                entries.append(
                    f"월 2회 이상: {', '.join(sd_dates)} (생리휴가는 월 1회 한도)"
                )
            if entries:
                out.append({
                    "nurse_label": self._fmt_nurse_label(nurse),
                    "entries": entries,
                })
        return out

    def _scan_pre_charge_seniority_conflicts(self) -> list:
        """더 선임이 같은 듀티에서 일반 근무로 사전입력되어 있는데
        후임이 같은 날 같은 듀티의 Charge로 사전입력된 경우 검출.
        nurses 리스트 순서 = seniority (작을수록 선임).
        """
        # 듀티 → (charge_code, regular_codes)
        duty_pairs = []
        if self.DAY_SHIFTS:
            charge_d = next((c for c in self.DAY_SHIFTS if c == "DC"), None)
            if charge_d:
                duty_pairs.append(("D", charge_d, [c for c in self.DAY_SHIFTS if c != charge_d]))
        if self.EVENING_SHIFTS:
            charge_e = next((c for c in self.EVENING_SHIFTS if c == "EC"), None)
            if charge_e:
                duty_pairs.append(("E", charge_e, [c for c in self.EVENING_SHIFTS if c != charge_e]))
        if self.NIGHT_SHIFTS:
            charge_n = next((c for c in self.NIGHT_SHIFTS if c == "NC"), None)
            if charge_n:
                duty_pairs.append(("N", charge_n, [c for c in self.NIGHT_SHIFTS if c != charge_n]))

        out = []
        for d in range(self.T):
            dt = self.all_dates[d]
            if dt.month != self.month:
                continue
            dt_str = dt.strftime("%Y-%m-%d")
            for duty_label, ccode, regular in duty_pairs:
                charges = []
                regulars = []
                for idx, nurse in enumerate(self.nurses):
                    s = self.prev.get(nurse["id"], {}).get(dt_str)
                    if s == ccode:
                        charges.append((idx, nurse))
                    elif s in regular:
                        regulars.append((idx, nurse))
                # 후임 charge + 더 선임 regular → 충돌
                for cidx, charge_nurse in charges:
                    seniors_on_duty = [n for ridx, n in regulars if ridx < cidx]
                    if seniors_on_duty:
                        out.append({
                            "date": self._fmt_date(dt),
                            "duty": duty_label,
                            "charge_label": self._fmt_nurse_label(charge_nurse),
                            "charge_code": ccode,
                            "senior_labels": [self._fmt_nurse_label(n) for n in seniors_on_duty],
                        })
        return out

    def _rank_cells_by_violation_count(self, participations: list) -> list:
        """
        사전입력 셀의 위반 기여도 ranking.

        Args:
            participations: [(nurse_id, date_iso, shift, date_label), ...]
                각 튜플은 한 위반 사건에서 해당 셀이 참여했다는 기록.
                같은 (nurse_id, date_iso) 셀이 여러 위반에 참여할 수 있음.

        Returns: [(human_label, count), ...] count 내림차순.
            human_label 예: "*김지현 05/12 (E)"
        """
        from collections import Counter
        # (nurse_id, date_iso) → 등장 횟수
        freq = Counter((nid, di) for nid, di, _sh, _dl in participations)
        # 표시용 라벨 만들기: shift는 첫 등장 사용
        label_map: dict = {}
        for nid, di, sh, dl in participations:
            key = (nid, di)
            if key not in label_map:
                nurse = next((n for n in self.nurses if n["id"] == nid), None)
                name = self._fmt_nurse_label(nurse) if nurse else nid
                label_map[key] = f"{name} {dl} ({sh})"
        ranked = sorted(
            ((label_map[key], cnt) for key, cnt in freq.items()),
            key=lambda x: -x[1],
        )
        # count >= 1 인 셀은 모두 반환 — 호출자가 자르도록
        return ranked

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
            transitions = self._scan_pre_forbidden_transitions()
            if transitions:
                lines.append(f"  [원인] 사전입력에 물리적으로 불가능한 근무 전환 — 총 {len(transitions)}건")
                lines.append("  (간격 < 8시간 — 9개 금지 전환: E→D/D1/중, N→E/D/D1/중, 중→D/D1)")
                lines.append("  문제가 된 사전입력 항목:")
                for t in transitions[:10]:
                    lines.append(
                        f"    · {t['nurse_label']}  "
                        f"{t['date1']} {t['shift1']} → {t['date2']} {t['shift2']}  "
                        f"[{t['rule']} 금지]"
                    )
                if len(transitions) > 10:
                    lines.append(f"    ... 외 {len(transitions)-10}건")
                # 셀 기여도 ranking — 어느 셀을 비우면 가장 많은 충돌을 동시에 해소하나
                cell_participations = (
                    [(t["nurse_id"], t["date1_iso"], t["shift1"], t["date1"]) for t in transitions]
                    + [(t["nurse_id"], t["date2_iso"], t["shift2"], t["date2"]) for t in transitions]
                )
                top_cells = self._rank_cells_by_violation_count(cell_participations)
                if top_cells:
                    lines.append("  ★ 셀 기여도 — 이 셀(들)을 비우면 가장 많은 충돌 해소:")
                    for label, count in top_cells[:3]:
                        lines.append(f"    · {label} → {count}건 동시 해소")
                lines.append("  → 해결: 위 셀을 빈 칸으로 두거나 D→E→N 순방향(8시간 이상 간격)으로 수정하세요.")
            else:
                lines.append("  [원인] 역순 전환 충돌 — 사전입력에서 직접 위반은 없으나 다른 제약과 결합 시 발생합니다.")
                lines.append("    해결: 사전입력을 일부 제거하거나 완화 모드로 재시도해 보세요.")
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
            worst_week_gap = 0
            worst_week_label = ""
            worst_week_daily_avg = 0  # 가장 부족한 주의 일평균 필요 슬롯
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
                gap = week_slots_needed - effective_avail
                tight = " ★빡빡" if gap > 0 else ""

                start_dt = self.all_dates[ws]
                end_dt = self.all_dates[min(we, len(self.all_dates)-1)]
                leave_note = f", 휴가고정 {total_extra_leave}건" if total_extra_leave else ""
                lines.append(
                    f"    {wi+1}주차 ({start_dt.strftime('%m/%d')}~{end_dt.strftime('%m/%d')}): "
                    f"필요 {week_slots_needed}슬롯 / 가용 {effective_avail}슬롯{leave_note}{tight}"
                )
                if gap > worst_week_gap:
                    worst_week_gap = gap
                    worst_week_label = f"{wi+1}주차 ({start_dt.strftime('%m/%d')}~{end_dt.strftime('%m/%d')})"
                    worst_week_daily_avg = week_slots_needed / month_days_in_week
                # 해당 주에서 가장 빡빡한 날 상위 3개
                day_details_sorted = sorted(day_details, key=lambda x: x[1] - (N - x[2]), reverse=True)
                for dt, needed, fixed_off in day_details_sorted[:3]:
                    avail_day = N - fixed_off
                    flag = " ←부족" if needed > avail_day else ""
                    lines.append(
                        f"      {dt.strftime('%m/%d')}({DAY_KR[dt.weekday()]}): "
                        f"필요 {needed}명 / 가용 {avail_day}명{flag}"
                    )
            # ── 액션 제안: 부족분을 구체 수치로 환산 ────────────────────────
            if worst_week_gap > 0:
                # 간호사 1명을 1주에 ~5슬롯(주휴+OF 빼고) 기여 가능 → 추가 N≈ceil(gap/5)
                add_nurses = -(-worst_week_gap // 5)
                # 일평균 demand 기준 줄여야 할 정도: gap/7 (반올림)
                demand_cut_per_day = -(-worst_week_gap // 7)
                lines.append("  ★ 해결 (택1):")
                lines.append(
                    f"     1) 간호사 +{add_nurses}명 추가 — "
                    f"가장 부족한 {worst_week_label}이 {worst_week_gap}슬롯 부족."
                )
                lines.append(
                    f"     2) 요일별 D/E/N 합계를 일평균 -{demand_cut_per_day}명 줄이기 "
                    f"(현재 일평균 {worst_week_daily_avg:.1f}명 → 목표 "
                    f"{max(0, worst_week_daily_avg - demand_cut_per_day):.1f}명)."
                )
                lines.append("     3) 사전입력 휴가/OF가 과도하면 일부 제거.")
            else:
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
            runs = self._scan_pre_consecutive_runs()
            wruns = runs["work_runs"]
            nruns = runs["night_runs"]
            lines.append(
                f"  [원인] 연속 근무/야간 제한 충돌  "
                f"(현재 설정: 연속 근무 ≤{self.rules.maxConsecutiveWorkDays}일, "
                f"연속 야간 ≤{self.rules.maxConsecutiveNightDays}일)"
            )
            if wruns:
                lines.append("  사전입력만으로 이미 연속 근무 한도를 초과한 구간:")
                for r in wruns[:5]:
                    seq = " → ".join(f"{md}({wk}) {sh}" for md, wk, sh in r["days"])
                    lines.append(
                        f"    · {r['nurse_label']}  {r['len']}일 연속: {seq}"
                    )
                if len(wruns) > 5:
                    lines.append(f"    ... 외 {len(wruns)-5}건")
            if nruns:
                lines.append("  사전입력만으로 이미 연속 야간 한도를 초과한 구간:")
                for r in nruns[:5]:
                    seq = " → ".join(f"{md}({wk}) {sh}" for md, wk, sh in r["days"])
                    lines.append(
                        f"    · {r['nurse_label']}  {r['len']}일 연속 야간: {seq}"
                    )
                if len(nruns) > 5:
                    lines.append(f"    ... 외 {len(nruns)-5}건")
            if not wruns and not nruns:
                lines.append(
                    "  사전입력에서 직접 한도 초과는 없으나, 솔버가 채울 가용 일수가 부족합니다."
                )
            lines.append("  → 해결:")
            lines.append("     1) 위 사전입력의 일부를 OF/주/V 등으로 끊어 주세요.")
            lines.append("     2) 또는 규칙 설정에서 연속 근무/야간 일수 한도를 늘리세요.")
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
            over = self._scan_pre_code_excess("V", self.rules.maxVPerMonth)
            lines.append(
                f"  [원인] V(연차) 사전입력이 월 최대 {self.rules.maxVPerMonth}회 한도를 초과했습니다."
            )
            if over:
                lines.append("  사전입력에서 V 횟수가 한도 초과인 간호사:")
                for o in over[:8]:
                    lines.append(
                        f"    · {o['nurse_label']}  V {o['count']}회 (한도 {o['limit']}회): "
                        f"{', '.join(o['dates'])}"
                    )
                if len(over) > 8:
                    lines.append(f"    ... 외 {len(over)-8}명")
            lines.append("  → 해결: 위 V 사전입력 일부를 제거하거나, 규칙에서 V 월 최대 횟수를 늘리세요.")
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

                # ── 액션 제안: D/E 총 부족분 → 수치 환산 ────────────────────
                total_de_shortage = sum(r[9] for r in day_rows if r[9] > 0)
                worst_day_shortage = max((r[9] for r in day_rows), default=0)
                if total_de_shortage > 0:
                    # 정규 간호사 1명 = 주 ~5 D/E 슬롯 기여 가능 (주휴+OF 빼고)
                    # 월 환산: 1명이 한 달에 ~21~22 D/E 슬롯 커버 가능
                    add_regular = -(-total_de_shortage // 21)
                    # 야간전담 1명을 정규로 전환 = 월 14 N 슬롯 손실 + ~22 D/E 슬롯 획득
                    convert_night = -(-total_de_shortage // 22)
                    lines.append("    ★ 해결 (택1, 수치 기준):")
                    lines.append(
                        f"      1) 정규 간호사 +{add_regular}명 추가 — "
                        f"D/E 월간 총 {total_de_shortage}슬롯 부족"
                    )
                    if night_nurses and convert_night <= len(night_nurses):
                        lines.append(
                            f"      2) 야간전담 {len(night_nurses)}명 중 {convert_night}명을 정규로 전환 "
                            f"(N 슬롯 {convert_night*14}개 감소 ↔ D/E 슬롯 +{convert_night*22}개)"
                        )
                    lines.append(
                        f"      3) 부족 일자의 D/E 인원을 평균 -{(-(-worst_day_shortage//1))}명씩 줄이기 "
                        f"(사전입력 탭의 일별 D/E 필요행 직접 편집)"
                    )
                    lines.append(f"      4) 야간전담 근무 범위 (현재 월 14일, {month_days}일 달 기준) 확인")
                else:
                    lines.append("    해결 방법:")
                    lines.append("      1. 야간전담이 아닌 간호사를 추가하세요.")
                    lines.append("      2. 부족한 날짜의 D/E 필요 인원을 줄이세요.")
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
            seniors = self._scan_pre_charge_seniority_conflicts()
            lines.append("  [원인] Charge 시니어리티 제약 충돌")
            lines.append("  (Charge는 같은 듀티에서 가장 선임에게만 — 더 선임이 일반 근무로 사전입력되어 있으면 후임은 Charge 불가)")
            if seniors:
                lines.append(f"  사전입력에서 직접 충돌 — 총 {len(seniors)}건:")
                # 후임이 일반 근무인 같은 charger가 여러 날 반복되는 경우 묶기
                from collections import Counter
                charge_freq = Counter(c["charge_label"] for c in seniors)
                for c in seniors[:8]:
                    seniors_str = ", ".join(c["senior_labels"])
                    lines.append(
                        f"    · {c['date']} {c['duty']}듀티 — "
                        f"{c['charge_label']}이(가) {c['charge_code']}로 입력됨, "
                        f"그러나 더 선임이 같은 듀티에서 일반 근무: {seniors_str}"
                    )
                if len(seniors) > 8:
                    lines.append(f"    ... 외 {len(seniors)-8}건")
                # 액션 제안: 가장 빈번히 등장한 후임 charger 우선 처리
                if len(charge_freq) > 0:
                    top_offender, count = charge_freq.most_common(1)[0]
                    lines.append(
                        f"  ★ 해결 우선순위:"
                    )
                    if count >= 2:
                        lines.append(
                            f"    1) {top_offender}의 Charge 사전입력 {count}건을 한꺼번에 처리 "
                            f"(가장 빈번한 충돌 유발 간호사)"
                        )
                    lines.append(
                        f"    2) 위 날짜의 Charge 사전입력을 더 선임 간호사로 옮기거나, "
                        f"선임의 일반 근무 입력을 제거"
                    )
                    lines.append(
                        f"    3) 간호사 목록 순서(설정 탭 → 드래그)로 시니어리티 재조정 가능"
                    )
            else:
                lines.append("    사전입력에서 직접 충돌은 발견되지 않음 — 야간전담 NC 배정과의 조합 충돌일 수 있습니다.")
                lines.append("    해결: 간호사 목록 순서(시니어리티) 또는 야간전담 설정을 확인해 주세요.")
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
            issues = self._scan_pre_menstrual_issues()
            lines.append("  [원인] 생리휴가(생) 제약 충돌")
            if issues:
                lines.append("  사전입력에서 직접 충돌하는 항목:")
                for it in issues[:8]:
                    lines.append(f"    · {it['nurse_label']}")
                    for ent in it["entries"][:5]:
                        lines.append(f"        - {ent}")
                if len(issues) > 8:
                    lines.append(f"    ... 외 {len(issues)-8}명")
                lines.append("  → 해결: 위 날짜의 '생' 사전입력을 다른 코드로 바꾸거나 제거하세요.")
            else:
                lines.append("    사전입력에서 직접 충돌은 발견되지 않음.")
                lines.append("    여성 간호사 + 31일 달일 때 야간전담 1회 의무로 발생할 수 있음 — 해당 간호사 야간전담 설정을 확인하세요.")
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
                over = self._scan_pre_night_excess(max_n)
                lines.append(f"  [원인] 월 최대 야간 {max_n}회 제약 충돌")
                if over:
                    lines.append("  사전입력에서 N(야간) 횟수가 한도 초과인 정규 간호사:")
                    for o in over[:8]:
                        lines.append(
                            f"    · {o['nurse_label']}  N {o['count']}회 (한도 {o['limit']}회): "
                            f"{', '.join(o['entries'])}"
                        )
                    if len(over) > 8:
                        lines.append(f"    ... 외 {len(over)-8}명")
                    lines.append("  → 해결: 위 N 사전입력 일부를 제거하거나, 규칙에서 월 최대 야간을 늘리세요.")
                else:
                    lines.append(f"    사전입력에서 직접 한도 초과는 없음. 총 야간 슬롯 대비 간호사×{max_n}회가 부족합니다.")
                    lines.append("    해결: 월 최대 야간 횟수를 늘리거나, 야간 필요인원을 줄이세요.")
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
                lim = self.rules.maxNightTwoMonthCount
                over = self._scan_pre_two_month_night_excess(lim)
                lines.append(f"  [원인] 홀짝월 합산 야간 {lim}회 제약 충돌")
                if over:
                    lines.append("  전월 야간 + 당월 사전입력 야간이 합산 한도를 초과한 간호사:")
                    for o in over[:8]:
                        cur = ", ".join(o["cur_dates"]) if o["cur_dates"] else "(당월 사전 N 없음)"
                        lines.append(
                            f"    · {o['nurse_label']}  "
                            f"전월 N {o['prev_month']}회 + 당월 사전 N {len(o['cur_dates'])}회 = {o['total']}회 "
                            f"(한도 {o['limit']}회)"
                        )
                        lines.append(f"        당월 N: {cur}")
                    if len(over) > 8:
                        lines.append(f"    ... 외 {len(over)-8}명")
                    lines.append("  → 해결: 당월 사전입력 N을 일부 제거하거나, 전월N 입력값을 검토하거나, 합산 상한을 늘리세요.")
                else:
                    lines.append("    사전입력에서 직접 합산 초과는 없음 — 전월N 입력값과 야간 의무 분배 충돌일 수 있습니다.")
                    lines.append("    해결: 분석 탭에서 '전월N'(prev_month_nights) 값을 확인하거나 합산 상한을 늘리세요.")
                return "\n".join(lines)

        # ── 원인 불명 ────────────────────────────────────────────────────────
        lines.append("  [원인 불명] 개별 제약은 통과하지만 전체 조합이 Infeasible입니다.")
        lines.append("    시간이 지나도 해를 찾지 못했을 수 있습니다 (타임아웃).")
        lines.append("    해결: 간호사를 추가하거나 일부 제약을 완화해보세요.")
        return "\n".join(lines)
