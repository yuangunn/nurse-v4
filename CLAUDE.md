# NurseScheduler v4 — 프로젝트 문서

## 개요
간호사 3교대 근무표 자동 생성 **Windows·macOS 데스크톱 앱**.
수리최적화 듀얼 엔진(HiGHS MILP · OR-Tools CP-SAT)으로 최적 근무표 자동 생성.
Electron 네이티브 창으로 실행, 인트라넷(인터넷 없음) 환경 완전 지원.

**최신**: v4.13.1 (2026-09-06, M8 리디자인 + 생성 성공·확정 시 자동 저장)
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
9. **차지(DC/EC/NC)는 시니어리티가 높은 사람이 맡는다 — 차지 횟수를 공정성 항목에 넣지 않는다.**
   차지의 부담은 **어싸인에서 환자를 적게 보는 것**으로 이미 보상·균형이 맞춰져 있다
   (2026-08-20). 차지 횟수 균등 배점을 제안하지 말 것. 지켜야 할 사전입력의 보호 채널은
   **잠금(🔒)** 하나다 — 셀 메모는 기록용이지 보호 등급이 아니다.

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
| 프론트엔드 | HTML + Tailwind CSS + Alpine.js (CDN → `frontend/lib/*.js` 번들) + 리디자인 토큰/컴포넌트 CSS (`design/handoff` 계약, v4.13) |
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
│   ├── index.html           # SPA (⚙ 설정 + 사전입력·분석·근무표 3단계, 저장은 근무표 서랍 + 모바일 '오늘' 홈)
│   ├── css/                 # tokens·base·components·yginvest-skin → redesign-tokens·redesign-components(핸드오프 원본)·redesign-bridge(접착, 마지막)
│   ├── js/
│   │   ├── app.js           # Alpine.js 코어 (~530줄: 상태·computed·init·API·모듈 합성)
│   │   └── modules/         # 15개 도메인 모듈 (analysis·solver·profiles·nurse-manage·redesign·
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
├── tests/                   # pytest 회귀 167건 (제약·진단·CP-SAT 동등성·충돌·완화·모성보호·위시·공휴일·오프특근·사실클램프·쉴코드수급·주휴블록)
│   └── fixtures/            # kr_holidays_golden.json (KASI 2025~2050 공휴일 골든셋)
├── dist/                    # 빌드 산출물 (gitignore)
├── docs/
│   ├── decisions.md         # 아키텍처 결정 + 네거티브 지식 (세션 간 공유)
│   └── session_notes/       # 세션별 작업 일지
├── design/handoff/          # 클로드 디자인 핸드오프 (계약): README·copy.json(문구)·check/spec.json+check_redesign.mjs(검사기)·reference/*.png·design/*.dc.html
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
python3 -m pytest -q                  # 167건
node scripts/test_assign_core.mjs && node scripts/test_paste_dates.mjs \
  && node scripts/test_preinput_lint.mjs && node scripts/test_night_badge.mjs \
  && node scripts/test_juhu_rotation.mjs && node scripts/verify_holidays.mjs
# 화면(index.html)을 재배치했다면 — 핸들러 손실 0 확인 (REMOVED 는 전부 의도한 것이어야 한다)
python3 scripts/handler_inventory.py <(git show origin/main:frontend/index.html) frontend/index.html
# 리디자인 계약 검사 (design/handoff) — 1920×1080 으로 실제 앱을 열어 200+ 항목 getComputedStyle 검사, 불일치 0 이어야 한다
# (서버가 떠 있어야 한다. check 디렉터리에 playwright 가 resolve 돼야 하고, PW_CHROMIUM 으로 크로미움 경로를 줄 수 있다)
node design/handoff/check/check_redesign.mjs --url http://127.0.0.1:5757 --shots out/rd
```

> `httpx` 는 앱이 쓰지 않지만 `starlette.testclient` 가 요구한다 — 없으면
> `test_nurse_xlsx.py`·`test_parse_table_file.py` 11건이 **수집 자체가 안 된다**
> (통과가 아니라 조용히 안 도는 상태). 런타임 번들이 커지므로 requirements.txt 가 아니라
> requirements-dev.txt 에 둔다.

### 설치된 배포판
- `NurseScheduler_Setup_v4.13.1.exe` 실행 → 설치 마법사 → 바로 실행
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
- 야간 공정 배분 (range 최소화, -가중치, 직전 3개월 누적 오프셋)
- **주말·공휴일 근무 공정 배분** (토·일 ∪ 공휴일 근무일 range 최소화 + 직전 3개월 누적 오프셋, 기본 -30; 야간전담·당월 전입/전출 제외, 임산부 포함) — 결정 1-21
- 희망 근무 반영 (+50)
- V 사용 페널티 (-500) — 마지막 수단
- 생 사용 (여성) 보상 (+80)
- 법정공휴일 휴가 보상 (+30)
- 공휴일 근무 보상 (+20)
- **사전입력 유지 보너스**(완화 시 뒤집히는 순서의 역순): 휴가 `preBonusLeave=5000` > 쉬는 날(OF·P1) `preBonusOff=3000` > 근무 `preBonusWork=500` > 주휴 `preBonusRest=300`(주휴 무시 시에만). 절대 못 건드리는 셀은 🔒 잠금(`locked_cells`)

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
| GET | `/api/relax_ledger` | 완화 이력 원장 — 직전 N개월 저장본의 간호사별 뒤집힌 원티드 수 (결정 1-20) |
| GET | `/api/fairness_ledger` · `/api/prev_month_nights` | 공정성 원장(야간·주말·공휴일·주말∪공휴일 `weekend_holiday`·위시 — night/weekend_fairness 오프셋 원천) · 전월 야간 자동 인수인계(나이트킵 달 제외) |

### 개발자 API
| Method | Path | 설명 |
|---|---|---|
| GET | `/api/dev/info` | 현재 DB 경로·크기·간호사 수 |
| POST | `/api/dev/reset-seed` | 예시 18명 재생성 |
| GET | `/api/dev/download-db` | 현재 DB 파일 다운로드 |

---

## 프론트엔드 화면 구성 (⚙ 설정 + 3단계) — v4.12.0 M7 · v4.13.0 M8 리디자인

### v4.13.0 리디자인 계약 (design/handoff) — 결정 1-24
- **계약 3종**: `design/handoff/copy.json`(모든 라벨·툴팁·용어 — 그대로 쓴다) · `check/spec.json`(화면·상태별 computed-style 단언 + 전역 규칙:
  최소 글자 14px, 22px 미만 굵기 ≤700, 회색 글자(#8A93A1·#B8BFC9·#D4D9E0) 금지, 클릭 대상 ≥40px, 아이콘만 버튼 금지, 모든 버튼 title,
  화면당 `.rbtn-primary` 정확히 1개, 영어 라벨 금지) · `reference/*.png`(1920×1080 원본). 검사기 `check_redesign.mjs` 실행법은 [테스트](#테스트) 참조.
- **CSS 순서**: 기존 4장 → `redesign-tokens.css` → `redesign-components.css`(둘 다 핸드오프 원본, 손대지 않는다) → `redesign-bridge.css`(접착·재매핑·특이성 보정, 우리 것).
  근무 코드 색은 `[data-shift="D"]` 속성으로 칠한다(인라인 getShiftStyle 대신). 셀은 `data-cell="nid|iso"` 로 점프·팝업 위치에 쓴다.
- **JS**: `modules/redesign.js`(`RedesignModule`) 가 문구·배치·상태 문장(`rdStep`·`rdSignal`·`rdStatus`·`rdFail`·서랍 탭·요약 행)·되돌리기 토스트·
  툴팁 엔진·2단 확인·± 버튼·셀 팝업 위치(뷰포트 좌표, `position:fixed`)·인쇄 미리보기·폰 내 근무·서체 선택·검증 훅 `window.__rdState(screen,state)` 를 맡는다.
  기존 핸들러 표현식은 그대로 두고(핸들러 인벤토리 REMOVED 10건은 전부 의도된 이름 바꿈 — 세션노트 2026-09-06) 문구와 배치만 바꿨다.
- **화면**: 헤더(앱 이름·병동·인원·버전 / 년월 컨트롤 / 다크·도움말·프로필) + 단계 바(설정 ✓ · ① 사전입력 · ② 분석 · ③ 근무표, 현재 단계만 검정, 부제는 상태 문장).
  사전입력: 신호등 문장 + 툴바(가져오기 ▾ · 자동 채움 ▾ · 이대로 근무표로 · 되돌리기/다시 · 저장 · 더보기 ▾) + 표. 근무표: 만들기(검정) · 완화 · V 무제한 · 고급 ▾ /
  인쇄 · 내보내기 ▾ · 요약·리포트 · 불러오기 ▾ · 저장 · 더보기 ▾ + 상태 줄 · 실패 배너(원인 + 고칠 수 있는 셋 + 완화 켜고 다시) + 표 + 서랍. 설정: 왼쪽 메뉴(`settingsSection`).
  폰(≤767px): 헤더·단계 바·툴바 숨김(`rdesk-only`), 오늘(내 근무 카드 = 이름 고르기 주 버튼) · 근무표(월 이동 + 전체/내 근무만/그룹 칩) · 사전입력 · 더보기 시트, 하단 내비 78px.
- **금지**: 검사기를 통과시키려고 화면을 속이지 않는다 — 검사기 버그는 검사기를 고치고(축약 속성 색 변환·outline 순서), 정적 HTML 가정(`nth-child`)은 같은 셀을 가리키는
  `nth-of-type`/`first-of-type` 으로 spec 을 고치며, 자기모순(13px 라벨·어두운 바탕의 #D4D9E0)은 규칙 쪽을 따른다. 전부 `$comment`/CSS 주석으로 남긴다.


**원칙 (결정 1-22)**: 근무표가 주인공. 매달 밟는 단계만 번호를 주고(사전입력 → 분석 → 근무표),
첫 1회만 만지는 설정은 ⚙ 아이콘, 진단·리포트는 표 아래 서랍, 개발자 언어의 옵션은 ⚙ 고급.
**년월은 헤더 컨트롤 하나**로 모든 탭 공통. 첫 화면은 명부가 있으면 사전입력, 없으면 설정, 폰은 오늘.
화면을 옮길 때는 `scripts/handler_inventory.py` 로 재배치 전후 핸들러 집합을 비교해 기능 손실 0을 확인한다.

0. **⚙ 설정** (헤더 왼쪽 톱니 스텝): 간호사 명부 + 요일별 인원 + 규칙 + 배점 규칙 + 개발자 설정
   - 명부 파일 5개 버튼(템플릿 저장/불러오기·엑셀 템플릿·내보내기·가져오기)은 **📗 명부 파일** 메뉴
   - 근무 정의 17종은 **고급(접힘)** — 병동 표준이라 보통 손댈 일이 없다. 역순 전환 금지 3종은 문장 한 줄(끌 수 없음)
   - 명부의 **야간전담 뱃지**: `3월 야간전담`·`3,5월 야간전담`처럼 **지정된 달**을 보여준다
     (당월 포함이면 진한 강조, 다른 달만이면 옅게). 클릭 = 보고 있는 달 토글.
     구현 `nurse-manage.js:nightMonthsBadge`, 검증 `node scripts/test_night_badge.mjs`
1. **사전입력**: 근무표 선입력 (또는 **이미 완성된 근무표 입력**). 툴바는 한 줄 —
   **📥 가져오기**(엑셀 붙여넣기·위시 붙여넣기·전달이월) · **⚡ 자동 채움**(공휴일·전월N·이 표대로 인원) ·
   ✅ 이대로 근무표로 · ↩↪ · 메모 · 저장/불러오기 · **⋯**(단축키·다른달 정리·초기화)
   - 💾 패널: 서버 저장/불러오기/삭제 (잠금·메모 포함)
   - 셀 우클릭 → **메모 + 🔒 완화 시 고정** 토글
   - 셀 드래그 → 다중 선택 + 근무 일괄 지정
   - Ctrl+Z/Shift+Ctrl+Z undo/redo (40단계)
   - 키보드: D/E/N/V/O/W 직접 입력, ←↑↓→ 이동, Delete 삭제 (전체 목록은 ⌨ 전체 단축키)
   - tfoot: 일별 D/E/N 배정 수 + 필요 수 (편집 가능)
   - **✅ 이대로 근무표로** (`usePrevAsSchedule`): 사람이 손으로 짠 근무표를 붙여넣었을 때
     솔버를 돌리지 않고 사전입력을 그대로 근무표로 확정. 점수·완화 정보는 비어 있음
     (📌 이 표대로 인원 → ✅ 이대로 근무표로 순으로 쓰면 인원 기준까지 그 표에 맞춰진다)
   - 폰(<768px)에서는 편집 도구가 **⋯ 도구**로 접혀 있고 표가 먼저 보인다 (보기 전용 우선)
2. **분석**: 일자별 과부족 히트맵 + 주휴 추천 배분 → "사전입력에 적용" (자동 실행)
3. **근무표** (옛 '스케줄/생성' 탭): 기본 행은 **근무표 만들기 · 사전입력 완화 · 연차(V) 무제한 · 고급 ▾**뿐 (v4.13 문구).
   - **⚙ 고급**(접힘): 오차(MIP gap)·시간·솔버(HiGHS/CP-SAT/레이스 — 셋 다 완화 지원)·주휴 무시·
     주휴 이동 제한 풀기·완화 설정 슬라이더 4개·배점 조절 슬라이더 5개
   - 표가 상태 메시지 바로 아래. 표 아래 **📊 요약**(간호사별 월간 요약 — 옛 ⚖ 공정성 카드를 흡수:
     주말∪공휴일 열, 야간·주말·공휴일의 누적(3M)+당월 합과 편차 색, ※ = 공정성 대상 아님,
     "이번 생성에 누적 반영" = 원장 주입됨) → **📋 리포트 서랍**(원티드 미반영·**🧾 연차(V) 설명**·오프특근·
     주의·위시 반영·생성 리포트·솔버 로그; 사연 항목이 있으면 생성 직후 자동으로 열림)
   - **🧾 연차(V) 설명** (`_v_report`, 결과 `v_report`): 솔버가 놓은 V를 주 단위로 "재적 칸 − 근무 = 쉬어야 할 칸,
     주휴·OF·확정 휴가·생으로 채우고 남은 칸이 V" 산술로 설명 + 힌트(주휴 없는 사람·남는 날 원티드·필요 인원).
     사전입력 V는 세지 않는다. 주 안에서 주휴 요일을 옮기는 것은 주간 총량을 못 바꾼다 (결정 1-23)
   - **📂 불러오기 서랍** (옛 저장 탭): 저장된 근무표 목록·삭제·새로고침 + **📥 근무표 업로드**
     (완성 번표를 xlsx/csv 업로드 또는 붙여넣기로 저장 목록에 추가, 솔버 안 돌림, 표 역산 일별 인원 함께 저장;
     연간 번표처럼 시트가 여러 개면 년월을 감지해 매핑 표 → 월별 저장본 일괄 생성).
     코드 어디서든 `activeTab='saved'` 를 넣으면 별칭 워처가 이 서랍을 연다.
   - **📤 내보내기** 메뉴: CSV · 인쇄 · **📋 어싸인용 복사**(`copyScheduleTsv`: 이름 + 날짜 + 근무 표를
     클립보드로 → 어싸인 배정표(standalone)에 그대로 붙여넣는다)
   - 주의(⚡) 목록은 **규칙 한도를 넘긴 것만** (연속 근무·월 야간, 나이트킵 제외) — 주말 근무 횟수 같은
     통계는 요약 표 열로 옮겼다 (정상 표에서도 병동 절반에게 매달 뜨던 노이즈)

> 엑셀 붙여넣기/파일 읽기의 날짜 해석은 **멀티월**: 날짜에 월이 있으면(5/26 등) 그대로,
> 일자만 있으면 감소 지점을 월 경계로 해석해 당월 밖 날짜에도 모두 적용된다
> (`paste-import.js:_resolveHeaderDates`).

> 어싸인(병실 배정)은 **본 앱에서 뺐다** — 병동에서 실제로 쓰는 건 `standalone/assign.html`
> 하나뿐이고(본 앱엔 배정표 출력이 없었다) 같은 로직을 두 곳에서 관리할 이유가 없다.
> 근무표는 근무표 탭 [📤 내보내기 → 📋 어싸인용 복사] → standalone 붙여넣기로 넘긴다.
> 공유 코어 `frontend/js/modules/assign-core.js` 는 standalone 빌드가 쓰므로 **남겨 둔다**
> (본 앱 HTML 에서는 더 이상 로드하지 않음).

> 년월은 헤더 컨트롤 하나로 모든 탭 공통. 주기 경계(7일 단위) 컬러 헤더.
> 토요일 이후 컬럼 구분선.

---

## 어싸인 (병실 배정) — 별도 도구

병동 근무표가 나온 뒤 **누가 어느 방을 보는지** 정하는 도구. 본 앱과 분리돼 있다.

- 코어: `frontend/js/modules/assign-core.js` (순수 함수, `opts.seed`=전월 이월,
  `opts.roomsFor`=방 기준 연속성. 검증 `node scripts/test_assign_core.mjs`)
- 원칙: 차지=DC/EC/NC 우선(항상) · ①전일 같은 근무 방 유지 ②근무 변경 시 유지
  ③오프 복귀 유지 ④오프 복귀 튕기기(③과 상호배제). 우선순위 ①>②>③.
  **연속성은 알파벳(A/B/C)이 아니라 실제 병실 겹침 기준** — 인원이 5→4로 바뀌어도
  6~9호 보던 사람이 6~10호를 이어받는다. 겹침은 **병상수 합**(같이 보던 환자 수, `opts.bedsOf` —
  standalone 이 병실 목록의 병상수를 넘긴다; 없으면 방 개수)으로 잰다. **등급(원칙 1>2>3)은 자리뿐
  아니라 방 선택에서도 사전식으로 앞선다** (2026-09-16): 예전엔 겹침 총합만 최대화해 오프 복귀자·
  근무 변경자가 전일 근무자를 겹침 적은 방으로 밀어냈다(5~10 보던 사람이 6~9 대신 5,10,11).
  가중치 `SEAT_W`/`OV_W` 는 2^53 안에 들도록 잡았다 — 회귀 `test_assign_core.mjs` 에 재현 시나리오 있음.
- 인트라넷용 ①: `standalone/assign.html` — 단일 파일 통합본(외부 의존 0, Chrome/Edge 103+).
  엑셀식 편집 그리드(붙여넣기·근무만 붙여넣기·모르는 근무 매핑·범위선택·파일 DnD·CP949 폴백),
  옆 폴더 `assign-data.js/json` 자동 열림(여러 개면 선택), 전월 어싸인 자동 이월,
  주간 배정표 xlsx 내보내기(순수 JS zip 패치) + HTML 인쇄, 다크 모드, 도움말(그림 없이 **실제 화면 투어**).
  **되돌리기는 화면 공용** (`undoAny`) — 배정표 화면의 근무 바꾸기·어싸인 교체·교육 입력·
  붙여넣기 확정도 `Ctrl+Z` 또는 **파란 알림 클릭**으로 되돌아간다. 파괴적 동작에는 반드시
  `snapshot()` 을 먼저 찍을 것(찍지 않으면 영구 손실). **기준 해상도는 1920×1080**(사용자
  지정, 2026-09-16) — 검증 스크린샷·레이아웃 판단은 이 크기로 한다. 툴바 버튼을 늘릴 땐
  1920 폭에서 한 줄인지 확인(좁은 화면에선 두 줄로 접혀 N 구역이 잘린다).
  **화면 날짜는 전부 두 자리** (`fmtMD` = `mm/dd`) — 양식 xlsx 의 날짜 서식이
  `mm"월" dd"일"` 이라 거기에 맞춘 것. 새 날짜 표시를 넣을 때도 `fmtMD` 를 쓸 것.
  단 '9일 D' 처럼 일(日) 하나만 쓰는 문구는 그대로 둔다(‘09일’은 한국어로 어색).
  **병동 양식 교체**: 관리 > 배정표 양식에서 xlsx 를 올려 구조를 검사하고 채택.
  구조가 다르면 자리표시자(`{{이름}} {{방}} {{차지:/CRN}} {{날짜}} {{요일}} {{중간번}} {{교육}}`)를
  자동으로 꽂아 받은 뒤 엑셀에서 위치만 손보면 된다.
  **병동·병실 규칙** (2026-09-16): 병동 번호 = 층 + 라인(61 = 6층 1라인, 102 = 10층 2라인), 병실 =
  층×100 + 호수 — **1라인 1~14호, 2라인 51~64호**(92병동 → 951~964). 관리 > 병실 목록에서 병동을
  고르면 `setWard()`가 병실 14개를 채우고 병상수·방 구성·주지 않을 방을 **같은 자리**(`roomPos`, 1라인
  3호 ↔ 2라인 53호)로 옮긴다. 화면·인쇄·xlsx 표기는 `roomsBase()`(층×100) 기준 축약으로 통일
  (901→1, 951→51) — `abbrevRooms/roomShort/roomFull` 을 거치지 않는 방 표시를 새로 만들지 말 것.
  **보관 방식은 데이터 파일 하나뿐** (사용자 결정 2026-09-17, 결정 2-23): 각 병동은 컴퓨터 한 대에서 `assign-data.js` 하나를 쓴다.
  공유 폴더·다중 PC 동기화는 요구사항이 아니고, 파일 기능은 **백업 내려받기·백업 불러오기(되살리기)** 뿐이다. '이 컴퓨터 안(브라우저 저장소)'
  보관 방식은 **뺐다** — 남은 코드는 옛 잔재 처리(`readOldLocalStore`/`migrateOldLocalData`: [처음 시작]으로 파일을 만들 때 옮겨 넣을지 묻고 지움)뿐.
  **안내문 원칙 (사용자 지적 2026-09-17)**: 설계 전제("각 병동은 컴퓨터 한 대에 파일 하나" 같은 문장)를 화면 문구에 그대로 쓰지 않는다 —
  간호사가 할 일만 쓴다: 처음 한 번 파일 만들기(이름·위치) → 다음부터 켜면 바로 뜸 → 고칠 때 [허용] 한 번 → 가끔 백업, 문제 생기면 백업 불러오기.
  공유·공용 폴더·NAS·다른 PC·여러 병동·exe·브라우저 안·전제 문장은 화면에 쓰지 않는다(스크래치 `test-onepc.mjs` 가 잔존 0 을 검사).
  시작 화면은 [처음 시작]이 주 버튼, [데이터 파일 열기]는 **파일 하나 고르기**(폴더 고르기 안 씀; `openFromDir` 는 옛 `dir` 핸들 이어서 시작용).
  부팅 순서 native → silentReattach → sidecar. **백업 불러오기 `restoreBackup(file?)`** = 고른(또는 드롭한) 파일의 내용으로 지금 데이터를 바꾸되
  연결된 파일은 그대로(갈아타지 않는다) — `rev=max(지금,백업)` 으로 자동 저장이 '밖에서 바뀜'으로 오해하지 않게 한다. 드롭(.js/.json)은
  연결돼 있으면 되살리기, 아니면 그 파일을 연다. rev 충돌 감지는 안전망으로 남기되 문구는 '파일이 밖에서 바뀜'·'다른 창에서 먼저 저장'.
  **재연결**: 닫았다 켜면 쓰기 권한은 잊지만 핸들은 남으므로 `reattachHandle`
  이 사용자 동작 안에서 `requestPermission`만 받아(파일 창 없음) rev 비교 후 잇는다 — [저장 연결]과 첫
  편집(`touch`)에서 시도. 읽기 전용 중 고친 내용은 파일이 안 바뀌었을 때만 살린다.
  **시니어리티 = 관리 > 간호사 관리의 순서**(위가 선임 — 줄 드래그·▲▼, `moveNurse`). 코어 `seniority`
  가 이 순서라 같은 날 차지 가능자 중 최상단이 차지를 맡는다. 붙여넣기의 '명부 순서(시니어리티)도 표
  순서로'는 그래서 **기본 꺼짐**. **신규 간호사**: 근무표 `/D·/E·/N`(인원·어싸인 제외) + 배정표에서
  간호사 이름 클릭 → '신규 간호사 붙이기'(계속 = `store.trainee[T].pre`, 오늘만 = `store.trOv[iso][T]`)
  → 이름 아래 `/ 이름`으로 화면·인쇄·xlsx(줄바꿈 + `applyWrapStyles` 가 wrapText 서식을 복제해 단다).
  프리셉터가 그 시간대 근무가 아니면 '확인 필요'에 뜬다. **양식 문구 고치기**: 관리 > 배정표 양식에서
  글자 칸(채우는 구역·자리표시자 제외)을 편집해 `packXlsx` 로 다시 싸 custom form(`store.form`)으로
  저장 — 칸 구조 변경은 여전히 엑셀에서 고쳐 올린다.
  **방 구성 프리셋 (2026-09-17, 사용자 요청)**: 인원수(5·4·3·2)마다 프리셋을 여러 개 둔다 — '기본' = `store.schemes[cnt]` 그대로, 추가분은
  `store.presets[cnt]=[{id,name,rooms}]`. 어느 것을 쓰는지는 **그날 예외 `store.presetDay[iso][P][cnt]` → 요일 계획 `store.presetPlan[요일][P][cnt]` → 기본**
  순서(`presetFor(P,cnt,iso)`, `roomsFor` 가 이것을 쓴다; 손 방 수정 `roomOv` 는 여전히 최우선). **인원수별로 따로 고른다** — 5인인 날은 5인 프리셋만 보인다
  (사용자: "5인일 때 프리셋 설정을 누르면 5인에 해당하는 프리셋만 고르면 되잖아"). 관리 > 방 구성 = 인원수 탭 → 프리셋 칩(＋ 새 프리셋은 보고 있던 것을 복제·
  이름 바꾸기·삭제) → 자리별 입력 + **주간 계획표**(일~토 × D/E/N `<select>`, 칸의 인원수는 요일별 필요 인원 `store.req`; 다른 인원수 계획은 칸 아래 작은 글씨).
  배정표 방 칸 픽커에 '이 날 P 방 구성 (n인)' 줄 — [오늘만]=presetDay, [매주 ○요일]=presetPlan(그 근무의 roomOv 는 지운다, `snapshot()` 후라 Ctrl+Z 가능).
  기본이 아닌 날은 A(CN) 방 칸에 `td.rm.rpre` 띠 + 툴팁. 코어 연속성 캐시 키에 프리셋 id 를 넣었다(`roomsForCore`) — 빼면 요일별 프리셋이 첫 날 것으로 굳는다.
  `setWard` 가 프리셋 방도 같은 자리로 옮기고, `deletePreset` 은 계획·예외의 참조를 지운다. 배지 '빈 칸 n' 은 모든 프리셋의 빈 자리 수. 스크래치 `test-presets.mjs` 10케이스.
  **배정표 출력 서식 두 벌 (2026-09-18, v260918a, 결정 2-25)**: 인쇄·엑셀 내보내기에 쓰는 양식을 **101병동 서식 / 122병동 서식** 중 고른다
  (관리 > 배정표 양식 맨 위 세그먼트, `store.formId`). 두 서식 모두 문구 고치기·양식 파일 교체·기본 복원이 되고, 고친 것은 **서식마다 따로**
  `store.forms[id]` 에 남는다(옛 `store.form` 은 `migrateStore` 가 `forms['101']` 로 이관). 칸 구조가 다르다 — 101 은 요일마다 `방·이름` 두 칸,
  **122 는 요일마다 `이름·메모`** 두 칸이고 방은 **일(C)·월~금 공용(F)·토(Q)** 세 열에 `자리⏎방` 으로 한 번씩 적는다(그 날만 방이 다르면 그 날 메모 칸에).
  자리 이름도 서식을 따른다 — `FORM_LBL(l,P)`: 101 `A(CN)·B·C·D·E`, 122 `CN·A·B·C·D`(야간 `A·B·C`). 구조 인식 `findLayout`(101)/`findLayout122`,
  채우기 `fillForm122`, 인쇄 `buildPrintArea122`(A4 한 장, 글자·색은 양식 xlsx 에서 읽는다 — 하드코딩 금지). 내장 양식은 빌드 스크립트가
  `tplB64`·`tplB64_122` 두 마커에 심으므로 **`standalone/병실 배정표*.xlsx` 를 고치면 반드시 `node scripts/build-assign-standalone.mjs`**.
  **병동 번호로 서식을 자동 판별하지 않는다** — 사람이 고르고 데이터 파일에 저장된다.
  **양식 xlsx 는 빈 양식에서 뽑는다** — 데이터가 든 시트를 지워 쓰면 그 주에만 칠한 서식(행사 칸 바탕색 등)이 딸려 들어와 매주 그 색으로 찍힌다 (사용자 지적 2026-09-18).
  인쇄 HTML 도 양식에 없는 색을 하드코딩하지 않는다. 122 인쇄의 방 칸은 길면(`2,3,12,13`) 글자를 줄이고 쉼표에서 접는다 — 잘라내지 않는다.
  다른 병동 번표 표기도 읽는다: `VAC→V`, `수면8→OF`(끝 숫자 제거), `필`(필수교육)·`예`(예비군)는 내장 휴가 코드(범례에는 없다).
  붙여넣기 헤더 줄은 '조건에 맞는 첫 줄'이 아니라 **날짜 칸이 가장 많은 줄**(날짜 줄 위 주차 번호 줄을 헤더로 잡지 않게)이고,
  합계 줄(날짜 칸이 전부 숫자)·이름만 있는 빈 줄('대체')은 간호사로 넣지 않는다.
    **실사용 전수조사 반영 (2026-09-17, v260917j)**: 코드 정독 + 실제 규모(18명·두 달치·92병동) 워크스루로 찾은 24건과 사용자 추가 요청 2건을 한 번에 반영.
  ① **붙여넣기 헤더**는 첫 줄 고정이 아니라 앞 6줄에서 '날짜 칸 3개 이상·글자 칸의 절반 이상'인 첫 줄 — 그 위(제목·병동명)는 버리고, 요일 줄은 어디 있든 버리되 1일의 요일은
  연·월 추정에 쓴다(`guessYearMonth(md,{wd1,ndays})`: 요일 → 기록 다음 달 → 이번 달, `how` 가 노란 칸 문구). `hasDateHdr` 는 그 헤더 줄 하나로 판정(합계 숫자 열 4개가 든 근무 줄을
  날짜 줄로 오인하지 않게). 한두 줄 붙여넣기는 명부 일치 1개로 이름 열 인정. xlsx 시트가 여럿이면 시트 이름의 월로 제안(공용 모달).
  ② **확인 카드** `renderWeekWarnings(days,infos)` — 빈 주에도 불러 지난 주 카드가 남지 않게, 같은 종류는 사람별·내용별 한 줄, 6줄 초과는 접기(`wkWarnOpen`). 새 항목: 차지 가능자 없이 차지
  (표기 없이 자동 선정된 경우만), 인원 ≠ 요일별 필요 인원, 아무도 안 보는 방·두 자리가 겹치는 방(날짜·시간대 묶음), 근무표 없는 날(월말 경계 주 + [새 근무표 넣기]), 신규 미배정 줄의 날짜별
  [붙일 사람…]·[계속 붙일 사람] select.
  ③ **픽커**: `placePopup(el,x,y)` 가 화면 안으로 클램프, 근무 바꾸기 목록은 전체 코드 + `store.custom`, 맞바꿈은 `store.ovrPair` 에 기록해 [자동으로 되돌리기] 때 상대 고정도 함께 해제,
  [이 날 ○ 교체 모두 풀기](`pickClearDay`), 배정표 화면 ←→ 키로 주 이동.
  ④ **공용 모달** `askModal({title,sub,groups,current,text:{label,placeholder,initial,multiline,only}})` → Promise(값|null) — 고치기 화면 더블클릭·우클릭·Space·F2 = 근무 고르기 모달
  (`openShiftModal`: 근무/휴무/트레이닝/우리 병동 표기 + [✏ 직접 입력] — 모르는 표기는 그 자리에서 휴무/휴가 등록, 선택 범위 전체 적용), 교육·행사 여러 줄, 시트 고르기. 모달이 열린 동안
  그리드 단축키는 멈춘다(`_modal`). 고치기 화면은 `edRows`(화면 줄 → 명부 index, 전출자는 그 달 근무 없으면 제외 — `store.order[r]` 직접 쓰지 말 것), `edToday`(오늘 열 강조 + 처음 선택),
  `edMisList`(칩 클릭으로 다음 안 맞는 날).
  ⑤ **관리**: 병실 목록은 병동을 고르면 **늘 14개**를 만든다 — 병동마다 없는 방이 있지만 **특정 호실(13호)을 프로그램이 특별 취급하지 않는다**(사용자 2026-09-18, 결정 2-24 개정).
  없는 방은 ✕(`delRoom` → `detachRoom` 이 방 구성·주지 않을 방에서도 뺀다), 더 있으면 ＋(`addRoom` → 번호 자리에 끼우고 `attachRoom` 이 이웃 자리에 붙인다),
  호실 번호 수정(`setRoom`)은 방 구성·주지 않을 방의 그 호실도 함께 바꾸고, 순서는 줄 끌기·▲▼(`moveRoom`, 공용 `rowDragStart/rowDragOver/rowDrop` — 간호사 명부와 같은 코드).
  표는 **전체 호실**(1001호)로 고치고 '배정표 표기'(1호)를 따로 보여주며, 표 위에 우리 병동 호실 전체가 한 줄로 나온다. `migrateStore` 는 병실 목록에 있는데 어느 프리셋도 모르는 방을 이웃 자리에 붙인다.
  되돌리기(`snapshot`)에 `rooms`·`schemes`·`presets` 가 들어가므로 순서·추가·삭제·번호 수정이 모두 Ctrl+Z 로 돌아온다. 방 구성 `presetAudit/presetAuditHtml`
  (빠진 방·겹친 방) + 배지 '확인 n' + 온보딩 `schemeOk`. 전출 `store.hidden`(간호사 관리 [전출]/[복귀] — 근무표 기록 유지, 목록·차지 카운트·고치기 줄에서 제외, 새 근무표에 근무가 들어오면 자동 복귀).
  토 기본 인원 4/3/2(본 앱과 동일). 헤더 병동 칩 `renderWardChip`. 수동 수정 관리 `ovrAudit/pruneOvr`(근무가 바뀌어 효력 없는 교체).
  ⑥ **안전망**: `keepHistory(label)` 가 큰 변경(새 근무표 넣기·백업 불러오기·간호사 삭제·기본 프리셋 복원·병동 바꾸기) 직전 상태를 `store.history`(최근 3개, form 제외)에 남기고 데이터 보관에서
  `restoreHistory` — 창을 닫아 Ctrl+Z 가 사라진 뒤의 안전망. 칸 구조가 다른 우리 양식은 `customFormDiffers()`(내장 양식 `loadBaseTemplate` 과 `formVerdict` 비교)로 인쇄 전 확인창 + 양식 패널 안내.
  인쇄 방 칸은 쉼표 뒤 공백 제거 + nowrap. 스크래치 `test-audit.mjs` 38케이스, 기존 회귀는 13호 기본·인원 카드·인쇄 쉼표·스냅샷 버튼·검사 배지에 맞춰 기대값 갱신.
  **UX 3차 (2026-09-16, 1920 워크스루 제안 9건)**: 본문 폭 1480(`.screen`) · 클릭 대상 ≥32px(`.segbtn`·칩·픽커
  버튼 `min-height`) · 보조 글자 ≥12px. 주간 표는 **방 칸이 이름 칸보다 넓다**(`colgroup` 6.8/5.8% — 방 목록이
  이름보다 길다; 1920 에서 `51, 52, 62, 64` 가 잘리지 않는다) + 방 칸 `title` 에 전체 목록. **확인 필요 카드**는
  `{lv:'err'|'warn'}` 항목 — 규칙 위반(err, 빨강 '확인 필요')과 안내(warn, 노랑 '안내')를 나누고 신규 미배정은
  사람별 한 줄(`trMiss`). **2인 근무 기본 방 구성**(`DEFAULT_SCHEMES[2]`, 차지 1·2·12·14 / A 3~11) — 빈 구성은
  `migrateStore` 가 병동 자리로 채우고 관리 메뉴에 '빈 칸 n' 배지(`adminBadge('schemes')`). **간호사 관리**에
  ＋추가·✎이름 수정·✕삭제 — 이름 바꾸기는 `applyNurseName` 이 근무표·가능 근무·주지 않을 방·수동 수정·신규
  연결(`migTr`)까지 옮긴다. 붙여넣기는 **덮어쓰는 칸 수**를 타일로 보이고 저장 전 확인창(`pending.overwrite`).
  양식 문구 편집기는 구조 인식 칸(요일·날짜·구역·어싸인 라벨 = `findLayout` 이 쓰는 칸)을 🔒 readonly 로 잠그고
  제목 / 표 안 라벨(접힘) / 하단 블록(A열 글자에서 나눔)으로 묶는다. 사이드카 목록에 병동 번호, 인쇄 이름 칸은
  신규 줄이 있어도 행 높이 유지(`.pnm.two`·`.ptr`).
  **상단 파일 칩** (2026-09-16, 사용자 요청 "항상 현재 연결된 저장파일 경로+파일명"): `#fileInfo` 는 `fileLoc`
  ({kind:native|sidecar|file|local|ro|none, name, dir}) 하나를 `renderFileInfo()` 가 그린다 — 다른 곳에서 textContent 를
  직접 쓰지 말고 `setFileLoc()`. 경로를 아는 경우는 exe(`nativeInfo.path`)와 자동 열림 파일(`htmlDirPath()` = HTML 주소의
  폴더: file:///D:/x/ → `D:\x\`, file://srv/share/ → `\\srv\share\`, http 는 origin+경로). **파일 핸들은 브라우저가
  폴더를 알려주지 않는다** — `locateHandle(h)` 가 핸들 파일의 rev·saved 를 HTML 옆 같은 이름 파일(`probeSidecar`)과
  대조해 일치하면 그 폴더로 표시(`verified`), 아니면 이름만 + 툴팁에 이유. 클릭 = 경로 복사. 관리 > 데이터 보관도
  `fileLocPath()`. **저장 연결 검증은 진짜 핸들로**: OPFS(`navigator.storage.getDirectory()`) 핸들은 file:// 에서
  SecurityError 라 스크래치 폴더를 `http://127.0.0.1` 로 띄워 검사한다(스크래치 `test-save-connect.mjs`: 새 파일→자동
  저장→새로고침 0클릭 재연결→충돌 보류/덮어쓰기/내 rev 이어쓰기→파일 사라짐 보류·복구, 사이드카 읽기 전용→저장 연결→
  폴더 확인, exe 경로. 가짜 `chrome.webview` 로 네이티브 분기까지).
  **온보딩·도움말은 그림 없이 실제 화면으로** (2026-09-17, 결정: GIF 파이프라인 폐기): ① 투어 엔진 `startTour(steps)` —
  가리개(`#tourShield`) + 구멍(`#tourHole`, box-shadow 스포트라이트) + 말풍선(`#tourBox`), 단계 `{sel|el(), title, text,
  before(), after()}`, Esc/←→, 가리개가 클릭을 막아 '보여 주기'이지 '따라 하기'가 아니다(상태 안 흐트러짐). 도움말 주제별
  투어는 `TOURS[id]`(`needData` 면 근무표 있어야 열림, `cleanup` 으로 픽커·미리보기 정리·배정표 복귀), 도움말 문서의
  [▶ 화면에서 보여 주기]=`startTopicTour(id)`, 주제의 `tour:` 로 다른 투어를 빌릴 수 있다(배정표 보는 법 → `look`).
  붙여넣기 투어는 예시 표를 `ingestGrid` 로 실제로 읽어 미리보기를 보여 주고 `resetPaste()` 로 치운다(저장 안 됨).
  ② 시작 안내 체크리스트 `#onboard`(배정표 화면 위): `onboardItems()` 가 데이터 파일·병동(`store.wardPicked` — 기본값
  101 은 안 고른 것)·방 구성·차지 가능자(D/E/N 각 1명 이상)·이번 주 근무·인쇄(`assignPrinted`)를 실제 상태로 ✓/○,
  [하기]=이동·[보여 주기]=투어, 다 되면 사라지고 [숨기기]는 `assignOnboardHidden`(도움말 '시작 안내'에서 복귀).
  `show()`·`touch()`·`setFileLoc()` 이 다시 그린다. ③ 엑셀 복사 범위는 그림 대신 HTML 모형 표 `xlMock('all'|'cells')`.
  이유: GIF 는 화면이 바뀔 때마다 거짓말이 되고(이 세션에서만 헤더·간호사 관리·병실 패널이 바뀜) 0.9MB 를 먹었다 —
  투어는 지금 화면의 진짜 버튼을 가리키고 자산 0바이트. `standalone/help/`·`scripts/make-help-media.py` 는 삭제.
  **데이터 파일이 유일한 저장소, HTML 은 병동 중립** (사용자 결정 2026-09-17): 이 HTML 은 온 병동이 쓰고 입원간호팀 전체로
  넓힌다 — 병동마다 다른 것(병동·병실·병상수·방 구성·인원·원칙·양식·명부)은 **전부 그 병동의 데이터 파일**에 있고, HTML 에는
  어느 병동의 값도 넣지 않는다. 'HTML 안 기본 설정'(설정을 구운 HTML 사본 내려받기, PR #47)은 **시도 후 철회, 머지 안 함**:
  브라우저는 자기 HTML 을 못 고쳐 쓰므로 담을 때마다 3MB 사본 + 손 덮어쓰기, 업데이트로 HTML 을 갈아 끼우면 사라짐, 병동이
  여럿이면 병동 수만큼 HTML 이 갈라짐. 인트라넷이라 리포에 설정 JSON 을 두는 것도 무의미(사용자). **exe 는 인트라넷에서 못 쓰므로
  범위 밖 — HTML 만 개발한다.** 초기 설정은 시작 안내 체크리스트(병동 고르기 → 병실 자동 생성)로 데이터 파일 안에서 끝낸다. 결정 2-22.
  동기화 `node scripts/build-assign-standalone.mjs` (코어 + 양식 + 폰트 + 버전 주입)
  — CI(`test.yml`)가 재빌드해 버전 줄 외 diff가 있으면 실패시키므로 `assign.html` 수정 후 반드시 실행.
- 인트라넷용 ②: `standalone/app/` — 같은 화면을 담은 Windows 단일 exe (WebView2, 127.0.0.1 안 씀).
  파일 저장 권한 확인 없이 바로 저장. 빌드 `standalone/app/build.cmd`
  **범위 밖** (사용자 2026-09-17: 인트라넷에서 exe 를 못 쓰므로 HTML 만 개발) — 코드는 남아 있으나 손대지 않는다.
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
- 배점 규칙: 18종 (법정공휴일/주말/주말·공휴일 공평성 마이그레이션 포함)

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
6. Inno Setup (ISCC) — `dist/installer/NurseScheduler_Setup_v4.13.1.exe`

### 산출물
- `NurseScheduler_Setup_v4.13.1.exe` (~190MB) — 설치마법사 (Windows)
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
`nurses, requirements, rules, schedule, prev_schedule, nurse_scores, nurse_score_details, locked_cells, cell_notes, holidays, prev_day_reqs, prev_month_nights, relaxed_cells, solver_log`

### 자동 저장 (`_autoSaveSchedule`, v4.13.1)
생성 성공(`solver.js`)·이대로 근무표로 확정(`usePrevAsSchedule`)·새로고침 복구 시 `자동저장 YYYY-MM` 이름으로 저장한다.
**같은 달 자동저장본은 하나만** — 목록에서 같은 이름·년월을 지운 뒤 새로 넣는다. 저장되면 `rdSaved=true`(버튼 저장됨·단계 바 저장됨),
근무표 칸을 손으로 고치면 `rdSaved=false` 로 돌아와 저장 버튼이 다시 살아난다 (사용자 결정 2026-09-06).

### 사전입력 저장 (`savePrevToServer`) 포함 필드
`schedule, day_reqs, holidays, prev_month_nights, locked_cells, cell_notes`

> v4.0.5 이전엔 `locked_cells`, `cell_notes`, `holidays`, `prev_day_reqs`, `prev_month_nights`가 저장/복원에서 누락돼 잠금·메모가 유실되던 버그 있었음. v4.0.6에서 완전 복구.

### localStorage 자동 저장 (`_saveFullState`)
`year, month, tab, prevSchedule, prevDayReqs, holidays, lockedCells, cellNotes, prevMonthNights, timestamp`
— 48시간 이내 복원.

### Undo/Redo (40단계)
위 필드들 JSON stringify → stack. Ctrl+Z/Shift+Ctrl+Z.

---

## 알려진 주의사항 (v4.13.1 기준)

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
- **모듈 합성은 디스크립터** — `app()` 끝의 `Object.defineProperties(_app, getOwnPropertyDescriptors(mod()))`. `...spread` 로 되돌리면
  getter(`rd*` 계산 속성, `ruleScoreSummary`)가 값으로 굳어 화면이 안 바뀐다 (결정 2-20)
- **`data-rd` 표식은 검사기 전용** — 사전입력·근무표에 같은 이름(table·table-wrap·toolbar·btn-more)이 있어 보이는 탭에서만 붙인다
  (`:data-rd="activeTab==='schedule'?'table':null"`). 새 표식을 둘 화면에 넣을 때도 같은 방식
- **`x-for` 키는 문자열** — `:key="day"`(Date 객체)는 Alpine 경고가 행마다 찍힌다 → `:key="dayKey(day)"`
- **문구는 `design/handoff/copy.json` 그대로** — 라벨·툴팁을 의역하지 말 것. 새 버튼에도 `title` 한 문장(끝 문장은 툴팁에서 옅게 표시)
- **목록(x-for)을 품은 블록은 x-show** — x-if 는 내려가는 찰나 안쪽 x-for 가 한 번 더 돌아 콘솔 오류(결정 2-21). 부재를 단언하는 상태 줄만 x-if.
  늘 그려지므로 리포트 식은 널 안전(`vReport?.total`, `(wishReport?.per_nurse||[])`)으로 쓴다

---

## 커밋/릴리즈 정책

- 브랜치: `main` (릴리즈)
- **원격(Claude) 세션의 PR 은 CI 가 green 이면 묻지 않고 바로 머지한다** (사용자 지시 2026-09-16 — "앞으로 모두 네가
  알아서 머지해"). 드래프트면 ready 로 바꾼 뒤 merge commit 으로 머지하고, 머지 여부를 사용자에게 다시 묻지 말 것.
  머지 후 후속 작업은 같은 브랜치 이름을 최신 main 에서 다시 만들어 이어간다.
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
