"""
스케줄러 공유 베이스 — 엔진(HiGHS/CP-SAT) 무관 데이터·셋업·추출 로직.

NurseScheduler(HiGHS)와 CpSatScheduler(CP-SAT)가 공통 상속한다.
여기에는 솔버를 모르는 코드만 둔다: 날짜 범위/재적/주기/시니어리티 데이터 파싱,
근무 분류, 점수 계산, 솔루션 추출(값 읽기는 value_fn 주입).
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Callable, Dict, List, Optional, Tuple

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
# 날이 정해진 휴가 — 결혼·장례·공적 업무·병가·산전검진·특별휴가. V·생·법과 달리 다른 날로
# 옮겨 쓸 수 없어, 완화에서 오프특근보다 먼저 지킨다 (2026-10-03 사용자 결정, 결정 1-35).
_FIXED_DATE_LEAVE = frozenset({"특", "공", "병", "경가", "조가", "산전"})
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
# 끝에 붙은 다음 달 며칠 — 다음 달 나이트킵의 야간 몫이 하나 모자랄 때 (2026-10-18, _tail_keeper_targets).
# 꼬리 V(-500)보다 커서 남는 휴무를 나이트킵 OF 가 아니라 다른 사람의 V 로 돌리고, 근무 원티드를 깨고 V 를 주는 값
# (완화 500 + V 500)보다 작아서 완화를 켜도 원티드를 깨면서까지 채우지 않는다. 하드가 아니라서 꼬리 N 자리를
# 다른 사람이 이미 다 넣었어도 생성은 막히지 않는다.
_TAIL_KEEPER_SHORT_PENALTY = 700

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


def generation_bounds(year: int, month: int, ref: date = date(2026, 3, 1)) -> Tuple[date, date]:
    """생성 범위 (첫날, 끝날) — 그 달을 주기(7일 블록, ref 기준) 단위로 채운다.
    1일이 주기 첫날이면 한 주를 앞으로 더 붙인다 (월 경계 전환·연속 규칙을 지난달 기록에 잇기 위해).
    엔진 _build_date_range 와 사전검증(api)이 같은 범위를 쓰도록 이 함수 하나를 쓴다 (프론트 scheduleDays 와 같은 산식)."""
    first = date(year, month, 1)
    last = (date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)) - timedelta(days=1)
    first_offset = (first - ref).days
    start_offset = first_offset - (first_offset % 7)
    if first_offset % 7 == 0:
        start_offset -= 7
    last_offset = (last - ref).days
    end_offset = last_offset + (6 - last_offset % 7)
    return ref + timedelta(days=start_offset), ref + timedelta(days=end_offset)


def trainee_last_day(nurse: dict, prev_days: dict = None, range_iso=None):
    """신규간호사의 마지막 트레이닝 날 — 다음 날부터 보통 간호사다 (2026-10-16, 101병동 11월).

    트레이닝 끝나는 날과, 생성 범위(range_iso) 안에서 사전입력이 '/'(/D·/E·/N…)로 시작하는 가장
    늦은 날 중 늦은 쪽. 명부엔 11/03 인데 번표엔 11/04 까지 /E 였다 — 사람이 표에 '/'로 넣은 날은
    트레이닝 날이다. 끝나는 날이 없거나 읽을 수 없으면 None = 계속 트레이닝 ('/' 칸이 줄이지 않는다).
    프론트 traineeLastKey(preinput-io.js)와 같은 규칙이다."""
    end = nurse.get("training_end_date")
    try:
        last = date.fromisoformat(end) if end else None
    except (ValueError, TypeError):
        last = None
    if last is None:
        return None
    for dk, code in (prev_days or {}).items():
        if not (isinstance(code, str) and code.startswith("/")):
            continue
        if range_iso is not None and dk not in range_iso:
            continue
        try:
            d = date.fromisoformat(dk)
        except (ValueError, TypeError):
            continue
        if d > last:
            last = d
    return last


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
        # 날짜 범위 먼저 — 신규간호사가 생성 범위 안에서 독립하는지 보려면 범위가 있어야 한다
        self._build_date_range()
        range_iso = set(dt.strftime("%Y-%m-%d") for dt in self.all_dates)
        first_day = self.all_dates[0] if self.all_dates else self.schedule_start
        last_day = self.all_dates[-1] if self.all_dates else self.schedule_end
        raw_prev = request.prev_schedule or {}
        # 신규간호사(트레이니) 분리 — 마지막 트레이닝 날(trainee_last_day)의 다음 날부터 보통 간호사.
        #  · 범위 시작 전에 독립: 보통 간호사
        #  · 범위 안에서 독립: 그날부터 재적하는 보통 간호사(self.nurses, 전입처럼 start_date) 이면서
        #    트레이닝 날의 '/' 표시를 위해 self._trainees 에도 남는다 (2026-10-16, 101병동 11월 —
        #    달 중간에 끝나면 달 전체가 트레이니라 독립한 뒤 칸이 비었다)
        #  · 범위 끝까지 트레이닝(끝나는 날 없음 포함): 트레이니만 — 프리셉터 근무를 따른다
        self._all_nurses = all_nurses
        self._trainees = []
        self._train_last: Dict[str, Optional[date]] = {}   # 트레이니 id → 마지막 트레이닝 날 (None = 범위 끝까지)
        self._indep: Dict[str, date] = {}        # 범위 안에서 독립한 신규 id → 독립한 날
        self.nurses: List[Dict] = []
        for n in all_nurses:
            if not n.get("is_trainee"):
                self.nurses.append(n)
                continue
            last = trainee_last_day(n, raw_prev.get(n["id"]), range_iso)
            if last is not None and last < first_day:
                self.nurses.append(n)              # 트레이닝 이미 종료 → 일반 간호사로 전환
                continue
            self._trainees.append(n)
            if last is None or last >= last_day:
                self._train_last[n["id"]] = None
                continue
            self._train_last[n["id"]] = last
            indep = last + timedelta(days=1)
            self._indep[n["id"]] = indep
            m = dict(n)
            try:
                own_start = date.fromisoformat(n["start_date"]) if n.get("start_date") else None
            except (ValueError, TypeError):
                own_start = None
            if own_start is None or own_start < indep:
                m["start_date"] = indep.isoformat()   # 트레이닝 날 = 재적 밖 (인원·차지·주 OF 에 안 센다)
            self.nurses.append(m)
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
        self.prev_juhu_dates = getattr(request, "prev_juhu_dates", None) or {}

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
        # 쉬는 날 전부 — N→휴무→D 의 '휴무'는 V·생·법 같은 휴가도다 (2026-10-17, 사용자 "N > V > D 도 금지")
        self.OFF_SHIFTS     = self.REST_SHIFTS + self.LEAVE_SHIFTS
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
        # 끝 주에 주휴가 빠졌으면 블록 요일로 채운다 (결정 1-41). 신호등·두 엔진·진단이 같은 prev 를 본다.
        self.auto_juhu: List[Dict] = self._fill_missing_juhu(raw_prev)

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
        # 주기 블록 시작으로 정렬 (7일 단위, _CYCLE_REF 기준) — 산식은 generation_bounds 한 곳.
        # 1일이 주기 경계와 정확히 일치하면 전월 중첩이 0일이 되어, 월 경계의
        # 금지 전환·연속 야간·N→OF→D를 아무 제약도 검증하지 못한다(전월
        # 사전입력이 범위 밖이라 전부 드롭됨). 한 주를 앞으로 확장해 전월 말
        # 기록이 경계 제약에 연결되게 한다. (프론트 scheduleDays도 동일 산식)
        self.schedule_start, self.schedule_end = generation_bounds(
            self.year, self.month, self._CYCLE_REF)

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

    # ── 달 중간에 독립한 신규간호사 (2026-10-16) ─────────────────────────────
    # 트레이닝 날은 재적 밖(start_date = 독립한 날)이라 인원·차지·주 OF·월 한도에 안 센다.
    # 하지만 그날 실제로 일했다(프리셉터와 /E) — 독립한 첫날들은 그 근무에 이어 역순 전환·
    # 연속 근무·연속 야간·연속 야간 후 휴무·N→휴무→D 를 지켜야 한다 (/E 다음 날 D 금지).
    # 지난달 칸(1일 전 기록)을 잇는 것과 같은 방식이다: 이음 규칙만 트레이닝 날 칸을 보고,
    # 트레이닝 날끼리의 쌍·윈도우는 검사하지 않는다 (프리셉터 근무라 프리셉터 쪽에서 검사한다).

    def _rules_from(self, nurse: dict, base: date) -> date:
        """이음 규칙(쌍·윈도우)을 검사하기 시작하는 날 — 끝나는 날이 이보다 앞이면 건너뛴다.
        보통 base(엔진은 1일 — 지난달 안에 갇힌 것은 기록), 범위 안에서 독립한 신규는 독립한 날과 견줘 늦은 쪽."""
        indep = self._indep.get(nurse["id"]) if getattr(self, "_indep", None) else None
        return max(base, indep) if indep else base

    def _training_view(self, x: Dict) -> Dict:
        """이음 규칙용 x — 범위 안에서 독립한 신규의 트레이닝 날 칸을 그날 한 근무로 채운 사본.

        자기 사전입력('/' 아닌 주·OF·생·D1…)이 있는 날은 그 코드(상수 1), 없는 날('/'칸·빈칸)은
        프리셉터의 그날 변수 그대로 — 결과 표의 '/'+프리셉터 근무(_fill_trainee_cells)와 같은 뜻이다.
        x 는 고치지 않는다 (인원·차지 같은 날 단위 제약은 원래 x 를 쓴다). 양 엔진·진단·분석기 공용 —
        상수는 두 엔진 모두 int 다."""
        if not getattr(self, "_indep", None):
            return x
        xv = dict(x)
        by_id = {t["id"]: t for t in self._trainees}
        for nid, indep in self._indep.items():
            if nid not in x or nid not in by_id:
                continue
            trainee = by_id[nid]
            pid = trainee.get("preceptor_id")
            own = self.prev.get(nid, {})
            cells = dict(x[nid])
            for d, dt in enumerate(self.all_dates):
                if dt >= indep:
                    break
                if not self._nurse_active_on(trainee, dt):
                    continue   # 자기 전입 전·전출 후
                code = own.get(dt.strftime("%Y-%m-%d"))
                if code:
                    cells[d] = {s: (1 if s == code else 0) for s in self.ALL_SHIFTS}
                elif pid and pid != nid and pid in x:
                    cells[d] = x[pid][d]
            xv[nid] = cells
        return xv

    def _pin_view(self) -> Dict:
        """이음 규칙용 사실-클램프 인덱스 — _pin 에 독립한 신규의 트레이닝 날을 더한 사본.
        자기 사전입력은 사실, 프리셉터 칸은 프리셉터 칸이 확정일 때만 사실이다 — 프리셉터 확정 E 다음 날
        신규 확정 D 처럼 둘 다 사람이 넣은 것이면 검사하지 않는다 (결정 1-15). 완화(클램프 끔)면 _pin 그대로.
        _pin 자체에는 넣지 않는다 — 일별 인원·차지 클램프(_pin_day_period_count)가 트레이닝 날을 세면 안 된다."""
        pin = self._pin
        if (not getattr(self, "_indep", None) or getattr(self, "_pre_soft", False)
                or self.allow_pre_relax):
            return pin
        out = dict(pin)
        by_id = {t["id"]: t for t in self._trainees}
        for nid, indep in self._indep.items():
            trainee = by_id.get(nid)
            if trainee is None:
                continue
            pid = trainee.get("preceptor_id")
            own = self.prev.get(nid, {})
            for d, dt in enumerate(self.all_dates):
                if dt >= indep:
                    break
                if not self._nurse_active_on(trainee, dt):
                    continue
                code = own.get(dt.strftime("%Y-%m-%d")) or (pin.get((pid, d)) if pid and pid != nid else None)
                if code:
                    out[(nid, d)] = code
        return out

    def _fill_trainee_cells(self, table: Dict, dates) -> None:
        """결과 표에 신규의 트레이닝 날을 채운다 — 자기 사전입력('/' 아닌 코드)이 있으면 그것,
        없으면 프리셉터 근무 + '/' 접두어. 독립한 뒤 칸(엔진이 배정)은 건드리지 않는다.
        table 의 프리셉터 줄을 읽는다 (당월만 담은 표·범위 전체 표 각각에)."""
        for trainee in self._trainees:
            tid = trainee["id"]
            pid = trainee.get("preceptor_id")
            last = self._train_last.get(tid)
            src = table.get(pid, {}) if pid and pid != tid else {}
            own = self.prev.get(tid, {})
            for dt in dates:
                if last is not None and dt > last:
                    continue
                if not self._nurse_active_on(trainee, dt):
                    continue
                dt_str = dt.strftime("%Y-%m-%d")
                code = own.get(dt_str) or ("/" + src[dt_str] if src.get(dt_str) else "")
                if code:
                    table.setdefault(tid, {})[dt_str] = code

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

        생성 달 안은 _c_night_shift_nurses / _cs_night_shift_nurses 가 맡는다 (14회와 함께).
        사전입력 pre 의 근무는 그대로 둔다 — strict 에서 사전입력은 사실이다. 완화 경로는
        잠긴 칸을 이 게이트 전에 상수로 묶으므로 pre=None 으로 불러 원티드도 함께 막는다."""
        if s not in self.WORK_SHIFTS or s in self.NIGHT_SHIFTS:
            return False
        if dt <= self._month_last_day():
            return False   # 생성 달 안(달 규칙이 맡음)이거나 지난달 기록
        if not self._keeper_on(nurse, dt):
            return False
        # 완화를 켰으면 사전입력도 규칙 앞에서 풀린다 — 생성 달 안의 나이트킵 규칙(_pin 이 빈다)과 같게
        return not (pre and not self.allow_pre_relax and s in self._PRE_FLEX.get(pre, {pre}))

    def _locked_domain(self, nurse: dict, dt: date, pre: str) -> set:
        """완화에서 잠긴 칸(🔒)·지난달 기록이 가질 수 있는 근무.

        병동 번표엔 누가 차지인지 없다 (제1원칙 11) — 잠긴 D·E·N 은 '그 시간대 근무'가 사실이고
        차지는 앱이 정한다. 그래서 같은 시간대 차지(DC·EC·NC)로 올릴 수 있다. 문자 그대로 두지 않으면
        잠긴 칸으로 꽉 찬 날(붙여 넣은 실제 번표의 첫 며칠)은 차지 1명을 못 채워 완화가 늘 실패한다.
        그대로 두는 것: 지난달 기록(과거), 사람이 고른 차지 코드, 자격 없는 근무, 나이트킵의 야간 외 근무
        (달 규칙이 그 변수를 0 으로 묶는다)."""
        if dt < date(self.year, self.month, 1) or pre in self.CHARGE_SHIFTS:
            return {pre}
        flex = self._PRE_FLEX.get(pre)
        capable = set(nurse.get("capable_shifts") or self.WORK_SHIFTS)
        if not flex or pre not in capable:
            return {pre}
        if self._keeper_on(nurse, dt) and pre not in self.NIGHT_SHIFTS:
            return {pre}
        return {s for s in flex if s in capable}

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

    def _window_has_pinned_rest(self, nid, window, pin: Dict = None) -> bool:
        """윈도우 안에 확정된 쉬는 칸이 있으면 연속 근무 제약이 저절로 지켜진다 (변수 절약).
        pin = 사실-클램프 인덱스 (기본 _pin, 이음 규칙은 _pin_view)."""
        work = set(self.WORK_SHIFTS)
        pin = self._pin if pin is None else pin
        for d in window:
            p = pin.get((nid, d))
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
        **오프특근은 가장 나중** (2026-10-03 사용자 결정): 감점을 원티드 한 칸의 유지 보너스 중
        가장 큰 것(휴가 원티드, 완화 이력 보정 포함)과 마지막 수단보다 크게 둔다 — 근무·OF·휴가
        원티드를 풀어서 되면 오프특근을 쓰지 않는다. 견주는 단위는 한 칸 대 한 번이다.
        단 날이 정해진 휴가(경가·조가·공·특·병·산전)는 오프특근보다 먼저 지킨다
        (_relax_fixed_leave_bonus, 2026-10-03 사용자 결정) — 옮길 수 있는 건 V·생·법·OF·근무 원티드.
        bonuses = 엔진의 원티드 유지 보너스(휴가·쉬는 날·근무). 100 단위로 맞춰 완화 폴백의
        보너스 gcd 를 깨지 않는다."""
        pen = self._relax_off_teukgeun_pen(*bonuses)
        return [(pen, sl) for sl in getattr(self, "_off_slack", [])]

    def _relax_off_teukgeun_pen(self, *bonuses: int) -> int:
        """완화 1단계 오프특근 한 번의 감점 — 옮길 수 있는 원티드 한 칸의 유지 보너스 중 가장 큰 것
        (완화 이력 보정 포함)·마지막 수단보다 크게, 100 단위로."""
        boosts = getattr(self, "relax_boosts", None) or {}
        boost = max([1.0] + [float(b) for b in boosts.values()])
        top = max([int(round(int(b) * boost)) for b in bonuses]
                  + [_LONG_RUN_PENALTY, _RARE_TRANSITION_PENALTY])
        return -(-top // 100) * 100 + 100

    def _relax_fixed_leave_bonus(self, *bonuses: int) -> int:
        """날이 정해진 휴가(_FIXED_DATE_LEAVE) 한 칸의 완화 1단계 유지 보너스 = 오프특근 감점 × 5.

        "경가·조가 등으로 휴무가 갑자기 많아지면 남은 근무자들이 오프를 줄여가며 근무를 뛴다"
        (제1원칙 3) — 이 휴가는 오프특근으로 메우는 쪽이지 옮기는 쪽이 아니다 (2026-10-03 사용자 결정).
        한 칸을 비우면 그날 근무 하루가 빠지므로 보통 오프특근 한 번으로 메워진다. ×5 는 그 여유 —
        주휴 없애기(_relax_juhu_drop_pen, ×3) 위에 오프특근 둘을 더 얹어도 지킨다. ×3 이던 때는
        주휴 없애기와 100 차이라 근무 원티드 한 칸(500)에 병·공이 먼저 빠졌다 (결정 1-36 후속).
        그래도 근무표가 안 나오면 옮긴다.
        bonuses = _relax_off_teukgeun_terms 와 같은 값(옮길 수 있는 원티드의 유지 보너스)."""
        return 5 * self._relax_off_teukgeun_pen(*bonuses)

    def _relax_juhu_drop_pen(self, rest_bonus: int, *bonuses: int) -> int:
        """주휴 이동 허용에서 사전입력 주휴가 있던 주의 주휴를 아예 없애는 감점 (결정 1-36).
        오프특근 감점 × 3 − 주휴 유지 보너스 − 100 — 유지 보너스를 더해도 오프특근 셋보다 작고
        둘보다는 크다. 날이 정해진 휴가(×5)와는 오프특근 둘만큼 떨어져 있다.
        bonuses = _relax_off_teukgeun_terms 와 같은 값."""
        return max(3 * self._relax_off_teukgeun_pen(*bonuses) - int(rest_bonus) - 100, 0)

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
        # 잠긴 D·E·N 이 차지로 올라갈 수 있으면(결정 1-34) 누가 차지인지는 앱이 정한다 — 시니어리티대로.
        # 그 날 그 차지를 사람이 잠가 정해 뒀으면 그 사람이 차지 (선임의 잠긴 D 는 D 그대로)
        if j_fixed and getattr(self, "_pre_soft", False):
            up = self._locked_domain(nurse_j, dt, j_fixed) - {j_fixed}
            if up and not any(self.locked_cells.get(n["id"], {}).get(dt_str)
                              and self.prev.get(n["id"], {}).get(dt_str) in up
                              for n in self.nurses):
                j_fixed = None
        # 엄격(사실)에서도 사전입력 D·E·N 은 차지로 올라갈 수 있다(_PRE_FLEX — 변수 도메인과 같다). 병동 번표엔 누가 차지인지
        # 나오지 않으므로(제1원칙 11) 그 날 차지는 앱이 시니어리티대로 정한다. 예전엔 선임이 D 를 넣어 두면 그 짝을 건너뛰어
        # 엔진이 후임에게 차지를 줬다 (11월 생성 5건 — 겹치는 주 11/29 포함, 2026-10-18).
        if j_fixed and not getattr(self, "_pre_soft", False) and len(self._PRE_FLEX.get(j_fixed, ())) > 1:
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
        # 이번 달 안에서 독립한 신규도 뺀다 — 지난달까지 야간이 0(트레이닝 '/N' 은 안 센다)이라
        # 누적 오프셋과 견주면 첫 달부터 야간을 몰아 받는다 (화면 공정성 카드도 이 달 신규는 대상 아님)
        first = date(self.year, self.month, 1)
        fresh = {nid for nid, d in (getattr(self, "_indep", None) or {}).items() if d > first}
        return [
            nurse for nurse in self.nurses
            if not nurse.get("is_night_shift")
            and nurse["id"] not in two_mo_blocked
            and nurse["id"] not in fresh
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

    def _juhu_anchor_pen(self, *bonuses: int) -> int:
        """지난달 요일 어기기 감점 (블록 하나, 완화 1단계) — 파트장 확인 마지막 수단(6일 연속 1500~3000 · E→D1·중→D 2000)과
        bonuses(OF·휴가 원티드 유지 보너스) 중 가장 작은 것보다 100 작게, 100 단위로. 기본 1400.
        2500 이던 때는 6일 연속(주말 이틀 2000)·E→D1 하나에 주휴 옮기기 하나(300)를 더해도 이것보다 싸서, 지난달 요일을
        지키려고 6일 연속을 만들었다 (2026-10-16 검토, 제1원칙 13). 블록의 이번 달 주휴는 많아야 넷이라 기본값에선
        다 옮겨도(4 × 300 = 1200) 이것보다 싸다 — 그래서 옮길 수 있으면 지난달 요일로 옮긴다.
        하드로 두면 그 요일에 자리가 없을 때 주휴를 없앴다 (제1원칙 3 — 결정 1-37)."""
        caps = [_LONG_RUN_MIN_PENALTY, _RARE_TRANSITION_PENALTY] + [int(b) for b in bonuses if int(b) > 0]
        return max(min(caps) // 100 * 100 - 100, 0)

    def _juhu_anchor(self, nurse):
        """달 첫날이 든 4주 블록이 지난달에 시작했으면 (블록 번호, 그 블록 지난달 주휴의 요일) — 아니면 None.

        1~4주기는 같은 요일이다 (결정 1-37, 2026-10-15 사용자 '지난달 요일 이어받기'). 엔진은 이번 달만 보므로
        달이 3주기에서 시작하면 지난달 1·2주기 요일을 몰라 3·4주기만 다른 요일로 옮길 수 있었다.
        출처: 사전입력의 지난달 칸(사람이 넣은 사실 — 전달 이월) > 지난달 저장본(prev_juhu_dates, 서버 주입).
        그 블록에서 가장 늦은 주휴의 요일 (파이썬 weekday). 지난달 나이트킵의 날은 세지 않는다 — 블록 요일 잠금도
        나이트킵의 날을 뺀다 (결정 1-36 후속 2)."""
        first = date(self.year, self.month, 1)
        blk = ((first - self._CYCLE_REF).days // 7) // 4
        start = self._CYCLE_REF + timedelta(days=blk * 28)
        if start >= first:
            return None
        nid = nurse["id"]
        pre = self.prev.get(nid, {})
        saved = set(self.prev_juhu_dates.get(nid) or [])
        last = None
        dt = start
        while dt < first:
            iso = dt.strftime("%Y-%m-%d")
            if (not self._keeper_on(nurse, dt)
                    and (pre[iso] if iso in pre else ("주" if iso in saved else None)) == "주"):
                last = dt
            dt += timedelta(days=1)
        return (blk, last.weekday()) if last else None

    def _juhu_block_items(self, nurse, x, is_var):
        """블록 → [(날짜 인덱스, 파이썬 weekday, 주휴 변수)] — 양 엔진 공용 수집기.
        재배치 대상(자유 변수)인 주휴 칸만 모은다. 나이트킵의 날은 뺀다 — 나이트킵은 날짜가 속한 달로 정하고
        (결정 1-33) 그 날의 주휴는 같은 주 나이트킵의 날 안에서만 옮기므로, 일반의 날과 한 요일로 묶으면
        다음 달 며칠의 주휴 하나를 지키려고 이번 달 주휴 셋을 옮겼다 (2026-10-16 검토)."""
        first_of_month = date(self.year, self.month, 1)
        nid = nurse["id"]
        blocks = {}
        for d, dt in enumerate(self.all_dates):
            if dt < first_of_month or not self._nurse_active_idx(nurse, d):
                continue
            if self._keeper_on(nurse, dt):
                continue
            t = x.get(nid, {}).get(d, {}).get("주")
            if not is_var(t):
                continue
            blocks.setdefault(self._juhu_block(d), []).append((d, dt.weekday(), t))
        return blocks

    def _relax_juhu_free_ok(self, nurse, d: int) -> bool:
        """주휴 이동 허용에서 이 칸에 주휴 자유 변수를 둘 수 있는가 — 양 엔진 공용.
        나이트킵의 날엔 N·V·생·OF 뿐이라 새 주휴를 만들지 않는다 (제1원칙 10). 그 주 나이트킵의 날에
        미리 넣은 주휴가 있을 때만 그것을 같은 주 나이트킵의 날 안에서 옮길 수 있다.
        엔진이 옮길 수 있는 칸만 센다 — 지난달 칸(1일 전)·재적 밖·잠긴 칸의 주휴는 고정이라 옮길 것이 없다."""
        if not self._keeper_on(nurse, self.all_dates[d]):
            return True
        cache = self.__dict__.setdefault("_keeper_juhu_weeks", {})
        nid = nurse["id"]
        if nid not in cache:
            pre = self.prev.get(nid, {})
            locked = self.locked_cells.get(nid, {})
            first_of_month = date(self.year, self.month, 1)

            def movable(k):
                dt = self.all_dates[k]
                iso = dt.strftime("%Y-%m-%d")
                return (pre.get(iso) == "주" and dt >= first_of_month and not locked.get(iso)
                        and self._nurse_active_idx(nurse, k) and self._keeper_on(nurse, dt))
            cache[nid] = [(ws, we) for ws, we in self.weeks
                          if any(movable(k) for k in range(ws, we + 1))]
        return any(ws <= d <= we for ws, we in cache[nid])

    def _juhu_week_segments(self, nurse, week_days) -> list:
        """주휴 이동 허용의 주당 상한(≤1)·바닥(결정 1-36)을 거는 묶음 — 한 주를 나이트킵의 날과 일반의 날로 나눈다.
        이번 달 나이트킵도 다음 달 며칠은 일반 간호사라(결정 1-33) 거기 미리 넣은 주휴는 그 며칠 안에서
        지키고, 나이트킵의 날로 옮겨 일반의 날 쉬는 날을 없애지 않게 한다. 상한도 묶음마다 — 주 전체에 1 을 걸면
        두 묶음에 다 미리 넣은 주휴가 있을 때 하나를 늘 없앴다 (2026-10-16 검토). 나이트킵이 아닌 주는 한 묶음."""
        segs: dict = {}
        for d in week_days:
            segs.setdefault(self._keeper_on(nurse, self.all_dates[d]), []).append(d)
        return list(segs.values())

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

        반환: [{"week","start","end","demand","supply","shortfall","nurses","boundary"}]
        (boundary = 끝에 다음 달 며칠이 붙은 주)
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
        periods = (("D", self.DAY_SHIFTS), ("E", self.EVENING_SHIFTS), ("N", self.NIGHT_SHIFTS))
        den = {c for _, codes in periods for c in codes}
        # D·E·N 밖의 근무(D1·중)를 솔버가 놓을 수 있으면 남는 인력이 그 근무로 빠질 수 있어
        # 쉬어야 할 칸의 하한을 못 잡는다 — 판정하지 않는다.
        if (set(self.SOLVER_SHIFTS) & set(self.WORK_SHIFTS)) - den:
            return []
        first_of_month = date(self.year, self.month, 1)
        month_idxs = [d for d, dt in enumerate(self.all_dates) if dt.month == self.month
                      and dt.year == self.year]

        # 월 단위 한도(V·생)는 그 달 사전입력으로 이미 쓴 만큼 차감.
        # V 월 한도는 엔진과 같다(_c_max_v_per_month): 무제한이거나 규칙이 0 이하이면 상한 없음 (v_cap None)
        rule_v = int(getattr(self.rules, "maxVPerMonth", 0) or 0)
        v_cap = None if (self.unlimited_v or rule_v <= 0) else rule_v
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

        clamp = not self.allow_pre_relax     # 엔진 _build_pin_index 와 같은 조건
        def fact(nurse, d):
            """사실-클램프가 보는 확정 칸 (_build_pin_index 와 같은 값 — 원티드 '둘 중 하나'는 아님)."""
            dt = self.all_dates[d]
            raw = self.prev.get(nurse["id"], {}).get(dt.strftime("%Y-%m-%d"))
            if not raw:
                return ""
            return self._effective_pre(nurse, dt, raw, dt.strftime("%Y-%m-%d") in self.holidays) or ""

        last_day = self._month_last_day()
        tail_idx = [d for d, dt in enumerate(self.all_dates) if dt > last_day]
        used = {}
        for nurse in self.nurses:
            nid = nurse["id"]
            cells = [eff_pre(nurse, d) for d in month_idxs]
            used[nid] = {"V": cells.count("V"), "생": cells.count("생"),
                         "V_tail": [eff_pre(nurse, d) for d in tail_idx].count("V")}

        out = []
        for wi, (ws, we) in enumerate(self.weeks):
            idxs = [d for d in range(ws, we + 1) if self.all_dates[d] >= first_of_month]
            if not idxs:
                continue
            # 달 끝에 걸친 주(11/29~12/05)도 판정한다 — 이 근무표가 정하는 주다 (11월 번표 = 11/1~12/5).
            # 끝에 붙은 다음 달 며칠의 몫은 따로 센다: V 는 다음 달 몫 1회(두 엔진 _c_max_v_per_month),
            # 생은 미리 넣은 것만(_tail_saeng_cap — 자유 생 0). 예전엔 이 주를 통째로 건너뛰어
            # 주휴가 빠진 꼬리 주를 아무도 알리지 않았다 (2026-10-16).
            boundary = any(self.all_dates[d] > last_day for d in idxs)
            # 그 주 D·E·N 근무 칸 수 — 인원 제약과 같은 값(상한이자 정확한 값):
            # 날 전체가 확정이면 인원 제약을 건너뛰므로 확정된 근무 수 그대로(사실),
            # 아니면 시간대마다 max(요구, 확정분) (사실-클램프, 결정 1-15 — 완화를 켜면 클램프 없이
            # 요구 그대로). 요구보다 적게 잡으면 쉬어야 할 칸이 부풀어 실제 병동 번표가
            # '쉴 코드 부족'으로 막힌다. 신호등은 _build_pin_index 전에 부르므로 _pin 을 쓰지 않는다.
            work_need = 0
            unbounded = False
            for d in idxs:
                dt = self.all_dates[d]
                act_n = [n for n in self.nurses if self._nurse_active_idx(n, d)]
                facts = [fact(n, d) for n in act_n]
                if clamp and act_n and all(facts):
                    work_need += sum(1 for c in facts if c in den)
                    continue
                base = req_dict.get(WEEKDAY_KEYS[dt.weekday()], {})
                # 날짜별 인원은 그 날짜에 — 끝에 붙은 다음 달 며칠도 (인원 제약 _c_daily_requirements 와 같다, 2026-10-18)
                ovr = self.per_day_req.get(dt.strftime("%Y-%m-%d"), {})
                dr = {**base, **ovr} if ovr else base
                for pp, codes in periods:
                    if pp not in dr:
                        unbounded = True      # 인원 제약이 없는 시간대 — 상한 없음
                        continue
                    pinned = sum(1 for c in facts if c in codes) if clamp else 0
                    work_need += max(int(dr.get(pp) or 0), pinned)
            if unbounded:
                continue

            cells = supply = n_reg = keeper_work = other_work = 0
            for nurse in self.nurses:
                nid = nurse["id"]
                act = [d for d in idxs if self._nurse_active_idx(nurse, d)]
                if not act:
                    continue
                # 나이트킵의 날은 OF 무제한이라 이 부족을 만들지 않는다 — 수급 양쪽에서 뺀다.
                # 날짜가 속한 달로 본다(_of_week_days → _keeper_on): 11월 나이트킵도 12/1~ 은 일반.
                # 그날 나이트킵이 맡는 근무만큼 일반 간호사 근무가 준다 — 수요가 하한이려면 그 근무는
                # 하한(확정된 D·E·N)만 뺀다. 최대치(재적 칸 전부)로 빼면 쉬어야 할 칸이 부풀어 거짓 부족이 난다.
                reg = self._of_week_days(nurse, ws, we)
                reg_set = set(reg)
                keeper_work += sum(1 for d in act if d not in reg_set and eff_pre(nurse, d) in den)
                if not reg:
                    continue
                n_reg += 1
                cells += len(reg)
                pins = [eff_pre(nurse, d) for d in reg]
                pinned_rest = sum(1 for c in pins if c in rest_codes)
                pinned_work = sum(1 for c in pins if c and c not in rest_codes)
                # D1·중 같은 D·E·N 밖 근무는 쉬는 칸도 D·E·N 칸도 아니다
                other_work += sum(1 for c in pins if c and c not in rest_codes and c not in den
                                  and c not in _FLEX_ONE_OF)
                free = len(reg) - pinned_rest - pinned_work
                in_month = any(self.all_dates[d] <= last_day for d in reg)
                free_in = sum(1 for d, c in zip(reg, pins)
                              if not c and self.all_dates[d] <= last_day)
                in_tail = any(self.all_dates[d] > last_day for d in reg)
                # 자유 칸에 솔버가 놓을 수 있는 휴무 (상한)
                # 공휴일 자유 칸은 '법'으로 쉴 수 있다 (사전입력 전용이지만 공휴일엔 솔버가 놓는다,
                # 일반 간호사) — 빼면 병원 휴일처럼 주 중간 공휴일이 낀 주에 거짓 부족이 난다
                slots = 0
                if "법" in self.LEAVE_SHIFTS:
                    slots += sum(1 for d, c in zip(reg, pins) if not c and
                                 self.all_dates[d].strftime("%Y-%m-%d") in self.holidays)
                if "OF" in self.SOLVER_SHIFTS and "OF" not in pins and not self._of_train_used(nurse, ws, we):
                    slots += 1
                if "V" in self.SOLVER_SHIFTS:
                    # 공급은 상한이다 — 남은 월 한도를 이 한 주에 다 쓸 수 있다 (월 2회 규칙이면 한 주에 둘)
                    if in_month:
                        slots += free_in if v_cap is None else min(max(0, v_cap - used[nid]["V"]), free_in)
                    if in_tail and not used[nid]["V_tail"]:
                        slots += 1      # 다음 달 몫 V — 무제한이어도 꼬리 며칠은 1회
                # 생은 이번 달 몫만 — 꼬리 며칠의 생은 미리 넣은 것뿐이고 그건 pinned_rest 에 들어 있다
                if ("생" in self.SOLVER_SHIFTS and nurse.get("gender") == "female"
                        and in_month and used[nid]["생"] < 1):
                    slots += 1
                if "P1" in self.SOLVER_SHIFTS and nurse.get("is_pregnant"):
                    slots += 1
                supply += pinned_rest + min(free, slots)

            # 일반의 날 쉬어야 할 칸의 하한 = 일반의 날 칸 − (D·E·N 근무 − 나이트킵의 날 확정 근무)
            #   − D·E·N 밖 확정 근무. 근무를 상한으로 잡아야 수요가 하한이 된다.
            regular_work = max(0, work_need - keeper_work)
            demand = cells - regular_work - other_work
            gap = demand - supply
            if gap > 0:
                out.append({
                    "week": wi + 1,
                    "start": self.all_dates[idxs[0]].strftime("%Y-%m-%d"),
                    "end": self.all_dates[idxs[-1]].strftime("%Y-%m-%d"),
                    "demand": demand, "supply": supply, "shortfall": gap, "nurses": n_reg,
                    "boundary": boundary,
                })
        return out

    @staticmethod
    def rest_supply_message(rows: list) -> str:
        """rest_supply_shortfall() 결과를 사람 문장으로. 비어 있으면 ''."""
        if not rows:
            return ""
        w = rows[0]
        # 주는 날짜로 — 'N주차'는 생성 범위 첫 주(지난달 말)부터 세어 화면 주기와 다르다
        span = f"{w['start'][5:].replace('-', '/')}~{w['end'][5:].replace('-', '/')}"
        head = (f"잉여 인력이 쉴 코드가 없습니다 — {span} 주에 "
                f"휴무 {w['demand']}칸이 필요한데 "
                f"놓을 수 있는 휴무는 {w['supply']}칸뿐입니다 (부족 {w['shortfall']}칸).")
        why = ("일별 인원이 '정확히 일치'라 남는 인력은 반드시 쉬어야 하는데, "
               "솔버가 놓을 수 있는 휴무는 OF(주1)·V(월1)·생(월1)뿐입니다. "
               "주휴(주)는 사전입력 전용이라 사람이 넣어야 합니다.")
        if w.get("boundary"):
            why += " 끝에 붙은 다음 달 며칠의 주휴도 이 근무표에서 넣습니다 — 거기엔 생을 새로 놓지 않습니다(다음 달 몫)."
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
        name_of = {n["id"]: n.get("name", n["id"]) for n in self.nurses}
        out = []
        for nurse in self.nurses:
            nid = nurse["id"]
            days = schedule.get(nid, {})
            for wi, (ws, we) in enumerate(self.weeks):
                # 나이트킵의 날은 OF 규칙 대상이 아니다 — 일반의 날이 완전한 주일 때만 (엔진과 같은 _of_week_days)
                wd = self._of_week_days(nurse, ws, we)
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

        preceptor_of = {t["id"]: t.get("preceptor_id") for t in self._trainees}

        def kept(nid, i, code):
            pre = self.prev.get(nid, {}).get(iso(i))
            if not pre and nid in self._indep and self.all_dates[i] < self._indep[nid]:
                # 트레이닝 날의 '/' 칸 = 프리셉터 칸 — 프리셉터가 넣은 그대로면 사람이 넣은 사실
                pre = self.prev.get(preceptor_of.get(nid) or "", {}).get(iso(i))
            return bool(pre) and code in self._PRE_FLEX.get(pre, {pre})

        out = []
        limit = self.rules.maxConsecutiveWorkDays
        for nurse in self.nurses:
            nid = nurse["id"]
            name = name_of[nid]
            days = schedule.get(nid, {})
            # 신규의 트레이닝 날('/E' = 프리셉터와 E)도 그날 일한 것 — 엔진 이음 규칙(_training_view)과 같게.
            # 트레이닝 날 안에서 끝나는 연속·전환은 프리셉터 쪽 일이라 세지 않는다 (_rules_from)
            codes = [days.get(iso(i)) for i in range(self.T)]
            codes = [c[1:] if c and c.startswith("/") else c for c in codes]
            from_ = self._rules_from(nurse, first_of_month)
            if self.rules.maxConsecutiveWork:
                run = []
                for i, c in enumerate(codes + [None]):
                    if c in work:
                        run.append(i)
                        continue
                    if (len(run) > limit and self.all_dates[run[-1]] >= from_
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
                if self.all_dates[i + 1] < from_:
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
        세지 않고, 나이트킵의 날은 OF 규칙 밖이라 제외한다(날짜가 속한 달로 —
        끝에 붙은 다음 달 며칠의 V 도 이 표에 나온다).
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
        # 나이트킵의 날만 뺀다 — 날짜가 속한 달로 (_keeper_on): 11월 나이트킵이 12/1~ 에 받은 V 도 설명한다
        regular = list(self.nurses)
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
                    if not self._nurse_active_idx(n, d) or self._keeper_on(n, dt):
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
            summary = (f"{start[5:].replace('-', '/')}~{end[5:].replace('-', '/')} 주 V {v}건 — 재적 {cells}칸 중 근무 {work}칸, "
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

    def _pre_code_count(self, nurse, day_idxs, code) -> int:
        """사전입력(유효 — _effective_pre)이 code 인 칸 수, 재적 안만 — strict·완화 모두.
        strict 에선 _pin_nurse_count 와 같고, 완화에선 _pin 이 비어도 사람이 넣은 칸을 센다
        (잠긴 칸은 상수 1 이라 상한이 그보다 작으면 모순이 된다)."""
        nid = nurse["id"]
        pre = self.prev.get(nid, {})
        n = 0
        for d in day_idxs:
            dt = self.all_dates[d]
            iso = dt.strftime("%Y-%m-%d")
            if not pre.get(iso) or not self._nurse_active_on(nurse, dt):
                continue
            if self._effective_pre(nurse, dt, pre[iso], iso in self.holidays) == code:
                n += 1
        return n

    def _tail_idxs(self) -> list:
        """생성 달 뒤에 붙은 다음 달 며칠 (끝 주 안)."""
        last = self._month_last_day()
        return [d for d, dt in enumerate(self.all_dates) if dt > last]

    def _score_days(self) -> list:
        """배점 항목(전환·연속·패턴·주말·공휴일)을 거는 날 — 생성 달 + 끝에 붙은 다음 달 며칠 (2026-10-18).

        끝 주는 다음 달이 그대로 넘겨받는 사실이 된다(병동 11월 번표 = 11/1~12/5). 예전엔 배점이 생성 달에만 걸려
        꼬리 며칠은 D→N·퐁당 같은 감점이 하나도 없이 아무렇게나 채워졌다. 공정성(달 횟수)·V·생 같은 달 예산 항목은 달 기준 그대로."""
        first = date(self.year, self.month, 1)
        return [d for d, dt in enumerate(self.all_dates) if dt >= first]

    def _score_windows(self, n: int) -> list:
        """연속 n일 창 — 마지막 날이 _score_days 안. 1일 앞 지난달 칸(기록)과 1일의 이음새도 이 달이 정하므로 넣는다
        (사람마다 그 지난달 칸이 기록일 때만 — _score_window_ok)."""
        return [[e - n + 1 + k for k in range(n)] for e in self._score_days() if e - n + 1 >= 0]

    def _score_window_ok(self, nid: str, window) -> bool:
        """창에 든 지난달 칸이 그 사람의 기록(사전입력)인가. 기록이 없는 지난달 칸은 이음새 규칙을 잇는 숨은 변수라
        (결과에 내지 않는다) 거기에 배점을 걸면 지어낸 값이 1일 배정을 끌고 간다."""
        first = date(self.year, self.month, 1)
        pre = self.prev.get(nid, {})
        return all(self.all_dates[d] >= first or pre.get(self.all_dates[d].strftime("%Y-%m-%d"))
                   for d in window)

    def _tail_keeper_targets(self) -> list:
        """끝에 붙은 다음 달 며칠의 다음 달 나이트킵 야간 몫 — [(nurse, tail_idxs, 몫)] (2026-10-18).

        나이트킵은 달력 달로 14회다 (실제 번표 1~10월 20/20 달 — 앞 달 번표에 실린 그 달 첫 며칠의 야간도 14회에 든다).
        끝 주엔 이 몫이 없고 나이트킵의 날 OF 는 상한이 없어서, 남는 휴무가 다음 달 나이트킵 OF 로 몰렸다
        (11월 생성: 12월 나이트킵 둘이 12/1~12/5 내내 OF — 사용자 "버그"). 실제 번표는 다음 달 나이트킵이 그 며칠에
        이미 야간을 선다 (첫 5일 평균 2.8회, 3일 넘는 겹침에서 전부 OF 인 적 없음).
        몫 = 14 × 그 며칠 / 다음 달 날수 (`_night_dedicated_quota`, 12/1~5 → 2). 사람이 넣은 칸은 그대로 — 넣은 N 은 몫에 들고,
        넣은 다른 칸은 비우지 않는다 (완화에서도 원티드는 몫보다 먼저). 몫은 목적함수 감점으로만 건다 (_TAIL_KEEPER_SHORT_PENALTY)."""
        tail = self._tail_idxs()
        if not tail:
            return []
        import calendar
        nxt = self.all_dates[tail[0]]
        dim = calendar.monthrange(nxt.year, nxt.month)[1]
        out = []
        for nurse in self.nurses:
            if not self._keeper_on(nurse, nxt):
                continue
            active, target = self._night_dedicated_quota(nurse, tail, dim)
            if active <= 0 or target <= 0:
                continue
            pre = self.prev.get(nurse["id"], {})
            keys = [(d, self.all_dates[d].strftime("%Y-%m-%d")) for d in tail]
            pre_n = sum(1 for _, k in keys if pre.get(k) in self.NIGHT_SHIFTS)
            free = sum(1 for d, k in keys if self._nurse_active_idx(nurse, d) and not pre.get(k))
            eff = min(max(target, pre_n), pre_n + free)
            if eff > 0:
                out.append((nurse, tail, eff))
        return out

    def _tail_saeng_cap(self, nurse, next_idx) -> int:
        """생성 달 뒤에 붙은 다음 달 며칠의 생 상한 — 미리 넣은 생의 수만큼 (자유 생 0).

        생은 달력 달마다 하나다 (101병동 5~10월 번표: 한 달에 둘 받은 사람 없음). 꼬리 며칠의 생은
        다음 달 몫이라 거기 쓰면 다음 달(12/6~12/31)엔 생이 없다 — 상한 max(1, 넣은 수) 이던 때
        엔진은 주휴가 빠진 꼬리 주를 이 생으로 메웠다 (11월: 15명, 실제 번표는 꼬리 생이 2% 남짓).
        병동이 넣은 꼬리 생은 사실이라 그대로 받고 다음 달 몫으로 친다 (2026-10-16 사용자)."""
        return self._pre_code_count(nurse, next_idx, "생")

    def _week_span(self, idxs) -> str:
        """주를 날짜로 — '11/01~11/07'. 'N주차'는 생성 범위 첫 주(지난달 말)부터 세어 화면의 주기 번호와
        달랐다 (11월 '2주차' = 11/1 주). 사람에게 보이는 문구는 모두 이것으로 쓴다."""
        a, b = self.all_dates[idxs[0]], self.all_dates[idxs[-1]]
        return f"{a.strftime('%m/%d')}~{b.strftime('%m/%d')}"

    def _of_week_days(self, nurse, ws: int, we: int) -> list:
        """주 1회 OF 를 거는 날 — 그 주에서 이 사람이 **일반 간호사인 날** (생성 달 1일부터, 재적 안).

        나이트킵인지는 날짜가 속한 달로 본다(_keeper_on, 결정 1-33): 11월 나이트킵은 12/1~12/5 에 일반,
        12월 나이트킵은 11/29·11/30 에 일반이다. 예전엔 생성 달 판정으로 사람을 통째로 빼거나 넣어서
        11월 나이트킵은 꼬리 며칠에 OF 를 둘·셋 받았고, 12월 나이트킵은 나이트킵의 날까지 OF == 1 에 묶였다.
        실제 번표(달이 바뀌는 주 20건)도 일반의 날엔 OF ≤ 1, 나이트킵의 날엔 0~3 이었다.
        일반의 날이 완전한 한 주(7일)일 때만 OF == 1(오프특근 슬랙), 아니면 상한만 — 나이트킵의 날은 상한 없음."""
        first = date(self.year, self.month, 1)
        return [d for d in range(ws, we + 1)
                if self.all_dates[d] >= first and self._nurse_active_idx(nurse, d)
                and not self._keeper_on(nurse, self.all_dates[d])]

    def _of_train_used(self, nurse, ws: int, we: int) -> int:
        """그 주 트레이닝 날에 자기 사전입력으로 넣은 OF 수 — 달 중간에 독립한 신규만 (결정 1-39 후속).

        트레이닝 날은 재적 밖이라 _of_week_days 에 안 든다. 그래서 독립한 주의 일반의 날에 OF 상한 1 이 따로 걸려
        11월 실제 사례에서 신규가 11/1(트레이닝 날, 병동이 넣은 OF)과 11/6(엔진) 한 주에 OF 를 둘 받았다.
        주 OF 1회는 달력 주 기준이다 — 트레이닝 날의 OF 도 그 주 몫으로 센다."""
        return self._train_own_count(nurse, range(ws, we + 1), "OF")

    def _train_own_count(self, nurse, day_idxs, code: str) -> int:
        """day_idxs 중 트레이닝 날(생성 달 1일 ~ 독립한 날 전)에 자기 사전입력으로 넣은 code 수 — 범위 안에서 독립한 신규만.

        트레이닝 날은 재적 밖이라 x 에 없지만 결과 표엔 그 코드가 그대로 들어간다(_fill_trainee_cells).
        주 OF·월 V·월 생 한도는 달력 주·달 기준이라 그 날 것까지 센다 — 안 세면 트레이닝 날 생(3/2)에 더해
        독립한 뒤 생(3/5)을 또 받았다 (2026-10-16 검토)."""
        indep = self._indep.get(nurse["id"]) if getattr(self, "_indep", None) else None
        if not indep:
            return 0
        first = date(self.year, self.month, 1)
        own = self.prev.get(nurse["id"], {})
        trainee = next((t for t in self._trainees if t["id"] == nurse["id"]), None)
        n = 0
        for d in day_idxs:
            dt = self.all_dates[d]
            if not (first <= dt < indep) or own.get(dt.strftime("%Y-%m-%d")) != code:
                continue
            if trainee is None or self._nurse_active_on(trainee, dt):
                n += 1
        return n

    def _cap_with_training(self, nurse, day_idxs, code: str, base: int, train_idxs=None) -> int:
        """한도 base 인 x 합(day_idxs)의 상한 — 사실-클램프(확정분만큼 올림)에 트레이닝 날 자기 사전입력분
        (train_idxs, 없으면 day_idxs)을 더해 센다. 트레이닝 날 것이 없으면 예전 그대로 max(base, 확정분).
        완화에선 잠긴 칸(상수 1)이 모순이 되지 않게 그 수 아래로는 내리지 않는다.
        양 엔진·신호등이 같은 값을 쓴다 (주 OF·월 V·꼬리 V·월 생)."""
        nid = nurse["id"]
        pinned = self._pin_nurse_count(nid, day_idxs, (code,))
        used = self._train_own_count(nurse, day_idxs if train_idxs is None else train_idxs, code)
        if not used:
            return max(base, pinned)
        pre, locked = self.prev.get(nid, {}), self.locked_cells.get(nid, {})
        held = sum(1 for d in day_idxs
                   if locked.get(self.all_dates[d].strftime("%Y-%m-%d"))
                   and pre.get(self.all_dates[d].strftime("%Y-%m-%d")) == code
                   and self._nurse_active_idx(nurse, d))
        return max(base - used, pinned, held)

    def _of_week_bound(self, nurse, ws: int, we: int, week_days: list) -> int:
        """그 주 일반의 날 OF 상한 — 확정 OF 수와 1 중 큰 것 (사실-클램프), 트레이닝 날 OF 만큼 1 에서 뺀다.
        양 엔진·신호등이 같은 값을 쓴다."""
        return self._cap_with_training(nurse, week_days, "OF", 1, train_idxs=range(ws, we + 1))

    def _fill_missing_juhu(self, raw_prev: dict) -> List[Dict]:
        """끝에 붙은 다음 달 며칠이 든 주(끝 주)에 주휴가 빠졌으면 블록 요일로 넣는다 — 넣은 칸 목록 (결정 1-41).

        병동 번표는 완전한 주마다 사람마다 주휴가 정확히 하나다 (101병동 5~10월 382/382 주). 엔진은 주휴를
        만들지 않으므로(사전입력 전용) 한 주가 통째로 빠지면 그 주 쉬는 칸이 모자라 V·오프특근으로 메우거나
        근무표가 아예 안 나온다 — 사용자의 11월 근무표 끝 주(11/29~12/5)가 그랬다: 옛 주휴 추천이 끝 주를
        건너뛰어(analysis.js, b1182d1 에서 고침) 거의 모두 비어 있었고, 꼬리 생을 막고 신규가 독립하자 휴무 칸이
        모자라 엉뚱한 '생리휴가 제약 충돌'로 막혔다. 병동이 실제로 넣은 그 주 주휴는 13명 중 12명이 같은 블록 요일.
        달 안의 주는 건드리지 않는다 — 사람이 넣는 자리이고 주휴 추천이 여유 있는 요일로 블록을 옮겨 준다.

        요일: 같은 4주 블록(1~4주기) 다른 주의 주휴 요일(하나로 정해질 때). 끝 주가 새 블록의 첫 주면 앞 블록 요일에서
        하루 당긴 요일 (4주기 → 1주기, juhu_auto_rotate — 끄면 같은 요일). 실제 번표의 블록이 바뀔 때 85%(165/194)가
        하루 당겼다. 출처는 사전입력(트레이니 '/주' 포함) > 지난달 저장본(prev_juhu_dates), 나이트킵의 날은 세지 않는다.
        넣는 칸: 그 사람이 7일 내내 재적, 그 주에 주휴가 없고, 그 요일 칸이 비어 있고 잠기지 않았고, 그 날 나이트킵이
        아닐 때만 (나이트킵의 주휴는 미리 넣은 것만 — 제1원칙 10). 그 날 근무할 수 있는 사람이 필요 인원보다 많을 때만
        (주휴 하나가 인원을 깨면 넣지 않고 '주휴 없는 주' 안내로 남긴다). 주휴 무시(allow_juhu_relax)면 엔진이 주휴를
        직접 놓으므로 넣지 않는다. 넣은 칸은 사람이 넣은 주휴와 같다 — 결과에 auto_juhu 로 알린다."""
        if self.allow_juhu_relax or "주" not in self.ALL_SHIFTS or not self.weeks:
            return []
        first = date(self.year, self.month, 1)
        last = self._month_last_day()
        tail = [(ws, we) for ws, we in self.weeks
                if self.all_dates[ws] >= first and self.all_dates[we] > last]
        if not tail:
            return []
        work = set(self.WORK_SHIFTS)
        req_dict = self.req.model_dump()
        wk = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

        def need(dt):
            iso = dt.strftime("%Y-%m-%d")
            base = req_dict.get(wk[dt.weekday()], {}) or {}
            ovr = self.per_day_req.get(iso, {}) if (dt.year, dt.month) == (self.year, self.month) else {}
            r = {**base, **(ovr or {})}
            return sum(max(0, int(r.get(p) or 0)) for p in ("D", "E", "N"))

        def free_for_work(nurse, dt):
            if not self._nurse_active_on(nurse, dt):
                return False
            c = self.prev.get(nurse["id"], {}).get(dt.strftime("%Y-%m-%d"))
            return not c or c in work

        def is_juhu(nid, iso):
            if self.prev.get(nid, {}).get(iso) == "주":
                return True
            raw = (raw_prev.get(nid) or {}).get(iso) or ""
            return isinstance(raw, str) and _PRE_ALIAS.get(raw.lstrip("/"), raw.lstrip("/")) == "주"

        def block_weekday(nurse, blk, skip):
            """블록 blk 의 주휴 요일 (skip 범위 날짜는 빼고) — 하나로 안 정해지면 None."""
            nid = nurse["id"]
            saved = set(self.prev_juhu_dates.get(nid) or [])
            start = self._CYCLE_REF + timedelta(days=blk * 28)
            cnt = {}
            for k in range(28):
                dt = start + timedelta(days=k)
                iso = dt.strftime("%Y-%m-%d")
                if skip[0] <= dt <= skip[1] or self._keeper_on(nurse, dt):
                    continue
                # 사전입력이 있으면 그것, 없으면 지난달 저장본 (_juhu_anchor 와 같은 출처)
                if is_juhu(nid, iso) or (iso not in self.prev.get(nid, {}) and iso in saved):
                    cnt[dt.weekday()] = cnt.get(dt.weekday(), 0) + 1
            if not cnt:
                return None
            top = max(cnt.values())
            cand = [w for w, c in cnt.items() if c == top]
            return cand[0] if len(cand) == 1 else None

        spare = {}   # 날짜 인덱스 → 근무할 수 있는 사람 − 필요 인원 (넣을 때마다 1씩 준다)
        added: List[Dict] = []
        for nurse in self.nurses:
            nid = nurse["id"]
            locked = self.locked_cells.get(nid, {})
            for ws, we in tail:
                days = list(range(ws, we + 1))
                if not all(self._nurse_active_idx(nurse, d) for d in days):
                    continue
                if any(is_juhu(nid, self.all_dates[d].strftime("%Y-%m-%d")) for d in days):
                    continue
                span = (self.all_dates[ws], self.all_dates[we])
                blk = self._juhu_block(ws)
                wd = block_weekday(nurse, blk, span)
                if wd is None and (span[0] - self._CYCLE_REF).days % 28 == 0:
                    prev_wd = block_weekday(nurse, blk - 1, span)   # 새 블록의 첫 주 — 앞 블록에서 하루 당긴다
                    if prev_wd is not None:
                        wd = (prev_wd - 1) % 7 if nurse.get("juhu_auto_rotate", True) else prev_wd
                if wd is None:
                    continue
                d = next(d for d in days if self.all_dates[d].weekday() == wd)
                dt = self.all_dates[d]
                iso = dt.strftime("%Y-%m-%d")
                if (self.prev.get(nid, {}).get(iso) or self.flex_pre.get(nid, {}).get(iso)
                        or locked.get(iso) or self._keeper_on(nurse, dt)):
                    continue
                if d not in spare:
                    spare[d] = sum(1 for n in self.nurses if free_for_work(n, dt)) - need(dt)
                if spare[d] <= 0:
                    continue
                spare[d] -= 1
                self.prev.setdefault(nid, {})[iso] = "주"
                added.append({"nurse_id": nid, "name": nurse.get("name", nid), "date": iso})
        return added

    def _missing_juhu_weeks(self, schedule: dict) -> dict:
        """주휴가 빠진 완전한 주 — 경고 전용 (생성은 막지 않는다).

        병동 번표는 모든 완전한 주에 사람마다 주휴가 정확히 하나다 (101병동 5~10월: 382/382 주,
        나이트킵이 바뀌는 주 20/20 — 나이트킵·트레이니도). 엔진은 주휴를 만들지 않으므로(사전입력 전용)
        빠지면 그 주 쉬는 칸이 그대로 모자라 V·꼬리 생·오프특근으로 메워진다. 끝에 붙은 다음 달 며칠도
        이 근무표에서 정한다 (11월 번표 = 11/1~12/5).
        완전한 주 = 7일이 모두 생성 달 1일 이후(지난달 칸은 기록), 그 사람이 7일 내내 재적, 7칸이 다 채워짐.
        schedule: {nid: {iso: code}} — 결과 표. 트레이니 표시('/주')도 주휴로 센다.
        (사전입력 쪽 같은 검사는 화면 analysis.js _missingJuhuWarnings — 빈 칸이 기본이라 채워짐은 보지 않는다.)
        반환 {"weeks": [{"week","cycle","start","end","names"}], "none": [이름]} — 범위 안에 주휴가
        하나도 없는 사람(아직 안 넣음)은 주마다 되풀이하지 않고 "none" 에 한 번만."""
        first = date(self.year, self.month, 1)
        # 한 사람은 한 번만 — 범위 안에서 독립한 신규는 self.nurses(독립한 날부터 재적하는 사본)와 _trainees(원래 기록)
        # 둘 다에 있다. 결과 표의 그 사람 줄(트레이닝 날 '/' + 독립한 뒤 근무)은 원래 기록의 재적 기간과 맞는다.
        by_id = {}
        for n in list(self.nurses) + list(getattr(self, "_trainees", [])):
            by_id[n["id"]] = n
        people = list(by_id.values())
        name_of = {n["id"]: n.get("name", n["id"]) for n in people}

        def code(nid, d):
            return schedule.get(nid, {}).get(self.all_dates[d].strftime("%Y-%m-%d")) or ""

        def is_juhu(nid, d):
            return code(nid, d).lstrip("/") == "주"

        full = [(ws, we) for ws, we in self.weeks if self.all_dates[ws] >= first]

        def judged(n, ws, we):
            # 7일 내내 재적 + 7칸이 다 채워진 주만 (빈 칸이 있으면 판단 보류 — 오프특근 보고와 같게)
            return all(self._nurse_active_idx(n, d) and code(n["id"], d) for d in range(ws, we + 1))

        own = [d for d in range(self.T) if self.all_dates[d] >= first]   # 이 근무표가 정하는 날
        none = [n for n in people
                if any(judged(n, ws, we) for ws, we in full)
                and not any(is_juhu(n["id"], d) for d in own)]
        none_ids = {n["id"] for n in none}
        weeks = []
        for wi, (ws, we) in enumerate(self.weeks):
            if self.all_dates[ws] < first:
                continue
            miss = [name_of[n["id"]] for n in people
                    if n["id"] not in none_ids and judged(n, ws, we)
                    and not any(is_juhu(n["id"], d) for d in range(ws, we + 1))]
            if miss:
                dt = self.all_dates[ws]
                weeks.append({
                    "week": wi + 1,
                    "cycle": ((dt - self._CYCLE_REF).days % 28) // 7 + 1,
                    "start": dt.strftime("%Y-%m-%d"),
                    "end": self.all_dates[we].strftime("%Y-%m-%d"),
                    "names": miss,
                })
        return {"weeks": weeks, "none": [name_of[n["id"]] for n in none]}

    @staticmethod
    def missing_juhu_lines(rep: dict, limit: int = 6) -> list:
        """_missing_juhu_weeks() 결과를 사람 문장으로 — 주마다 한 줄 + 아직 안 넣은 사람 한 줄."""
        def names(ns):
            more = f" 외 {len(ns) - limit}명" if len(ns) > limit else ""
            return ", ".join(ns[:limit]) + more

        def md(iso):
            return f"{iso[5:7]}/{iso[8:10]}"

        out = [f"{w['cycle']}주기({md(w['start'])}~{md(w['end'])}) 주휴 없음 {len(w['names'])}명: "
               f"{names(w['names'])}" for w in (rep or {}).get("weeks", [])]
        if (rep or {}).get("none"):
            ns = rep["none"]
            out.append(f"주휴가 아직 하나도 없는 사람 {len(ns)}명: {names(ns)} — "
                       "분석 탭 '주휴 추천 배분 → 사전입력에 적용'으로 넣을 수 있습니다")
        return out

    def _attach_reports(self, result: Dict) -> Dict:
        """성공 결과에 오프특근 발생 목록을 덧붙인다 (제1원칙 3 — 누가 오프를
        반납했는지는 사람이 알아야 한다)."""
        if not result.get("success"):
            return result
        rows = self._off_teukgeun_report(result.get("schedule") or {})
        if rows:
            result["off_teukgeun"] = rows
            shown = ", ".join(f"{r['name']} {r['start'][5:].replace('-', '/')}~{r['end'][5:].replace('-', '/')}"
                              for r in rows[:8])
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
        # 주휴가 빠진 완전한 주 — 끝에 붙은 다음 달 며칠 포함 (안내만, 생성은 그대로)
        mj = self._missing_juhu_weeks(result.get("schedule") or {})
        if mj["weeks"] or mj["none"]:
            result["missing_juhu"] = mj
            result["message"] += ("\n\n📌 주휴가 없는 주가 있습니다 — 그 주는 V·오프특근으로 메워졌을 수 있습니다:\n"
                                  + "\n".join("  · " + t for t in self.missing_juhu_lines(mj)))
        # 주휴가 빠진 주에 같은 블록 요일로 넣은 주휴 (결정 1-41) — 사전입력엔 없던 칸이라 알린다
        aj = [a for a in (getattr(self, "auto_juhu", None) or [])
              if (result.get("schedule") or {}).get(a["nurse_id"], {}).get(a["date"], "주") == "주"]
        if aj:
            result["auto_juhu"] = aj
            result["message"] += ("\n\n📌 주휴가 빠진 주에 같은 주기(1~4주기) 요일로 주휴를 넣었습니다 "
                                  f"{len(aj)}칸 — 다르면 사전입력에서 고쳐 주세요:\n"
                                  + "\n".join("  · " + t for t in self.auto_juhu_lines(aj)))
        return result

    @staticmethod
    def auto_juhu_lines(rows: list, limit: int = 6) -> list:
        """auto_juhu 를 사람 문장으로 — 날짜(요일)마다 한 줄: '12/02(수) 간호01·간호05'."""
        kr = ["월", "화", "수", "목", "금", "토", "일"]
        by = {}
        for a in rows:
            by.setdefault(a["date"], []).append(a["name"])
        out = []
        for iso in sorted(by):
            dt = date.fromisoformat(iso)
            out.append(f"{dt.strftime('%m/%d')}({kr[dt.weekday()]}) " + "·".join(by[iso]))
        if len(out) > limit:
            out = out[:limit] + [f"… 외 {len(out) - limit}일"]
        return out

    def _relax_timeout_result(self) -> Dict:
        """사전입력 완화로 다시 풀었는데 제한 시간 안에 해를 못 찾은 실패 — 원인 진단(13단계) 대신 시간 안내.
        완화는 사전입력을 지키는 것까지 최적화하므로 오래 걸린다. 진단 문구('생리휴가 제약 충돌' 등)는
        완화 전 모델을 쌓아 본 것이라 이 실패의 원인이 아니다 (11월 실제: HiGHS 완화 7분 뒤 그 문구)."""
        mins = max(1, int(self.time_limit) // 60)
        return {
            "success": False, "schedule": {}, "extended_schedule": {},
            "relax_timed_out": True,
            "message": (f"사전입력 완화로 다시 만들어 봤지만 제한 시간({mins}분) 안에 끝내지 못했습니다.\n"
                        "힌트:\n"
                        "  · ⚙ 고급에서 시간을 늘리거나 솔버를 'CP-SAT' 또는 '레이스'로 바꿔 보세요.\n"
                        "  · 완화하지 않고 만들 때 막히는 곳은 사전입력 화면의 신호등이 짚어 줍니다."),
        }

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
                # 끝에 붙은 다음 달 며칠도 결과 표에 — 솔버 결과(_extract_solution)와 같게. 예전엔 생성 달만 담아
                # 다음 달 '지난달 표 이어오기'와 내보내기에서 끝 주가 빠졌다 (2026-10-18)
                schedule.setdefault(nid, {})[dt_str] = code
        # 신규의 트레이닝 날도 솔버 결과와 같게 '/'+프리셉터 근무 (자기 사전입력이 있으면 그것)
        self._fill_trainee_cells(schedule, self.all_dates)
        self._fill_trainee_cells(extended, self.all_dates)
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
                    notes.append(f"{name_of[nid]} {self._week_span(wd)} OF {ofs}회 (생성 규칙은 주 1회)")
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
                            if (codes[rd] in (work_set if k else work_non_night)   # 둘째 날부터 N 도 근무
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
            rest_set = set(self.OFF_SHIFTS)
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
        first_of_month = date(self.year, self.month, 1)

        for nurse in self.nurses:
            nid = nurse["id"]
            pre_days = self.prev.get(nid, {})
            for d, dt in enumerate(self.all_dates):
                dt_str = dt.strftime("%Y-%m-%d")
                # 재적 밖 날짜(전입 전/전출 후): 빈 셀로 두어 "OF로 근무" 오인 방지
                if not self._nurse_active_on(nurse, dt):
                    continue
                # 1일 앞(지난달) 칸은 기록이다 — 사전입력(전달 이월)이 있는 칸만 낸다.
                # 빈 칸은 월 경계 규칙을 잇는 변수일 뿐 엔진이 정한 근무가 아니다: 내보내면 지어낸
                # 10월 D·OF 가 화면에 깔리고 파트장 확인·위반 표시가 그것으로 연속 근무를 셌다 (2026-10-16).
                # 변수와 제약은 그대로 둔다 (지난달 말 기록 → 1일 금지 전환·연속 근무).
                if dt < first_of_month and not pre_days.get(dt_str):
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

        # 트레이니: 트레이닝 날 = 자기 사전입력 또는 프리셉터 근무 + '/' (독립한 뒤 칸은 위에서 엔진이 채웠다 —
        # 예전엔 schedule[tid] = {} 로 비워 달 중간에 독립한 사람의 나머지 칸이 사라졌다)
        self._fill_trainee_cells(schedule, self.all_dates)
        self._fill_trainee_cells(extended, self.all_dates)

        return dict(schedule), dict(extended)
