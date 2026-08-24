# NurseScheduler v4 — 프로젝트 문서

## 개요
간호사 3교대 근무표 자동 생성 **Windows·macOS 데스크톱 앱**.
수리최적화 듀얼 엔진(HiGHS MILP · OR-Tools CP-SAT)으로 최적 근무표 자동 생성.
Electron 네이티브 창으로 실행, 인트라넷(인터넷 없음) 환경 완전 지원.

**최신**: v4.10.2 (2026-08-20, 명부에 야간전담 월 뱃지)
**리포**: https://github.com/yuangunn/nurse-v4
**라이선스**: All Rights Reserved

> 아키텍처 결정·네거티브 지식은 [`docs/decisions.md`](docs/decisions.md) 참조.
> 기능 로드맵·남은 작업은 [`docs/milestones.md`](docs/milestones.md) 참조 (세션 간 이어서 작업).
> 세션별 작업 노트는 [`docs/session_notes/`](docs/session_notes/) 참조.

---

## 제1원칙 — 병동 도메인 사실 (사용자 명시, 2026-08-20)

> **모든 세션은 작업 전 이 절부터 읽는다.** 시뮬레이션·규칙 변경·추천 로직은 이
> 사실들과 어긋나면 안 된다. 임의 가정 금지 — 보충이 필요하면 **먼저 물어볼 것**.

1. **공휴일에는 법휴(법)·주휴(주)·근무를 모두 넣을 수 있다.**
2. **공휴일에도 병원은 돌아간다** — 전원 휴무는 불가.
3. **오프특근**: 주 1회 OFF는 정말 불가피한 경우 뺄 수 있다. **경가·조가 등으로
   휴무가 갑자기 많아지면 남은 근무자들이 오프를 줄여가며 근무를 뛴다** — 그것이
   오프특근이다. 그때도 깎이지 않는 **최소한의 휴무 보장이 주휴**다.
   (공휴일·법휴는 오프특근의 조건이 아니다 — 휴무 공급 부족이 원인이다.)
4. **요일별 최소 근무 인원은 18명 기준**으로 맞춰져 있다:
   일 3/4/3 · 월 4/5/3 · 화~목 5/5/3 · 금 5/4/3 · **토 4/3/2**.
   공휴일이 평일에 지속되는 경우 임의 조절 가능하지만 크게 벗어나지 않는다.
   결원이 있어도 이 최소는 보장한다.
5. **주휴를 법정공휴일에 몰아주는 관행은 존재하지 않는다.** 주휴와 공휴가 겹치면
   **주휴·공휴 중복수당**으로 보상하는 것이다 (근로기준법의 주휴 개념 참조).
6. 이 프로그램은 **대학병원 3교대 외과병동** 기준이다 — 주말에 전원 OFF가 발생할
   수 없는 구조.
7. **나이트킵(야간전담) 달의 야간은 수면오프와 전혀 무관하다.** 홀짝월 합산
   (수면오프 회피)은 일반 근무로 쌓은 야간에만 적용된다 — 나이트킵 달의 14회를
   합산에 넣으면 그 사람만 다음 달 야간을 못 받는다.
8. **사전입력(원티드)에는 반드시 사유가 있다** — 제사·생일·가족여행·부동산 계약·
   결혼 준비·결혼·부모님 외래진료 동행 등. 근무표와 사전입력은 **한 개인의 한 달을
   결정하는 일**이다. 조정이 불가피할 때도 V(연차) 자동 대량 사용은 납득 불가 —
   **원티드 미반영 안내·주휴 조정이 우선** 검토 대상이다.

> ✅ **확인 완료 (2026-08-20 사용자 답변 — 반영됨)**:
> ⓐ 토요일 인원 → DB 시드·문서·시뮬레이터 모두 **4/3/2**로 수정.
> ⓑ 인원이 숫자보다 남는 날의 실제 처리 = **연차·휴가로 소진** → 하드 제약
>   "정확히 일치(`==`)"는 현행 유지 (초과 출근 없음).
> ⓒ 오프특근 → **엔진 규칙으로 구현**. v4.8.0(공휴일 주면 누구나)·v4.9.0(법휴·
>   공휴일 근무자만)은 **둘 다 트리거를 잘못 잡은 것**이었다. v4.10.0에서 사용자
>   재설명대로 바로잡았다 — **오프특근은 휴무 공급이 모자랄 때 어쩔 수 없이 발생**
>   하며 공휴일·법휴와 무관하다. 구현: 슬랙 변수 + 압도적 페널티(마지막 수단),
>   발생 시 `off_teukgeun` 리포트로 누가 반납했는지 보고. 최소 보장은 주휴.

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
├── tests/                   # pytest 회귀 137건 (제약·진단·CP-SAT 동등성·충돌·완화·모성보호·위시·공휴일·오프특근·사실클램프)
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
├── requirements.txt         # Python 런타임 의존성 (PyInstaller 번들 대상)
├── requirements-dev.txt     # + pytest·httpx (테스트 전용, 번들 제외)
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

### 테스트
```bash
pip install -r requirements-dev.txt   # pytest·httpx 포함 (requirements.txt 만으로는 2개 파일이 수집 실패)
python3 -m pytest -q                  # 137건
node scripts/test_assign_core.mjs && node scripts/test_paste_dates.mjs \
  && node scripts/test_preinput_lint.mjs && node scripts/test_night_badge.mjs \
  && node scripts/verify_holidays.mjs
```

> `httpx` 는 앱이 쓰지 않지만 `starlette.testclient` 가 요구한다 — 없으면
> `test_nurse_xlsx.py`·`test_parse_table_file.py` 11건이 **수집 자체가 안 된다**
> (통과가 아니라 조용히 안 도는 상태). 런타임 번들이 커지므로 requirements.txt 가 아니라
> requirements-dev.txt 에 둔다.

### 설치된 배포판
- `NurseScheduler_Setup_v4.10.2.exe` 실행 → 설치 마법사 → 바로 실행
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
| 법은 공휴일에만 | 법정공휴일 코드 `법`은 공휴일 날짜에만 **자유 배정** (사전입력 확정 셀은 사실로 수용) |
| 야간전담 공휴일 제외 | 야간전담에게 법/생/V 공휴일 배정 차단 규칙 다름 |
| 주휴(주) | **엔진이 배정하지 않는다** — 사전입력 전용(auto_assign ✗). 일반 모드엔 강제 없음(사람이 넣은 그대로), 주휴 재배치 완화(`allow_juhu_relax`)를 켰을 때만 주당 `<=1` |
| OF 1회/주 | 완전한 주 `Σ OF + s == 1` (`s`=오프특근 슬랙), 부분 주는 `<=1`. **상한 1회는 하드**, 1회 의무는 목적함수에서 `-1,000,000×s`로 지킨다 — 어떤 배점보다 크므로 **그러지 않으면 근무표가 성립하지 않을 때만** OF를 반납한다(제1원칙 3). 반납한 주는 결과 `off_teukgeun`으로 보고 |
| 최대 연속 근무 | 기본 5일 (설정 가능) |
| 최대 연속 야간 | 기본 3일 (설정 가능) |
| 연속야간 후 휴무 | 2연속 이상 야간 후 2일 휴무 (기본값) |
| V 월 최대 | 기본 월 1회 (hard, unlimited_v 모드 해제 가능) |
| 생 월 최대 | 여성 간호사 월 **≤1회 (보장 아님)** — 스케줄상 안 나오면 못 받는 것. 강제 배정 없음 (2026-08-19 야간전담 예외도 제거) |
| **사전입력 사실-클램프** | 확정(사전입력) 셀은 검증 대상이 아니라 **주어진 사실** — 제약에 걸리는 셀이 전부 확정이면 그 제약은 스킵(일 전체·인접 쌍·윈도우·주 전체 확정, 완전 확정 날은 변수 리터럴화), 확정+자유 혼합 카운트 제약은 상한을 `max(규칙, 확정분)`으로 클램프(자유 셀이 위반을 더 늘리는 건 금지). 부분 확정("2주차까지만 꽉 채움")도 동일 작동. 규칙 차이는 성공 결과에 `pinned_notes` 안내만. 완화(allow_pre_relax) 명시 시엔 클램프 OFF(완화 우선). 완전 확정 표 폴백(`pinned_confirmed`)은 타임아웃 안전망으로 유지. 결정 1-15 |
| 월 최대 야간 | 기본 월 6회 (수면OFF 임계) |
| 홀짝월 합산 야간 | 전월+당월 ≤ 11회 (선택적). **나이트킵 달의 야간은 합산 제외** (제1원칙 7) — 전월N 자동 인수인계(`compute_prev_month_nights`)와 엔진 `_two_month_rhs` 양쪽에서 뺀다 |
| **야간전담 규칙** | N/NC만 배정, 5일 윈도우 내 ≤3 야간, 당월 정확히 14일 근무 (생휴 강제 없음 — 월 ≤1 상한만) |
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

### 블록 안에서는 한 요일 (2026-08-24)
1~4주기 동안 주휴 요일이 **같고**, 4주기→1주기로 넘어갈 때만 하루 당긴다.
당긴 요일에 자리가 없으면 **그 블록 4주를 통째로** 다른 요일로 옮기고, 옮긴
요일이 다음 블록의 기준이 된다. 주 단위로 흩뜨리지 않는다.

- 추천(분석 탭): `analysis.js:_pickBlockDow` — 기준 요일이 블록 전체를 덮으면
  옮기지 않는다. 못 덮으면 덮는 주가 많은 요일 > 여유가 큰 요일.
  여유 = 재적 − 그날 필요 인원이라 토(4/3/2)·일이 자연히 뽑힌다
  ('주말에 많이, 주중에 적게'에 별도 설정이 필요 없는 이유).
- 엔진: `juhu_block_lock`(기본 True). **`allow_juhu_relax`(주휴 무시)로 재배치할
  때만** 걸린다 — strict 로 풀리면 사전입력 주휴는 손대지 않는다(제1원칙 8).
  `_c_juhu_block_dow`(HiGHS) / `_cs_juhu_block_dow`(CP-SAT) 패리티.
  UI 토글 '주휴 이동 제한 풀기' = `juhu_block_lock=False`.
- 블록 번호 기준 `_CYCLE_REF = 2026-03-01` 은 프론트 `view-helpers.js` 와
  **같아야 한다** — 어긋나면 화면의 '3주기'와 엔진의 블록이 다른 걸 가리킨다.

---

## 요일별 필요 인원 (기본값)

| 요일 | D | E | N |
|------|---|---|---|
| 월 | 4 | 5 | 3 |
| 화 | 5 | 5 | 3 |
| 수 | 5 | 5 | 3 |
| 목 | 5 | 5 | 3 |
| 금 | 5 | 4 | 3 |
| 토 | 4 | 3 | 2 |
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
| GET | `/api/nurses/template.xlsx` | 명부 엑셀 템플릿 (드롭다운·안내 시트, 기본) — `/template`은 CSV 호환용 |
| GET | `/api/nurses/export.xlsx` | 현재 간호사 엑셀 내보내기 (기본) — `/export`는 CSV 호환용 |
| POST | `/api/nurses/import` | 명부 일괄 등록/업데이트 — xlsx(매직 바이트 자동 감지)·CSV 모두 허용 |
| GET/POST | `/api/rules` | 규칙 |
| GET/POST | `/api/requirements` | 요일별 필요 인원 |
| GET/POST/DELETE | `/api/shifts[/code]` | 근무 정의 |
| GET/POST/DELETE | `/api/scoring_rules[/id]` | 배점 규칙 |
| POST | `/api/parse-table-file` | 표 파일(xlsx/xlsm/csv/tsv, base64) → 시트별 2D 그리드 — 붙여넣기 모달 '파일에서 읽기' |

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
   - 명부의 **야간전담 뱃지**: `3월 야간전담`·`3,5월 야간전담`처럼 **지정된 달**을 보여준다
     (당월 포함이면 진한 강조, 다른 달만이면 옅게). 클릭 = 보고 있는 달 토글.
     구현 `nurse-manage.js:nightMonthsBadge`, 검증 `node scripts/test_night_badge.mjs`
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
   - **📥 근무표 업로드**: 이미 완성된 번표를 엑셀 파일(xlsx/csv) 업로드 또는 붙여넣기로
     저장 목록에 바로 추가 (솔버 안 돌림, 표 역산 일별 인원을 함께 저장)
   - **멀티시트 일괄 업로드**: 연간 번표처럼 시트가 여러 개면 시트 이름·내용·파일명에서
     각 시트의 년월을 감지해 매핑 표를 띄우고, 확인 후 월별 저장본을 한 번에 생성

> 엑셀 붙여넣기/파일 읽기의 날짜 해석은 **멀티월**: 날짜에 월이 있으면(5/26 등) 그대로,
> 일자만 있으면 감소 지점을 월 경계로 해석해 당월 밖 날짜에도 모두 적용된다
> (`paste-import.js:_resolveHeaderDates`).

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
6. Inno Setup (ISCC) — `dist/installer/NurseScheduler_Setup_v4.10.2.exe`

### 산출물
- `NurseScheduler_Setup_v4.10.2.exe` (~190MB) — 설치마법사 (Windows)
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

## 알려진 주의사항 (v4.10.2 기준)

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
- **공휴일은 '생성 주기 범위' 기준** (v4.9.0) — 당월만이 아니라 전월 말·익월 초
  패딩 날짜의 공휴일도 인정한다. 당월 프리픽스로 자르면 월경계 주에 걸린 신정·
  설날·삼일절을 못 봐서 그 날에 OF/V/생이 배정되고 오프특근 판정도 어긋난다.
  프론트 `autoFillHolidays`도 주기 범위를 채운다 — 한쪽만 고치면 다시 어긋난다
- 간호사 삭제는 API 경유 — 저장본 캐스케이드 정리 자동 실행

---

## 커밋/릴리즈 정책

- 브랜치: `main` (릴리즈)
- 태그: `v4.0.X` 형식
- 릴리즈 자산: 설치파일 + 포터블 ZIP 모두 GitHub Releases에 업로드
- 버전 올릴 시 동기화 파일: `electron/package.json`, `electron/preload.js`, `installer/setup.iss`, `frontend/index.html` (버전 표시 라인 2곳), `README.md` 다운로드 섹션, `CLAUDE.md` 최신 라인, `CHANGELOG.md` (미출시 → 버전 확정), **`RELEASE_NOTES.md`** (릴리스 본문 — CI가 `body_path`로 사용)
- 태그 push(vX.Y.Z) → `.github/workflows/release.yml`이 Windows·macOS 산출물을 빌드해 릴리스에 자동 업로드 (본문은 RELEASE_NOTES.md)
- 원격(Claude) 세션은 git 프록시가 태그 push를 막음(403) → `tag.yml` workflow_dispatch로 태그 생성 후, `release.yml`을 같은 태그로 workflow_dispatch (GITHUB_TOKEN 태그는 push 트리거를 발동시키지 않음)

---

## 참고 문서

- [`docs/milestones.md`](docs/milestones.md) — 기능 로드맵 + 남은 작업 (세션 간 이어서 작업)
- [`docs/decisions.md`](docs/decisions.md) — 아키텍처 결정 + 네거티브 지식 (컴팩팅 내성)
- [`docs/session_notes/`](docs/session_notes/) — 세션별 작업 일지
- [`MANUAL.md`](MANUAL.md) — 사용자 매뉴얼
- [`BUILD.md`](BUILD.md) — 빌드 가이드
- [`README.md`](README.md) — 리포 소개
