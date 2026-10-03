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
#   · 휴무      : OFF + 연차/생리/특/공/법/병/경가/조가/산전 — 쉼·여행·성취·결혼 등 개인의 시간 → 강하게 보호.
#   · 근무      : 배정 의도 — 상대적으로 유연 → 필요 시 먼저 완화.
# 경가(경사휴가)·조가(조사휴가)·산전(산전검진) = 병동 번표에 실제로 쓰는 사전입력 전용 휴가 (2026-10-03)
_LEAVE_CODES = frozenset({"V", "생", "특", "공", "법", "병", "경가", "조가", "산전"})  # 연차류 휴가
_OFF_CODES = frozenset({"OF", "P1"})                          # 휴식(비번) + 임부휴무(모성보호)
_OFF_CODE = "OF"                                              # 휴식(비번)
_JUHU_CODE = "주"                                            # 주휴(고정)
# 오프특근 페널티 — 제1원칙 3(2026-08-20 사용자 명시).
# "오프특근은 어쩔 수 없으면 발생한다. 경가·조가 등으로 휴무가 갑자기 많아지면 남은
#  근무자가 오프를 줄여가며 근무를 뛴다. 그에 대한 최소한의 휴무 보장이 주휴다."
# → 주 1회 OF는 '조건부 면제'가 아니라 **최대한 지키는 의무**다. 하드로 못 박으면
#   결원이 생긴 달이 통째로 실패하므로, 슬랙 변수 + 압도적 페널티로 건다:
#     Σ(주간 OF) + s = bound,  목적함수 -= 1_000_000 × s
#   다른 어떤 배점 조합보다 크므로 s=1(오프특근)은 '그러지 않으면 근무표가 성립하지
#   않을 때'만 켜진다. 켜진 주는 결과의 off_teukgeun 리포트로 보고한다.
_OFF_TEUKGEUN_PENALTY = 1_000_000
# 파트장 확인 하에 쓰는 마지막 수단 — 제1원칙 13(2026-10-03 101병동 확인).
# "연속근무 6일은 가급적 만들어지면 안 되지만 파트장 컨펌 하 제한적으로 가능 — 주말이
#  껴 있으면 업무 로딩이 준다" · "번표가 정 안 나오면 E→D1·중→D 로도 근무한다".
# → 하드 금지를 슬랙 + 큰 감점으로 바꾼다. 감점은 연차(V -500)·근무 원티드(500)보다 크고
#   휴가 원티드(5000)보다 작다. 완화 1단계(원티드 유지)에도 같은 감점을 넣어, 근무 원티드
#   하나를 지키려고 6일 연속을 만들지 않게 한다. 상한은 한도+1(7일 연속은 여전히 금지).
#   쓴 곳은 결과의 manager_check('파트장 확인 필요')로 보고한다.
_LONG_RUN_PENALTY = 3000          # 연속 근무 한도를 하루 넘김
_LONG_RUN_WEEKEND_RELIEF = 500    # 그 연속 안의 토·일·공휴일 하루마다 덜 깎는다
_LONG_RUN_MIN_PENALTY = 1500
_RARE_TRANSITION_PENALTY = 2000   # E→D1 · 중→D

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

def parse_pregnancy(nurse: dict) -> Dict[str, object]:
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


def preg_overlaps_month(nurse: dict, year: int, month: int) -> bool:
    """임신 구간 [early.start, late.end] 이 그 달과 겹치는가."""
    w = parse_pregnancy(nurse)
    bounds = [w[k] for k in ("early", "late") if w.get(k)]
    if not bounds:
        return False
    import calendar as _cal
    m_s = date(year, month, 1)
    m_e = date(year, month, _cal.monthrange(year, month)[1])
    return min(b[0] for b in bounds) <= m_e and max(b[1] for b in bounds) >= m_s


def night_keeper_in_month(nurse: dict, year: int, month: int) -> bool:
    """그 달 야간전담(나이트킵)인가.
    night_months 에 하나라도 있으면 그 달 키로, 비었으면 is_night_shift 폴백.
    임신 중인 달은 야간전담이 아니다(모성보호가 이긴다).
    엔진(__init__)과 사전검증(api)이 같은 답을 내도록 이 함수 하나를 쓴다."""
    nm = nurse.get("night_months") or {}
    if nm:
        nk = bool(nm.get(f"{year}-{month:02d}", False))
    else:
        nk = bool(nurse.get("is_night_shift"))
    if nk and nurse.get("is_pregnant") and preg_overlaps_month(nurse, year, month):
        return False
    return nk


# 기본 근무 20종 (DB 없이 fallback 시 사용)
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
    # 병동 휴가 코드 — 사전입력 전용(솔버가 놓지 않는다). auto_assign 을 꼭 적는다:
    # 빠지면 기본값 True 가 되어 폴백 경로에서 비용 없는 휴무 코드 3개가 생긴다.
    {"code": "경가", "period": "leave",  "is_charge": False, "auto_assign": False},
    {"code": "조가", "period": "leave",  "is_charge": False, "auto_assign": False},
    {"code": "산전", "period": "leave",  "is_charge": False, "auto_assign": False},
]

# 병동 번표 표기 → 앱 코드 (붙여넣기 프론트와 같은 뜻 — 옛 저장본·API 직접 호출 대비)
_PRE_ALIAS = {"OFF": "OF", "Off": "OF", "off": "OF", "특V": "특", "특v": "특", "공가": "공",
              # 원티드 '둘 중 하나'·'N 빼고' 표기 (제1원칙 14)
              "E/D": "D/E", "DE": "D/E", "ED": "D/E", "N/E": "E/N", "EN": "E/N", "NE": "E/N",
              "DN": "D/N", "ND": "D/N", "N/D": "D/N", "N 제외": "N제외", "N빼고": "N제외"}

# 원티드 '둘 중 하나' — 그 날 두 근무 중 아무거나 (차지 포함, D1·중 제외) (제1원칙 14, 2026-10-03)
_FLEX_ONE_OF = {"D/E": ("day", "evening"), "E/N": ("evening", "night"), "D/N": ("day", "night")}
# 원티드 'N 빼고' — 야간(N·NC)만 아니면 쉬어도 된다
_FLEX_NOT = {"N제외": ("night",)}
FLEX_WISH_CODES = frozenset(_FLEX_ONE_OF) | frozenset(_FLEX_NOT)


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
    # 원티드 '둘 중 하나'·'N 빼고' 칸 {nid: {날짜: 코드}} — __init__ 이 prev 에서 떼어 채운다
    flex_pre: Dict = {}

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
        # 임산부(모성보호): 해당 월에 임신 중이면 야간전담 해제 — 야간 면제와 충돌 방지
        # 덮어쓰기 전 원래 값 — 생성 범위 끝에 붙은 다음 달 며칠을 그 달 기준으로 볼 때 쓴다 (_keeper_on)
        self._night_base = {n["id"]: bool(n.get("is_night_shift")) for n in self.nurses}
        self._keeper_cache = {}
        for nurse in self.nurses:
            nurse["is_night_shift"] = night_keeper_in_month(nurse, self.year, self.month)
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
        # 법정공휴일: 범위 좁히기는 _build_date_range() 뒤에서 (생성 주기 기준)
        self.holidays = set(request.holidays or [])
        self.allow_pre_relax = request.allow_pre_relax
        self.allow_juhu_relax = request.allow_juhu_relax
        self.juhu_block_lock = getattr(request, 'juhu_block_lock', True)
        self.unlimited_v = request.unlimited_v
        # 위시 공정성 보정 (서버가 거절 이력에서 산출) — {nid: 배수}
        self.wish_boosts = getattr(request, "wish_boosts", None) or {}
        # 완화 이력 보정 (서버가 뒤집힌 원티드 이력에서 산출) — {nid: 유지 보너스 배수}
        self.relax_boosts = getattr(request, "relax_boosts", None) or {}
        # 야간 공정성 원장 오프셋 (직전 달 누적 야간) — {nid: n}
        self.fairness_offsets = getattr(request, "fairness_offsets", None) or {}
        # 주말·공휴일 근무 공정성 원장 오프셋 (직전 달 누적 주말·공휴일 근무일) — {nid: n} (M6 P3②)
        self.weekend_offsets = getattr(request, "weekend_offsets", None) or {}

        # ── 근무 정의 → 카테고리 리스트 동적 구성 ─────────────────────────────
        shifts = [s.model_dump() for s in request.shifts] if request.shifts else []
        if not shifts:
            # fallback: 기본 20종 (DB 없이 임포트 시)
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
        # 법정공휴일은 '생성 주기 범위' 안의 날짜만 사용한다 — 당월만 필터하면
        # 월경계 주에 걸린 익월 공휴일(신정·설날·삼일절)을 못 봐서 ① 그 날에
        # OF/V/생을 배정해 버리고 ② 오프특근 판정에서도 빠진다. (2026-08-20)
        self.holidays = set(h for h in self.holidays if h in valid_dates)
        valid_nurse_ids = set(n["id"] for n in self._all_nurses)
        def _normalize_pre(s: str) -> str:
            if not s:
                return s
            if s.startswith("/"):
                return ""
            return _PRE_ALIAS.get(s, s)
        self.prev = {
            nid: {dt: _normalize_pre(s) for dt, s in days.items()
                  if dt in valid_dates and _normalize_pre(s)}
            for nid, days in self.prev.items()
            if nid in valid_nurse_ids
        }
        # 원티드 '둘 중 하나'(D/E·E/N·D/N)·'N 빼고'(N제외)는 한 근무로 정해진 칸이 아니다 —
        # 사전입력(확정 사실)에서 떼어 따로 둔다. 그 칸은 빈칸처럼 자유롭되 허용 근무만 쓴다
        # (_apply_flex_wishes). prev 에 두면 사실-클램프·완전 확정 표가 'D/E'를 한 코드로 센다.
        self.flex_pre: Dict[str, Dict[str, str]] = {}
        for nid, days in self.prev.items():
            for dt in [k for k, v in days.items() if v in FLEX_WISH_CODES]:
                self.flex_pre.setdefault(nid, {})[dt] = days.pop(dt)
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
        """임신 구간을 date 튜플로 파싱 — 모듈 함수 parse_pregnancy 위임."""
        return parse_pregnancy(nurse)

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
        """임신 구간이 대상 월과 겹치는가 — 생리휴가 면제·야간전담 해제 대상."""
        return preg_overlaps_month(nurse, self.year, self.month)

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

    def _keeper_on(self, nurse: dict, dt: date = None) -> bool:
        """그 날짜에 나이트킵(야간전담)인가 — **날짜가 속한 달** 기준 (2026-10-03).

        병동은 나이트킵을 달력 달로 맡긴다: 실제 번표에서 9월 나이트킵은 10/1~10/3 에 D·E,
        10월 나이트킵은 같은 사흘에 N·OF·주였다. 생성 범위는 주 단위라 끝에 다음 달 며칠이
        붙는데, 거기서 생성 달 판정을 그대로 쓰면 다음 달 나이트킵에게 D·E 가 들어가고
        (나이트킵은 N·V·생·OF 만 — 제1원칙 10), 이번 달 나이트킵은 다음 달에도 법을 못 받는다.
        생성 달 안은 __init__ 이 해석해 둔 nurse['is_night_shift'] (night_months + 임산부 해제)."""
        if dt is None or (dt.year == self.year and dt.month == self.month):
            return bool(nurse.get("is_night_shift"))
        cache = getattr(self, "_keeper_cache", None)
        if cache is None:
            cache = self._keeper_cache = {}
        key = (nurse["id"], dt.year, dt.month)
        if key not in cache:
            base = getattr(self, "_night_base", {}).get(nurse["id"], nurse.get("is_night_shift"))
            cache[key] = night_keeper_in_month(dict(nurse, is_night_shift=base), dt.year, dt.month)
        return cache[key]

    def _keeper_forbids(self, nurse: dict, dt: date, s: str, pre: str = None) -> bool:
        """생성 달 뒤에 붙은 다음 달 며칠에서, 그 달 나이트킵에게 야간 외 근무를 막는다.

        생성 달 안은 _c_night_shift_nurses / _cs_night_shift_nurses 가 맡는다 (14회·5일 윈도우와 함께).
        사전입력 pre 의 근무는 그대로 둔다 — strict 에서 사전입력은 사실이다. 완화 경로는
        잠긴 칸을 이 게이트 전에 상수로 묶으므로 pre=None 으로 불러 원티드도 함께 막는다."""
        if s not in self.WORK_SHIFTS or s in self.NIGHT_SHIFTS:
            return False
        if dt <= self._month_last_day():
            return False   # 생성 달 안(달 규칙이 맡음)이거나 지난달 기록
        if not self._keeper_on(nurse, dt):
            return False
        return not (pre and s in self._PRE_FLEX.get(pre, {pre}))

    def _month_last_day(self) -> date:
        import calendar as _cal
        return date(self.year, self.month, _cal.monthrange(self.year, self.month)[1])

    def _holiday_of_banned(self, nurse: dict, is_holiday: bool, dt: date = None) -> bool:
        """공휴일 OF 금지는 일반 간호사에게만 — 일반은 공휴일에 '법'으로 쉰다.
        야간전담(나이트킵)은 법을 받지 못하므로 공휴일에도 OF로 쉰다
        (2026-10-03 병동 확인: 실제 번표의 공휴일 OF 15건이 모두 그 달 나이트킵).
        나이트킵인지는 날짜가 속한 달로 본다(_keeper_on) — 모든 변수 생성 경로가 이 함수를 써야 한다.
        지난달 칸(dt < 1일)은 기록이라 막지 않는다 — 지난달 나이트킵의 설날 OF 같은
        사실을 이번 달 기준으로 지우면 월 경계 N→OF→D·연속 근무 검사가 흐려진다."""
        if dt is not None and dt < date(self.year, self.month, 1):
            return False
        return bool(is_holiday) and not self._keeper_on(nurse, dt)

    # ── 파트장 확인 하에 쓰는 마지막 수단 (제1원칙 13) ────────────────────────
    def _soft_long_run(self) -> bool:
        """연속 근무 한도 +1일을 마지막 수단으로 허용하는가 (규칙 longRunLastResort)."""
        return bool(self.rules.maxConsecutiveWork
                    and getattr(self.rules, "longRunLastResort", True))

    def _transition_rules(self) -> list:
        """역순 전환 9종 — (라벨, 앞 근무들, 뒤 근무들, 마지막 수단 여부).
        E→D1·중→D 는 '번표가 정 안 나오면 그렇게 근무한다'(2026-10-03) — 규칙
        rareTransitionLastResort 가 켜져 있으면 큰 감점으로만 막는다. 나머지 7개는 하드."""
        soft = bool(getattr(self.rules, "rareTransitionLastResort", True))
        return [
            ("E→D",   self.EVENING_SHIFTS, self.DAY_SHIFTS,    False),  # 22:00→06:00 = 8h
            ("E→D1",  self.EVENING_SHIFTS, self.DAY1_SHIFTS,   soft),   # 22:00→08:30 = 10.5h
            ("E→중",  self.EVENING_SHIFTS, self.MIDDLE_SHIFTS, False),  # 22:00→11:00 = 13h
            ("N→E",   self.NIGHT_SHIFTS,   self.EVENING_SHIFTS, False),
            ("N→D",   self.NIGHT_SHIFTS,   self.DAY_SHIFTS,    False),
            ("N→D1",  self.NIGHT_SHIFTS,   self.DAY1_SHIFTS,   False),
            ("N→중",  self.NIGHT_SHIFTS,   self.MIDDLE_SHIFTS, False),
            ("중→D",  self.MIDDLE_SHIFTS,  self.DAY_SHIFTS,    soft),   # 19:00→06:00 = 11h
            ("중→D1", self.MIDDLE_SHIFTS,  self.DAY1_SHIFTS,   False),  # 19:00→08:30 = 13.5h
        ]

    def _long_run_penalty(self, window) -> int:
        """한도+1 연속 근무 감점 — 그 안의 토·일·공휴일 하루마다 덜 깎는다
        ('주말이 껴 있으면 업무 로딩이 준다', 2026-10-03)."""
        k = sum(1 for d in window if self._is_weekend_or_holiday(self.all_dates[d]))
        return max(_LONG_RUN_MIN_PENALTY, _LONG_RUN_PENALTY - _LONG_RUN_WEEKEND_RELIEF * k)

    def _window_has_pinned_rest(self, nid, window) -> bool:
        """윈도우 안에 확정된 쉬는 칸이 있으면 연속 근무 제약이 저절로 지켜진다 (변수 절약)."""
        work = set(self.WORK_SHIFTS)
        for d in window:
            p = self._pin.get((nid, d))
            if p and p not in work:
                return True
        return False

    def _last_resort_terms(self) -> list:
        """[(감점, 슬랙 변수)] — 목적함수와 완화 1단계가 같은 목록을 쓴다."""
        return (list(getattr(self, "_long_run_slack", []))
                + list(getattr(self, "_rare_tr_slack", [])))

    def _relax_off_teukgeun_terms(self, *bonuses: int) -> list:
        """완화 1단계에 넣는 오프특근 [(감점, 슬랙)] — 2단계 목적함수의 1,000,000 과는 따로.

        1단계에 마지막 수단(6일 연속·E→D1)만 있고 오프특근이 없으면, 원티드를 풀어야 하는 달엔
        6일 연속 대신 오프특근(+V)을 공짜로 골라 버린다 — strict(오프특근 ≫ 6일 연속)와 거꾸로다.
        **오프특근은 가장 나중** (2026-10-03 원근 결정): 감점을 원티드 한 칸의 유지 보너스 중
        가장 큰 것(휴가 원티드, 완화 이력 보정 포함)과 마지막 수단보다 크게 둔다 — 근무·OF·휴가
        원티드를 풀어서 되면 오프특근을 쓰지 않는다. 견주는 단위는 한 칸 대 한 번이다.
        bonuses = 엔진의 원티드 유지 보너스(휴가·쉬는 날·근무). 100 단위로 맞춰 완화 폴백의
        보너스 gcd 를 깨지 않는다."""
        boosts = getattr(self, "relax_boosts", None) or {}
        boost = max([1.0] + [float(b) for b in boosts.values()])
        top = max([int(round(int(b) * boost)) for b in bonuses]
                  + [_LONG_RUN_PENALTY, _RARE_TRANSITION_PENALTY])
        pen = -(-top // 100) * 100 + 100
        return [(pen, sl) for sl in getattr(self, "_off_slack", [])]

    def _effective_pre(self, nurse: dict, dt: date, pre: str, is_holiday: bool):
        """변수 도메인 기준의 '유효 사전입력' — 공휴일 OF 드롭(일반 간호사) + 모성보호 드롭.
        모든 변수 생성 경로와 게이팅이 이 함수를 써야 의미가 일치한다."""
        if pre == "OF" and self._holiday_of_banned(nurse, is_holiday, dt):
            pre = None
        return self._preg_effective_pre(nurse, dt, pre)

    # ── 원티드 '둘 중 하나'·'N 빼고' (제1원칙 14) ─────────────────────────────

    def _has_pre(self) -> bool:
        """완화 재시도할 사전입력이 있는가 — 확정 칸 또는 원티드 D/E·N제외 칸."""
        return bool(self.prev) or bool(self.flex_pre)

    def _flex_allowed(self, code: str) -> set:
        """원티드 D/E·E/N·D/N·N제외 칸에 놓을 수 있는 근무 집합.
        '둘 중 하나'는 두 시간대의 근무(차지 포함 — D1·중은 아님), 'N 빼고'는 야간만 뺀 전부
        (쉬는 코드 포함 — 쉬는 코드의 일반 규칙[법은 공휴일만 등]은 변수 도메인이 따로 건다)."""
        if code in _FLEX_ONE_OF:
            per = {"day": self.DAY_SHIFTS, "evening": self.EVENING_SHIFTS,
                   "night": self.NIGHT_SHIFTS}
            return {s for p in _FLEX_ONE_OF[code] for s in per[p]}
        if code in _FLEX_NOT:
            return set(self.ALL_SHIFTS) - set(self.NIGHT_SHIFTS)
        return set(self.ALL_SHIFTS)

    def _apply_flex_wishes(self, x, soft: bool = False) -> list:
        """변수 생성 직후 원티드 D/E·N제외 칸에 허용 근무만 남긴다 (모든 엔진·진단 공통).

        strict(soft=False): 허용 밖 근무를 상수 0 — 사전입력처럼 하드 도메인.
        완화(soft=True): 잠긴 칸·지난달 기록만 하드, 나머지는 손대지 않고
        [(nid, d, code, [허용 변수])] 를 돌려준다 — 엔진이 근무 원티드 유지 보너스를 붙인다.
        x 값은 변수 또는 상수(int) — 두 엔진 모두 상수는 int 다."""
        keeps = []
        if not self.flex_pre:
            return keeps
        idx = {dt.strftime("%Y-%m-%d"): d for d, dt in enumerate(self.all_dates)}
        first = date(self.year, self.month, 1)
        for nurse in self.nurses:
            nid = nurse["id"]
            for dt_str, code in self.flex_pre.get(nid, {}).items():
                d = idx.get(dt_str)
                if d is None or nid not in x or not self._nurse_active_on(nurse, self.all_dates[d]):
                    continue
                allowed = self._flex_allowed(code)
                cell = x[nid][d]
                hard = (not soft or bool(self.locked_cells.get(nid, {}).get(dt_str))
                        or self.all_dates[d] < first)
                if hard:
                    for s in list(cell):
                        if s not in allowed:
                            cell[s] = 0
                    continue
                terms = [cell[s] for s in allowed if s in cell and not isinstance(cell[s], int)]
                if terms:
                    keeps.append((nid, d, code, terms))
        return keeps

    def _flex_relaxed(self, schedule: Dict, relaxed_cells: Dict) -> int:
        """완화 결과에서 못 지킨 원티드 D/E·N제외 칸을 relaxed_cells 에 더한다 (근무 원티드).
        더한 칸 수를 돌려준다."""
        added = 0
        for nid, days in self.flex_pre.items():
            for dt_str, code in days.items():
                assigned = schedule.get(nid, {}).get(dt_str)
                if assigned and assigned not in self._flex_allowed(code):
                    relaxed_cells.setdefault(nid, {})[dt_str] = {
                        "original": code, "assigned": assigned, "is_timeoff": False,
                    }
                    added += 1
        return added

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

    def _night_dedicated_in(self, nid: str, year: int, month: int) -> bool:
        """그 달에 이 간호사가 야간전담(나이트킵)이었는가 — night_months 기준."""
        key = f"{year:04d}-{month:02d}"
        for n in getattr(self, "_all_nurses", None) or self.nurses:
            if n.get("id") != nid:
                continue
            nm = n.get("night_months") or {}
            if nm:
                return bool(nm.get(key))
            # night_months 미사용 명부: is_night_shift는 상시 설정이라 당월 판정과 동일
            return bool(n.get("is_night_shift"))
        return False

    def _two_month_rhs(self, nid: str) -> int:
        """홀짝월 합산 야간의 당월 RHS.

        **야간전담(나이트킵) 달의 야간은 수면오프와 무관하다** (2026-08-20 사용자
        명시). 홀짝월 합산은 수면오프(월 7회 이상 시 발생)를 피하려는 규칙이므로,
        전월이 그 간호사의 야간전담 달이었다면 그 달 야간은 합산에서 제외한다.
        (제외하지 않으면 전월 14회 → 당월 상한 0 이 되어 나이트킵을 마친 사람이
         다음 달에 야간을 아예 못 받는다.)
        """
        py, pm = (self.year - 1, 12) if self.month == 1 else (self.year, self.month - 1)
        if self._night_dedicated_in(nid, py, pm):
            return self.rules.maxNightTwoMonthCount
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

    def _is_weekend_or_holiday(self, dt: date) -> bool:
        """주말(토·일) 또는 법정공휴일 — 주말·공휴일 근무 공정성의 '부담일' (M6 P3②)."""
        return dt.weekday() >= 5 or dt.strftime("%Y-%m-%d") in self.holidays

    def _weekend_fairness_pool(self):
        """주말·공휴일 근무 공정 배분 대상 풀 — 근무일 수가 구조적으로 다른 간호사
        (야간전담 14일 고정, 당월 전입·전출로 부분 재적)는 제외해야 range가 유효하다.
        임산부는 주말 D/E를 볼 수 있으므로 포함한다 (야간 풀과 다른 점). 양 엔진 공용."""
        first = date(self.year, self.month, 1)
        last = (first.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        return [
            nurse for nurse in self.nurses
            if not nurse.get("is_night_shift")
            and self._nurse_active_on(nurse, first)
            and self._nurse_active_on(nurse, last)
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
            elif rt in ("night_fairness", "weekend_fairness"):
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

            # night_fairness·weekend_fairness는 개인 점수에 미포함 (전체 지표 — ⚖ 공정성 카드)
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

    # 프론트 view-helpers.js 의 _CYCLE_REF 와 같아야 한다 — 주기 표시(getCycleNum)와
    # 엔진의 블록 번호가 어긋나면 화면의 '3주기'와 엔진의 블록이 다른 것을 가리킨다.
    _CYCLE_REF = date(2026, 3, 1)

    def _juhu_block(self, d: int) -> int:
        """절대 4주 블록 번호. 1~4주기가 한 블록이고, 블록이 바뀔 때만 주휴 요일이 바뀐다."""
        return ((self.all_dates[d] - self._CYCLE_REF).days // 7) // 4

    def _juhu_block_items(self, nurse, x, is_var):
        """블록 → [(날짜 인덱스, 파이썬 weekday, 주휴 변수)] — 양 엔진 공용 수집기.
        재배치 대상(자유 변수)인 주휴 칸만 모은다."""
        first_of_month = date(self.year, self.month, 1)
        nid = nurse["id"]
        blocks = {}
        for d, dt in enumerate(self.all_dates):
            if dt < first_of_month or not self._nurse_active_idx(nurse, d):
                continue
            t = x.get(nid, {}).get(d, {}).get("주")
            if not is_var(t):
                continue
            blocks.setdefault(self._juhu_block(d), []).append((d, dt.weekday(), t))
        return blocks

    def _week_has_holiday(self, week_days) -> bool:
        """주(날짜 인덱스 목록)에 법정공휴일이 있는가."""
        return any(self.all_dates[d].strftime("%Y-%m-%d") in self.holidays
                   for d in week_days)

    def rest_supply_shortfall(self) -> list:
        """주별 '쉴 코드' 수급 산술 — 솔버 없이 즉시 판정 (M4-P1).

        일별 인원이 '정확히 일치'라 남는 인력은 **반드시 휴무 칸**에 들어가야 한다.
        그런데 솔버가 놓을 수 있는 휴무는 OF(주1)·V(월1)·생(월1·여성)·P1(임산부)뿐이고
        주휴(주)·특·공·법·병·경가·조가·산전은 사전입력 전용이다. 주휴를 안 넣으면 채울 코드가 없어
        infeasible 이 되는데, 13단계 진단에서는 마지막 상한 단계에서야 터져
        '생리휴가(생) 제약 충돌'로 오진된다. 인원이 남을수록 심해지는 것도 이 때문.

        수요는 하한, 공급은 상한으로 잡는다 — **부족이 나오면 확정적으로 infeasible**
        (거짓 양성 없음). 반대로 0이라고 생성이 보장되는 것은 아니다.

        반환: [{"week","start","end","demand","supply","shortfall","nurses"}]
        """
        if not self.weeks or not self.nurses:
            return []
        req_dict = self.req.model_dump()
        rest_codes = set(self.REST_SHIFTS) | set(self.LEAVE_SHIFTS)
        # 솔버가 놓을 수 있는 휴무 중 '주당 상한이 있는' 코드만 부족을 만든다.
        # 병동이 주휴(주)·특·공 등을 auto_assign 으로 열어 뒀다면 그 코드로 얼마든지
        # 채울 수 있으므로 이 산술은 성립하지 않는다 — 아예 판정하지 않는다.
        # (상한을 과대평가해서라도 거짓 부족은 내지 않는다.)
        solver_rest = set(self.SOLVER_SHIFTS) & rest_codes
        uncapped = solver_rest - {"OF", "V", "생", "P1"}
        if uncapped:
            return []
        if "OF" in solver_rest and not self.rules.weeklyOff:
            return []          # OF 주 1회 제한이 꺼져 있으면 OF 로 무한정 채운다
        first_of_month = date(self.year, self.month, 1)
        month_idxs = [d for d, dt in enumerate(self.all_dates) if dt.month == self.month
                      and dt.year == self.year]

        # 월 단위 한도(V·생)는 그 달 사전입력으로 이미 쓴 만큼 차감
        max_v = 0 if self.unlimited_v else max(0, int(getattr(self.rules, "maxVPerMonth", 0) or 0))
        def eff_pre(nurse, d):
            """엔진이 보는 사전입력 — 일반 간호사의 공휴일 OF·모성보호로 지워지는 칸은 빈칸."""
            dt = self.all_dates[d]
            dk = dt.strftime("%Y-%m-%d")
            raw = self.prev.get(nurse["id"], {}).get(dk)
            if not raw:
                # 원티드 '둘 중 하나'는 어느 쪽이든 근무 칸 — 'N 빼고'는 쉴 수도 있어 빈칸
                fx = self.flex_pre.get(nurse["id"], {}).get(dk)
                return fx if fx in _FLEX_ONE_OF else ""
            return self._effective_pre(nurse, dt, raw, dk in self.holidays) or ""

        used = {}
        for nurse in self.nurses:
            nid = nurse["id"]
            cells = [eff_pre(nurse, d) for d in month_idxs]
            used[nid] = {"V": cells.count("V"), "생": cells.count("생")}

        out = []
        for wi, (ws, we) in enumerate(self.weeks):
            idxs = [d for d in range(ws, we + 1) if self.all_dates[d] >= first_of_month]
            if not idxs:
                continue
            # 월 경계에 걸친 주는 판정하지 않는다 — V·생의 '월 한도'가 다음 달 몫으로
            # 넘어가 공급이 실제로는 더 크다. 여기서 세면 거짓 부족이 된다.
            if any(self.all_dates[d].month != self.month
                   or self.all_dates[d].year != self.year for d in idxs):
                continue
            work_need = night_need = 0
            for d in idxs:
                dt = self.all_dates[d]
                base = req_dict.get(WEEKDAY_KEYS[dt.weekday()], {})
                ovr = self.per_day_req.get(dt.strftime("%Y-%m-%d"), {})
                dr = {**base, **ovr} if ovr else base
                work_need += sum(int(dr.get(pp) or 0) for pp in ("D", "E", "N"))
                night_need += int(dr.get("N") or 0)

            cells = supply = n_reg = nd_cells = 0
            for nurse in self.nurses:
                nid = nurse["id"]
                act = [d for d in idxs if self._nurse_active_idx(nurse, d)]
                if not act:
                    continue
                # 야간전담은 OF 무제한이라 이 부족을 만들지 않는다 — 수급 양쪽에서 뺀다
                # (__init__ 이 해석한 당월 값 — 임신 달 해제까지 엔진과 같게)
                if nurse.get("is_night_shift"):
                    nd_cells += len(act)
                    continue
                n_reg += 1
                cells += len(act)
                pins = [eff_pre(nurse, d) for d in act]
                pinned_rest = sum(1 for c in pins if c in rest_codes)
                pinned_work = sum(1 for c in pins if c and c not in rest_codes)
                free = len(act) - pinned_rest - pinned_work
                # 자유 칸에 솔버가 놓을 수 있는 휴무 (상한)
                # 공휴일 자유 칸은 '법'으로 쉴 수 있다 (사전입력 전용이지만 공휴일엔 솔버가 놓는다,
                # 일반 간호사) — 빼면 병원 휴일처럼 주 중간 공휴일이 낀 주에 거짓 부족이 난다
                slots = 0
                if "법" in self.LEAVE_SHIFTS:
                    slots += sum(1 for d, c in zip(act, pins) if not c and
                                 self.all_dates[d].strftime("%Y-%m-%d") in self.holidays)
                if "OF" in self.SOLVER_SHIFTS and "OF" not in pins:
                    slots += 1
                if "V" in self.SOLVER_SHIFTS and (self.unlimited_v or used[nid]["V"] < max_v):
                    slots += 1 if not self.unlimited_v else free
                if ("생" in self.SOLVER_SHIFTS and nurse.get("gender") == "female"
                        and used[nid]["생"] < 1):
                    slots += 1
                if "P1" in self.SOLVER_SHIFTS and nurse.get("is_pregnant"):
                    slots += 1
                supply += pinned_rest + min(free, slots)

            # 야간전담이 채울 수 있는 근무는 최대치로 잡아 수요를 하한으로 만든다
            regular_work = max(0, work_need - min(nd_cells, night_need))
            demand = cells - regular_work
            gap = demand - supply
            if gap > 0:
                out.append({
                    "week": wi + 1,
                    "start": self.all_dates[idxs[0]].strftime("%Y-%m-%d"),
                    "end": self.all_dates[idxs[-1]].strftime("%Y-%m-%d"),
                    "demand": demand, "supply": supply, "shortfall": gap, "nurses": n_reg,
                })
        return out

    @staticmethod
    def rest_supply_message(rows: list) -> str:
        """rest_supply_shortfall() 결과를 사람 문장으로. 비어 있으면 ''."""
        if not rows:
            return ""
        w = rows[0]
        head = (f"잉여 인력이 쉴 코드가 없습니다 — {w['week']}주차"
                f"({w['start'][5:]}~{w['end'][5:]}) 휴무 {w['demand']}칸이 필요한데 "
                f"놓을 수 있는 휴무는 {w['supply']}칸뿐입니다 (부족 {w['shortfall']}칸).")
        why = ("일별 인원이 '정확히 일치'라 남는 인력은 반드시 쉬어야 하는데, "
               "솔버가 놓을 수 있는 휴무는 OF(주1)·V(월1)·생(월1)뿐입니다. "
               "주휴(주)는 사전입력 전용이라 사람이 넣어야 합니다.")
        how = "→ 분석 탭 '주휴 추천 배분 → 사전입력에 적용' 후 다시 생성하세요."
        more = (f" (같은 부족이 {len(rows)}개 주에서 발생)" if len(rows) > 1 else "")
        return f"{head} {why}{more}\n{how}"

    def _off_teukgeun_report(self, schedule: dict) -> list:
        """오프특근 발생 목록 — 완전한 주인데 OF가 0회인 (간호사, 주) 기록.

        제1원칙 3: 결원으로 휴무 공급이 모자라면 남은 사람이 OF를 줄여 근무를
        메꾼다. 엔진은 이를 마지막 수단으로만 허용하므로(슬랙+페널티), 실제로
        발생했다면 **누가 오프를 반납했는지 사람이 알아야 한다**(수당·보상 처리).
        """
        if not self.rules.weeklyOff:
            return []
        first_of_month = date(self.year, self.month, 1)
        name_of = {n["id"]: n.get("name", n["id"]) for n in self.nurses}
        out = []
        for nurse in self.nurses:
            if nurse.get("is_night_shift"):
                continue          # 야간전담은 OF 규칙 대상이 아니다
            nid = nurse["id"]
            days = schedule.get(nid, {})
            for wi, (ws, we) in enumerate(self.weeks):
                wd = [d for d in range(ws, we + 1)
                      if self.all_dates[d] >= first_of_month
                      and self._nurse_active_idx(nurse, d)]
                if len(wd) < 7:
                    continue
                dks = [self.all_dates[d].strftime("%Y-%m-%d") for d in wd]
                if not all(days.get(dk) for dk in dks):
                    continue      # 그 주가 다 채워지지 않았으면 판단 보류
                if any(days.get(dk) == "OF" for dk in dks):
                    continue
                out.append({
                    "nurse_id": nid,
                    "name": name_of[nid],
                    "week": wi + 1,
                    "start": dks[0],
                    "end": dks[-1],
                })
        return out

    def _manager_check_report(self, schedule: dict) -> list:
        """파트장 확인 필요 — 마지막 수단(제1원칙 13)으로 놓인 연속 근무 한도 초과·E→D1·중→D.

        엔진은 그러지 않으면 근무표가 안 나올 때만 이렇게 놓는다(큰 감점). 6일 연속은
        파트장 확인 하에 제한적으로만 쓰는 것이라 **누가 언제인지 사람이 알아야 한다**.
        확정(사전입력) 칸을 그대로 지킨 것만으로 된 것은 사람이 넣은 사실이라 뺀다 (strict 는 pinned_notes
        가 따로 알린다). 완화 모드에선 사실-클램프 인덱스(_pin)가 비므로 사전입력과 직접 견준다 — 화면
        scheduleWarnings 와 같은 기준. 원티드 D/E·N제외 칸(flex_pre)은 엔진이 고른 것이라 센다.
        반환: [{"kind": "run"|"transition", "nurse_id", "name", "start", "end",
                "days"?, "weekend_days"?, "rule"?, "text"}]
        """
        first_of_month = date(self.year, self.month, 1)
        name_of = {n["id"]: n.get("name", n["id"]) for n in self.nurses}
        work = set(self.WORK_SHIFTS)
        ev, mid = set(self.EVENING_SHIFTS), set(self.MIDDLE_SHIFTS)
        day, day1 = set(self.DAY_SHIFTS), set(self.DAY1_SHIFTS)

        def md(i):
            dt = self.all_dates[i]
            return f"{dt.month}/{dt.day}"

        def iso(i):
            return self.all_dates[i].strftime("%Y-%m-%d")

        def kept(nid, i, code):
            pre = self.prev.get(nid, {}).get(iso(i))
            return bool(pre) and code in self._PRE_FLEX.get(pre, {pre})

        out = []
        limit = self.rules.maxConsecutiveWorkDays
        for nurse in self.nurses:
            nid = nurse["id"]
            name = name_of[nid]
            days = schedule.get(nid, {})
            codes = [days.get(iso(i)) for i in range(self.T)]
            if self.rules.maxConsecutiveWork:
                run = []
                for i, c in enumerate(codes + [None]):
                    if c in work:
                        run.append(i)
                        continue
                    if (len(run) > limit and self.all_dates[run[-1]] >= first_of_month
                            and not all(kept(nid, d, codes[d]) for d in run)):
                        k = sum(1 for d in run if self._is_weekend_or_holiday(self.all_dates[d]))
                        out.append({
                            "kind": "run", "nurse_id": nid, "name": name,
                            "start": iso(run[0]), "end": iso(run[-1]),
                            "days": len(run), "weekend_days": k,
                            "text": (f"{name} {md(run[0])}~{md(run[-1])} 연속 근무 {len(run)}일"
                                     + (f" (주말·공휴일 {k}일 포함)" if k else "")),
                        })
                    run = []
            for i in range(self.T - 1):
                if self.all_dates[i + 1] < first_of_month:
                    continue
                c1, c2 = codes[i], codes[i + 1]
                if c1 in ev and c2 in day1:
                    rule = "E→D1"
                elif c1 in mid and c2 in day:
                    rule = "중→D"
                else:
                    continue
                if kept(nid, i, c1) and kept(nid, i + 1, c2):
                    continue
                out.append({
                    "kind": "transition", "nurse_id": nid, "name": name,
                    "start": iso(i), "end": iso(i + 1), "rule": rule,
                    "text": f"{name} {md(i)} {c1} → {md(i + 1)} {c2} ({rule})",
                })
        return out

    def _v_report(self, schedule: dict):
        """연차(V) 자동 배정 설명 — '왜 V가 나왔는가'를 주 단위 산술로 (제1원칙 8, M6 P4).

        일별 인원은 '정확히 일치'라 남는 사람은 반드시 쉬어야 하는데, 솔버가 놓을 수 있는
        휴무는 OF(주 1)·생(월 1)·V뿐이다. 그래서 V = 쉬어야 할 칸 − (주휴 + OF + 확정 휴가 + 생).
        결과 표 자체에서 센다(요구 인원 재계산 없음) — 사전입력(원티드) V는 사람이 정한 것이라
        세지 않고, 야간전담은 OF 규칙 밖이라 제외한다.
        주 안에서 주휴 요일을 옮기는 것은 주간 총량을 바꾸지 못한다. 줄이는 길은
        ① 주휴가 없는 사람에게 주휴를 넣기 ② 남는 날에 연차·휴가 원티드를 먼저 받기
        ③ 요일별 필요 인원 조정 — 이 셋을 힌트로 낸다.
        반환: {"total", "weeks": [{"week","start","end","cells","work","rest_need","juhu","off",
                "leave_pinned","saeng","v","missing_juhu","days","cells_v","summary","hints"}]}
        """
        if "V" not in self.ALL_SHIFTS or not self.weeks:
            return None
        first_of_month = date(self.year, self.month, 1)
        work_codes = set(self.WORK_SHIFTS)
        leave_codes = set(self.LEAVE_SHIFTS) | {"P1"}
        name_of = {n["id"]: n.get("name", n["id"]) for n in self.nurses}
        dow_kr = "월화수목금토일"
        regular = [n for n in self.nurses if not n.get("is_night_shift")]
        weeks_out, total = [], 0
        for wi, (ws, we) in enumerate(self.weeks):
            idxs = [d for d in range(ws, we + 1) if self.all_dates[d] >= first_of_month]
            if not idxs:
                continue
            cells = work = juhu = off = leave_pinned = saeng = other_auto = 0
            cells_v, days_out = [], []
            active_all = {n["id"]: 0 for n in regular}
            juhu_of = {n["id"]: 0 for n in regular}
            for d in idxs:
                dt = self.all_dates[d]
                dk = dt.strftime("%Y-%m-%d")
                day = {"date": dk, "dow": dow_kr[dt.weekday()], "active": 0, "work": 0, "rest": 0, "v": 0}
                for n in regular:
                    if not self._nurse_active_idx(n, d):
                        continue
                    nid = n["id"]
                    code = schedule.get(nid, {}).get(dk)
                    if not code:
                        continue
                    active_all[nid] += 1
                    day["active"] += 1
                    pinned = self._pin.get((nid, d)) == code
                    if code in work_codes:
                        day["work"] += 1
                        continue
                    day["rest"] += 1
                    if code == "주":
                        juhu += 1; juhu_of[nid] += 1
                    elif code == "OF":
                        off += 1
                    elif code == "V" and not pinned:
                        day["v"] += 1
                        cells_v.append({"nurse_id": nid, "name": name_of[nid], "date": dk})
                    elif code == "생" and not pinned:
                        saeng += 1
                    elif code in leave_codes and pinned:
                        leave_pinned += 1      # 사전입력 휴가(확정 V 포함)
                    elif code in leave_codes:
                        other_auto += 1        # 병동이 자동으로 열어 둔 다른 휴가·P1
                cells += day["active"]; work += day["work"]
                days_out.append(day)
            v = len(cells_v)
            if not v:
                continue
            total += v
            rest_need = cells - work
            n_days = len(idxs)
            missing = [name_of[nid] for nid in active_all
                       if active_all[nid] == n_days and n_days == 7 and juhu_of[nid] == 0]
            start, end = days_out[0]["date"], days_out[-1]["date"]
            parts = [f"주휴 {juhu}", f"OF {off}"]
            if leave_pinned:
                parts.append(f"사전입력 휴가 {leave_pinned}")
            if saeng:
                parts.append(f"생 {saeng}")
            if other_auto:
                parts.append(f"기타 자동 휴가 {other_auto}")
            summary = (f"{wi + 1}주차({start[5:]}~{end[5:]}) V {v}건 — 재적 {cells}칸 중 근무 {work}칸, "
                       f"쉬어야 할 칸 {rest_need}개. {' · '.join(parts)}로 채우고 남은 {v}칸이 V입니다.")
            v_days = ", ".join(f"{dd['date'][5:].replace('-', '/')}({dd['dow']}) {dd['v']}명"
                               for dd in days_out if dd["v"])
            hints = []
            if missing:
                hints.append(f"주휴가 없는 {', '.join(missing)} — 이 주에 주휴를 넣으면 그만큼 V가 줄어듭니다 "
                             f"(분석 탭 주휴 추천 → 사전입력에 적용).")
            hints.append(f"남는 날 {v_days}에 연차·휴가 원티드를 먼저 받으면 V가 사람이 원한 날로 갑니다.")
            if not missing:
                hints.append("주휴 요일을 주 안에서 옮기는 것은 주간 총량을 바꾸지 못합니다 — 요일별 필요 인원을 "
                             "이 주에 맞게 올리거나(⚙ 설정) 남는 날의 휴가로 소진하는 것이 방법입니다.")
            weeks_out.append({
                "week": wi + 1, "start": start, "end": end,
                "cells": cells, "work": work, "rest_need": rest_need,
                "juhu": juhu, "off": off, "leave_pinned": leave_pinned, "saeng": saeng,
                "other_auto": other_auto, "v": v,
                "missing_juhu": missing, "days": days_out, "cells_v": cells_v,
                "summary": summary, "hints": hints,
            })
        if not total:
            return None
        return {"total": total, "weeks": weeks_out}

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

    def _attach_reports(self, result: Dict) -> Dict:
        """성공 결과에 오프특근 발생 목록을 덧붙인다 (제1원칙 3 — 누가 오프를
        반납했는지는 사람이 알아야 한다)."""
        if not result.get("success"):
            return result
        rows = self._off_teukgeun_report(result.get("schedule") or {})
        if rows:
            result["off_teukgeun"] = rows
            shown = ", ".join(f"{r['name']} {r['week']}주차" for r in rows[:8])
            more = f" 외 {len(rows) - 8}건" if len(rows) > 8 else ""
            result["message"] += (
                f"\n\n⚠ 오프특근 {len(rows)}건 — 휴무 공급이 모자라 OF를 반납한 주가 "
                f"있습니다 (주휴는 유지): {shown}{more}")
        # 파트장 확인 필요 — 마지막 수단(제1원칙 13)으로 놓인 6일 연속·E→D1·중→D
        mc = self._manager_check_report(result.get("schedule") or {})
        if mc:
            result["manager_check"] = mc
            shown = ", ".join(r["text"] for r in mc[:6])
            more = f" 외 {len(mc) - 6}건" if len(mc) > 6 else ""
            result["message"] += (
                f"\n\n⚠ 파트장 확인 필요 {len(mc)}건 — 근무표가 이렇게만 나와서 연속 근무 한도를 "
                f"하루 넘기거나 E→D1·중→D 로 잡은 곳입니다: {shown}{more}")
        # 연차(V) 자동 배정 설명 — 제1원칙 8: V 자동 대량 사용은 이유와 줄이는 길을 같이 보여야 한다
        vr = self._v_report(result.get("schedule") or {})
        if vr:
            result["v_report"] = vr
            result["message"] += (
                f"\n\n🧾 연차(V) 자동 배정 {vr['total']}건 — 이유와 줄이는 방법은 표 아래 📋 리포트에 있습니다.")
        return result

    def _attach_pin_notes(self, result: Dict) -> Dict:
        """strict 성공 결과에 '확정 사실 vs 앱 규칙' 차이 안내를 덧붙인다 (정보 제공)."""
        result = self._attach_reports(result)
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
                # OF 0회는 '규칙 차이'가 아니다 — 결원 시 불가피한 오프특근(제1원칙 3).
                # 발생 사실은 _off_teukgeun_report 가 따로 보고한다.

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
