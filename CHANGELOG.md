# Changelog

NurseScheduler v4의 주요 변경 이력. 최신 버전이 위쪽.

---

## v4.1.0 — 2026-05-28

대규모 UI 리디자인 + 솔버 진단 강화 + 테스트 회귀망 + 코드 모듈화.

### 🎨 디자인 선택 시스템 (신규)

기존 **Premium UI**(v4.0.x — Outfit + Noto Sans KR, modern blue)와
새 **Clinical Paper UI**(v4.1 — Pretendard + Newsreader + JetBrains Mono,
세브란스 navy + paper beige)를 **둘 다** 포함.

- 기본 진입: 새 Clinical Paper UI (`/`)
- 레거시 진입: `/legacy` 경로 또는 사이드바 "디자인: 신버전" / appbar "UI ▸ Premium" 버튼
- 선택은 `localStorage.design` 에 기억 — 다음 방문에 자동 복원
- 두 디자인 모두 동일 백엔드 API 사용, 데이터/프로필 호환

### 🩺 Clinical Paper 리디자인 (Phase 6 — 완료)

- **타이포그래피**: Newsreader serif headings + JetBrains Mono 셀/수치 + Pretendard Variable 본문
- **컬러**: 세브란스 navy #023671 + 따뜻한 paper beige (#f3eee3) + 잉크 그라데이션
- **레이아웃**: 상단 마스트헤드 + 5-step stepper (사이드바 제거, 데스크톱)
- **헤더 컴팩션**: appbar/stepper/month-banner padding 축소로 테이블 영역 +50px 확보

### 🐛 헤더 sticky 투명도 수정

- `.cy-1~4` 주기 헤더, `.g-sat-bg` 토요일 헤더가 `rgba 0.06` 단일 레이어라
  스크롤 시 본문이 비쳐보이던 문제 해소
- 솔리드 `var(--card-warm)` 베이스 + 색조 오버레이로 분리
- `.g-fix`의 `background: ... !important` shorthand가 tint를 덮어쓰던 충돌 해결

### 🔍 솔버 진단 메시지 강화

[`scheduler.py` `_diagnose_infeasibility()` Phase 5] 주휴/OF 부족 출력에
구체적 액션 제안 추가 — 일반 조언 대신 수치 기반 3택:

1. **간호사 +N명 추가** (가장 부족한 주의 gap÷5 올림)
2. **요일별 D/E/N 합계 일평균 -K명** (현재 X.X → 목표 Y.Y)
3. 사전입력 휴가/OF 일부 제거

### 🧪 pytest 회귀 테스트 (10건, 0.5초)

- `tests/conftest.py`: `LimitedScheduler` 픽스처 + 빌더
- `tests/test_constraints.py`: smoke / 9개 금지 전환 / 일별 인원 정확 일치 /
  charge 시니어리티 / V 월 한도 / 1일1근무 / 사전 고정 유지
- `tests/test_diagnostics.py`: Phase 5 액션 제안 메시지 / infeasible 응답 형태
- `pytest.ini` + `tests/__init__.py` 추가

### 📦 JS 모듈화 (패턴 확립)

- `frontend/js/modules/undo-redo.js` — `_pushUndo / undo / redo` 추출
- `frontend/js/modules/drag-select.js` — 드래그 멀티셀렉트 5개 메서드 추출
- `app.js` 진입점에서 `...UndoRedoModule(), ...DragSelectModule()` 스프레드
- 빌드 도구 없이 `<script>` 순차 로드 + window namespace 패턴 — 점진적 분리 가능

### 🐞 알려진 사소한 시맨틱

- `Rules.maxVPerMonth=0`은 `_c_max_v_per_month`에서 "제약 미적용" 의미
  (UI는 별도 `unlimited_v` 플래그 사용). 회귀 테스트 주석으로 명시.

---

## v4.0.8 — 2026-04-28

간호사 일괄 관리와 사전입력 엑셀 붙여넣기 중심의 큰 UX 개선.

### ✨ 새로운 기능

#### 사전입력 엑셀 붙여넣기
Teams 공용 엑셀에서 표 영역을 그대로 복사 → 사전입력 탭의 **📋 엑셀 붙여넣기** 버튼 → 한 번의 클릭으로 적용.
- 이름 컬럼 / 날짜 헤더 행 **자동 감지** (4가지 조합 점수 비교 후 최선 선택)
- 헤더 없어도 동작 — 당월 1일부터 자동 매핑
- **한글 별칭** 자동 변환: `낮→D`, `저녁→E`, `야간→N`, `오프→OF`, `데이/이브닝/나이트차지` 등
- 다양한 날짜 형식 인식: `5/3`, `2026-05-03`, `1(일)`, `5월 3일`, 단순 숫자
- `-`, `없음`, `x` 등은 비우기 신호로 처리
- 적용 전 **미리보기 모달**: 변경/비움/미인식 코드/매칭 실패 이름 배지 + diff 표

#### 간호사 인라인 편집 + 일괄 작업
간호사 목록을 스프레드시트처럼 직접 수정.
- 셀 클릭으로 **이름/그룹/성별/가능 근무/야간전담** 즉시 변경 — 모달 안 열어도 됨
- 가능 근무: chip 토글, 성별/야간: 단일 토글 버튼
- 다중 선택(체크박스) + 일괄 작업 툴바
- 일괄 변경: **그룹 chip 클릭 / 성별 / N월 야간전담 ON·OFF / 삭제(인라인 confirm)**
- 그룹 history (localStorage) + 표준 `[A,B,C]` 합집합 — 모두 같은 그룹이어도 다른 옵션이 항상 chip으로 노출
- 그룹 input `maxlength=3` + `field-sizing: content` (적응형 폭)

#### CSV 일괄 등록 대폭 개선
- **인코딩 자동 감지** (UTF-8-sig / CP949 / EUC-KR / UTF-8) — 한국 엑셀이 그대로 저장한 파일도 받힘
- `id` 빈 칸이면 자동 생성, **이름+그룹**으로 기존 nurse 매칭하여 ID 보존 (재업로드 안전)
- `POST /api/nurses/import/preview` 신규 — DB 변경 전 추가/수정/삭제 후보 계산
- **미리보기 모달** — diff 표 + 구조화된 경고(행/컬럼/받은값/기대값/메시지) + 병합/교체 토글
- 드래그 앤 드롭: 간호사 카드 위에 CSV 파일을 끌어다 놓으면 바로 미리보기

### 🎨 UI/UX 다듬기
- **사이드바 병원 로고**: 흰 카드 배경 제거 → 투명 배경(PNG 본래 모습), 기본 숨김 — 개발자 설정에서 토글
- **개발자 설정 모달**: 폭 480→720px 확대, 다크모드 배경 fix (`--bg-card` 투명 → `--modal-bg`), 다른 모달과 톤 통일
- **사전입력 footer 행** (D/E/N 배정·필요인원): 다크모드 색상 톤다운 (반투명 컬러 틴트 + 밝은 채도 글자)
- **간호사 표 헤더**: `white-space: nowrap` (예: "5월 야간" 줄바꿈 방지)
- **모달 capable_shifts undefined 경고** 가드 (콘솔 스팸 제거)

### 🔧 인프라
- 정적 파일(`/css /js /lib /fonts /assets`)에 `Cache-Control: no-cache` 미들웨어 추가
- ETag / Last-Modified 헤더 제거 (브라우저 304 conditional 차단으로 stale stylesheet 방지)

---

## v4.0.7 — 2026-04-20

- 용인세브란스병원 로고 사이드바 추가 + 로고 크기 확대 (36→60-110px auto-scale)
- v5 Severance 대규모 리디자인은 가독성 문제로 롤백 (v5-severance 브랜치는 보존)
- assets/ 디렉터리 정적 파일 마운트 누락 fix (로고 404 해결)

## v4.0.6 — 2026-04-19

- 유령 간호사 방어 (cleanup_orphan_nurse_refs) — 삭제된 간호사 ID 캐스케이드 정리
- 사전입력 저장/복원 누락 필드 9건 fix: locked_cells, cell_notes, holidays, prev_day_reqs, prev_month_nights
- W 키로 사전입력 탭에서 주휴 빠른 입력
- CLAUDE.md 전면 갱신
- `.superpowers/` gitignore

## v4.0.5 — 2026-04-19

- 다크모드 카드 배경 버그 fix (`var(--card)` → `var(--bg-card)`) — 프로필창·온보딩 모달 흰 배경 깨짐 해결
- `build.bat`에서 `build/` 전체 삭제하던 게 icon.ico를 지워서 빌드 실패하던 문제 fix

## v4.0.4

- PyInstaller `--windowed` (console=False) 환경에서 `sys.stdout=None` 크래시 fix
- 숫자 input 폭을 em 단위로 변경 + webkit/moz 스피너 숨김

## v4.0.3

- 토스트 히스토리, Undo 카운터, 프린트 등 UX 개선

## v4.0.2

- 중간번 포함 9개 금지 전환 추가 (E→D/D1/중, N→E/D/D1/중, 중→D/D1)

## v4.0.1

- 차등 사전입력 보너스 (`preBonusLeave: 5000` / `preBonusWork: 500` / `preBonusRest: 300`)

## v4.0.0

- 초기 Electron 포팅 + 프로필 시스템 (Fernet + PBKDF2 암호화)
