# NurseScheduler v4 — 프로젝트 문서

## 개요
간호사 3교대 근무표 자동 생성 **Windows·macOS 데스크톱 앱**.
수리최적화 듀얼 엔진(HiGHS MILP · OR-Tools CP-SAT)으로 최적 근무표 자동 생성.
Electron 네이티브 창으로 실행, 인트라넷(인터넷 없음) 환경 완전 지원.

**최신**: v4.6.0 (2026-07-04, 어싸인 병실 자동 배정 추가)
**리포**: https://github.com/yuangunn/nurse-v4
**라이선스**: All Rights Reserved

> 아키텍처 결정·네거티브 지식은 [`docs/decisions.md`](docs/decisions.md) 참조.
> 세션별 작업 노트는 [`docs/session_notes/`](docs/session_notes/) 참조.

---

## 기술 스택

| 구분 | 기술 |
|------|------|
| 백엔드 | Python 3.11 + FastAPI + uvicorn |
| 스케줄링 엔진 | PuLP 2.9 + HiGHS (`highspy 1.8.1+`) · **OR-Tools CP-SAT** 듀얼 엔진 |
| 데이터 저장 | SQLite (프로필별 분리) + Fernet 암호화 (`cryptography`) |
| 프론트엔드 | HTML + Tailwind CSS + Alpine.js (CDN → `frontend/lib/*.js` 번들) |
| 데스크톱 래퍼 | Electron 38 |
| 패키징 | PyInstaller (Python) + @electron/packager (Electron) + Inno Setup 6 (설치마법사) |

> **중요**: `pulp.HiGHS_CMD` (실행파일) 대신 `pulp.HiGHS` (Python 바인딩, `highspy` 패키지) 사용.
> `pulp.HiGHS_CMD`는 highs.exe 경로 문제로 PyInstaller 빌드에서 동작하지 않음.

---

## 프로젝트 구조

```
nurse-v4/
├── main.py                  # 진입점: 포트 찾기 → stdout "PORT:N" → uvicorn + 브라우저 오픈
├── server/
│   ├── api.py               # FastAPI 라우터 (프로필/간호사/규칙/스케줄/진단/개발자)
│   ├── scheduler_base.py    # 엔진 공유 베이스 _SchedulerBase (데이터·날짜·추출·점수·게이팅 헬퍼)
│   ├── scheduler.py         # HiGHS(MILP) 엔진 NurseScheduler (solve/2단계 완화)
│   ├── scheduler_highs_constraints.py # HiGHS 하드 제약 + 목적함수 믹스인
│   ├── scheduler_highs_diagnosis.py   # HiGHS Infeasible 13-phase 진단 믹스인
│   ├── scheduler_cpsat.py   # CP-SAT(OR-Tools) 엔진 CpSatScheduler
│   ├── conflict_analyzer.py # 정밀 충돌 분석 (assumptions·MUS/MCS) — /api/diagnose·suggest-fix
│   ├── solver_progress.py   # 솔버 무관 진행/취소 레지스트리 (레이스 안전 다중 어댑터)
│   ├── database.py          # SQLite CRUD + 마이그레이션 + 유령 정리
│   ├── models.py            # Pydantic 데이터 모델 (GenerateRequest 등)
│   └── profiles.py          # 프로필 관리 + Fernet 암호화 (PBKDF2 100k)
├── frontend/
│   ├── index.html           # SPA (설정·사전입력·분석·스케줄·저장 + 모바일 '오늘' 홈)
│   ├── css/                 # tokens·base·components·yginvest-skin (cascade 순서로 link)
│   ├── js/
│   │   ├── app.js           # Alpine.js 코어 (~530줄: 상태·computed·init·API·모듈 합성)
│   │   └── modules/         # 14개 도메인 모듈 (analysis·solver·profiles·nurse-manage·
│   │                        #   preinput-io·grid-interactions·schedule-features·misc-features·
│   │                        #   settings-defs·view-helpers·paste-import·dev-tools·undo-redo·drag-select)
│   │                        # + assign-core.js — standalone 배정표 전용 공유 코어 (앱은 로드 안 함)
│   ├── lib/                 # tailwindcss, alpine, lucide (오프라인 번들)
│   └── fonts/               # Pretendard(주) + 번들 폰트
├── electron/
│   ├── main.js              # Electron main: Python 자식 프로세스 스폰 + BrowserWindow
│   ├── preload.js           # contextBridge (electronInfo.version 등)
│   └── package.json         # Electron 의존성 + @electron/packager 설정
├── build/
│   ├── icon.ico, icon.png   # 앱 아이콘
│   └── make_icon.py         # 아이콘 생성 스크립트
├── installer/
│   └── setup.iss            # Inno Setup 스크립트 (#define AppVersion)
├── scripts/
│   └── verify_holidays.mjs  # 공휴일 자동계산 KASI 골든셋 대조 검증
├── tests/                   # pytest 회귀 86건 (제약·진단·CP-SAT 동등성·충돌·완화·모성보호·위시·공휴일)
│   └── fixtures/            # kr_holidays_golden.json (KASI 2025~2050 공휴일 골든셋)
├── dist/                    # 빌드 산출물 (gitignore)
├── docs/
│   ├── decisions.md         # 아키텍처 결정 + 네거티브 지식 (세션 간 공유)
│   └── session_notes/       # 세션별 작업 일지
├── NurseScheduler.spec      # PyInstaller 스펙
├── build.bat                # Windows 원클릭 빌드 (Python → Electron → ZIP → 설치파일)
├── build-mac.sh             # macOS 빌드 (PyInstaller → electron-packager → ad-hoc 서명 → zip/dmg)
├── BUILD.md                 # 상세 빌드 가이드
├── MANUAL.md                # 사용자 매뉴얼
├── README.md                # 리포 소개
├── requirements.txt         # Python 의존성
└── CLAUDE.md                # 이 파일
```

---

## 실행 방법

### 개발 환경 (브라우저)
```bash
cd c:\Users\Helios_Neo_18\nurse-v4
pip install -r requirements.txt
py main.py
# → http://localhost:5757 자동 오픈
```

포트 충돌 시 5758~5766 순으로 시도.

### 개발 환경 (Electron)
```bash
cd electron
npm install
# 사전: py main.py로 Python 서버 먼저 기동되어야 함
# 또는 dist/NurseScheduler/NurseScheduler.exe (PyInstaller 번들) 존재 시:
npm start
```

### 설치된 배포판
- `NurseScheduler_Setup_v4.5.0.exe` 실행 → 설치 마법사 → 바로 실행
- 또는 `NurseScheduler_v4_portable.zip` 해제 → `NurseScheduler.exe` 실행

> **Python/Node.js 설치 불필요** — PyInstaller + electron-packager로 런타임 완전 번들.

---

## 근무 유형 정의 (기본 17종)

| 코드 | 이름 | 시간 | auto_assign | 비고 |
|------|------|------|:--:|------|
| DC | Day Charge | 06:00~14:00 | ✓ | 차지 간호사 |
| D | Day | 06:00~14:00 | ✓ | |
| D1 | Day1 | 08:30~17:30 | ✗ | 상근/교육 (사전입력 전용) |
| EC | Evening Charge | 14:00~22:00 | ✓ | 차지 간호사 |
| E | Evening | 14:00~22:00 | ✓ | |
| 중 | 중간번 | 11:00~19:00 | ✗ | 사전입력 전용, E→중 전환 순방향 |
| NC | Night Charge | 22:00~익일 06:00 | ✓ | 차지 간호사 |
| N | Night | 22:00~익일 06:00 | ✓ | |
| OF | Off | — | ✓ | 주 1회 의무. 공휴일 배정 하드 금지 |
| 주 | 주휴 | — | ✗ | 주 1회 의무 (법정 주휴일) |
| P1 | 임부휴무 | — | ✓ | **임산부(모성보호) 전용**. 임신 구간 주 1회 자동. 비임산부엔 미배정 |
| V | 연차 | — | ✓ | 월 최대 1회 (기본) |
| 생 | 생리휴가 | — | ✓ | 여성 간호사만, 공휴일 금지 |
| 특 | 특별휴가 | — | ✗ | 사전입력 전용 |
| 공 | 공적업무 | — | ✗ | 사전입력 전용 |
| 법 | 법정공휴일 | — | ✗ | 공휴일 날짜에만 배정 가능 |
| 병 | 병가 | — | ✗ | 사전입력 전용 |

**트레이니 표시 코드** (출력 전용): `/D`, `/E`, `/N` — 프리셉터 근무에 `/` 접두어.
사전입력으로 재로드 시 스케줄러가 자동 무시 (프리셉터 기반 복사 로직으로 위임).

### 근무 분류
- **WORK_SHIFTS**: DC, D, D1, EC, E, 중, NC, N
- **DAY_SHIFTS**: DC, D
- **DAY1_SHIFTS**: D1
- **EVENING_SHIFTS**: EC, E
- **MIDDLE_SHIFTS**: 중
- **NIGHT_SHIFTS**: NC, N
- **CHARGE_SHIFTS**: DC, EC, NC
- **REST_SHIFTS**: OF, 주, P1 (휴무) — P1은 임부휴무(모성보호), `is_protected_timeoff`에서 OFF급 보호
- **LEAVE_SHIFTS**: V, 생, 특, 공, 법, 병 (휴가)
- **SOLVER_SHIFTS**: auto_assign=True인 집합 (솔버 자유 배정 가능)

---

## 스케줄링 제약 규칙

### Hard Constraints (반드시 지켜야 함)

| 제약 | 설명 |
|------|------|
| 1일 1근무 | 재적 중인 간호사는 하루에 정확히 1개 근무 (전입 전/전출 후 제외) |
| 일별 인원 **정확** 충족 | D/E/N 각 시간대 요구 인원과 **정확히 일치** (초과 불가). auto_assign 외 근무(중 등)도 개별 제약 |
| Charge 필수 | D/E/N 요구 있는 날 DC/EC/NC 각 정확히 1명 |
| **Charge 시니어리티** | DC/EC/NC는 해당 듀티에서 seniority 가장 낮은(선임)에게만. 더 선임이 같은 듀티 일반 근무면 후임은 Charge 불가 |
| 근무 자격 | capable_shifts에 없는 D/E/N period 근무 불가 (D1/중은 체크 안 함) |
| **9개 금지 전환** | E→D, E→D1, E→중, N→E, N→D, N→D1, N→중, 중→D, 중→D1 (물리적 간격 < 8h) |
| N→OF→D 금지 | `noNOD` 규칙 시 Night→Off→Day 패턴 금지 |
| **공휴일 OF 금지** | 법정공휴일에는 OF 배정 불가 (일반/완화/진단 모두 적용) |
| 법은 공휴일에만 | 법정공휴일 코드 `법`은 공휴일 날짜에만 배정 |
| 야간전담 공휴일 제외 | 야간전담에게 법/생/V 공휴일 배정 차단 규칙 다름 |
| 주휴 1회/주 | 매주 정확히 주 1회 (완화 모드엔 `<=1`) |
| OF 1회/주 | 완전한 주 정확히 1회, 부분 주 `<=1` |
| 최대 연속 근무 | 기본 5일 (설정 가능) |
| 최대 연속 야간 | 기본 3일 (설정 가능) |
| 연속야간 후 휴무 | 2연속 이상 야간 후 2일 휴무 (기본값) |
| V 월 최대 | 기본 월 1회 (hard, unlimited_v 모드 해제 가능) |
| 생 월 최대 | 여성 간호사 월 1회 |
| 월 최대 야간 | 기본 월 6회 (수면OFF 임계) |
| 홀짝월 합산 야간 | 전월+당월 ≤ 11회 (선택적) |
| **야간전담 규칙** | N/NC만 배정, 5일 윈도우 내 ≤3 야간, 당월 정확히 14일 근무, 여성+31일 달엔 생 1회 |
| **임산부 모성보호** | `is_pregnant`+`pregnancy`{early,late} 설정 시: ①P1 구간 완전 포함 주마다 P1 정확히 1회(부분 주 ≤1) ②임신 전 구간 `[early.start~late.end]` N/NC 금지 ③임신-중-달 생(生) 면제(배정 금지) ④임산부 달엔 야간전담 자동 해제. P1은 임산부+구간 또는 사전입력 P1에서만 허용(그 외 변수 0). HiGHS·CP-SAT·conflict_analyzer 패리티. 헬퍼: `_preg_window_on`/`_preg_span_on`/`_preg_active_in_month`/`_preg_forbids`/`_preg_effective_pre` (scheduler_base) |
| 전입/전출 재적 | start_date ≤ d ≤ end_date 범위에서만 배정 |
| **셀 잠금** | `locked_cells[nurse][date]=true`인 셀은 완화 모드에서도 사전입력 고정 |

> **허용 전환 (순방향)**: D→E→N (8h+ 간격). 중간번(19:00) → 익일 N(22:00) = 27h 순방향 정상.

### Soft Constraints (scoring_rules 기반 동적 목적함수)

사용자가 `설정 → 배점 규칙`에서 편집 가능. 기본 규칙:
- 공 전날 N 회피 (-40)
- D→N 전환 회피 (-30)
- 순방향 D→E, E→N 보상 (+20)
- 동일 근무 연속 보상 (+15)
- 연속 휴일 보상 (+30)
- 야간 공정 배분 (range 최소화, -가중치)
- 희망 근무 반영 (+50)
- V 사용 페널티 (-500) — 마지막 수단
- 생 사용 (여성) 보상 (+80)
- 법정공휴일 휴가 보상 (+30)
- 공휴일 근무 보상 (+20)
- **사전입력 유지 보너스**: 휴가 `preBonusLeave=5000`, 근무 `preBonusWork=500`, 휴무 `preBonusRest=300`

---

## 주휴 순환 로직

**주휴(週休)**: 법정 주휴일. 1~4주기 동안 동일 요일 유지 후 5주차부터 1일씩 당겨짐.

### 사용자 요일 코드 → Python weekday 매핑
```
사용자: 0=일, 1=월, 2=화, 3=수, 4=목, 5=금, 6=토
Python: 0=월, 1=화, 2=수, 3=목, 4=금, 5=토, 6=일
변환:   {0:6, 1:0, 2:1, 3:2, 4:3, 5:4, 6:5}
```

### 순환 계산
```python
cycle = week_idx // 4          # 0,0,0,0,1,1,1,1,2,...
effective_day = (juhu_day - cycle) % 7   # 4주마다 1일 당기기
```

### 간호사별 설정
- `juhu_day`: None(임의) 또는 0~6 (요일 고정)
- `juhu_auto_rotate`: True(4주 순환) / False(고정)

---

## 요일별 필요 인원 (기본값)

| 요일 | D | E | N |
|------|---|---|---|
| 월 | 4 | 5 | 3 |
| 화 | 5 | 5 | 3 |
| 수 | 5 | 5 | 3 |
| 목 | 5 | 5 | 3 |
| 금 | 5 | 4 | 3 |
| 토 | 3 | 3 | 2 |
| 일 | 3 | 4 | 3 |

D/E/N 수치는 charge 포함 총 인원 (D=4 → DC 1 + D 3).
특정 날짜 override: `per_day_requirements[date_str]` 로 덮어쓰기.

---

## 간호사 속성

```python
{
  "id": "a0",                  # 고유 ID
  "name": "김지현",
  "group": "A",                # 자유
  "gender": "female",          # female|male
  "capable_shifts": [...],     # ["DC","D","EC","E","NC","N"] 등
  "is_night_shift": False,     # 기본 야간전담 (fallback)
  "night_months": {"2026-05":true},  # 월별 야간전담 (비어있지 않으면 여기가 우선)
  "seniority": 0,              # 숫자 작을수록 선임 (목록 순서 = 시니어리티)
  "wishes": {"15":"OFF"},      # 희망근무 {날짜: shift}
  "juhu_day": None,            # 0~6 or None
  "juhu_auto_rotate": True,    # 4주 순환
  "is_trainee": False,         # 트레이니(신규)
  "training_end_date": None,   # 트레이닝 종료 → 이후 일반 전환
  "preceptor_id": None,        # 프리셉터 연결
  "start_date": None,          # 전입일 YYYY-MM-DD (None=상시)
  "end_date": None,            # 전출일 YYYY-MM-DD (None=상시)
  "is_pregnant": False,        # 임산부(모성보호)
  "pregnancy": {},             # {"early":{"start","end"},"late":{"start","end"}} 임신초기/출산전 구간
}
```

**임산부(모성보호)**: `is_pregnant`+`pregnancy` 두 구간 설정 시 솔버가 각 구간 주마다 P1(임부휴무)
1회 자동 배치 + 임신 전 기간 야간(N/NC) 제외 + 그 달 생리휴가 면제 + 야간전담 자동 해제.
사전입력으로 P1을 직접 지정할 수도 있음. 상세 규칙은 [스케줄링 제약 규칙](#hard-constraints-반드시-지켜야-함) 참조.

**월별 야간전담**: `night_months` dict에 값이 하나라도 있으면 해당 월 키 존재 여부로 결정.
값이 비었으면 `is_night_shift` 폴백.

---

## API 엔드포인트

### 프로필 API
| Method | Path | 설명 |
|---|---|---|
| GET | `/api/profiles` | 프로필 목록 + 마스터 비밀번호 설정 여부 |
| POST | `/api/profiles/create` | 프로필 생성 |
| POST | `/api/profiles/open` | 프로필 열기 (암호 검증 + DB 복호화 + 유령 정리) |
| POST | `/api/profiles/close` | 현재 프로필 닫기 (암호화 후 평문 삭제) |
| DELETE | `/api/profiles/{id}` | 프로필 삭제 |
| POST | `/api/profiles/change-password` | 비밀번호 변경 |
| POST | `/api/profiles/master-password` | 마스터 비밀번호 (set/remove/verify) |

### 핵심 API
| Method | Path | 설명 |
|---|---|---|
| GET | `/` | 프론트엔드 서빙 |
| GET | `/health` | 상태 확인 |
| GET/POST | `/api/nurses` | 간호사 목록/추가 |
| POST | `/api/nurses/reorder` | 순서(시니어리티) 변경 |
| DELETE | `/api/nurses/{id}` | 삭제 + **저장본 캐스케이드 정리** |
| GET | `/api/nurses/template` | CSV 템플릿 다운로드 |
| GET | `/api/nurses/export` | 현재 간호사 CSV 내보내기 |
| POST | `/api/nurses/import` | CSV 일괄 등록/업데이트 |
| GET/POST | `/api/rules` | 규칙 |
| GET/POST | `/api/requirements` | 요일별 필요 인원 |
| GET/POST/DELETE | `/api/shifts[/code]` | 근무 정의 |
| GET/POST/DELETE | `/api/scoring_rules[/id]` | 배점 규칙 |

### 스케줄 생성 API
| Method | Path | 설명 |
|---|---|---|
| POST | `/api/estimate` | 예상 소요시간 |
| POST | `/api/generate` | 스케줄 생성 (사전검증 → 솔버 → 완화 → 진단) |
| POST | `/api/generate/stop` | `cancelSolve` 신호 |
| GET | `/api/generate/progress` | 2초 폴링용 진행 상황 |
| GET | `/api/generate/stream` | SSE 실시간 로그 + 진행 스트리밍 |
| GET | `/api/generate/result` | 마지막 결과 (새로고침 복구) |

### 저장/불러오기
| Method | Path | 설명 |
|---|---|---|
| GET/POST | `/api/schedules` | 생성된 스케줄 (저장 시 locked_cells, cell_notes, holidays 등 포함) |
| GET/DELETE | `/api/schedules/{id}` | 개별 조회/삭제 |
| GET/POST | `/api/prev_schedules` | 사전입력 저장 (유령 자동 제거) |
| GET/DELETE | `/api/prev_schedules/{id}` | 개별 조회/삭제 |

### 개발자 API
| Method | Path | 설명 |
|---|---|---|
| GET | `/api/dev/info` | 현재 DB 경로·크기·간호사 수 |
| POST | `/api/dev/reset-seed` | 예시 18명 재생성 |
| GET | `/api/dev/download-db` | 현재 DB 파일 다운로드 |

---

## 프론트엔드 탭 구성 (5탭)

1. **설정**: 간호사 관리 + 요일별 인원 + 규칙 + 근무 정의 + 배점 규칙 + CSV 일괄 + 개발자 설정
2. **사전입력**: 년월 선택 + 근무표 선입력 (또는 **이미 완성된 근무표 입력**)
   - 💾 패널: 서버 저장/불러오기/삭제 (잠금·메모 포함)
   - 셀 우클릭 → **메모 + 🔒 완화 시 고정** 토글
   - 셀 드래그 → 다중 선택 + 근무 일괄 지정
   - Ctrl+Z/Shift+Ctrl+Z undo/redo (40단계)
   - 키보드: D/E/N/V/O 직접 입력, ←↑↓→ 이동, Delete 삭제
   - tfoot: 일별 D/E/N 배정 수 + 필요 수 (편집 가능)
   - **✅ 이대로 근무표로** (`usePrevAsSchedule`): 사람이 손으로 짠 근무표를 붙여넣었을 때
     솔버를 돌리지 않고 사전입력을 그대로 스케줄로 확정. 점수·완화 정보는 비어 있음
     (📌 이 표대로 인원 → ✅ 이대로 근무표로 순으로 쓰면 인원 기준까지 그 표에 맞춰진다)
3. **분석**: 일자별 과부족 히트맵 + 주휴 추천 배분 → "사전입력에 적용"
4. **스케줄**: 생성 결과 표시, 셀 직접 편집, 인원 카운트, 배점 상세
   - **📋 어싸인용 복사** (`copyScheduleTsv`): 이름 + 날짜 + 근무 표를 클립보드로 →
     어싸인 배정표(standalone)에 그대로 붙여넣는다
5. **저장**: 생성 스케줄 저장/불러오기

> 어싸인(병실 배정)은 **본 앱에서 뺐다** — 병동에서 실제로 쓰는 건 `standalone/assign.html`
> 하나뿐이고(본 앱엔 배정표 출력이 없었다) 같은 로직을 두 곳에서 관리할 이유가 없다.
> 근무표는 스케줄 탭 [📋 어싸인용 복사] → standalone 붙여넣기로 넘긴다.
> 공유 코어 `frontend/js/modules/assign-core.js` 는 standalone 빌드가 쓰므로 **남겨 둔다**
> (본 앱 HTML 에서는 더 이상 로드하지 않음).

> 사전입력·스케줄 탭은 년월 연동. 주기 경계(7일 단위) 컬러 헤더.
> 토요일 이후 컬럼 구분선.

---

## 어싸인 (병실 배정) — 별도 도구

병동 근무표가 나온 뒤 **누가 어느 방을 보는지** 정하는 도구. 본 앱과 분리돼 있다.

- 코어: `frontend/js/modules/assign-core.js` (순수 함수, `opts.seed`=전월 이월,
  `opts.roomsFor`=방 기준 연속성. 검증 `node scripts/test_assign_core.mjs`)
- 원칙: 차지=DC/EC/NC 우선(항상) · ①전일 같은 근무 방 유지 ②근무 변경 시 유지
  ③오프 복귀 유지 ④오프 복귀 튕기기(③과 상호배제). 우선순위 ①>②>③.
  **연속성은 알파벳(A/B/C)이 아니라 실제 병실 겹침 기준** — 인원이 5→4로 바뀌어도
  6~9호 보던 사람이 6~10호를 이어받는다(겹침 총합 최대 매칭).
- 인트라넷용 ①: `standalone/assign.html` — 단일 파일 통합본(외부 의존 0, Chrome/Edge 103+).
  엑셀식 편집 그리드(붙여넣기·근무만 붙여넣기·모르는 근무 매핑·범위선택·파일 DnD·CP949 폴백),
  옆 폴더 `assign-data.js/json` 자동 열림(여러 개면 선택), 전월 어싸인 자동 이월,
  주간 배정표 xlsx 내보내기(순수 JS zip 패치) + HTML 인쇄, 다크 모드, 도움말(실제 화면 GIF).
  **되돌리기는 화면 공용** (`undoAny`) — 배정표 화면의 근무 바꾸기·어싸인 교체·교육 입력·
  붙여넣기 확정도 `Ctrl+Z` 또는 **파란 알림 클릭**으로 되돌아간다. 파괴적 동작에는 반드시
  `snapshot()` 을 먼저 찍을 것(찍지 않으면 영구 손실). 툴바에 버튼을 더 얹지 않은 이유:
  1366×768 에서 툴바가 두 줄로 접혀 N 구역이 더 잘린다.
  **화면 날짜는 전부 두 자리** (`fmtMD` = `mm/dd`) — 양식 xlsx 의 날짜 서식이
  `mm"월" dd"일"` 이라 거기에 맞춘 것. 새 날짜 표시를 넣을 때도 `fmtMD` 를 쓸 것.
  단 '9일 D' 처럼 일(日) 하나만 쓰는 문구는 그대로 둔다(‘09일’은 한국어로 어색).
  **병동 양식 교체**: 관리 > 배정표 양식에서 xlsx 를 올려 구조를 검사하고 채택.
  구조가 다르면 자리표시자(`{{이름}} {{방}} {{차지:/CRN}} {{날짜}} {{요일}} {{중간번}} {{교육}}`)를
  자동으로 꽂아 받은 뒤 엑셀에서 위치만 손보면 된다.
  동기화 `node scripts/build-assign-standalone.mjs` (코어 + 양식 + 폰트 + 도움말 그림 + 버전 주입)
- 인트라넷용 ②: `standalone/app/` — 같은 화면을 담은 Windows 단일 exe (WebView2, 127.0.0.1 안 씀).
  파일 저장 권한 확인 없이 바로 저장. 빌드 `standalone/app/build.cmd`
- 인트라넷용 ③: `standalone/assign_vba.bas` (Excel VBA 매크로 4종)

## Infeasible 진단 단계

`_diagnose_infeasibility()` — 각 단계 timeLimit=10초. 순차 추가로 충돌 지점 탐색.

| Phase | 누적 제약 | 실패 시 진단 |
|:---:|---|---|
| 1 | 1근무/일 + 자격 | 사전입력 알 수 없는 코드 / 자격 충돌 (트레이니 /D 코드도 힌트) |
| 2 | + 일별 인원 | 날짜별 공급 부족 리스트 |
| 3 | + Charge 요구 | Charge 자격 간호사 부족 |
| 4 | + 역순 전환 | 사전입력에 E→D, N→E 등 역순 존재 |
| 5 | + 주휴/OF | 주차별 공급/수요 분석 ★ |
| 6 | + 연속 근무/야간 | 주차별 근무일 한도 초과 |
| 7 | + V 월 최대 | V 초과 |
| 8 | + **야간전담** | 정규 간호사 D/E 공급 부족 — **재적·완화가능·주간 총량 상세 표시** |
| 9 | + Charge 시니어리티 | 시니어리티/NC 충돌 |
| 10 | + N→OF→D | 사전입력 N→OF→D 패턴 발견 |
| 11 | + 생리휴가 | 여성+31일 제약 충돌 |
| 12 | + 월 최대 야간 | 전체 야간 슬롯 부족 |
| 13 | + 홀짝월 합산 | 이전달 야간 과다 |

**Phase 8 출력 (핵심)**:
- 일별: 필요 D/E, 사전배정 D/E, 타근무/휴무 n명(완화가능 k), 가용, 남은필요, ▲부족
- 주간 총량: 주휴+OF 의무 반영, 전입/전출 재적 수 기반 공급 vs 수요
- "솔버가 실제 시도 후 실패 — strict + 완화 모두 infeasible" 명시

---

## 데이터베이스

### 위치
- **기본**: `%APPDATA%\NurseScheduler\nurse_scheduler.db` (프로필 시스템 도입 전 폴백)
- **프로필별**: `%APPDATA%\NurseScheduler\{profile_id}.db` (평문) 또는 `.db.enc` (암호화)
- **게스트**: `%APPDATA%\NurseScheduler\_guest_temp.db` (종료 시 삭제)
- **프로필 메타**: `%APPDATA%\NurseScheduler\profiles.json`

### 테이블
| 테이블 | 내용 |
|---|---|
| `nurses` | id(PK), name, grp, gender, capable_shifts, is_night_shift, seniority, wishes, juhu_day, juhu_auto_rotate, night_months, is_trainee, training_end_date, preceptor_id, start_date, end_date, **is_pregnant, pregnancy** |
| `rules` | key-value |
| `requirements` | id=1 고정, data JSON |
| `shifts` | code(PK), name, period, is_charge, hours, color_bg/text, sort_order, auto_assign |
| `scoring_rules` | id, name, rule_type, params JSON, score, enabled, sort_order |
| `schedules` | id, year, month, name, data JSON, created_at |
| `prev_schedules` | id, year, month, name, data JSON, created_at |

### 암호화 (프로필 비밀번호 설정 시)
- **PBKDF2-HMAC-SHA256** (100k iter) 로 비밀번호 해시
- **Fernet** (대칭 AES-128) 으로 DB 파일 암호화
- 프로필 오픈: `.db.enc` → 복호화 → `.db` (평문). 사용 중엔 평문 유지
- 프로필 close: `.db` → 재암호화 → `.db.enc`, 평문 삭제

### 유령 간호사 방어 (v4.0.6)
- 간호사 삭제 시 저장된 prev_schedules/schedules JSON에서도 해당 ID 캐스케이드 제거
- 프로필 오픈 시 `cleanup_orphan_nurse_refs()` 일회 스윕 (과거 데이터 호환)
- 저장 엔드포인트에서 유효 nurse_id만 통과시키는 필터
- 스케줄러 초기화 시 `self.prev` / `self.locked_cells` 유령 필터

### 기본 시드
- 간호사 18명: A/B/C 그룹, 각 여4+남2
- 근무 17종: DC, D, D1, EC, E, 중, NC, N, OF, 주, P1, V, 생, 특, 공, 법, 병
- 배점 규칙: 14종 (법정공휴일/주말 마이그레이션 포함)

---

## 패키징 (배포 빌드)

### 원클릭 빌드
```bash
build.bat
```
1. `build/NurseScheduler/` 정리 (PyInstaller work dir만, icon.ico 등 소스는 보존)
2. PyInstaller — `NurseScheduler.spec` → `dist/NurseScheduler/NurseScheduler.exe`
3. `cd electron && npm install` (최초 1회)
4. `electron-packager` → `dist/electron/NurseScheduler-win32-x64/`
5. 포터블 ZIP — PowerShell `Compress-Archive`
6. Inno Setup (ISCC) — `dist/installer/NurseScheduler_Setup_v4.5.0.exe`

### 산출물
- `NurseScheduler_Setup_v4.5.0.exe` (~190MB) — 설치마법사 (Windows)
- `NurseScheduler_v4_mac_arm64.dmg` / `.zip` — macOS(Apple Silicon, ad-hoc 서명) → `build-mac.sh`
- `NurseScheduler_v4_portable.zip` (~250MB) — 포터블

### 제약
- **electron-builder 사용 금지** — 26.x가 `winCodeSign` 심볼릭 링크 생성 실패 (Windows 개발자 모드 없이 불가). `@electron/packager` + 수동 ISCC로 대체.
- **PyInstaller `--windowed`**에서 `sys.stdout=None` → `main.py:_ensure_stdio()`로 devnull 대체 + `PORT:` 출력 try/except.

---

## highspy 1.8.1 콜백 API

```python
# 구 API (동작 안 함)
# self.setLogCallback(lambda _, msg: ...)

# 신 API
def _on_log(event):
    msg = getattr(event, "message", "")
    ...
self.cbLogging.subscribe(_on_log)
```

`setCallback(fn, user_data)`는 모든 내부 이벤트("MIP check limits" 등)를 쏟아내므로 사용 금지.
`cbLogging.subscribe()`가 로그 전용 콜백.

---

## 솔버 중지 / 새로고침 복구 / 동시 생성 방지

### 중지 (`cancelSolve`)
- `POST /api/generate/stop` → 실행 중인 `_TrackableHighs.cancelSolve()` 호출
- PuLP가 `kInterrupt` 상태 반환 → LpStatus 매핑 없음
- 해결: `prob.solve()` 예외 처리 + 변수값 할당됐으면 feasible로 인정

### 새로고침 복구
- `_last_generate_result` 전역 변수에 최종 결과 보관
- `GET /api/generate/result` → `running`/`done`/`idle`
- 프론트 `init()` 시 자동 감지: 진행 중이면 SSE 재접속, 완료면 결과 복원

### 동시 생성 방지
- `POST /api/generate` 진입 시 이전 솔버 돌고 있으면 409 반환

---

## Electron IPC 플로우

1. Electron `main.js`가 `getPythonExePath()` → `resources/NurseScheduler/NurseScheduler.exe` 스폰
2. Python stdout에서 `PORT:5757` 라인 파싱 → `serverPort` 저장
3. `waitForServerReady(port)` — `/health` 500ms 간격 폴링
4. 서버 준비되면 `BrowserWindow.loadURL(http://127.0.0.1:5757)`
5. 종료 시 `pythonProcess.kill()`

### 싱글 인스턴스
- `app.requestSingleInstanceLock()` → 중복 실행 시 기존 창 focus

---

## 성능 참고 (18명 × 31일 기준)

- 주휴만 사전입력 (81건): ~5분 (300초), Optimal
- 사전입력 많을수록 자유 변수 감소 → 속도 향상
- `mip_gap=0.02` (2% 오차) 설정 시 조기 종료
- CPU 싱글코어 성능이 핵심 (HiGHS 기본 싱글스레드)
- GPU 사용 안 함
- 예상 시간: `base_vars × 0.12초/변수` 기반 추정 (`estimate_seconds()`)

---

## 프론트엔드 핵심 상태 / 저장 라운드트립 (v4.0.6)

### 스케줄 저장 (`saveSchedule`) 포함 필드
`nurses, requirements, rules, schedule, prev_schedule, nurse_scores, nurse_score_details, locked_cells, cell_notes, holidays, prev_day_reqs, prev_month_nights, solver_log`

### 사전입력 저장 (`savePrevToServer`) 포함 필드
`schedule, day_reqs, holidays, prev_month_nights, locked_cells, cell_notes`

> v4.0.5 이전엔 `locked_cells`, `cell_notes`, `holidays`, `prev_day_reqs`, `prev_month_nights`가 저장/복원에서 누락돼 잠금·메모가 유실되던 버그 있었음. v4.0.6에서 완전 복구.

### localStorage 자동 저장 (`_saveFullState`)
`year, month, tab, prevSchedule, prevDayReqs, holidays, lockedCells, cellNotes, prevMonthNights, timestamp`
— 48시간 이내 복원.

### Undo/Redo (40단계)
위 필드들 JSON stringify → stack. Ctrl+Z/Shift+Ctrl+Z.

---

## 알려진 주의사항 (v4.5.0 기준)

- `pulp.HiGHS_CMD` 금지 → `pulp.HiGHS` (Python 바인딩)
- 소프트 제약 보조변수는 당월 날짜 쌍에만 적용 (문제 크기 최소화)
- solver timeLimit: 프론트 설정 가능 (기본 20분, 최대 60분)
- 일별 인원 제약 `==` (정확히 일치, 초과 불가)
- `__pycache__` 구버전 캐시 오류 시: 서버 종료 후 `server/__pycache__` 삭제
- 포트 5757 점유 시 기존 uvicorn 프로세스 확인 후 재시작
- 전역 keydown 리스너는 `activeElement`가 INPUT/TEXTAREA/SELECT/contentEditable일 때 grid key 처리 skip 필수
- CSS: `var(--card)` 사용 금지 → `var(--bg-card)` (다크모드 fallback 버그 방지)
- CSS: `input[type="text"]` 속성 셀렉터는 type 명시 없는 input 매칭 안 됨 → `input:not([type])` 포함 또는 HTML에 `type="text"` 명시
- 사전입력 저장/로드는 `locked_cells`, `cell_notes`, `holidays`, `prev_day_reqs`, `prev_month_nights` 포함 필수 (v4.0.6에서 추가)
- 간호사 삭제는 API 경유 — 저장본 캐스케이드 정리 자동 실행

---

## 커밋/릴리즈 정책

- 브랜치: `main` (릴리즈)
- 태그: `v4.0.X` 형식
- 릴리즈 자산: 설치파일 + 포터블 ZIP 모두 GitHub Releases에 업로드
- 버전 올릴 시 동기화 파일: `electron/package.json`, `electron/preload.js`, `installer/setup.iss`, `frontend/index.html` (버전 표시 라인), `README.md` 다운로드 섹션

---

## 참고 문서

- [`docs/decisions.md`](docs/decisions.md) — 아키텍처 결정 + 네거티브 지식 (컴팩팅 내성)
- [`docs/session_notes/`](docs/session_notes/) — 세션별 작업 일지
- [`MANUAL.md`](MANUAL.md) — 사용자 매뉴얼
- [`BUILD.md`](BUILD.md) — 빌드 가이드
- [`README.md`](README.md) — 리포 소개
