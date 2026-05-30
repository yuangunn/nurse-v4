"""
스케줄러 공유 베이스 — 엔진(HiGHS/CP-SAT) 무관 데이터·셋업·추출 로직.

NurseScheduler(HiGHS)와 CpSatScheduler(CP-SAT)가 공통 상속한다.
여기에는 솔버를 모르는 코드만 둔다: 날짜 범위/재적/주기/시니어리티 데이터 파싱,
근무 분류, 점수 계산, 솔루션 추출(값 읽기는 value_fn 주입).
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Callable, Dict, List, Tuple

from .models import GenerateRequest, ScoringRule


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


class _SchedulerBase:
    """엔진 무관 공통 베이스. 서브클래스가 solve()/제약/목적함수를 구현."""

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

    _DAY_KR = ["월", "화", "수", "목", "금", "토", "일"]

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
        """LP 변수 수 기반 풀이 시간 추정 (HiGHS 실측 기준 ~0.12초/변수)."""
        N = len(self.nurses)
        T = self.T
        S = len(self.ALL_SHIFTS)

        pre_filled = sum(len(days) for days in self.prev.values())
        free_cells = max(0, N * T - pre_filled)
        base_vars = free_cells * S

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
                soft_vars += N + 2

        total_vars = base_vars + soft_vars
        estimated = total_vars * 0.12
        return int(min(self.time_limit, max(5, round(estimated))))

    # ── 그룹 해석 ─────────────────────────────────────────────────────────────

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

    # ── 표시 헬퍼 ─────────────────────────────────────────────────────────────

    def _fmt_nurse_label(self, nurse: dict) -> str:
        nm = nurse.get("name", "?")
        grp = nurse.get("group", "")
        return f"{nm}({grp})" if grp else nm

    def _fmt_date(self, dt: date) -> str:
        return f"{dt.strftime('%m/%d')}({self._DAY_KR[dt.weekday()]})"

    # ── 점수 계산 (확정 스케줄 → 간호사별 soft 점수) ──────────────────────────

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
        details: Dict[str, list] = {nurse["id"]: [] for nurse in self.nurses}

        for rule in self.scoring_rules:
            rt = rule.rule_type
            p  = rule.params
            sc = rule.score

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
                work_set = set(self.WORK_SHIFTS)
                for nurse in self.nurses:
                    nid = nurse["id"]
                    ns = schedule.get(nid, {})
                    for dk in dt_keys:
                        if dk in self.holidays and ns.get(dk, "") in work_set:
                            scores[nid] += sc
                            counts[nid] += 1

            elif rt == "weekend_work":
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

    # ── 솔루션 추출 (값 읽기는 엔진별 value_fn 주입) ──────────────────────────

    def _extract_solution(
        self, x: Dict, value_fn: Callable
    ) -> Tuple[Dict[str, Dict[str, str]], Dict[str, Dict[str, str]]]:
        """
        x[nid][d][shift] 변수에서 확정 스케줄을 읽는다.
        value_fn(var)->number: 엔진별 값 읽기 (HiGHS=pulp.value, CP-SAT=solver.Value).
        상수 셀(0/1)은 그대로 사용.
        Returns:
            schedule: {nurse_id: {YYYY-MM-DD: shift}} 당월만 (+범위)
            extended: {nurse_id: {YYYY-MM-DD: shift}} 전체 (인접 월 포함)
        """
        schedule: Dict[str, Dict[str, str]] = defaultdict(dict)
        extended: Dict[str, Dict[str, str]] = defaultdict(dict)

        for nurse in self.nurses:
            nid = nurse["id"]
            for d, dt in enumerate(self.all_dates):
                dt_str = dt.strftime("%Y-%m-%d")
                # 재적 밖 날짜(전입 전/전출 후): 빈 셀로 두어 "OF로 근무" 오인 방지
                if not self._nurse_active_on(nurse, dt):
                    continue
                assigned = None
                for s in self.ALL_SHIFTS:
                    v = x[nid][d][s]
                    if isinstance(v, (int, float)):
                        val = v
                    else:
                        val = value_fn(v)
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
                    continue
                if pid and pid in schedule:
                    preceptor_shift = schedule[pid].get(dt_str, "")
                    if preceptor_shift:
                        schedule[tid][dt_str] = "/" + preceptor_shift
                        extended[tid][dt_str] = "/" + preceptor_shift

        return dict(schedule), dict(extended)
