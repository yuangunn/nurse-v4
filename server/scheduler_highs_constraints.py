"""
HiGHS 엔진 하드 제약 + 목적함수 믹스인 (scheduler.py NurseScheduler에서 분리).
모든 메서드는 self.*(인스턴스 속성)를 사용하며 NurseScheduler에 믹스인된다.
"""
from __future__ import annotations

from datetime import date

import pulp

from .scheduler_base import WEEKDAY_KEYS


class _HighsConstraintsMixin:
    # ── Hard Constraint 구현 ──────────────────────────────────────────────────

    def _c_one_shift_per_day(self, prob, x):
        """하루에 정확히 1개의 근무/휴무 (전입/전출 범위 밖은 제외)"""
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T):
                if not self._nurse_active_idx(nurse, d):
                    continue  # 재적 중 아님 → 제약 없음 (모든 변수 이미 0)
                prob += pulp.lpSum(x[nid][d][s] for s in self.ALL_SHIFTS) == 1, f"one_{nid}_{d}"

    # (주휴 재배치 ≤1 제약은 scheduler.py 완화 경로에 단일 구현 — 과거의
    #  _add_weekly_juhu는 호출처가 없는 사장 코드라 제거됨)

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
                if self._pin.get((nid, d)):
                    continue  # 확정 셀 — 자격을 소급 검증하지 않음 (사실 존중)
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
            # 사실-클램프: 날 전체가 확정이면 그 날은 사실 — 인원 검증 스킵.
            # 일부만 확정이면 확정분만큼 요구를 상향 (확정 셀 수용 + 자유 셀이 잔여 충족)
            if self._day_all_pinned(d, dt):
                continue
            for period, shifts in period_map.items():
                if period not in day_req:
                    continue
                required = max(0, int(day_req.get(period) or 0))
                required = max(required, self._pin_day_period_count(d, shifts))
                # 명시적 0도 == 제약으로 강제 — '정확히 일치(초과 불가)' 사양.
                # 생략하면 0명 요구 시간대가 잉여 인력의 투입처로 쓰일 수 있다.
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
            if self._day_all_pinned(d, dt):
                continue  # 사실-클램프: 확정된 날의 차지 구성은 표 그대로
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
                # 선임 j의 '유효' 사전입력으로 게이팅 (공용 헬퍼 — 변수 생성과
                # 동일하게 공휴일 OF·임산부 드롭 + 완화 모드 잠금 처리)
                j_fixed = self._seniority_jfixed(nurse_by_id[nid_j], dt, dt_str, is_holiday)
                if j_fixed and j_fixed != charge_s:
                    continue
                v_charge = x[nid_i][d][charge_s]
                vc_const = not isinstance(v_charge, pulp.LpVariable)
                if vc_const and v_charge != 1:
                    continue
                for regular_s in regulars:
                    v_reg = x[nid_j][d][regular_s]
                    vr_const = not isinstance(v_reg, pulp.LpVariable)
                    if vr_const and v_reg != 1:
                        continue
                    if vc_const and vr_const:
                        continue  # 둘 다 사용자 고정 — 사용자 입력 존중
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
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T - 1):
                # 전월(역사) 내부에 완전히 갇힌 쌍은 제외 — 과거 기록에 현재
                # 규칙을 소급하면 불필요 infeasible. 경계를 넘는 쌍만 검사.
                if self.all_dates[d + 1] < first_of_month:
                    continue
                # 사실-클램프: 두 셀 모두 확정 = 사용자 사실 — 검증하지 않음
                if self._pin.get((nid, d)) and self._pin.get((nid, d + 1)):
                    continue
                for first_group, second_group in forbidden:
                    for s1 in first_group:
                        v1 = x[nid][d][s1]
                        v1_const = not isinstance(v1, pulp.LpVariable)
                        # 상수 0은 무관하지만 상수 1(잠금/주휴 고정)은 식에 반영해야
                        # 한다 — 건너뛰면 잠긴 셀 옆 자유 변수에 금지 전환이 안 걸린다.
                        if v1_const and v1 != 1:
                            continue
                        for s2 in second_group:
                            v2 = x[nid][d + 1][s2]
                            v2_const = not isinstance(v2, pulp.LpVariable)
                            if v2_const and v2 != 1:
                                continue
                            if v1_const and v2_const:
                                continue  # 둘 다 사용자 고정 — 사용자 입력 존중
                            prob += (
                                v1 + v2 <= 1,
                                f"forbid_{nid}_{d}_{s1}_{s2}"
                            )

    def _c_nod_pattern(self, prob, x):
        """N→휴무→D 금지: N/NC 다음날 REST_SHIFTS(OF, 주 등) 중 하나, 그 다음날 D/DC 금지"""
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            for d in range(self.T - 2):
                # 전월(역사) 내부 완결 윈도우 제외 (경계 걸침만 검사)
                if self.all_dates[d + 2] < first_of_month:
                    continue
                # 사실-클램프: 세 셀 모두 확정 = 사용자 사실
                if (self._pin.get((nid, d)) and self._pin.get((nid, d + 1))
                        and self._pin.get((nid, d + 2))):
                    continue
                for ns in self.NIGHT_SHIFTS:
                    vn = x[nid][d][ns]
                    vn_const = not isinstance(vn, pulp.LpVariable)
                    if vn_const and vn != 1:
                        continue
                    for rs in self.REST_SHIFTS:
                        vr = x[nid][d + 1][rs]
                        vr_const = not isinstance(vr, pulp.LpVariable)
                        if vr_const and vr != 1:
                            continue
                        for ds in self.DAY_SHIFTS:
                            vd = x[nid][d + 2][ds]
                            vd_const = not isinstance(vd, pulp.LpVariable)
                            if vd_const and vd != 1:
                                continue
                            if vn_const and vr_const and vd_const:
                                continue  # 전부 사용자 고정 — 사용자 입력 존중
                            # 상수 1(잠금 고정)도 식에 반영 (예: 1+vr+vd<=2)
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
                # 사실-클램프: 주 전체 확정이면 스킵, 일부 확정이면 확정 OF만큼 상향
                # (확정 OF 2회 → 자유 셀 추가 금지 + 기존 2회 수용)
                if all(self._pin.get((nid, d)) for d in week_days):
                    continue
                bound = max(1, self._pin_nurse_count(nid, week_days, ("OF",)))
                # 오프특근(제1원칙 3): 공휴일 포함 주는 OF를 뺄 수 있다 → ≤ bound
                if len(week_days) >= 7 and not self._week_has_holiday(week_days):
                    prob += (
                        pulp.lpSum(x[nid][d][of_code] for d in week_days) == bound,
                        f"weekly_of_{nid}_{ws}"
                    )
                else:
                    prob += (
                        pulp.lpSum(x[nid][d][of_code] for d in week_days) <= bound,
                        f"weekly_of_{nid}_{ws}"
                    )

    def _c_pregnancy_p1_weekly(self, prob, x):
        """임산부(모성보호): P1 구간에 완전히 포함된 주마다 P1 정확히 1회 (부분 주 ≤1).
        weeklyOff와 동일 패턴. 야간 제외·생 면제는 변수 게이팅(_preg_forbids)으로 처리된다."""
        if "P1" not in self.ALL_SHIFTS:
            return
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            if not nurse.get("is_pregnant"):
                continue
            nid = nurse["id"]
            for ws, we in self.weeks:
                # 전월(역사) 날짜 제외 — weekly OF와 동일 패턴. 누락 시 확장된
                # 전월 주의 빈 칸에 P1이 '날조' 배치된다.
                win_days = [d for d in range(ws, we + 1)
                            if self.all_dates[d] >= first_of_month
                            and self._nurse_active_idx(nurse, d)
                            and self._preg_window_on(nid, self.all_dates[d])]
                if not win_days:
                    continue
                p1_vars = [x[nid][d]["P1"] for d in win_days
                           if isinstance(x[nid][d].get("P1"), pulp.LpVariable)]
                if not p1_vars:
                    continue
                # 사실-클램프: 구간 전체 확정이면 스킵, 일부 확정이면 확정 P1만큼 상향
                if all(self._pin.get((nid, d)) for d in win_days):
                    continue
                bound = max(1, self._pin_nurse_count(nid, win_days, ("P1",)))
                full_week = (we - ws + 1) == len(win_days)
                if full_week and len(win_days) >= 7:
                    prob += pulp.lpSum(p1_vars) == bound, f"preg_p1_{nid}_{ws}"
                else:
                    prob += pulp.lpSum(p1_vars) <= bound, f"preg_p1_{nid}_{ws}"

    def _c_max_consecutive_work(self, prob, x, max_days: int):
        """최대 연속 근무일 제한 (전월 내부 완결 윈도우는 제외 — 역사 소급 금지)"""
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            for start in range(self.T - max_days):
                if self.all_dates[start + max_days] < first_of_month:
                    continue
                window = range(start, start + max_days + 1)
                if all(self._pin.get((nid, d)) for d in window):
                    continue  # 사실-클램프: 윈도우 전체 확정 = 사용자 사실
                prob += (
                    pulp.lpSum(x[nid][d][s] for d in window for s in self.WORK_SHIFTS) <= max_days,
                    f"consec_work_{nid}_{start}"
                )

    def _c_max_consecutive_night(self, prob, x, max_nights: int):
        """최대 연속 야간 근무 제한 (전월 내부 완결 윈도우는 제외)"""
        first_of_month = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            for start in range(self.T - max_nights):
                if self.all_dates[start + max_nights] < first_of_month:
                    continue
                window = range(start, start + max_nights + 1)
                if all(self._pin.get((nid, d)) for d in window):
                    continue  # 사실-클램프: 윈도우 전체 확정 = 사용자 사실
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
        first_of_month = date(self.year, self.month, 1)
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
                    # 전월(역사) 날짜에는 휴식 강제를 소급하지 않음
                    if self.all_dates[rest_d] < first_of_month:
                        continue
                    # 사실-클램프: 확정된 휴식일 셀은 사용자 선택 그대로
                    if self._pin.get((nid, rest_d)):
                        continue
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
                month_idx = [d for d, dt in enumerate(self.all_dates)
                             if dt.month == self.month and dt.year == self.year]
                v_vars = [x[nid][d]["V"] for d in month_idx]
                if v_vars:
                    # 사실-클램프: 확정 V만큼 상한 상향 (자유 셀 추가는 여전히 한도 내)
                    cap = max(max_v, self._pin_nurse_count(nid, month_idx, ("V",)))
                    prob += pulp.lpSum(v_vars) <= cap, f"max_v_{nid}"
            # 이전달 overflow: V 금지 — 단 사전입력으로 확정된 전월 기록(V)은
            # 존중한다. 무조건 금지하면 1일1근무(==1)와 모순돼 전체 infeasible.
            first_of_month = date(self.year, self.month, 1)
            for d, dt in enumerate(self.all_dates):
                if dt < first_of_month and "V" in self.ALL_SHIFTS:
                    v = x[nid][d]["V"]
                    pre = self.prev.get(nid, {}).get(dt.strftime("%Y-%m-%d"))
                    if isinstance(v, pulp.LpVariable) and pre != "V":
                        prob += v == 0, f"no_v_overflow_{nid}_{d}"
            # 이후달 overflow: V 최대 1회 (확정 V만큼 상향)
            next_idx = [d for d, dt in enumerate(self.all_dates)
                        if (dt.month != self.month or dt.year != self.year) and dt >= first_of_month]
            next_v_vars = [x[nid][d]["V"] for d in next_idx]
            if next_v_vars:
                cap = max(1, self._pin_nurse_count(nid, next_idx, ("V",)))
                prob += pulp.lpSum(next_v_vars) <= cap, f"max_v_next_{nid}"

    def _c_max_night_per_month(self, prob, x):
        """월 최대 야간 횟수 제한 (수면OFF 최소화) — 야간전담 제외"""
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
                prob += pulp.lpSum(night_vars) <= cap, f"max_night_month_{nid}"

    def _c_max_night_two_month(self, prob, x):
        """홀짝월 합산 야간 제한 (이전달 야간 + 당월 야간 <= maxNightTwoMonthCount) — 야간전담 제외"""
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
                # RHS 음수 클램프 포함 (공용 헬퍼) + 사실-클램프 (확정 야간만큼 상향)
                cap = max(self._two_month_rhs(nid),
                          self._pin_nurse_count(nid, month_idx, self.NIGHT_SHIFTS))
                prob += pulp.lpSum(night_vars) <= cap, f"max_night_2mo_{nid}"

    def _c_menstrual_leave(self, prob, x):
        """생리휴가: 여성 간호사당 당월 최대 1회 + 익월에서 사용 금지"""
        if "생" not in self.ALL_SHIFTS:
            return
        for nurse in self.nurses:
            nid = nurse["id"]
            if nurse.get("gender") != "female":
                continue
            # 당월만 최대 1회 (항상 하드 제약, 확정 생만큼 상향)
            month_idx = [d for d, dt in enumerate(self.all_dates)
                         if dt.month == self.month and dt.year == self.year]
            month_vars = [x[nid][d]["생"] for d in month_idx]
            if month_vars:
                cap = max(1, self._pin_nurse_count(nid, month_idx, ("생",)))
                prob += pulp.lpSum(month_vars) <= cap, f"menstrual_{nid}"
            # 이전달 overflow: 생 금지 — 사전입력된 전월 확정 기록은 존중
            first_of_month = date(self.year, self.month, 1)
            for d, dt in enumerate(self.all_dates):
                if dt < first_of_month:
                    v = x[nid][d]["생"]
                    pre = self.prev.get(nid, {}).get(dt.strftime("%Y-%m-%d"))
                    if isinstance(v, pulp.LpVariable) and pre != "생":
                        prob += v == 0, f"no_menstrual_overflow_{nid}_{d}"
            # 이후달 overflow: 생 최대 1회 (확정 생만큼 상향)
            next_idx = [d for d, dt in enumerate(self.all_dates)
                        if (dt.month != self.month or dt.year != self.year) and dt >= first_of_month]
            next_m_vars = [x[nid][d]["생"] for d in next_idx]
            if next_m_vars:
                cap = max(1, self._pin_nurse_count(nid, next_idx, ("생",)))
                prob += pulp.lpSum(next_m_vars) <= cap, f"max_menstrual_next_{nid}"

    def _c_night_shift_nurses(self, prob, x):
        """
        야간전담 간호사 전용 제약 (is_night_shift=True):
          1. N/NC만 배정 (낮·저녁·중간번·상근 모두 금지)
          2. 5일 윈도우 내 근무 <= 3 → 3일 연속 후 2일 휴무 자동 보장
          3. 당월 정확히 14일 근무 (N+NC)
        (생리휴가는 강제하지 않음 — 월 ≤1 상한만, _c_menstrual_leave)
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
            active_days, night_target = self._night_dedicated_quota(
                nurse, month_idxs, month_days)
            if active_days <= 0:
                continue  # 당월 재적 없음 — ==14를 걸면 무조건 infeasible

            # ── 1. N/NC 외 모든 근무 금지 (당월만, overflow 제외) ──────────
            for d in month_idxs:
                if self._pin.get((nid, d)):
                    continue  # 사실-클램프: 확정 셀은 코드 그대로 (소급 검증 안 함)
                for s in non_night_work:
                    v = x[nid][d].get(s)
                    if isinstance(v, pulp.LpVariable):
                        prob += v == 0, f"night_only_{nid}_{d}_{s}"

            # ── 2. 5일 윈도우 <= 3 — 월 경계에 걸친 윈도우(전월 tail·익월
            #       overflow 포함)도 검사한다 ──────────────────────────────
            w_lo = max(0, month_idxs[0] - 4)
            w_hi = min(self.T - 5, month_idxs[-1])
            for start in range(w_lo, w_hi + 1):
                window = range(start, start + 5)
                if all(self._pin.get((nid, d)) for d in window):
                    continue  # 사실-클램프
                w_cap = max(3, self._pin_nurse_count(nid, window, self.NIGHT_SHIFTS))
                prob += (
                    pulp.lpSum(
                        x[nid][d][s]
                        for d in window
                        for s in self.NIGHT_SHIFTS
                    ) <= w_cap,
                    f"night_5day_{nid}_{start}",
                )

            # ── 3. 당월 야간 근무 일수 — 재적 비례 + N 가용일 클램프 (공용 헬퍼)
            #       + 사실-클램프: 확정분이 목표를 넘으면 실측 존중, 자유 일수가
            #       모자라면 달성 가능한 만큼만 요구 ──────────────────────────
            pin_n = self._pin_nurse_count(nid, month_idxs, self.NIGHT_SHIFTS)
            free_days = sum(1 for d in month_idxs
                            if self._nurse_active_idx(nurse, d) and not self._pin.get((nid, d)))
            eff_target = min(max(night_target, pin_n), pin_n + free_days)
            night_sum = pulp.lpSum(
                x[nid][d][s]
                for d in month_idxs
                for s in self.NIGHT_SHIFTS
            )
            prob += (night_sum == eff_target, f"night_monthly_{nid}")

            # (과거 규칙 4 '여성+31일달 생 정확히 1회'는 제거 — 생휴는 보장이
            #  아니라 '주어질 수 있다'는 사용자 원칙. 월 ≤1 상한은
            #  _c_menstrual_leave가 모든 여성에게 동일하게 적용한다.)

    # ── period 그룹 → shift 코드 목록 해석 ──────────────────────────────────

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
                    # 위시 공정성 보정 — 직전 달 거절 누적이 큰 간호사의 위시 가중 상향
                    wsc = int(round(sc * float(self.wish_boosts.get(nid, 1.0))))
                    for day_str, wish_shift in nurse.get("wishes", {}).items():
                        try:
                            ds = str(day_str)
                            # 일(day) 숫자 키와 'YYYY-MM-DD' 키 모두 허용
                            # (프론트 dayKey는 ISO 포맷으로 저장)
                            if "-" in ds:
                                wish_date = date.fromisoformat(ds)
                            else:
                                wish_date = date(self.year, self.month, int(ds))
                            if wish_date not in self.date_to_idx:
                                continue
                            d = self.date_to_idx[wish_date]
                            if wish_shift == "OFF":
                                terms.append(wsc * pulp.lpSum(
                                    x[nid][d][s] for s in self.REST_SHIFTS + self.LEAVE_SHIFTS))
                            elif wish_shift in self.ALL_SHIFTS:
                                terms.append(wsc * x[nid][d][wish_shift])
                        except (ValueError, KeyError):
                            pass

            elif rt == "night_fairness":
                # 공정성 풀에서 제외: 야간전담(월 14회 고정 → max 핀),
                # N 비자격·임산부(야간 0 고정 → min 핀). 포함하면 range가
                # 상수화되어 일반 간호사 간 편차를 전혀 벌점하지 못한다.
                # 야간 횟수가 구조적으로 고정된 간호사 제외 (공용 헬퍼)
                fairness_pool = self._night_fairness_pool()
                if len(fairness_pool) >= 2:
                    night_counts = {
                        nurse["id"]: pulp.lpSum(
                            x[nurse["id"]][d][s]
                            for d in month_days
                            for s in self.NIGHT_SHIFTS
                        )
                        for nurse in fairness_pool
                    }
                    max_n = pulp.LpVariable(f"max_nights_{rid}", lowBound=0, cat="Integer")
                    min_n = pulp.LpVariable(f"min_nights_{rid}", lowBound=0, cat="Integer")
                    for nurse in fairness_pool:
                        nid = nurse["id"]
                        # 공정성 원장: (직전 달 누적 + 당월)의 편차를 최소화 —
                        # 지난달 야간이 많았던 간호사는 이번 달 적게 받는다
                        off = int(self.fairness_offsets.get(nid, 0))
                        prob += max_n >= night_counts[nid] + off, f"max_n_{rid}_{nid}"
                        prob += min_n <= night_counts[nid] + off, f"min_n_{rid}_{nid}"
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
