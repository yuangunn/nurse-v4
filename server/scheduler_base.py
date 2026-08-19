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

    # 사전입력 사실(fact) 인덱스 — strict 솔브 시작 시 _build_pin_index()가 채운다.
    # (클래스 기본값은 읽기 전용 폴백 — 제약 메서드를 단독 호출하는 테스트 대비)
    _pin: Dict = {}

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
        # 위시 공정성 보정 (서버가 거절 이력에서 산출) — {nid: 배수}
        self.wish_boosts = getattr(request, "wish_boosts", None) or {}
        # 야간 공정성 원장 오프셋 (직전 달 누적 야간) — {nid: n}
        self.fairness_offsets = getattr(request, "fairness_offsets", None) or {}

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
        _wish_extra: Dict[str, int] = {}  # 위시 공정성 보정분 (별도 행 표기용)

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
                    boost_extra = int(round(sc * (float(self.wish_boosts.get(nid, 1.0)) - 1.0)))
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
                            granted = (
                                (wish_shift == "OFF" and s in self.REST_SHIFTS + self.LEAVE_SHIFTS)
                                or s == wish_shift)
                            if granted:
                                scores[nid] += sc
                                counts[nid] += 1
                                if boost_extra:
                                    # 공정성 보정분은 별도 행으로 투명하게 표기
                                    _wish_extra[nid] = _wish_extra.get(nid, 0) + boost_extra
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

        # 위시 공정성 보정(직전 달 거절 누적 가중) — 별도 행으로 투명하게 표기
        for nid, extra in _wish_extra.items():
            scores[nid] += extra
            details[nid].append({
                "name": "위시 공정성 보정",
                "rule_type": "wish_boost",
                "count": 1,
                "score_per": extra,
                "total": extra,
            })

        return scores, details

    # ── 솔루션 추출 (값 읽기는 엔진별 value_fn 주입) ──────────────────────────

    # ── 사전입력 사실-클램프 (부분 확정 일반화, 2026-08-19 사용자 지시) ──────────
    #
    # "1월 2주차까지만 꽉 채우고 바꾸고 싶은 부분만 비워서 생성"하는 경우에도
    # 확정된 부분은 검증 대상이 아니라 주어진 사실이어야 한다:
    #   · 제약에 걸리는 셀이 전부 확정이면 그 제약은 걸지 않는다 (일 전체 확정 =
    #     그 날 확정, 인접 쌍/윈도우/주 전체 확정 = 그 구간 확정)
    #   · 확정+자유가 섞인 주/월 단위 카운트 제약은 확정분만큼 상한을 올린다
    #     (예: 확정 OF 2회인 주 → 자유 셀에 OF 추가 금지, 기존 2회는 수용)
    # 완화(allow_pre_relax)를 명시로 켰다면 "표를 고쳐서라도 규칙을 맞춰라"는
    # 뜻이므로 클램프를 끈다 (strict 시도 → infeasible → 완화 경로 유지).

    def _build_pin_index(self):
        """(nid, day_idx) → 유효 사전입력 코드. strict 솔브 시작 시 호출."""
        self._pin = {}
        if self.allow_pre_relax:
            return
        for nurse in self.nurses:
            nid = nurse["id"]
            pre_days = self.prev.get(nid, {})
            if not pre_days:
                continue
            for d, dt in enumerate(self.all_dates):
                if not self._nurse_active_on(nurse, dt):
                    continue
                pre = pre_days.get(dt.strftime("%Y-%m-%d"))
                if not pre:
                    continue
                pre = self._effective_pre(nurse, dt, pre, dt.strftime("%Y-%m-%d") in self.holidays)
                if pre:
                    self._pin[(nid, d)] = pre

    def _day_all_pinned(self, d, dt) -> bool:
        """그 날 재적 간호사 셀이 전부 확정인가 (= 그 날은 사실)."""
        active = [n for n in self.nurses if self._nurse_active_on(n, dt)]
        return bool(active) and all((n["id"], d) in self._pin for n in active)

    def _pin_day_period_count(self, d, codes) -> int:
        """그 날 확정 셀 중 코드 그룹에 속하는 수 (D↔DC류 플렉스는 period 불변)."""
        codes = set(codes)
        return sum(1 for n in self.nurses if self._pin.get((n["id"], d)) in codes)

    def _pin_nurse_count(self, nid, day_idxs, codes) -> int:
        """간호사 nid의 확정 셀 중 코드 그룹 개수 (day_idxs 범위)."""
        codes = set(codes)
        return sum(1 for d in day_idxs if self._pin.get((nid, d)) in codes)

    def _attach_pin_notes(self, result: Dict) -> Dict:
        """strict 성공 결과에 '확정 사실 vs 앱 규칙' 차이 안내를 덧붙인다 (정보 제공)."""
        if not self._pin or not result.get("success"):
            return result
        pin_sched: Dict[str, Dict[str, str]] = {}
        for (nid, d), code in self._pin.items():
            pin_sched.setdefault(nid, {})[self.all_dates[d].strftime("%Y-%m-%d")] = code
        notes = self._pinned_rule_notes(pin_sched)
        if notes:
            shown = notes[:12]
            result["pinned_notes"] = notes
            result["message"] += (
                f"\n\n📋 사전입력(확정 사실)이 앱 규칙과 다른 부분 {len(notes)}건 "
                "(참고용 — 확정 셀은 그대로 유지됨):\n"
                + "\n".join("  · " + n for n in shown))
            if len(notes) > 12:
                result["message"] += f"\n  · … 외 {len(notes) - 12}건"
        return result

    # ── 완전 확정 표 (완성 번표 입력) — 검증 대상이 아니라 주어진 사실 ─────────
    #
    # 이미 만들어진(지나간) 번표를 사전입력에 빈칸 없이 넣고 생성을 누르는 사용자
    # 시나리오: 솔버가 infeasible을 내면 표를 거부하는 대신 그대로 확정하고,
    # 앱 규칙과 다른 부분은 참고용으로만 알려준다 (2026-08-19 사용자 지시).

    def _fully_pinned(self) -> bool:
        """당월 재적 셀이 전부 사전입력으로 확정돼 있는가."""
        if not self.nurses:
            return False
        for nurse in self.nurses:
            pre_days = self.prev.get(nurse["id"], {})
            for dt in self.all_dates:
                if dt.month != self.month or dt.year != self.year:
                    continue
                if not self._nurse_active_on(nurse, dt):
                    continue
                if not pre_days.get(dt.strftime("%Y-%m-%d")):
                    return False
        return True

    def _confirm_pinned_result(self) -> Dict:
        """빈칸 없는 확정 표 → 솔버 결과 대신 표를 그대로 근무표로 확정.
        점수는 계산하고, 앱 규칙 기준 차이는 참고 목록으로만 첨부한다."""
        schedule: Dict[str, Dict[str, str]] = {}
        extended: Dict[str, Dict[str, str]] = {}
        for nurse in self.nurses:
            nid = nurse["id"]
            for dt in self.all_dates:
                dt_str = dt.strftime("%Y-%m-%d")
                code = self.prev.get(nid, {}).get(dt_str)
                if not code or not self._nurse_active_on(nurse, dt):
                    continue
                extended.setdefault(nid, {})[dt_str] = code
                if dt.month == self.month and dt.year == self.year:
                    schedule.setdefault(nid, {})[dt_str] = code
        nurse_scores, nurse_score_details = self._compute_nurse_scores(schedule)
        notes = self._pinned_rule_notes(extended)
        msg = ("✅ 사전입력이 빈칸 없이 확정되어 있어 표를 그대로 근무표로 확정했습니다.\n"
               "(완성된 표는 검증 대상이 아니라 주어진 사실로 취급 — 솔버가 표를 바꾸지 않음)")
        if notes:
            shown = notes[:12]
            msg += ("\n\n📋 앱 규칙 기준으로 다른 부분 (참고용 — 표는 그대로 유지됨):\n"
                    + "\n".join("  · " + n for n in shown))
            if len(notes) > 12:
                msg += f"\n  · … 외 {len(notes) - 12}건"
        else:
            msg += "\n앱 규칙 기준으로도 차이가 없습니다."
        return {
            "success": True,
            "schedule": schedule,
            "extended_schedule": extended,
            "nurse_scores": nurse_scores,
            "nurse_score_details": nurse_score_details,
            "message": msg,
            "pinned_confirmed": True,
            "pinned_notes": notes,
            "estimated_seconds": 0,
        }

    def _pinned_rule_notes(self, sched: Dict[str, Dict[str, str]]) -> List[str]:
        """확정 표가 앱 규칙과 다른 지점 목록 (정보 제공용 — 어떤 것도 강제하지 않음)."""
        notes: List[str] = []
        first_of_month = date(self.year, self.month, 1)
        weekday_keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        day_kr = ["월", "화", "수", "목", "금", "토", "일"]
        name_of = {n["id"]: (n.get("name") or n["id"]) for n in self.nurses}

        def md(dt):
            return f"{dt.strftime('%m/%d')}({day_kr[dt.weekday()]})"

        # ① 일별 D/E/N 인원 vs 기준 — 그 날이 표에서 '전부 채워진' 경우만 비교
        #    (부분 확정 날은 자유 셀이 채우므로 비교 무의미)
        req_dict = self.req.model_dump()
        period_map = {"D": set(self.DAY_SHIFTS), "E": set(self.EVENING_SHIFTS),
                      "N": set(self.NIGHT_SHIFTS)}
        diffs = []
        for dt in self.all_dates:
            if dt.month != self.month or dt.year != self.year:
                continue
            dt_str = dt.strftime("%Y-%m-%d")
            active = [n for n in self.nurses if self._nurse_active_on(n, dt)]
            if not active or not all(sched.get(n["id"], {}).get(dt_str) for n in active):
                continue
            base = req_dict.get(weekday_keys[dt.weekday()], {})
            override = self.per_day_req.get(dt_str) or {}
            day_req = {**base, **override}
            for p, codes in period_map.items():
                want = max(0, int(day_req.get(p) or 0))
                got = sum(1 for days in sched.values() if days.get(dt_str) in codes)
                if got != want:
                    diffs.append(f"{md(dt)} {p} {got}명(기준 {want})")
        if diffs:
            notes.append(f"일별 인원이 기준과 다른 날 {len(diffs)}건: "
                         + ", ".join(diffs[:4]) + (" …" if len(diffs) > 4 else ""))

        # ② 금지 전환 (전월 내부 완결은 역사로 보고 제외)
        forb = [
            (set(self.EVENING_SHIFTS), set(self.DAY_SHIFTS), "E→D"),
            (set(self.EVENING_SHIFTS), set(self.DAY1_SHIFTS), "E→D1"),
            (set(self.EVENING_SHIFTS), set(self.MIDDLE_SHIFTS), "E→중"),
            (set(self.NIGHT_SHIFTS), set(self.EVENING_SHIFTS), "N→E"),
            (set(self.NIGHT_SHIFTS), set(self.DAY_SHIFTS), "N→D"),
            (set(self.NIGHT_SHIFTS), set(self.DAY1_SHIFTS), "N→D1"),
            (set(self.NIGHT_SHIFTS), set(self.MIDDLE_SHIFTS), "N→중"),
            (set(self.MIDDLE_SHIFTS), set(self.DAY_SHIFTS), "중→D"),
            (set(self.MIDDLE_SHIFTS), set(self.DAY1_SHIFTS), "중→D1"),
        ]
        for nid, days in sched.items():
            for i in range(len(self.all_dates) - 1):
                d1, d2 = self.all_dates[i], self.all_dates[i + 1]
                if d2 < first_of_month:
                    continue
                c1 = days.get(d1.strftime("%Y-%m-%d"))
                c2 = days.get(d2.strftime("%Y-%m-%d"))
                if not c1 or not c2:
                    continue
                for g1, g2, label in forb:
                    if c1 in g1 and c2 in g2:
                        notes.append(f"{name_of.get(nid, nid)} {md(d1)} {c1} → {md(d2)} {c2} ({label} 전환)")

        # ③ 주별 OF 횟수 (야간전담 제외 — 완전한 주 기준 1회)
        for nurse in self.nurses:
            if nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            days = sched.get(nid, {})
            for wi, (ws, we) in enumerate(self.weeks):
                wd = [d for d in range(ws, we + 1)
                      if self.all_dates[d] >= first_of_month
                      and self._nurse_active_idx(nurse, d)]
                if not wd:
                    continue
                ofs = sum(1 for d in wd
                          if days.get(self.all_dates[d].strftime("%Y-%m-%d")) == "OF")
                covered = all(days.get(self.all_dates[d].strftime("%Y-%m-%d")) for d in wd)
                if ofs > 1:
                    notes.append(f"{name_of[nid]} {wi + 1}주차 OF {ofs}회 (생성 규칙은 주 1회)")
                elif len(wd) >= 7 and covered and ofs == 0:
                    notes.append(f"{name_of[nid]} {wi + 1}주차 OF 0회 (생성 규칙은 주 1회)")

        # ④ V 월 한도 / ⑤ 월 최대 야간 / ⑥ 연속 근무·야간 한도
        month_idxs = [i for i, dt in enumerate(self.all_dates)
                      if dt.month == self.month and dt.year == self.year]
        work_set = set(self.WORK_SHIFTS)
        night_set = set(self.NIGHT_SHIFTS)
        for nurse in self.nurses:
            nid = nurse["id"]
            days = sched.get(nid, {})
            month_codes = [days.get(self.all_dates[i].strftime("%Y-%m-%d")) for i in month_idxs]
            if self.rules.maxVPerMonth > 0 and not self.unlimited_v:
                v = sum(1 for c in month_codes if c == "V")
                if v > self.rules.maxVPerMonth:
                    notes.append(f"{name_of[nid]} V {v}회 (생성 규칙은 월 {self.rules.maxVPerMonth}회)")
            if self.rules.maxNightPerMonth and not nurse.get("is_night_shift"):
                n_cnt = sum(1 for c in month_codes if c in night_set)
                if n_cnt > self.rules.maxNightPerMonthCount:
                    notes.append(f"{name_of[nid]} 야간 {n_cnt}회 (생성 규칙은 월 {self.rules.maxNightPerMonthCount}회)")
            # 연속 근무/야간 — 전월 내부 완결 run은 제외 (당월에 닿는 run만)
            def _max_run(pred):
                best = run = 0
                run_end_cur = False
                best_cur = 0
                for i, dt in enumerate(self.all_dates):
                    c = days.get(dt.strftime("%Y-%m-%d"))
                    if c and pred(c):
                        run += 1
                        run_end_cur = run_end_cur or dt >= first_of_month
                    else:
                        if run_end_cur:
                            best_cur = max(best_cur, run)
                        run = 0
                        run_end_cur = False
                if run_end_cur:
                    best_cur = max(best_cur, run)
                return best_cur
            if self.rules.maxConsecutiveWork:
                mw = _max_run(lambda c: c in work_set)
                if mw > self.rules.maxConsecutiveWorkDays:
                    notes.append(f"{name_of[nid]} 연속 근무 {mw}일 (생성 규칙은 ≤{self.rules.maxConsecutiveWorkDays}일)")
            if self.rules.maxConsecutiveNight:
                mn = _max_run(lambda c: c in night_set)
                if mn > self.rules.maxConsecutiveNightDays:
                    notes.append(f"{name_of[nid]} 연속 야간 {mn}일 (생성 규칙은 ≤{self.rules.maxConsecutiveNightDays}일)")

        # ⑧ 연속 야간 후 휴무 (restAfterNight) — 확정만으로 완결된 위반 안내
        if getattr(self.rules, "restAfterNight", False):
            min_consec = getattr(self.rules, "restAfterNightMinConsec", 2)
            ran_days = getattr(self.rules, "restAfterNightDays", 2)
            work_non_night = work_set - night_set
            for nurse in self.nurses:
                if nurse.get("is_night_shift"):
                    continue
                days = sched.get(nurse["id"], {})
                codes = [days.get(dt.strftime("%Y-%m-%d")) for dt in self.all_dates]
                run = 0
                for i, c in enumerate(codes):
                    if c in night_set:
                        run += 1
                        continue
                    if run >= min_consec:
                        for k in range(ran_days):
                            rd = i + k
                            if rd >= len(codes):
                                break
                            if (codes[rd] in work_non_night
                                    and self.all_dates[rd] >= first_of_month):
                                seq = "→".join(self.all_dates[j].strftime("%m/%d")
                                               for j in range(i - run, i))
                                notes.append(
                                    f"{name_of[nurse['id']]} {seq} 연속 야간 직후 "
                                    f"{md(self.all_dates[rd])} '{codes[rd]}' 근무 "
                                    f"(생성 규칙은 야간 후 {ran_days}일 휴무)")
                                break
                    run = 0

        # ⑨ N→휴무→D 패턴 (noNOD) — 확정만으로 완결된 위반 안내
        if getattr(self.rules, "noNOD", False):
            rest_set = set(self.REST_SHIFTS)
            day_set = set(self.DAY_SHIFTS)
            for nid, days in sched.items():
                for i in range(len(self.all_dates) - 2):
                    if self.all_dates[i + 2] < first_of_month:
                        continue
                    c1 = days.get(self.all_dates[i].strftime("%Y-%m-%d"))
                    c2 = days.get(self.all_dates[i + 1].strftime("%Y-%m-%d"))
                    c3 = days.get(self.all_dates[i + 2].strftime("%Y-%m-%d"))
                    if c1 in night_set and c2 in rest_set and c3 in day_set:
                        notes.append(
                            f"{name_of.get(nid, nid)} {md(self.all_dates[i])} {c1} → "
                            f"{c2} → {md(self.all_dates[i + 2])} {c3} (N→휴무→D 패턴)")

        # ⑦ 야간전담 당월 야간 일수 vs 규정
        import calendar
        month_days = calendar.monthrange(self.year, self.month)[1]
        for nurse in self.nurses:
            if not nurse.get("is_night_shift"):
                continue
            nid = nurse["id"]
            days = sched.get(nid, {})
            active_days, target = self._night_dedicated_quota(nurse, month_idxs, month_days)
            if active_days <= 0:
                continue
            n_cnt = sum(1 for i in month_idxs
                        if days.get(self.all_dates[i].strftime("%Y-%m-%d")) in night_set)
            covered = all(days.get(self.all_dates[i].strftime("%Y-%m-%d"))
                          for i in month_idxs if self._nurse_active_idx(nurse, i))
            if n_cnt > target or (covered and n_cnt != target):
                notes.append(f"{name_of[nid]} (야간전담) 당월 야간 {n_cnt}일 (생성 규칙은 {target}일)")

        return notes

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
