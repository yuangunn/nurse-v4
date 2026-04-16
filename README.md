# NurseScheduler v4

**간호사 3교대 근무표 자동 생성 데스크톱 앱**

수리최적화(PuLP + HiGHS) 솔버 기반으로 최적의 근무표를 자동 생성합니다.
인터넷 연결 없이 완전한 오프라인 환경에서 동작합니다.

---

## 주요 기능

- **근무표 자동 생성** — MIP 솔버가 하드/소프트 제약을 만족하는 최적 배정 계산
- **사전입력 시스템** — 주휴, 연차, 희망근무를 미리 입력하면 나머지를 솔버가 자동 채움
- **인원 분석 + 주휴 추천** — 일자별 과부족 히트맵 + 최적 주휴 배분 자동 계산
- **프로필 시스템** — 병동별 DB 분리 + Fernet 암호화 (비밀번호 보호)
- **간호사 관리** — CSV 일괄 등록, 야간전담, 트레이닝(프리셉터 연동), 전입/전출 로테이션
- **사전입력 완화** — 생성 실패 시 종류별 차등 보너스로 유연하게 해결
- **Electron 데스크톱 앱** — 브라우저 없이 독립 창으로 실행
- **다크 모드, 키보드 단축키, 모바일 대응**

---

## 다운로드

> **최신 버전: v4.0.3** | [전체 릴리스 목록](https://github.com/yuangunn/nurse-v4/releases)

| 파일 | 용도 | 크기 |
|------|------|:----:|
| [**NurseScheduler_Setup_v4.0.3.exe**](https://github.com/yuangunn/nurse-v4/releases/download/v4.0.3/NurseScheduler_Setup_v4.0.3.exe) | 설치 마법사 (권장) | 137 MB |
| [**NurseScheduler_v4.0.3_portable.zip**](https://github.com/yuangunn/nurse-v4/releases/download/v4.0.3/NurseScheduler_v4.0.3_portable.zip) | 포터블 (설치 불필요) | 195 MB |

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
| 스케줄링 엔진 | PuLP 2.9 + HiGHS (Python 바인딩: highspy) |
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
- `dist/NurseScheduler_v4.0.3_portable.zip` — 포터블 ZIP
- `dist/installer/NurseScheduler_Setup_v4.0.3.exe` — 설치 마법사

자세한 빌드 가이드는 [BUILD.md](BUILD.md)를 참고하세요.

---

## 프로젝트 구조

```
nurse-v4/
├── main.py                  # Python 서버 진입점 (stdout PORT 출력)
├── server/
│   ├── api.py               # FastAPI 라우터 + 프로필/개발자 API
│   ├── scheduler.py         # HiGHS MIP 스케줄링 엔진
│   ├── database.py          # SQLite CRUD
│   ├── models.py            # Pydantic 데이터 모델
│   └── profiles.py          # 프로필 관리 + Fernet 암호화
├── frontend/
│   ├── index.html           # SPA (5탭: 설정/사전입력/분석/스케줄/저장)
│   ├── css/app.css          # 스타일
│   └── js/app.js            # Alpine.js 앱 로직
├── electron/
│   ├── main.js              # Electron main process
│   ├── preload.js           # context isolation
│   └── package.json         # Electron 의존성
├── build/
│   ├── icon.ico             # 앱 아이콘
│   └── make_icon.py         # 아이콘 생성 스크립트
├── installer/
│   └── setup.iss            # Inno Setup 스크립트
├── NurseScheduler.spec      # PyInstaller 스펙
├── build.bat                # 원클릭 빌드 스크립트
├── BUILD.md                 # 빌드 가이드
├── MANUAL.md                # 사용 매뉴얼
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
