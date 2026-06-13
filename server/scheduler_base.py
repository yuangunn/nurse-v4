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

# ── 사전입력 보호 등급 (최소 침습) ──────────────────────────────────────────
# 사전입력은 간호사 개인의 인생 일정. 완화/처방으로 '빼는' 것도 수술처럼 최소 침습이어야
# 한다. 등급(낮을수록 먼저 완화): 근무 < (인원부족 보고) < 휴무(OFF·연차류) < 주휴.
#   · 주휴(주)  : 법정 주휴 — 고정. 사실상 완화하지 않음(allow_juhu_relax 시에만 별도).
#   · 휴무      : OFF + 연차/생리/특/공/법/병 — 쉼·여행·성취·결혼 등 개인의 시간 → 강하게 보호.
#   · 근무      : 배정 의도 — 상대적으로 유연 → 필요 시 먼저 완화.
_LEAVE_CODES = frozenset({"V", "생", "특", "공", "법", "병"})  # 연차류 휴가
_OFF_CODES = frozenset({"OF", "P1"})                          # 휴식(비번) + 임부휴무(모성보호)
_OFF_CODE = "OF"                                              # 휴식(비번)
_JUHU_CODE = "주"                                            # 주휴(고정)

def timeoff_class(code: str) -> str:
    """사전입력 코드의 보호 등급: 'leave' | 'off' | 'juhu' | 'work'.
    P1(임부휴무)은 모성보호 휴무라 OFF급으로 보호한다(연차류처럼 강하게)."""
    if code in _LEAVE_CODES:
        return "leave"
    if code in _OFF_CODES:
        return "off"
    if code == _JUHU_CODE:
        return "juhu"
    return "work"

def is_protected_timeoff(code: str) -> bool:
    """주휴를 제외한 모든 휴무(OFF·P1·연차류) = 보호 대상 여부."""
    return code in _LEAVE_CODES or code in _OFF_CODES

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
    {"code": "P1", "period": "rest",    "is_charge": False},
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
        self._request = request  # 원본 (CP-SAT infeasible 시 conflict 분석 재사용)
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
            # 임산부(모성보호): 해당 월에 임신 중이면 야간전담 해제 — 야간 면제와 충돌 방지
            if nurse.get("is_pregnant") and self._preg_active_in_month(nurse):
                nurse["is_night_shift"] = False
        # 임신 구간 파싱 캐시 {nid: {"early":(s,e)|None, "late":(s,e)|None}}
        self._preg = {n["id"]: self._parse_pregnancy(n) for n in self.nurses}
        # 대상 월에 임신 중인 간호사 id 집합 (생리휴가 면제·야간전담 해제 대상)
        self._preg_in_month = set(
            n["id"] for n in self.nurses
            if n.get("is_pregnant") and self._preg_active_in_month(n)
        )
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
        # 1일이 주기 경계와 정확히 일치하면 전월 중첩이 0일이 되어, 월 경계의
        # 금지 전환·연속 야간·N→OF→D를 아무 제약도 검증하지 못한다(전월
        # 사전입력이 범위 밖이라 전부 드롭됨). 한 주를 앞으로 확장해 전월 말
        # 기록이 경계 제약에 연결되게 한다. (프론트 scheduleDays도 동일 산식)
        if first_offset % 7 == 0:
            start_offset -= 7
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

    # ── 임산부(모성보호) 유틸리티 ─────────────────────────────────────────────
    def _parse_pregnancy(self, nurse: dict) -> Dict[str, object]:
        """임신 구간을 date 튜플로 파싱.
        Returns {"early": (start,end)|None, "late": (start,end)|None}.
        is_pregnant=False거나 값이 잘못되면 해당 구간 None."""
        out = {"early": None, "late": None}
        if not nurse.get("is_pregnant"):
            return out
        preg = nurse.get("pregnancy") or {}
        for key in ("early", "late"):
            w = preg.get(key) or {}
            s, e = w.get("start"), w.get("end")
            try:
                sd = date.fromisoformat(s) if s else None
                ed = date.fromisoformat(e) if e else None
            except (ValueError, TypeError):
                sd = ed = None
            if sd and ed and sd <= ed:
                out[key] = (sd, ed)
        return out

    def _preg_window_on(self, nid: str, dt: date) -> bool:
        """dt가 P1 구간(초기/말기) 내 — P1 허용·주1회 대상."""
        w = self._preg.get(nid)
        if not w:
            return False
        for key in ("early", "late"):
            rng = w.get(key)
            if rng and rng[0] <= dt <= rng[1]:
                return True
        return False

    def _preg_span_on(self, nid: str, dt: date) -> bool:
        """dt가 임신 전체 구간 [early.start, late.end] 내 — 야간(N/NC) 제외 대상."""
        w = self._preg.get(nid)
        if not w:
            return False
        bounds = [w[k] for k in ("early", "late") if w.get(k)]
        if not bounds:
            return False
        span_s = min(b[0] for b in bounds)
        span_e = max(b[1] for b in bounds)
        return span_s <= dt <= span_e

    def _preg_active_in_month(self, nurse: dict) -> bool:
        """임신 구간이 대상 월과 겹치는가 — 생리휴가 면제·야간전담 해제 대상.
        (__init__ 단계에서도 호출되므로 self._preg 대신 직접 파싱한다.)"""
        w = self._parse_pregnancy(nurse)
        bounds = [w[k] for k in ("early", "late") if w.get(k)]
        if not bounds:
            return False
        span_s = min(b[0] for b in bounds)
        span_e = max(b[1] for b in bounds)
        import calendar as _cal
        mlast = _cal.monthrange(self.year, self.month)[1]
        m_s = date(self.year, self.month, 1)
        m_e = date(self.year, self.month, mlast)
        return span_s <= m_e and span_e >= m_s  # 구간 겹침

    def _preg_forbids(self, nurse: dict, dt: date, s: str, pre: str = None) -> bool:
        """임산부 모성보호로 (날짜 dt, shift s)를 0으로 고정해야 하면 True.
          · P1: 임산부의 P1 구간(또는 사전입력 P1)에서만 허용 → 그 외 전원 금지
          · 야간(N/NC): 임신 전체 구간 동안 금지
          · 생(生): 임신-중-달엔 금지 (임신 중 생리 없음)
        """
        nid = nurse["id"]
        # P1은 임산부 P1 구간 또는 사전입력 P1에서만 — 비임산부 포함 전원 게이팅
        if s == "P1":
            if pre == "P1":
                return False
            return not (nurse.get("is_pregnant") and self._preg_window_on(nid, dt))
        if not nurse.get("is_pregnant"):
            return False
        if s in self.NIGHT_SHIFTS and self._preg_span_on(nid, dt):
            return True
        if s == "생" and nid in self._preg_in_month:
            return True
        return False

    def _preg_effective_pre(self, nurse: dict, dt: date, pre: str):
        """임산부 모성보호로 무시해야 할 사전입력(야간/생)은 None으로 — 솔버가 유효 근무 선택.
        (사전입력 N을 임산부에게 강제하면 야간 면제와 충돌해 infeasible이 되므로 드롭.)"""
        if not pre or not nurse.get("is_pregnant"):
            return pre
        nid = nurse["id"]
        if pre in self.NIGHT_SHIFTS and self._preg_span_on(nid, dt):
            return None
        if pre == "생" and nid in self._preg_in_month:
            return None
        return pre

    # ── 공용 게이팅 헬퍼 ──────────────────────────────────────────────────────
    # 같은 의미의 로직이 5개 경로(HiGHS strict/relax, CP-SAT strict/relax,
    # 진단·분석기)에 사본으로 존재하면 한쪽만 수정되는 발산 버그가 생긴다 —
    # 실제로 발산했던 로직들을 여기 단일 구현으로 모은다.

    def _effective_pre(self, nurse: dict, dt: date, pre: str, is_holiday: bool):
        """변수 도메인 기준의 '유효 사전입력' — 공휴일 OF 드롭 + 모성보호 드롭.
        모든 변수 생성 경로와 게이팅이 이 함수를 써야 의미가 일치한다."""
        if pre == "OF" and is_holiday:
            pre = None
        return self._preg_effective_pre(nurse, dt, pre)

    def _seniority_jfixed(self, nurse_j: dict, dt: date, dt_str: str,
                          is_holiday: bool):
        """charge 시니어리티 게이팅용 선임 j의 유효 사전입력.
        완화 모드(_pre_soft)에서는 잠긴 셀만 고정으로 취급한다."""
        j_fixed = self.prev.get(nurse_j["id"], {}).get(dt_str)
        if j_fixed:
            j_fixed = self._effective_pre(nurse_j, dt, j_fixed, is_holiday)
        if getattr(self, "_pre_soft", False) \
                and not self.locked_cells.get(nurse_j["id"], {}).get(dt_str):
            j_fixed = None
        return j_fixed

    def _two_month_rhs(self, nid: str) -> int:
        """홀짝월 합산 야간의 당월 RHS — 전월 초과(야간전담→일반 전환)는 0 클램프."""
        prev_nights = getattr(self, "prev_month_nights", None) or {}
        return max(0, self.rules.maxNightTwoMonthCount - (prev_nights.get(nid) or 0))

    def _night_dedicated_quota(self, nurse: dict, month_idxs, month_days: int):
        """야간전담 (재적일수, 당월 야간 목표일수). 재적 0이면 (0, 0).
        부분 재적은 14일 비례, 'N 요구가 명시적 0'인 날과의 산술 충돌 방지를 위해
        달성 가능 일수로 클램프."""
        active_days = sum(1 for d in month_idxs if self._nurse_active_idx(nurse, d))
        if active_days <= 0:
            return 0, 0
        target = 14 if active_days >= month_days else max(
            0, round(14 * active_days / month_days))
        req_dict = self.req.model_dump()
        n_avail = 0
        for d in month_idxs:
            dt = self.all_dates[d]
            base = req_dict.get(WEEKDAY_KEYS[dt.weekday()], {})
            ovr = self.per_day_req.get(dt.strftime('%Y-%m-%d'), {})
            dr = {**base, **ovr} if ovr else base
            if "N" not in dr or int(dr.get("N") or 0) > 0:
                n_avail += 1
        return active_days, min(target, n_avail)

    def _night_fairness_pool(self):
        """야간 공정 배분 대상 풀 — 야간 횟수가 구조적으로 고정된 간호사
        (야간전담·N 비자격·임산부·홀짝월 0 클램프)는 제외해야 range가 유효하다."""
        two_mo_blocked = set()
        if getattr(self.rules, "maxNightTwoMonth", False):
            prev_n = getattr(self, "prev_month_nights", None) or {}
            lim = self.rules.maxNightTwoMonthCount
            two_mo_blocked = {k for k, c in prev_n.items() if (c or 0) >= lim}
        return [
            nurse for nurse in self.nurses
            if not nurse.get("is_night_shift")
            and nurse["id"] not in two_mo_blocked
            and any(s in set(nurse.get("capable_shifts", self.WORK_SHIFTS))
                    for s in self.NIGHT_SHIFTS)
            and not (nurse.get("is_pregnant") and self._preg_active_in_month(nurse))
        ]

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
                            ds = str(day_str)
                            # 일(day) 숫자 키와 'YYYY-MM-DD' 키 모두 허용
                            if "-" in ds:
                                dk = date.fromisoformat(ds).strftime("%Y-%m-%d")
                            else:
                                dk = date(self.year, self.month, int(ds)).strftime("%Y-%m-%d")
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
