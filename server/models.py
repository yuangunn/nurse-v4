from pydantic import BaseModel
from typing import Any, Dict, List, Optional


class ScoringRule(BaseModel):
    id: Optional[int] = None
    name: str
    rule_type: str   # transition|pattern|consecutive_same|specific_shift|wish|night_fairness
    params: Dict[str, Any] = {}
    score: int = 0
    enabled: bool = True
    sort_order: int = 0


class ShiftDef(BaseModel):
    code: str
    name: str
    period: str          # day|day1|evening|middle|night|rest|leave
    is_charge: bool = False
    hours: str = ''
    color_bg: str = '#f3f4f6'
    color_text: str = '#374151'
    sort_order: int = 0
    auto_assign: bool = True  # False = 사전입력 전용 (솔버 자동배정 불가)


class Nurse(BaseModel):
    id: str
    name: str
    group: str = ""
    gender: str = "female"  # female | male
    capable_shifts: List[str] = ["DC", "D", "D1", "EC", "E", "중", "NC", "N"]
    is_night_shift: bool = False  # 야간전담 여부 (기본값, night_months 없을 때 사용)
    night_months: Dict[str, bool] = {}  # 월별 야간전담: {"2026-03": true, "2026-04": false}
    seniority: int = 0  # 0 = 낮음(시니어), 숫자 클수록 경력 낮음
    wishes: Dict[str, str] = {}  # {"1": "D", "15": "OFF", ...}
    juhu_day: Optional[int] = None  # 주휴 요일: 0=일,1=월,...,6=토. None=임의
    juhu_auto_rotate: bool = True   # True: 4주마다 1일 자동 당기기
    is_trainee: bool = False        # 신규간호사 (트레이닝 중)
    training_end_date: Optional[str] = None  # 트레이닝 종료일 'YYYY-MM-DD'
    preceptor_id: Optional[str] = None       # 프리셉터 간호사 ID
    start_date: Optional[str] = None         # 전입일 'YYYY-MM-DD' (None=상시 근무)
    end_date: Optional[str] = None           # 전출일 'YYYY-MM-DD' (None=상시 근무)


class DayRequirement(BaseModel):
    """
    D/E/N은 해당 시간대 총 인원 (charge 포함).
    예) D=3 이면 DC 1명 + D 2명 = 합계 3명.
    스케줄러 내부에서 charge 1명을 자동으로 배정.
    """
    D: int = 3   # Day 시간대 총 인원 (DC 포함)
    E: int = 3   # Evening 시간대 총 인원 (EC 포함)
    N: int = 3   # Night 시간대 총 인원 (NC 포함)


class Requirements(BaseModel):
    mon: DayRequirement = DayRequirement()
    tue: DayRequirement = DayRequirement()
    wed: DayRequirement = DayRequirement()
    thu: DayRequirement = DayRequirement()
    fri: DayRequirement = DayRequirement()
    sat: DayRequirement = DayRequirement()
    sun: DayRequirement = DayRequirement()


class Rules(BaseModel):
    weeklyOff: bool = True
    noNOD: bool = True          # N→OF→D 금지
    avoidDN: bool = True         # D→N 회피 (soft)
    maxConsecutiveWork: bool = True
    maxConsecutiveWorkDays: int = 5
    maxConsecutiveNight: bool = True
    maxConsecutiveNightDays: int = 3
    restAfterNight: bool = True
    restAfterNightDays: int = 2          # 연속야간 후 보장할 휴무 일수
    restAfterNightMinConsec: int = 2     # 최소 연속야간 횟수 (이 이상이면 휴무 부여)
    patternOptimization: bool = True
    autoMenstrualLeave: bool = True
    maxVPerMonth: int = 1        # V(연차) 월 최대 사용 횟수 (hard)
    maxNightPerMonth: bool = True
    maxNightPerMonthCount: int = 6   # 월 최대 야간 횟수 (7회부터 수면OFF 발생)
    maxNightTwoMonth: bool = False
    maxNightTwoMonthCount: int = 11  # 홀짝월 합산 최대 야간 (12개이상 수면OFF 발생)
    # 사전입력 완화 차등 보너스
    preBonusLeave: int = 5000  # V/생/특/공/법/병 (휴가) 유지 보너스 — 간호사 요청 사항
    preBonusWork: int = 500    # D/E/N/DC/EC/NC/중/D1 (근무) 유지 보너스 — 교체 가능
    preBonusRest: int = 300    # OF/주 (쉬는 날) 유지 보너스 — 교체 가능


class GenerateRequest(BaseModel):
    year: int
    month: int
    nurses: List[Nurse]
    requirements: Requirements
    rules: Rules
    prev_schedule: Optional[Dict[str, Dict[str, str]]] = None  # {nurse_id: {date_str: shift}}
    holidays: List[str] = []  # ['YYYY-M-D', ...] 법정공휴일 날짜 목록 (스케줄러는 참조용)
    shifts: List[ShiftDef] = []  # 근무 정의 목록 (비어있으면 DB에서 로드)
    per_day_requirements: Optional[Dict[str, Dict[str, int]]] = None  # {'YYYY-MM-DD': {'D':4,'E':5,'N':3}}
    scoring_rules: List[ScoringRule] = []  # 배점 규칙 목록 (비어있으면 DB에서 로드)
    prev_month_nights: Optional[Dict[str, int]] = None  # {nurse_id: 이전달 야간횟수} (홀짝월 합산용)
    mip_gap: float = 0.02  # MIP 오차 허용 범위 (0=완벽한 최적해, 0.02=2% 오차허용 조기종료)
    time_limit: int = 1200  # 솔버 타임리밋 (초, 기본 20분)
    allow_pre_relax: bool = False  # infeasible 시 사전입력 완화 허용
    allow_juhu_relax: bool = False  # 주휴 재배치 허용
    unlimited_v: bool = False  # V 무제한 모드 (해를 못 찾을 때 사용)


class ScheduleSave(BaseModel):
    year: int
    month: int
    nurses: List[Nurse]
    requirements: Requirements
    rules: Rules
    schedule: Dict[str, Dict[str, str]]
    name: Optional[str] = None
