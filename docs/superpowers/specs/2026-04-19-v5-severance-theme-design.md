# NurseScheduler v5 — Severance Theme 디자인 스펙

**작성일**: 2026-04-19
**브랜치**: `v5-severance`
**상태**: 승인됨 — 구현 계획(writing-plans) 단계로 이동 예정
**관련 세션**: `docs/session_notes/2026-04-19.md`

---

## 1. 배경 및 목표

### 1.1 동기

v4는 기능적으로 성숙하지만 시각적으로 2023-2024 수준의 디자인 언어에 머물러 있다. 사용자(용인세브란스병원)가 요청한 리디자인의 우선순위:

1. **시각적 현대화** (최우선) — iOS 26 수준의 세련된 인상
2. **정보 밀도 / 가독성** (중요) — 20명×31일 그리드가 답답하지 않게
3. **신규 사용자 학습 곡선** (중요) — 첫 사용자도 30분 내 숙달

### 1.2 목표

v4 기능과 데이터는 100% 보존하면서 **프론트엔드 레이어만** 리디자인. 기존 `Classic` 테마는 그대로 남기고 `Severance` 테마를 추가하여 사용자가 전환할 수 있게 한다. v5 출시 시 기본값은 `Severance Light`.

### 1.3 범위 밖 (Out-of-scope)

- 워크플로우·탭 구성 변경
- 백엔드 API · 스케줄러 로직
- 데이터 모델 변경
- 모바일 전용 리디자인 (기존 반응형 유지)
- 다국어·번역
- Electron main 프로세스
- 성능/솔버 최적화

---

## 2. 디자인 결정 (Design Decisions)

### 2.1 미학 방향

**Apple Liquid Glass (iOS 26)** — 투명 레이어, 블러, 부드러운 곡선, 넉넉한 여백.

대안으로 검토했다가 폐기한 것들:
- **Linear/Vercel 다크 미니멀** — 차가운 인상, 병원 환경에 부적합
- **Notion/Obsidian 라이트 미니멀** — 문서 느낌은 좋지만 "리디자인 효과" 약함
- **Medical Pro (EMR 스타일)** — 기존 v4와 차이가 크지 않음

### 2.2 유리 효과 강도

**Moderate (B)** — 사이드바·헤더·카드·모달·드롭다운은 유리, 근무표 그리드는 flat(살짝 투명).

**기각된 옵션**:
- **Subtle** — 변화가 약해 리디자인 투자 효과 반감
- **Heavy** — 그리드 셀 620개 전부 blur 처리 시 GPU 부담, 장시간 사용 시 눈 피로

### 2.3 브랜드 색상

**기본색**: `#013378` (용인세브란스병원 공식 네이비)

- 배경 · 사이드바 뒷면 등 Severance 테마의 베이스
- Classic 테마는 기존 `#2563eb` 블루 계열 그대로 유지

### 2.4 라이트/다크 모드

**그리드만** 전환. 네이비 배경·유리 패널·사이드바는 **모드에 무관하게 동일**.

| | Light Grid | Dark Grid |
|---|---|---|
| 그리드 래퍼 | `rgba(255,255,255,0.82)` + `blur(16px)` | `rgba(0,0,0,0.25)` + `blur(16px)` |
| 본문 텍스트 | `#1f2937` | `rgba(255,255,255,0.9)` |
| D 시프트 | `#dbeafe` / `#1e40af` | `rgba(59,130,246,0.2)` / `#93c5fd` |
| E 시프트 | `#dcfce7` / `#166534` | `rgba(34,197,94,0.2)` / `#86efac` |
| N 시프트 | `#fef3c7` / `#92400e` | `rgba(251,191,36,0.2)` / `#fcd34d` |

### 2.5 병원 로고 배치

`frontend/assets/yongin-severance-logo.png` (이미 저장됨, 9.6KB).

**위치**: 사이드바 하단, 프로필 badge 바로 **위**.

**처리**: 네이비 배경과 로고(원본 배경 투명) 대비가 약할 수 있으므로 흰 카드로 감싸서 `rgba(255,255,255,0.9)` 배경에 표시.

### 2.6 테마 토글 전략

**Theme Toggle (다 옵션)** — Classic과 Severance 양쪽 코드 유지, 사용자가 언제든 전환.

**디폴트 정책**: 가 옵션 — Severance가 기본값. 기존 v4 사용자도 v5 첫 실행 시 자동으로 Severance Light 노출. 설정에서 Classic으로 돌아갈 수 있음.

**마이그레이션 로직**:
```javascript
// v5 최초 기동 시
const existingTheme = localStorage.getItem('theme');
if (!existingTheme) {
  localStorage.setItem('theme', 'severance');  // 신규·기존 사용자 모두
}
// darkMode 키는 기존 값 유지 (대부분 false = light 기본)
```

---

## 3. 기술 구조 (Architecture)

### 3.1 CSS 레이어링

기존 `html.dark` 클래스에 `html.severance` 클래스를 추가하는 **다축 체계**:

```
html                        → Classic Light (기본, 기존 v4 그대로)
html.dark                   → Classic Dark  (기존)
html.severance              → Severance Light (새)
html.severance.dark         → Severance Dark  (새)
```

모든 스타일은 CSS 변수 기반으로 이미 분리돼 있으므로 Severance는 변수만 override.

### 3.2 파일 구조

```
frontend/
├── assets/
│   └── yongin-severance-logo.png      ← 이미 저장됨
├── css/
│   ├── app.css                         ← 기존 유지 (Classic 테마, 거의 건드리지 않음)
│   └── severance.css                   ← 신규 (html.severance* 오버라이드 + 신규 컴포넌트)
├── index.html                          ← <link rel="stylesheet" href="css/severance.css">
└── js/
    └── app.js                          ← theme 상태 + 토글 함수
```

**설계 원칙**: `severance.css`는 **완전 분리**. `app.css`는 손대지 않음 (필요한 경우 극소량의 변경만). 롤백 시 `<link>` 주석 처리 + `theme=classic` 강제면 즉시 원복.

### 3.3 신규 CSS 변수

`severance.css`가 추가하는 CSS 변수:

```css
html.severance {
  /* 네이비 베이스 */
  --sev-bg: #013378;
  --sev-bg-glow: radial-gradient(ellipse at top right, rgba(96,165,250,0.25) 0%, transparent 50%);

  /* 유리 표면 */
  --sev-glass: rgba(255,255,255,0.08);
  --sev-glass-border: rgba(255,255,255,0.15);
  --sev-glass-highlight: inset 0 1px 0 rgba(255,255,255,0.2);
  --sev-glass-blur: 20px;

  /* 그리드 */
  --sev-grid-bg: rgba(255,255,255,0.82);
  --sev-grid-blur: 16px;
  --sev-grid-border: rgba(255,255,255,0.5);

  /* 텍스트 */
  --sev-text: rgba(255,255,255,0.9);
  --sev-text-sub: rgba(255,255,255,0.65);
  --sev-text-dim: rgba(255,255,255,0.45);

  /* 액센트 */
  --sev-accent: #60a5fa;
  --sev-accent-hover: #93c5fd;

  /* 기존 변수 override (app.css와 공통) */
  --bg: var(--sev-bg);
  --bg-sidebar: transparent;  /* 실제로는 .sidebar가 glass 처리 */
  --bg-card: var(--sev-glass);
  --border: var(--sev-glass-border);
  --text: var(--sev-text);
  --text-sub: var(--sev-text-sub);
  --accent: var(--sev-accent);
}

html.severance.dark {
  --sev-grid-bg: rgba(0,0,0,0.25);
  --sev-grid-border: rgba(255,255,255,0.1);
  /* 시프트 색상은 .grid-cell 클래스별로 별도 규칙 */
}
```

### 3.4 신규 컴포넌트 클래스

`severance.css` 내부에만 존재. Classic에서는 무시됨.

| 클래스 | 용도 |
|---|---|
| `.sev-glass` | 기본 유리 카드 (블러 + 반투명 + 하이라이트 + 경계) |
| `.sev-glass-strong` | 사이드바·헤더용 더 진한 유리 |
| `.sev-grid-pane` | 근무표 그리드 래퍼 (모드에 따라 투명도 변경) |
| `.sev-button` | 그라디언트 primary 버튼 (저장 등) |
| `.sev-hospital-logo` | 사이드바 하단 병원 로고 카드 |

**예시 규칙**:

```css
html.severance .sev-glass {
  background: var(--sev-glass);
  backdrop-filter: blur(var(--sev-glass-blur));
  -webkit-backdrop-filter: blur(var(--sev-glass-blur));
  border: 1px solid var(--sev-glass-border);
  border-radius: 16px;
  box-shadow: var(--sev-glass-highlight);
}

html.severance .sidebar { /* 기존 클래스에 Severance 규칙만 덮어쓰기 */
  background: var(--sev-glass);
  backdrop-filter: blur(var(--sev-glass-blur));
  border: 1px solid var(--sev-glass-border);
  border-radius: 16px;
  margin: 12px;
}
```

### 3.5 배경 그라디언트

`body` 에 고정 radial gradient. scroll 시 리페인트 없도록 `position:fixed` + `z-index:-1`.

```css
html.severance body::before {
  content: '';
  position: fixed;
  inset: 0;
  background: var(--sev-bg) var(--sev-bg-glow);
  z-index: -1;
  pointer-events: none;
}
```

### 3.6 성능 대응

- **그리드 셀 620개에는 `backdrop-filter` 미적용**. 래퍼에만 적용.
- 미지원 브라우저 폴백:
  ```css
  @supports not (backdrop-filter: blur(1px)) {
    html.severance .sev-glass { background: rgba(1,51,120,0.85); }
  }
  ```
- 테마 전환 시 `will-change: backdrop-filter` 임시 적용 후 애니메이션 종료 시 제거

---

## 4. 컴포넌트별 변경 매트릭스

| 컴포넌트 | Classic 유지 | Severance 적용 내용 |
|---|---|---|
| `.sidebar` | ✓ | `.sev-glass-strong` + radius 16px + margin 12px |
| `.sidebar-logo` | ✓ | 텍스트 색 `--sev-text`, 아이콘 `--sev-accent` |
| `.sidebar-item` / `.active` | ✓ | active 배경 `rgba(255,255,255,0.15)` + inset highlight |
| **신규 `.sev-hospital-logo`** | — | 사이드바 하단 (프로필 badge 위), 흰 카드 |
| `.profile-badge` | ✓ | 배경 `rgba(255,255,255,0.06)` |
| 상단 헤더 (년월 컨트롤) | ✓ | `.sev-glass` 래핑 |
| `.btn-primary` | ✓ | 그라디언트 `#60a5fa → #3b82f6` + glow shadow |
| `.btn-ghost` | ✓ | `rgba(255,255,255,0.1)` + hover 1 단계 밝게 |
| **근무표 테이블 래퍼** | — | `.sev-grid-pane` (반투명) |
| `.schedule-cell`, `.prev-cell` | ✓ | flat 유지. 색상만 밝기 조정 (다크 모드) |
| `.modal-bg` / `.modal` | ✓ | Severance에서 `rgba(1,51,120,0.6)` overlay + 모달은 `.sev-glass` |
| 시프트 태그 | ✓ | Light/Dark 모드별 배경·텍스트 색상 재정의 |
| 다크 토글 버튼 | ✓ | Theme 토글과 분리. 각각 독립 |
| **신규 Theme 토글** | — | 사이드바 하단에 Classic/Severance 토글 |
| 히트맵 (분석 탭) | ✓ | glass-card 안에 담음. 히트맵 색상 자체는 유지 |
| 주휴 추천 테이블 | ✓ | glass-card + 적용 버튼 tinted glass |
| 설정 탭 섹션 카드들 | ✓ | 각 섹션을 `.sev-glass` 카드로 래핑 |
| CSV import/export 모달 | ✓ | 모달 공통 처리 |
| 스케줄 저장 리스트 | ✓ | 각 아이템을 glass-card로 |
| 인쇄 뷰 | — | `@media print` → 배경 제거, flat 화이트 강제 |

---

## 5. Theme 전환 UX

### 5.1 토글 위치

**사이드바 하단**, 기존 다크모드 토글 자리를 **2축 컨트롤**로 확장:

```
[⚙ 설정] [✏ 사전입력] ... (상단 네비)
         ︙
[🎨 테마]  Classic | Severance
[🌗 모드]  Light   | Dark
─────────────
[세브란스 로고]
[101병동 프로필]
```

### 5.2 localStorage 키

- `theme`: `"classic"` | `"severance"` (신규)
- `darkMode`: `"true"` | `"false"` (기존 유지)

### 5.3 상태 전환 로직

```javascript
// init()
toggleTheme(newTheme) {
  this.theme = newTheme;
  document.documentElement.classList.toggle('severance', newTheme === 'severance');
  localStorage.setItem('theme', newTheme);
},
toggleDark() {
  this.darkMode = !this.darkMode;
  document.documentElement.classList.toggle('dark', this.darkMode);
  localStorage.setItem('darkMode', this.darkMode);
},
```

두 토글은 독립. 조합 4가지 모두 가능.

### 5.4 전환 애니메이션

```css
body, .sidebar, .sev-glass { transition: background 0.3s ease, border-color 0.3s ease; }
```

300ms 부드럽게 전환. 그리드 셀은 1000+ 개 리페인트 방지를 위해 트랜지션 없음 (즉시 전환).

---

## 6. 테스트 계획

### 6.1 회귀 테스트 (Classic)

- 모든 5탭이 v4.0.6과 동일하게 렌더링
- 키보드 단축키 (D/E/N/V/O/W + ←↑↓→) 동일 동작
- Undo/Redo, localStorage 복원 동일
- 저장/불러오기 라운드트립 동일

### 6.2 Severance 신규 확인

- Severance Light: 5탭 전부 렌더 확인 (설정/사전입력/분석/스케줄/저장)
- Severance Dark: 그리드만 변화, 나머지 동일 확인
- Theme 토글: Classic ↔ Severance 전환 시 상태 유실 없음
- Mode 토글: Light ↔ Dark 전환 시 상태 유실 없음
- 4가지 조합 (Classic L/D, Severance L/D) 전부 스크린샷

### 6.3 엣지 케이스

- `@supports not (backdrop-filter)` 폴백 동작 — DevTools에서 `will-change: none; backdrop-filter: none;` 강제로 테스트
- 인쇄 뷰: `@media print` → 네이비 배경 제거, flat 그리드
- localStorage 비어있는 상태 → Severance Light 디폴트
- 기존 사용자(`darkMode=true` 있음) → Severance Dark로 자동 전환 확인

### 6.4 성능

- Chrome DevTools Performance 탭에서 테마 전환 60fps 유지 확인
- 저사양 PC (내장 GPU) 시뮬레이션으로 스크롤 시 드롭프레임 확인
- 20명 × 31일 그리드 렌더 시간 비교 (Classic vs Severance)

### 6.5 수동 검증

`main.py` 실행 → 브라우저 http://localhost:5757 → 4가지 조합을 한 번씩 확인하며 체크리스트:
- [ ] 사이드바 로고 선명하게 보임
- [ ] 그리드 숫자/시프트 색 판독 가능
- [ ] 모달 열었을 때 뒤 화면 자연스럽게 blur
- [ ] 프로필 화면도 동일한 언어로
- [ ] 네이비 배경에서도 빨강(일요일)/공휴일 표시 눈에 띔

---

## 7. 롤백 계획

Severance 테마에서 문제 발생 시:

1. **즉시 완화** (코드 변경 없이):
   - 사용자: 설정 → 테마 → Classic 선택
   - 또는 개발자: DevTools → `localStorage.setItem('theme','classic')` + 새로고침

2. **부분 롤백** (핫픽스):
   - `frontend/index.html`에서 `<link href="css/severance.css">` 주석 처리
   - `js/app.js`에서 `this.theme` 기본값을 `'classic'`으로 고정
   - 한 줄씩 2개 변경, 재배포

3. **전체 롤백**:
   - `git revert <v5-severance 병합 커밋>` + 재배포
   - `app.css`를 손대지 않았으므로 충돌 없음

---

## 8. 마이그레이션 전략

### 8.1 기존 사용자

v4.0.6 → v5.0.0 업그레이드 시:
1. 프로필 데이터는 그대로 (DB 변경 없음)
2. 첫 기동 시 `localStorage.getItem('theme')` 확인 → `null`이면 `severance` 저장
3. 기존 `darkMode` 값은 유지 (Light 대부분)
4. 결과: 기존 사용자도 `Severance Light`로 진입

### 8.2 Classic 테마 라이프사이클

v5.0 → v5.x 동안 Classic 유지. v6에서 deprecate 여부 재검토. 사용자가 Classic 선호하면 제거 안 함.

### 8.3 관련 문서 업데이트

- `CLAUDE.md`: 테마 시스템 섹션 추가
- `MANUAL.md`: 테마 전환 방법 스크린샷 추가
- `README.md`: 다운로드 섹션 v5.0.0 링크
- `docs/decisions.md`: "Severance 네이비 브랜드 색상 채택 — 용인세브란스병원 공식 색 #013378" 기록

---

## 9. 버전 정책

- **브랜치**: `v5-severance`
- **태그**: `v5.0.0`
- **동기화 필요 파일**:
  - `electron/package.json` (`"version": "5.0.0"`)
  - `electron/preload.js` (`version: '5.0.0'`)
  - `installer/setup.iss` (`AppVersion "5.0.0"`)
  - `frontend/index.html` (버전 표시 라인 `v5.0.0 · Electron `)
  - `README.md` (다운로드 섹션)
  - `CLAUDE.md` (최신 버전 표기)

릴리즈 단계:
1. v5 브랜치에서 구현 + 로컬 검증
2. 내부 테스트 빌드 — `NurseScheduler_Setup_v5.0.0-beta.exe`
3. 사용자 1명 대상 베타 (수간호사 본인)
4. 피드백 반영 → v5.0.0 정식 릴리즈
5. README, CLAUDE.md 최종 업데이트 → main 병합

---

## 10. 오픈 이슈 (Open Questions)

구현 착수 전 아직 미결정된 작은 항목들:

1. **아이콘 세트**: 현재 사이드바에 이모지 (`⚙✏📊📅💾`) 사용 중. Severance에서 lucide 아이콘으로 교체할지? (이미 `lucide.min.js` 번들됨)
2. **로고 크기**: 사이드바 하단 로고 카드가 너무 크면 사이드바 압박. 40px 높이 제안.
3. **Classic 테마 색상 업데이트**: Classic도 소소한 정리를 할지, 완전 유지할지. 기본은 **완전 유지** 권장.
4. **Theme picker 레이블**: "테마" vs "디자인" vs "스킨"? 내부 논의.

이 항목들은 writing-plans 단계에서 결정 또는 구현 중 확인.

---

## 11. 승인 내역

- 2026-04-19 : 브레인스토밍 완료 (`docs/session_notes/2026-04-19.md`)
- 2026-04-19 : 디자인 승인 (사용자)
- 2026-04-19 : 이 spec 문서 작성
- 다음 단계: `writing-plans` 스킬로 구현 계획 수립
