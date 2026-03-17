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
    is_night_shift: bool = False  # 야간전담 여부
    seniority: int = 0  # 0 = 낮음(시니어), 숫자 클수록 경력 낮음
    wishes: Dict[str, str] = {}  # {"1": "D", "15": "OFF", ...}
    juhu_day: Optional[int] = None  # 주휴 요일: 0=일,1=월,...,6=토. None=임의
    juhu_auto_rotate: bool = True   # True: 4주마다 1일 자동 당기기


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
    patternOptimization: bool = True
    autoMenstrualLeave: bool = True
    maxVPerMonth: int = 1        # V(연차) 월 최대 사용 횟수 (hard)


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
    mip_gap: float = 0.02  # MIP 오차 허용 범위 (0=완벽한 최적해, 0.02=2% 오차허용 조기종료)
    time_limit: int = 1200  # 솔버 타임리밋 (초, 기본 20분)


class ScheduleSave(BaseModel):
    year: int
    month: int
    nurses: List[Nurse]
    requirements: Requirements
    rules: Rules
    schedule: Dict[str, Dict[str, str]]
    name: Optional[str] = None
