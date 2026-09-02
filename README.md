# NurseScheduler v4

```text
 _   _                       ____       _              _       _
| \ | |_   _ _ __ ___  ___  / ___|  ___| |__   ___  __| |_   _| | ___ _ __
|  \| | | | | '__/ __|/ _ \ \___ \ / __| '_ \ / _ \/ _` | | | | |/ _ \ '__|
| |\  | |_| | |  \__ \  __/  ___) | (__| | | |  __/ (_| | |_| | |  __/ |
|_| \_|\__,_|_|  |___/\___| |____/ \___|_| |_|\___|\__,_|\__,_|_|\___|_|

```

**간호사 3교대 근무표 자동 생성 데스크톱 앱**

> 🩺 **개발·AI 세션 참고**: 프로젝트 규칙과 **병동 도메인 제1원칙**(공휴일 운영·오프특근·
> 최소 인원·원티드의 의미 등)은 [`CLAUDE.md`](CLAUDE.md)에 있습니다 — **작업 전 먼저 확인하세요.**

수리최적화 솔버(HiGHS · CP-SAT 듀얼 엔진) 기반으로 최적의 근무표를 자동 생성합니다.
인터넷 연결 없이 완전한 오프라인 환경에서 동작합니다 (인트라넷 병원망 지원).

```text
   사전입력                      수리최적화 솔버                  완성된 근무표
   주휴·연차·희망·잠금   ──►    HiGHS · CP-SAT · ⚡레이스   ──►    최적 3교대 (D·E·N)
                                      │
                          infeasible  └─►  정밀 충돌 진단 + 최소 침습 완화
                                           (사전입력은 꼭 필요한 만큼만 건드림)
```

---

## 주요 기능

### 🎨 화면 · 사용 편의
- **정돈된 라이트 테마 + 단일 서체** — 흰 카드·부드러운 그림자·둥근 모서리에 Pretendard 단일 서체. 표를 오래 봐도 눈이 편하고 정보 위계가 분명합니다.
- **스크롤 적응형 헤더** — 표를 아래로 내리면 상단 바가 자동으로 축소돼 근무표를 더 넓게 볼 수 있습니다.
- **표 전체화면 보기** — ⛶ 버튼 하나로 헤더·툴바·옵션 패널을 모두 숨기고 표만 화면 가득. `Esc`로 복귀합니다.
- **신호색 구분** — 부족·경고는 빨강, 여유·정상은 파랑. 근무 칩은 D=파랑·E=빨강·N=보라·연차=초록으로 한눈에 구분됩니다.
- **모바일 대응** — 휴대폰에선 '오늘 근무 현황'(시간대별 배정/요구, 듀티별 근무자) 중심 화면과 하단 탭으로 조회에 최적화됩니다.
- **다크 모드 · 키보드 입력** — 방향키로 셀을 옮기고 `D E N V O` 키로 근무를 직접 입력해 사전입력이 빠릅니다.
- **셀 잠금 + 메모** — 특정 셀을 고정(완화 시에도 유지)하거나 메모를 남길 수 있어, 보수교육·원내교육 같은 확정 일정을 안전하게 표시합니다.
- **드래그 다중 선택 + 40단계 실행 취소** — 여러 셀을 한 번에 지정하고 `Ctrl+Z` / `Ctrl+Shift+Z`로 되돌리거나 다시 실행합니다.
- **도움말 · 접근성** — 사용법 도움말, 엑셀 붙여넣기 형식 안내, 스크린리더용 ARIA 라벨을 제공합니다.

### 🧮 자동 근무표 생성
- **제약 만족 최적화** — 수리최적화 솔버가 일별 인원·근무 자격·연속근무 한도·금지 전환·주휴/OFF 의무 등 모든 규칙을 동시에 만족하는 근무표를 자동으로 계산합니다. 손으로 며칠씩 짜던 3교대표를 수 분 내에 완성합니다.
- **사전입력 기반 작성** — 주휴·연차·희망근무를 미리 넣으면 나머지를 솔버가 채웁니다. 미리 넣을수록 결과가 의도에 가까워지고 생성 속도도 빨라집니다.
- **꼭 필요한 만큼만 완화** — 입력한 대로 짤 수 없을 때, 바꿔야 하는 사전입력을 최소한으로만 조정합니다. 휴무(OFF·연차·생리·특별·공가·병가)는 가장 마지막에 건드리고 변경 내역을 따로 보여주므로, 미리 잡아둔 개인 일정이 점수 때문에 함부로 사라지지 않습니다.
- **임산부 모성보호** — 간호사별 임신 구간(초기/출산 전)을 지정하면 ①각 구간 매주 임부휴무(P1)를 1회 자동 배치 ②임신 전 기간 야간(N/NC) 제외 ③해당 기간 생리휴가 면제 ④야간전담 자동 해제. 사전입력으로 P1을 직접 지정할 수도 있습니다.
- **두 엔진 + 동시 실행** — HiGHS·CP-SAT 두 솔버 중 선택하거나, 둘을 동시에 돌려 먼저 푼 결과를 채택합니다. 문제 특성에 따라 빠른 엔진이 달라도 항상 빠른 쪽 결과를 얻습니다.
- **생성 실패 원인 진단** — 해가 없을 때 어떤 규칙들이 동시에 충족될 수 없는지 짚고, 어떤 사전입력을 빼거나 인원을 얼마나 늘리면 풀리는지 수치로 제시합니다. 충돌 항목을 클릭하면 해당 셀로 바로 이동합니다.
- **인원 분석 + 주휴 추천** — 날짜별 인원 과부족을 히트맵으로 보여주고, 최적의 주휴 배분을 자동 계산해 사전입력에 한 번에 적용합니다.

### 📥 데이터 관리
- **엑셀 표 붙여넣기** — 기존 엑셀 근무표의 표 영역을 그대로 붙여넣으면 이름·날짜를 자동으로 인식해 사전입력에 채웁니다.
- **한국 공휴일 자동 입력** — 버튼 한 번으로 해당 월의 법정공휴일을 채웁니다. 설날·추석·부처님오신날은 **음력(KASI 한국천문연구원 기준)을 자동 변환**하고, 3일 연휴와 **대체공휴일까지 규칙대로 계산**합니다(2025~2050년 지원, 그 외 연도는 직접 지정 안내). 선거일 등 임시공휴일은 내장 목록으로 함께 입력되며, 공휴일은 OFF 금지·휴가 보상 같은 근무표 규칙에 그대로 반영됩니다.
- **간호사 즉시 편집 + 일괄 작업** — 셀 클릭으로 바로 수정하고, 여러 명을 골라 그룹·성별·야간전담·삭제를 한 번에 처리합니다.
- **CSV 일괄 등록** — UTF-8/CP949 인코딩을 자동 감지하고, 미리보기로 변경 사항을 확인한 뒤 적용합니다.
- **프로필 분리 + 암호화** — 병동별로 데이터를 따로 저장하고 비밀번호로 암호화합니다(모두 로컬 저장).
- **유연한 간호사 설정** — 야간전담(월별 지정), 신규간호사(프리셉터 연동), 전입/전출 로테이션, 임산부 모성보호를 지원합니다.

### 🛠 설치 · 품질
- **완전 오프라인 데스크톱 앱** — 인터넷 연결이나 Python·Node.js 설치 없이 독립 실행됩니다. 인터넷이 차단된 병원 인트라넷에서도 그대로 동작합니다.
- **자동 회귀 테스트 86건** — 핵심 제약·두 솔버의 결과 동등성·완화·임산부 모성보호·공휴일 자동계산을 자동 검증해, 기능을 추가해도 기존 동작이 깨지지 않도록 유지합니다.

---

## 다운로드

> **최신 버전: v4.10.3** | [전체 릴리스 목록](https://github.com/yuangunn/nurse-v4/releases) · [변경 이력](CHANGELOG.md)

#### 🪟 Windows
| 파일 | 용도 | 크기 |
|------|------|:----:|
| [**NurseScheduler_Setup_v4.10.3.exe**](https://github.com/yuangunn/nurse-v4/releases/download/v4.10.3/NurseScheduler_Setup_v4.10.3.exe) | 설치 마법사 (권장) | ~166 MB |
| [**NurseScheduler_v4_portable.zip**](https://github.com/yuangunn/nurse-v4/releases/download/v4.10.3/NurseScheduler_v4_portable.zip) | 포터블 (설치 불필요) | ~244 MB |

#### 🍎 macOS (Apple Silicon)
| 파일 | 용도 | 크기 |
|------|------|:----:|
| [**NurseScheduler_v4_mac_arm64.dmg**](https://github.com/yuangunn/nurse-v4/releases/download/v4.10.3/NurseScheduler_v4_mac_arm64.dmg) | 디스크 이미지 (권장) | ~226 MB |
| [**NurseScheduler_v4_mac_arm64.zip**](https://github.com/yuangunn/nurse-v4/releases/download/v4.10.3/NurseScheduler_v4_mac_arm64.zip) | 포터블 (.app) | ~200 MB |

> 🍎 macOS 빌드는 미서명(ad-hoc)이라 첫 실행 시 **우클릭 → 열기**로 한 번 허용해야 합니다 (또는 터미널에서 `xattr -dr com.apple.quarantine /Applications/NurseScheduler.app`). 현재 **Apple Silicon(arm64) 전용**입니다.

### 시스템 요구사항
- **Windows** 10/11 (64bit) 또는 **macOS** (Apple Silicon, 14 Sonoma+ 권장)
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

**Windows** (사전: Python 3.11, Node.js 20, Inno Setup 6)
```cmd
build.bat
```
결과물: `dist/installer/NurseScheduler_Setup_v4.10.3.exe`, `dist/NurseScheduler_v4_portable.zip`

**macOS** (사전: Python 3.11, Node.js 20 — Node 24는 패키징 단계 크래시)
```bash
./build-mac.sh
```
결과물: `dist/NurseScheduler_v4_mac_arm64.dmg`, `dist/NurseScheduler_v4_mac_arm64.zip` (ad-hoc 서명)

> 두 플랫폼 모두 태그(`vX.Y.Z`) push 시 [GitHub Actions](.github/workflows/release.yml)가 자동 빌드해 릴리스에 업로드합니다.

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
│   ├── index.html           # SPA (설정·사전입력·분석·스케줄·저장 + 모바일 '오늘' 홈)
│   ├── css/                 # tokens·base·components·yginvest-skin (cascade 순서로 link)
│   ├── js/
│   │   ├── app.js           # Alpine.js 코어 (~530줄: 상태·computed·init·API·모듈 합성)
│   │   └── modules/         # 14개 도메인 모듈 (analysis·solver·profiles·nurse-manage·
│   │                        #   preinput-io·grid-interactions·schedule-features·misc-features·
│   │                        #   settings-defs·view-helpers·paste-import·dev-tools·undo-redo·drag-select)
│   ├── lib/                 # tailwindcss, alpine, lucide (오프라인 번들)
│   ├── fonts/               # Pretendard(주) + 번들 폰트
│   └── assets/              # 아이콘·이미지
├── tests/                   # pytest 회귀 86건 (제약·진단·CP-SAT 동등성·충돌·야간전담·레이스·완화·모성보호·공휴일)
│   └── fixtures/            # kr_holidays_golden.json (KASI 기준 2025~2050 공휴일 골든셋)
├── pytest.ini
├── electron/                # Electron main.js / preload.js / package.json
├── build/                   # icon.ico, make_icon.py
├── installer/
│   └── setup.iss            # Inno Setup 스크립트 (#define AppVersion)
├── docs/                    # decisions.md · session_notes/ · superpowers/
├── NurseScheduler.spec      # PyInstaller 스펙 (ortools 오프라인 번들)
├── build.bat                # Windows 원클릭 빌드 (PyInstaller → Electron → ZIP → 설치파일)
├── build-mac.sh             # macOS 빌드 (PyInstaller → electron-packager → ad-hoc 서명 → zip/dmg)
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
