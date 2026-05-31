# NurseScheduler v4

**간호사 3교대 근무표 자동 생성 데스크톱 앱**

수리최적화 솔버(HiGHS · CP-SAT 듀얼 엔진) 기반으로 최적의 근무표를 자동 생성합니다.
인터넷 연결 없이 완전한 오프라인 환경에서 동작합니다.

---

## 주요 기능

### 🎨 UI / UX (v4.2 — YGinvest 리디자인)
- **YGinvest 핀테크 디자인** — 쿨그레이 바탕 + 흰 카드 + 딥 잉크 브랜드, 큰 둥근 모서리·부드러운 그림자, **Pretendard 단일** 타입 시스템
- **적응형 헤더** (v4.2.1) — 탭 콘텐츠를 스크롤하면 상단 앱바가 부드럽게 축소되어 근무표에 더 많은 공간 확보
- **테이블 전체화면 보기** (v4.3.2) — 사전입력·근무표 탭에서 ⛶ 토글로 헤더·툴바·옵션 패널을 모두 숨기고 슬림 배너 + 표만 화면 가득. `Esc`로 종료
- **KR 시그널 컬러** — 부족·경고 red↑, 여유·정상 blue↓ / 근무 칩: D=블루 · E=레드 · N=바이올렛 · V=그린
- **모바일 '오늘' 홈** — 오늘 근무 현황(D/E/N 배정/요구 stack) + 듀티별 근무자(차지 배지·시간) + 5-탭 하단 네비
- **다크 모드, 키보드 단축키, 모바일 대응** — `← ↑ ↓ →` 이동 / `D E N V O W` 직접 입력
- **셀 단위 잠금 + 메모** — 사전입력 셀 우클릭 → 메모 + "완화 시 고정" 토글 (보수교육·원내교육 등)
- **드래그 다중 선택 + Undo/Redo** — 40단계, Ctrl+Z / Ctrl+Shift+Z

### 🧮 스케줄러
- **MIP 기반 근무표 자동 생성** — PuLP + HiGHS, 하드/소프트 제약 만족 최적 배정
- **사전입력 시스템** — 주휴, 연차, 희망근무를 미리 입력하면 나머지를 솔버가 자동 채움
- **사전입력 완화 모드** — 생성 실패 시 종류별 차등 보너스로 유연하게 해결, 공휴일 OF는 하드 금지
- **트리플 솔버 (v4.3.1)** — HiGHS(MILP) · **CP-SAT** · **⚡ 레이스** 중 선택. 레이스는 두 엔진을 *동시 실행*해 먼저 해를 찾은 쪽을 채택(문제마다 빠른 엔진이 달라도 항상 빠른 쪽). infeasible 시 CP-SAT assumptions로 *어느 제약이 동시 충족 불가인지* 1회에 정밀 진단
- **충돌 완전정복 (v4.3.1)** — 전 하드 제약 게이팅 + 최소 MUS·다중 충돌 분리 열거. **최소 수정 처방(MCS)** — *어떤 사전입력을 빼거나 수요를 얼마나 줄이면 풀리는지* 계산("🔧 자동 수정 처방"). 충돌을 클릭하면 사전입력 탭 **해당 셀로 점프·강조**, "✅ 처방 모두 적용"으로 제거+수요감축 원클릭(Ctrl+Z 취소)
- **infeasible 진단 + 액션 제안** (v4.2.1 강화) — Phase 1~13 단계별 분석. 부족분을 *간호사 +N명 추가* / *일평균 -K명 감축* / *야간전담 K명을 정규로 전환* 등 수치 기반으로 제시. **셀 기여도 ranking** — 어느 사전입력 셀을 비우면 가장 많은 충돌이 동시 해소되는지 표시. **진단 액션 버튼** — UI에서 사전입력/분석 탭으로 한 번에 점프
- **인원 분석 + 주휴 추천** — 일자별 과부족 히트맵 + 최적 주휴 배분 자동 계산

### 📥 데이터 관리
- **사전입력 엑셀 붙여넣기** — Teams 공용 엑셀에서 표 영역을 그대로 복붙 (이름/날짜 자동 매칭, 한글 별칭 변환)
- **간호사 인라인 편집 + 일괄 작업** — 셀 클릭으로 즉시 수정, 다중 선택 후 그룹/성별/야간/삭제 한 번에
- **CSV 일괄 등록** — UTF-8/CP949 자동 감지, id 자동 생성, 미리보기 모달로 변경 사항 확인 후 적용
- **프로필 시스템** — 병동별 DB 분리 + Fernet 암호화 (PBKDF2 100k 비밀번호 보호)
- **간호사 관리** — 야간전담(월별 지정), 트레이닝(프리셉터 연동), 전입/전출 로테이션

### 🛠 인프라
- **Electron 데스크톱 앱** — 브라우저 없이 독립 창으로 실행, 완전 오프라인
- **pytest 회귀 테스트** — 37건: 9개 금지 전환·charge 시니어리티·일별 인원 등 하드 제약 + CP-SAT 동등성·정밀 충돌 분석·야간전담·두 엔진 레이스 자동 검증
- **JS 모듈화** — `app.js`(2744→~530줄 코어)에서 도메인 로직을 `frontend/js/modules/*` **14개 모듈**로 분리. window-namespace 합성(`...XxxModule()`) 패턴, 빌드 도구 불필요

---

## 다운로드

> **최신 버전: v4.3.3** | [전체 릴리스 목록](https://github.com/yuangunn/nurse-v4/releases) · [변경 이력](CHANGELOG.md)

| 파일 | 용도 | 크기 |
|------|------|:----:|
| [**NurseScheduler_Setup_v4.3.3.exe**](https://github.com/yuangunn/nurse-v4/releases/download/v4.3.3/NurseScheduler_Setup_v4.3.3.exe) | 설치 마법사 (권장) | ~190 MB |
| [**NurseScheduler_v4_portable.zip**](https://github.com/yuangunn/nurse-v4/releases/download/v4.3.3/NurseScheduler_v4_portable.zip) | 포터블 (설치 불필요) | ~250 MB |

### 시스템 요구사항
- Windows 10/11 (64bit)
- Python / Node.js 설치 **불필요** (전부 번들됨)
- 인터넷 연결 **불필요** (완전 오프라인 동작)

---

## 퀵가이드

| 단계 | 탭 | 할 일 |
|:----:|:--:|-------|
| 1 | **설정** | 간호사 등록 (CSV 일괄 가능) + 요일별 인원 + 규칙 |
| 2 | **사전입력** | 주휴 → 연차 → 생휴 → 희망 근무 입력 (빈 칸 = 자동) |
| 3 | **분석** | 인원 과부족 확인 + 주휴 추천 → "사전입력에 적용" |
| 4 | **스케줄** | "생성" 클릭 → 솔버 자동 생성 (5~20분) |
| 5 | **저장** | CSV/인쇄 내보내기, 저장 탭에서 불러오기 |

**키보드**: `← ↑ ↓ →` 이동 · `D/E/N/V/O` 직접 입력 · `Del` 삭제 · `Ctrl+Z` 되돌리기 · `?` 전체 단축키

> 상세 사용법은 [MANUAL.md](MANUAL.md)를 참고하세요.

---

## 기술 스택

| 구분 | 기술 |
|------|------|
| 백엔드 | Python 3.11 + FastAPI + uvicorn |
| 스케줄링 엔진 | PuLP 2.9 + HiGHS (highspy) · **OR-Tools CP-SAT** 듀얼 엔진 |
| 데이터 저장 | SQLite + Fernet 암호화 (cryptography) |
| 프론트엔드 | HTML + Tailwind CSS + Alpine.js |
| 데스크톱 래퍼 | Electron |
| 패키징 | PyInstaller + electron-packager + Inno Setup |

---

## 빌드 방법

> 개발자용. 일반 사용자는 위 다운로드 링크에서 설치 파일을 받으세요.

```cmd
# 사전 조건: Python 3.11+, Node.js 18+, Inno Setup 6

# 원클릭 빌드 (Python → Electron → ZIP → 설치파일)
build.bat
```

결과물:
- `dist/electron/NurseScheduler-win32-x64/` — Electron 번들
- `dist/NurseScheduler_v4_portable.zip` — 포터블 ZIP
- `dist/installer/NurseScheduler_Setup_v4.3.3.exe` — 설치 마법사

자세한 빌드 가이드는 [BUILD.md](BUILD.md)를 참고하세요.

---

## 프로젝트 구조

```
nurse-v4/
├── main.py                  # 진입점: 포트 탐색 → stdout "PORT:N" → uvicorn
├── server/
│   ├── api.py               # FastAPI 라우터 (프로필/간호사/규칙/스케줄/진단/개발자)
│   ├── scheduler_base.py    # 엔진 공유 베이스 _SchedulerBase (데이터·날짜·추출·점수)
│   ├── scheduler.py         # HiGHS(MILP) 엔진 — NurseScheduler (solve/완화, ~410줄 코어)
│   ├── scheduler_highs_constraints.py # HiGHS 하드 제약 + 목적함수 믹스인
│   ├── scheduler_highs_diagnosis.py   # HiGHS Infeasible 13-phase 진단 믹스인
│   ├── scheduler_cpsat.py   # CP-SAT(OR-Tools) 엔진 — CpSatScheduler
│   ├── conflict_analyzer.py # 정밀 충돌 분석 (assumptions·MUS/MCS) — /api/diagnose·suggest-fix
│   ├── solver_progress.py   # 솔버 무관 진행/취소 레지스트리 (레이스 안전 다중 어댑터)
│   ├── database.py          # SQLite CRUD + 마이그레이션 + 유령 정리
│   ├── models.py            # Pydantic 데이터 모델 (GenerateRequest 등)
│   └── profiles.py          # 프로필 관리 + Fernet 암호화 (PBKDF2 100k)
├── frontend/
│   ├── index.html           # SPA — YGinvest (설정·사전입력·분석·스케줄·저장 + 모바일 '오늘' 홈)
│   ├── css/                 # tokens·base·components·yginvest-skin (cascade 순서로 link)
│   ├── js/
│   │   ├── app.js           # Alpine.js 코어 (~530줄: 상태·computed·init·API·모듈 합성)
│   │   └── modules/         # 14개 도메인 모듈 (analysis·solver·profiles·nurse-manage·
│   │                        #   preinput-io·grid-interactions·schedule-features·misc-features·
│   │                        #   settings-defs·view-helpers·paste-import·dev-tools·undo-redo·drag-select)
│   ├── lib/                 # tailwindcss, alpine, lucide (오프라인 번들)
│   ├── fonts/               # Pretendard(주) + 번들 폰트
│   └── assets/              # 아이콘·이미지
├── tests/                   # pytest 회귀 37건 (제약·진단·CP-SAT 동등성·충돌·야간전담·레이스)
├── pytest.ini
├── electron/                # Electron main.js / preload.js / package.json
├── build/                   # icon.ico, make_icon.py
├── installer/
│   └── setup.iss            # Inno Setup 스크립트 (#define AppVersion)
├── docs/                    # decisions.md · session_notes/ · superpowers/
├── NurseScheduler.spec      # PyInstaller 스펙 (ortools 오프라인 번들)
├── build.bat                # 원클릭 빌드 (PyInstaller → Electron → ZIP → 설치파일)
├── BUILD.md                 # 빌드 가이드
├── MANUAL.md                # 사용 매뉴얼
├── CHANGELOG.md             # 변경 이력
└── CLAUDE.md                # 프로젝트 사양서
```

---

## 문의 및 피드백

- **GitHub Issues**: https://github.com/yuangunn/nurse-v4/issues
- 버그 신고, 기능 제안, 사용 중 궁금한 점을 편하게 남겨주세요.

---

## 라이선스

**All Rights Reserved.** 본 소프트웨어의 복사, 수정, 배포, 상업적 사용은 저작권자의 명시적 허락 없이 금지됩니다.

---

**개발**: yuangunn
