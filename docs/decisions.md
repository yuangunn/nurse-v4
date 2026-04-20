# NurseScheduler v4 — 아키텍처 결정 · 네거티브 지식

> 컴팩팅/세션 재시작으로 잃기 쉬운 세부 맥락 보존용.
> "이 방법은 시도했는데 실패함" 같은 네거티브 지식 포함.
> 마지막 갱신: 2026-04-19

---

## 1. 아키텍처 결정 (Accepted)

### 1-1. 데스크톱 패키징 = Electron + @electron/packager (NOT electron-builder)
- **결정**: `@electron/packager` v19 + 수동 Inno Setup(ISCC) 조합
- **이유**: `electron-builder` 26.x가 Windows에서 `winCodeSign` 심볼릭 링크 생성 실패. 개발자 모드 없는 환경에선 빌드 자체가 깨짐.
- **대안 폐기**: `electron-builder` `"nsis"` 타겟 — 빌드 시 symlink 권한 에러.
- **파일**: `electron/package.json`, `installer/setup.iss`, `build.bat`

### 1-2. Python 서버 ↔ Electron IPC = stdout "PORT:<n>"
- **결정**: `main.py`가 `sys.stdout.write(f"PORT:{port}\n")`로 Electron에 포트 전달.
- **이유**: 포트 충돌 가능. Python이 `find_free_port()`로 동적 할당하고 Electron `main.js`가 stdout 라인 파싱.
- **주의**: `--windowed`(console=False)에서 `sys.stdout is None`. `_ensure_stdio()`로 devnull 대체 + try/except로 write 감쌈.
- **파일**: `main.py:_ensure_stdio()`, `electron/main.js`

### 1-3. 프로필 데이터 암호화 = Fernet (PBKDF2 100k iterations)
- **결정**: `cryptography` 라이브러리, 프로필별 DB 파일 + 마스터 비밀번호로 Fernet 키 파생.
- **파일**: `server/profiles.py`
- **게스트 모드**: `_guest_temp.db` — 종료 시 삭제.

### 1-4. MIP 솔버 = `pulp.HiGHS` (Python 바인딩), NOT `pulp.HiGHS_CMD`
- **이유**: `HiGHS_CMD`는 highs.exe 경로 문제로 PyInstaller 빌드에서 동작 불가.
- **의존성**: `highspy` 패키지 (PyInstaller `--hidden-import=highspy` 필수).

### 1-5. 시니어리티 = `nurses` 리스트 순서 (0번이 가장 선임)
- **결정**: 별도 `seniority` 필드 없이 순서로 표현.
- **Charge 규칙**: 더 선임이 같은 듀티에서 일반 근무(D/E/N)로 배정되면, 후임은 그 듀티의 Charge(DC/EC/NC) 불가.

### 1-6. D/E/N 라벨 유지 (낮/저녁/야간으로 바꾸지 말 것)
- **사용자 명시 지시**: "누가 D/E/N을 낮/저녁/야간으로 바꾸래?"
- 근무 코드는 원본 영문 유지.

### 1-7. 사이드바 로고 = `18px !important` 고정
- **사용자 명시 지시**: "NurseScheduler v4 18px로 고정해줘"
- `fontSize` 설정이 커져도 로고는 변하지 않음.
- **파일**: `frontend/css/app.css` `.sidebar-logo { font-size: 18px !important }`

### 1-8. 일별 인원 제약 = `==` (정확히 일치)
- 초과 배정 불가. `_c_daily_requirements()` 에서 `==` 사용.

### 1-9. 소프트 제약 preBonus = 차등
- `preBonusLeave: 5000` / `preBonusWork: 500` / `preBonusRest: 300`
- 사전입력 완화 시 휴가는 최대한 유지, 근무는 조정 가능, 휴무는 유연하게.
- **파일**: `server/scheduler.py:_solve_with_relaxed_pre()` (line ~402)

### 1-10. 동시 생성 방지 = 409 에러
- `POST /api/generate` 진입 시 이전 솔버 실행 중이면 409 반환.

### 1-11. 라이선스 = All Rights Reserved (상업 사용 불가)
- 공개 리포지토리지만 사용·수정·배포 전반 금지.
- 외부망 환경에서 먼저 테스트 권장(README에 명시).

### 1-12. CSS 변수는 `--bg-card`, NOT `--card` (2026-04-19 확정)
- **결정**: 카드 배경은 항상 `var(--bg-card)` 사용.
- **이유**: `--card`는 정의되지 않았음. 과거 코드가 `var(--card, #fff)` 쓰면 fallback으로 항상 흰색이 돼서 다크모드가 깨짐 (프로필창·온보딩 모달 안 보임 버그 원인).

---

## 2. 네거티브 지식 (시도했는데 실패)

### 2-1. Alpine.js `x-show + x-cloak + :style` 조합
- **증상**: 프로필 전환 모달이 중앙이 아닌 좌상단에 출력.
- **원인**: `x-show`의 `display:none` 토글과 `:style`의 `display:flex`가 충돌.
- **해결**: `x-show`와 `x-cloak` 제거 → `:style` 조건부만 사용
  ```html
  :style="profileScreen?'position:fixed;...display:flex':'display:none'"
  ```

### 2-2. CSS `.name-cell { position: sticky }`가 `.g-cell { position: relative }`에 덮임
- **원인**: 둘 다 단일 클래스 선택자, 나중에 정의된 쪽이 이김 (specificity 동점).
- **해결**: `.name-cell`에 `!important` 추가 (position, left, z-index).

### 2-3. SVG 내부 `<template x-if>` 렌더 안 됨
- **원인**: Alpine이 SVG 네임스페이스 내부에서 template 처리 실패.
- **해결**: 동적 x-for를 제거하고 탭별 정적 SVG를 `xmlns="http://www.w3.org/2000/svg"` 포함해서 하드코딩.

### 2-4. `electron-builder` 26.x `winCodeSign` symlink 실패
- **증상**: "Cannot create symbolic links without dev mode"
- **포기**: electron-builder 사용 중단, @electron/packager + ISCC로 전환.

### 2-5. PyInstaller `--windowed`에서 `sys.stdout = None`
- **증상**: `main.py:40`에서 `AttributeError: 'NoneType' object has no attribute 'write'` 크래시.
- **해결**: `_ensure_stdio()`가 None이면 `open(os.devnull, "w")`로 대체. `PORT:` 출력은 try/except로 감쌈.

### 2-6. 숫자 input 폭을 `rem`으로 하면 폰트 크기 올릴 때 잘림
- **원인**: `rem`은 루트 폰트 크기 기준, 폰트 확대 시 input 폭이 내용을 따라가지 못함.
- **해결**: `em` 단위로 변경 (year: 4.5em, month: 3em, rules: 3.5em, fontSize: 4em).
- **부수 작업**: `input[type="number"] { padding: 2px; -moz-appearance: textfield }` + webkit spinner 숨김.

### 2-7. `this._toast()` vs `this.toast()` 이름 충돌
- **증상**: 39곳에서 `this._toast()` 호출 → undefined.
- **해결**: `sed 's/this\._toast(/this.toast(/g'` 일괄 치환.

### 2-8. `workShifts` 변수 제거 후 요일별 필요 인원 테이블 안 뜸
- **원인**: `<template x-for="shift in workShifts">`가 제거된 state 참조.
- **해결**: `reqShiftCodes` computed로 재작성 (auto_assign 기반 동적).

### 2-9. `highspy 1.8.1`에서 `setLogCallback()` 제거됨
- **구 API**: `self.setLogCallback(lambda _, msg: ...)` 동작 안 함.
- **신 API**: `self.cbLogging.subscribe(fn)` 사용. `event.message`로 로그 수신.
- **사용 금지**: `setCallback(fn, user_data)` — 모든 내부 이벤트("MIP check limits" 등) 쏟아냄.

### 2-10. 모바일 "더보기" 메뉴 클릭 막힘
- **원인**: `inset:0` 오버레이가 하단 nav 버튼 클릭 캡처.
- **해결**: 오버레이를 `bottom:56px`로 제한 (하단 nav 영역 제외).

### 2-11. 사이드바 축소(768–1023px)에서 폰트/프로필 버튼 잘림
- **해결**: `.sidebar-bottom-extra { display: none }` + `.sidebar-fontsize-v`로 수직 배치.

### 2-12. 브라우저 `prompt()` 호출 금지 (UX 혼란)
- 마스터 비밀번호 제거 등은 인라인 input + Enter 지원으로 구현.

### 2-14. 전역 keydown 리스너가 input 포커스 상태를 무시 (2026-04-19)
- **증상**: 사전입력 탭에서 "저장 이름", "일별 필요인원" input에 D/E/N 같은 글자가 타이핑되지 않음.
- **원인**: `frontend/js/app.js:165` 전역 keydown 리스너가 `this._focusedCell`만 보고 `onGridKeyDown(e)`로 분기. activeElement가 INPUT인지 확인 안 함 → onGridKeyDown에서 shift 코드 키(D/E/N/V/O)를 `preventDefault()`로 삼킴.
- **해결**: `_isTyping = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName) || isContentEditable` 가드 추가. 입력 중이면 grid key 처리 skip.
- **교훈**: 전역 keydown 단축키는 항상 activeElement 태그 체크 + contentEditable 고려.

### 2-15. CSS `input[type="text"]` 셀렉터는 type 속성 없는 input에 매치 안 됨 (2026-04-19)
- **증상**: `<input x-model="nurseModal.data.name" class="w-full">` 같이 type 생략된 input이 스타일 없이 브라우저 디폴트(매우 작은 입력창)로 렌더링 → 사용자가 입력 불가능하다고 인식.
- **원인**: CSS 속성 셀렉터 `[type="text"]`는 속성이 **명시적으로 존재**할 때만 매치. HTML 기본값이 "text"여도 CSS는 고려 안 함.
- **해결 두 갈래**:
  1. HTML에 `type="text"` 명시 (간호사 모달 이름/그룹 input에 적용)
  2. CSS에 `input:not([type])` 추가 셀렉터 포함 (전역+`.modal` 두 곳 갱신)
- **파일**: `frontend/index.html:1162`, `frontend/css/app.css:306, 522`

### 2-16. `style="width:3.5em py-1"` 문법 오류 (2026-04-19)
- `py-1`은 Tailwind 클래스인데 style 속성에 들어가면 width 값 전체 무효.
- **해결**: `class="text-center py-1" style="width:3.5em"`로 분리.
- **파일**: `frontend/index.html:350`

### 2-13. `var(--card, #fff)` fallback 때문에 다크모드에서 카드가 흰색 (2026-04-19)
- **증상**: 다크모드에서 프로필창·온보딩 모달 안 보임 (흰 배경 + 밝은 텍스트).
- **원인**: HTML 인라인 스타일이 `var(--card, #fff)` 쓰지만 실제 변수는 `--bg-card`. fallback이 항상 적용됨.
- **해결**: `var(--card)` → `var(--bg-card)` 일괄 치환 (index.html, app.css).

---

## 3. 사용자 정립 규칙 (명시 지시)

| 규칙 | 출처 |
|---|---|
| 사전 허가 질문 금지 | "왜 자꾸 물어보는거야?" |
| D/E/N 라벨 유지 (낮/저녁/야간 금지) | "누가 D/E/N을 낮/저녁/야간으로 바꾸래?" |
| 사이드바 로고 18px 고정 | "NurseScheduler v4 18px로 고정해줘" |
| 사이드바 메뉴 폰트 20–22px 범위 | 초기 지시 (이후 로고만 고정으로 변경) |
| 상업 사용 불가 라이선스 | "라이선스에 상업적 사용 불가능 넣을 수 있나?" |
| 외부망 사용 테스트 권장을 README에 포함 | 명시 요청 |

---

## 4. 주요 버전 이정표

| 버전 | 내용 |
|---|---|
| v4.0.0 | 초기 Electron 포팅 + 프로필 시스템 |
| v4.0.1 | 차등 보너스(preBonus) |
| v4.0.2 | 중간번 포함 9개 금지 전환 |
| v4.0.3 | UX 개선 (토스트 히스토리, Undo 카운터, 프린트 등) |
| v4.0.4 | PyInstaller `--windowed` stdout=None 수정 + em 기반 입력 폭 |
| v4.0.5 | 다크모드 카드 수정 + 셀 완화 제외 + 공휴일 OF 금지 |
| v4.0.6 | 유령 간호사 클린업 + 저장 라운드트립 복구 + 재적외 default OF 버그 |
| **v5.0.0** | **Severance Theme (Apple Liquid Glass + 용인세브란스 네이비 #013378)** |

---

## 5. Severance Theme 결정 (v5.0.0, 2026-04-19)

### 5-1. 브랜드 색상 `#013378` 채택
- **결정**: Severance 테마 기본색 `rgb(1, 51, 120)` = 용인세브란스병원 공식 네이비
- **이유**: 사용자(용인세브란스 소속) 요청. 병원 아이덴티티 직결
- **적용**: `html.severance` 클래스 내에서만. Classic 테마는 기존 `#2563eb` 그대로 유지

### 5-2. CSS 파일 분리 (`severance.css`)
- **결정**: 기존 `app.css`는 거의 건드리지 않고 별도 `severance.css`에 `html.severance*` 스코프 규칙만 추가
- **이유**: 롤백 안전성. 문제 시 `<link>` 한 줄 주석으로 즉시 원복
- **파일**: `frontend/css/severance.css` (~400줄)

### 5-3. 4개 테마 조합 (2축 토글)
- `Classic Light` / `Classic Dark` (기존)
- `Severance Light` / `Severance Dark` (신규)
- **핵심 설계**: Severance 내부 라이트/다크 전환 시 **그리드만** 변함. 네이비 배경·유리 사이드바 공통 유지
- **구현**: `html.severance` + `html.severance.dark` 다축 CSS 레이어링

### 5-4. 디폴트 테마 정책 (Severance-first)
- v5 첫 실행 시 `localStorage.theme === null` → 자동으로 `'severance'` 저장
- 기존 `darkMode` 값은 유지 (대부분 false → Light 기본)
- 결과: v4 사용자도 업그레이드 시 Severance Light로 진입
- **이유**: 리디자인 투자 효과 극대화. 사용자가 원하면 언제든 Classic 전환 가능

### 5-5. Liquid Glass 강도 = Moderate (B)
- **채택**: 사이드바·카드·모달·헤더 = `backdrop-filter: blur(20px)`, 그리드 래퍼 = `blur(16px)`, **그리드 셀은 flat 유지**
- **이유**: 620셀(20명×31일) 전부 blur 시 GPU 부담. 래퍼에만 적용으로 성능·시각 균형
- **기각**: Subtle(변화 약함), Heavy(장시간 눈 피로+성능 리스크)

### 5-6. 병원 로고 위치
- **결정**: `frontend/assets/yongin-severance-logo.png`를 흰 카드로 감싸서 사이드바 하단, 프로필 badge 바로 위
- **이유**: 네이비 배경에서 원본 투명 PNG가 흐려 보이는 문제 → 흰 카드 래핑으로 또렷
- **가시성**: `x-show="theme==='severance'"` + CSS `html:not(.severance) .sev-hospital-logo { display:none }` 이중 가드

### 5-7. backdrop-filter 폴백
- 구형 브라우저(IE/구 Safari)에서 `backdrop-filter` 미지원 시 `@supports not (...)` 규칙으로 `rgba(1,51,120,0.85)` 짙은 네이비 반투명 대체
