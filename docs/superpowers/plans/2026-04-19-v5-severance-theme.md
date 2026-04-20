# v5 Severance Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NurseScheduler v4 위에 Apple iOS 26 Liquid Glass 미학 기반 Severance Theme를 추가하여 v5.0.0 출시한다. Classic 테마는 공존 유지, 신규+기존 사용자 모두 Severance Light 디폴트로 진입.

**Architecture:** `frontend/css/severance.css` 단일 파일로 `html.severance` / `html.severance.dark` 다축 CSS 레이어링. 기존 `app.css`는 거의 건드리지 않아 롤백 안전성 확보. CSS 변수 기반 오버라이드 + `backdrop-filter` 유리 효과 + 그리드 셀은 flat 유지(성능).

**Tech Stack:** HTML + Tailwind CSS (CDN) + Alpine.js (기존) + 신규 vanilla CSS 파일. JS 상태는 Alpine 컴포넌트 `app()` 내 속성으로 통합. localStorage로 `theme`, `darkMode` 영속화.

**Related spec:** [`docs/superpowers/specs/2026-04-19-v5-severance-theme-design.md`](../specs/2026-04-19-v5-severance-theme-design.md)

---

## 중요 사전 원칙

1. **Classic 테마는 변경 금지**. `frontend/css/app.css` 편집은 마지막 수단. 꼭 필요하면 해당 규칙을 `html:not(.severance)` 스코프로 한정하는 방식 검토.
2. **각 task는 브라우저에서 시각 검증**이 마지막 단계. "커밋 전 반드시 `py main.py` 실행 후 해당 화면 확인" 원칙.
3. **4가지 테마 조합**: Classic Light / Classic Dark / Severance Light / Severance Dark. 각 주요 task 후 4가지 모두 동작하는지 스모크 확인.
4. **커밋 메시지 규칙**: `feat(v5):`, `style(v5):`, `fix(v5):` 접두어 사용. 본문에 영향받은 컴포넌트 명시.
5. **TDD 대상**: JS 로직 (theme toggle, migration). CSS는 시각 검증으로 대체.

---

## Phase 0 — Scaffolding (비파괴)

### Task 0.1: 버전 번호 v5.0.0-alpha로 bump

**Files:**
- Modify: `electron/package.json:3`
- Modify: `electron/preload.js:9`
- Modify: `installer/setup.iss:8`
- Modify: `frontend/index.html` (v4.0.6 문자열 위치 2곳)

- [ ] **Step 1: 버전 문자열 일괄 교체**

```bash
cd /c/Users/Helios_Neo_18/nurse-v4
grep -rn "4\.0\.6\|v4\.0\.6" electron/ installer/ frontend/index.html | head
```

Expected: 버전 문자열 위치 3~5곳 확인

- [ ] **Step 2: 각 파일에서 `4.0.6` → `5.0.0-alpha`**

`electron/package.json`: `"version": "5.0.0-alpha"`
`electron/preload.js`: `version: '5.0.0-alpha'`
`installer/setup.iss`: `#define AppVersion "5.0.0-alpha"`
`frontend/index.html`: `x-text="'v5.0.0-alpha · Electron ' + ..."`

- [ ] **Step 3: 서버 기동 후 브라우저에서 사이드바 하단 버전 확인**

```bash
py main.py
```
Expected: 사이드바 하단에 `v5.0.0-alpha · Electron 5.0.0-alpha`

- [ ] **Step 4: Commit**

```bash
git add electron/package.json electron/preload.js installer/setup.iss frontend/index.html
git commit -m "chore(v5): 버전 번호 v5.0.0-alpha로 bump"
```

---

### Task 0.2: severance.css 빈 파일 생성 + index.html에서 로드

**Files:**
- Create: `frontend/css/severance.css`
- Modify: `frontend/index.html:7` (CSS <link> 섹션)

- [ ] **Step 1: 빈 severance.css 생성**

```css
/* ═══════════════════════════════════════════════════════════
   NurseScheduler v5 — Severance Theme
   Apple iOS 26 Liquid Glass 미학 + 용인세브란스병원 네이비
   활성화: <html class="severance"> 또는 <html class="severance dark">
   ═══════════════════════════════════════════════════════════ */

/* Placeholder — 이후 task에서 스타일 추가 */
```

- [ ] **Step 2: index.html에 <link> 추가**

`frontend/index.html:7` 뒤에 다음 라인 추가:

```html
  <link rel="stylesheet" href="css/severance.css"/>
```

- [ ] **Step 3: DevTools Network 탭에서 `severance.css` 200 OK 확인**

- [ ] **Step 4: Commit**

```bash
git add frontend/css/severance.css frontend/index.html
git commit -m "feat(v5): severance.css 스캐폴드 + index.html 로드"
```

---

### Task 0.3: Alpine 상태에 theme 추가 (no-op)

**Files:**
- Modify: `frontend/js/app.js` (state 선언부 ~line 39 darkMode 근처)

- [ ] **Step 1: 상태 추가**

`darkMode` 선언 바로 아래에 추가:

```javascript
    theme: localStorage.getItem('theme') || 'classic',  // 아직 migration 없음
```

- [ ] **Step 2: Toggle 함수 스텁 추가 (toggleDark 근처)**

```javascript
    toggleTheme(t){
      this.theme = t;
      document.documentElement.classList.toggle('severance', t === 'severance');
      localStorage.setItem('theme', t);
    },
```

- [ ] **Step 3: init()에서 초기 class 반영**

`init()` 함수 내 `if(this.darkMode)...` 라인 근처에 추가:

```javascript
      if(this.theme === 'severance') document.documentElement.classList.add('severance');
```

- [ ] **Step 4: DevTools Console에서 수동 테스트**

```javascript
// 브라우저 콘솔에서
Alpine.$data(document.body).toggleTheme('severance');
document.documentElement.classList.contains('severance'); // true
Alpine.$data(document.body).toggleTheme('classic');
document.documentElement.classList.contains('severance'); // false
```

- [ ] **Step 5: Commit**

```bash
git add frontend/js/app.js
git commit -m "feat(v5): theme 상태 + toggleTheme() 스텁 추가"
```

---

## Phase 1 — Severance 베이스 CSS

### Task 1.1: CSS 변수 정의

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 변수 블록 추가 (severance.css 상단)**

```css
html.severance {
  /* 네이비 베이스 */
  --sev-bg: #013378;
  --sev-glow-1: rgba(96, 165, 250, 0.25);   /* 우상단 hover */
  --sev-glow-2: rgba(147, 197, 253, 0.15);  /* 좌하단 subtle */

  /* 유리 표면 */
  --sev-glass-bg: rgba(255, 255, 255, 0.08);
  --sev-glass-bg-strong: rgba(255, 255, 255, 0.12);
  --sev-glass-border: rgba(255, 255, 255, 0.15);
  --sev-glass-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.2);
  --sev-glass-blur: 20px;

  /* 그리드 (라이트 기본) */
  --sev-grid-bg: rgba(255, 255, 255, 0.82);
  --sev-grid-border: rgba(255, 255, 255, 0.5);
  --sev-grid-blur: 16px;
  --sev-grid-text: #1f2937;
  --sev-grid-sub: #6b7280;

  /* 텍스트 (네이비 위) */
  --sev-text: rgba(255, 255, 255, 0.92);
  --sev-text-sub: rgba(255, 255, 255, 0.65);
  --sev-text-dim: rgba(255, 255, 255, 0.45);

  /* 액센트 */
  --sev-accent: #60a5fa;
  --sev-accent-hover: #93c5fd;
  --sev-accent-solid: #013378;

  /* 기존 app.css 변수 오버라이드 (필요 시 추가) */
  --bg: var(--sev-bg);
  --text: var(--sev-text);
  --text-sub: var(--sev-text-sub);
  --accent: var(--sev-accent);
  --border: var(--sev-glass-border);
}

html.severance.dark {
  --sev-grid-bg: rgba(0, 0, 0, 0.25);
  --sev-grid-border: rgba(255, 255, 255, 0.1);
  --sev-grid-text: rgba(255, 255, 255, 0.9);
  --sev-grid-sub: rgba(255, 255, 255, 0.55);
}
```

- [ ] **Step 2: DevTools Elements → html → 해당 변수 활성화 확인**

```javascript
// Console
document.documentElement.classList.add('severance');
getComputedStyle(document.documentElement).getPropertyValue('--sev-bg'); // "#013378"
```

- [ ] **Step 3: Commit**

```bash
git add frontend/css/severance.css
git commit -m "feat(v5): Severance CSS 변수 정의 (light/dark 공통)"
```

---

### Task 1.2: body 배경 + radial glow

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: body 규칙 추가**

```css
/* Severance 배경: 네이비 + radial glow */
html.severance body {
  background: var(--sev-bg);
  color: var(--sev-text);
}

html.severance body::before {
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(ellipse at top right, var(--sev-glow-1) 0%, transparent 50%),
    radial-gradient(ellipse at bottom left, var(--sev-glow-2) 0%, transparent 40%);
  z-index: -1;
  pointer-events: none;
}
```

- [ ] **Step 2: 브라우저 확인 (클래스 수동 토글)**

```javascript
document.documentElement.classList.add('severance');
// Expected: 배경이 네이비 + 우상단 하늘색 glow
document.documentElement.classList.remove('severance');
// Expected: 원래 v4 배경 복귀
```

- [ ] **Step 3: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 네이비 배경 + radial glow 추가"
```

---

### Task 1.3: 유리 공용 클래스 (.sev-glass)

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 유리 효용 클래스 추가**

```css
/* 유리 표면 공용 — .sev-glass / .sev-glass-strong */
html.severance .sev-glass {
  background: var(--sev-glass-bg);
  backdrop-filter: blur(var(--sev-glass-blur));
  -webkit-backdrop-filter: blur(var(--sev-glass-blur));
  border: 1px solid var(--sev-glass-border);
  border-radius: 16px;
  box-shadow: var(--sev-glass-highlight);
}

html.severance .sev-glass-strong {
  background: var(--sev-glass-bg-strong);
  backdrop-filter: blur(var(--sev-glass-blur));
  -webkit-backdrop-filter: blur(var(--sev-glass-blur));
  border: 1px solid var(--sev-glass-border);
  border-radius: 16px;
  box-shadow: var(--sev-glass-highlight);
}

/* 성능 힌트: 전환 시에만 */
html.severance .sev-glass,
html.severance .sev-glass-strong {
  transition: background-color 0.2s ease, border-color 0.2s ease;
}
```

- [ ] **Step 2: 임시 테스트 요소로 확인**

DevTools Console에서:
```javascript
const t = document.createElement('div');
t.className = 'sev-glass';
t.style.cssText = 'position:fixed;top:100px;left:100px;width:200px;height:100px;';
t.textContent = 'Glass Test';
document.body.appendChild(t);
// Expected: 투명 유리 카드가 네이비 배경 위에 떠 있음
t.remove();
```

- [ ] **Step 3: Commit**

```bash
git add frontend/css/severance.css
git commit -m "feat(v5): .sev-glass / .sev-glass-strong 공용 유리 클래스"
```

---

### Task 1.4: @supports 폴백

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 폴백 규칙 추가 (severance.css 하단)**

```css
/* backdrop-filter 미지원 브라우저 폴백 */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  html.severance .sev-glass,
  html.severance .sev-glass-strong {
    background: rgba(1, 51, 120, 0.85);
    border-color: rgba(255, 255, 255, 0.2);
  }
}
```

- [ ] **Step 2: DevTools에서 강제 비활성화로 확인**

DevTools → Rendering 패널 → "Emulate CSS media feature `not (backdrop-filter)`"

Expected: 카드가 투명 유리 대신 짙은 네이비 반투명으로 렌더

- [ ] **Step 3: Commit**

```bash
git add frontend/css/severance.css
git commit -m "feat(v5): backdrop-filter 미지원 브라우저 폴백"
```

---

## Phase 2 — Theme Toggle Mechanics

### Task 2.1: Migration 로직 (기존 사용자 → Severance Light)

**Files:**
- Modify: `frontend/js/app.js` (init 함수)

- [ ] **Step 1: init() 첫 부분에 마이그레이션 추가**

```javascript
    async init(){
      // v5 migration: theme 키 없으면 severance 디폴트
      if(!localStorage.getItem('theme')){
        localStorage.setItem('theme', 'severance');
        this.theme = 'severance';
      }
      // 기존 class 반영
      if(this.theme === 'severance') document.documentElement.classList.add('severance');
      if(this.darkMode) document.documentElement.classList.add('dark');
      // ... (기존 나머지 로직)
```

- [ ] **Step 2: 브라우저 테스트 — theme 키 삭제 후 새로고침**

```javascript
localStorage.removeItem('theme');
location.reload();
// Expected: Severance 테마로 진입. localStorage.getItem('theme') === 'severance'
```

- [ ] **Step 3: 기존 classic 값 있는 경우 유지 확인**

```javascript
localStorage.setItem('theme', 'classic');
location.reload();
// Expected: Classic 테마 유지
```

- [ ] **Step 4: Commit**

```bash
git add frontend/js/app.js
git commit -m "feat(v5): theme localStorage 미설정 시 severance 디폴트 마이그레이션"
```

---

### Task 2.2: 사이드바에 Theme + Mode 2축 토글 UI

**Files:**
- Modify: `frontend/index.html` (사이드바 하단, 다크모드 토글 근처)

현재 다크모드 토글 위치를 grep으로 찾아 거기를 확장.

- [ ] **Step 1: 위치 확인**

```bash
grep -n "toggleDark\|darkMode" frontend/index.html | head -5
```

- [ ] **Step 2: 기존 다크 토글을 2축 컨트롤로 교체**

기존:
```html
<button @click="toggleDark()">🌗</button>  <!-- 예시 위치 -->
```

신규:
```html
<!-- Theme + Mode 2축 피커 (사이드바 하단) -->
<div class="sidebar-theme-picker" style="display:flex;flex-direction:column;gap:6px;padding:8px">
  <!-- Theme 토글 -->
  <div style="display:flex;gap:4px">
    <button @click="toggleTheme('classic')"
            :class="theme==='classic'?'btn-primary':'btn-ghost'"
            class="btn btn-xs flex-1" style="font-size:0.65rem">Classic</button>
    <button @click="toggleTheme('severance')"
            :class="theme==='severance'?'btn-primary':'btn-ghost'"
            class="btn btn-xs flex-1" style="font-size:0.65rem">Severance</button>
  </div>
  <!-- Mode 토글 -->
  <div style="display:flex;gap:4px">
    <button @click="!darkMode||toggleDark()"
            :class="!darkMode?'btn-primary':'btn-ghost'"
            class="btn btn-xs flex-1" style="font-size:0.65rem">🌞 Light</button>
    <button @click="darkMode||toggleDark()"
            :class="darkMode?'btn-primary':'btn-ghost'"
            class="btn btn-xs flex-1" style="font-size:0.65rem">🌙 Dark</button>
  </div>
</div>
```

- [ ] **Step 3: 네 가지 조합 수동 클릭 테스트**

- [ ] Classic Light → 기존 v4 화면
- [ ] Classic Dark → 기존 v4 다크
- [ ] Severance Light → 네이비 + 흰 유리 (현재는 베이스만)
- [ ] Severance Dark → 네이비 + 검정 유리 (현재는 베이스만)

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html
git commit -m "feat(v5): 사이드바 Theme + Mode 2축 토글 UI"
```

---

## Phase 3 — 사이드바 + 글로벌 레이아웃

### Task 3.1: 사이드바 유리 처리

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: .sidebar 오버라이드 추가**

```css
/* ─── Sidebar ─── */
html.severance .sidebar {
  background: var(--sev-glass-bg);
  backdrop-filter: blur(var(--sev-glass-blur));
  -webkit-backdrop-filter: blur(var(--sev-glass-blur));
  border: 1px solid var(--sev-glass-border);
  border-radius: 16px;
  margin: 12px;
  box-shadow: var(--sev-glass-highlight);
  height: calc(100vh - 24px);
}

html.severance .sidebar-logo {
  color: var(--sev-text);
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

html.severance .sidebar-item {
  color: var(--sev-text-sub);
  border-radius: 9px;
  margin: 2px 0;
}

html.severance .sidebar-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--sev-text);
}

html.severance .sidebar-item.active {
  background: rgba(255, 255, 255, 0.15);
  color: var(--sev-text);
  font-weight: 600;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
}
```

- [ ] **Step 2: 브라우저 확인 (Severance 전환 후 사이드바)**

- [ ] 네이비 배경 위로 유리 카드 형태로 사이드바 렌더링
- [ ] 활성 탭은 더 밝은 배경
- [ ] hover 시 살짝 밝아짐

- [ ] **Step 3: Classic 모드 회귀 확인**

- [ ] Classic Light로 돌아갔을 때 사이드바 원래 v4 모양

- [ ] **Step 4: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 사이드바 유리 처리 + hover/active 상태"
```

---

### Task 3.2: 병원 로고 카드

**Files:**
- Modify: `frontend/index.html` (사이드바 하단, 프로필 badge 바로 위)
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 프로필 badge 위치 grep**

```bash
grep -n "sidebar-bottom\|프로필\|profile-badge\|currentProfile" frontend/index.html | head -10
```

- [ ] **Step 2: 로고 HTML 삽입 (프로필 badge 위)**

```html
<!-- Severance 테마에서만 보이는 병원 로고 -->
<div x-show="theme==='severance'" class="sev-hospital-logo">
  <img src="assets/yongin-severance-logo.png" alt="용인세브란스병원" loading="lazy"/>
</div>
```

- [ ] **Step 3: CSS 추가 (severance.css)**

```css
/* ─── 병원 로고 카드 ─── */
html.severance .sev-hospital-logo {
  margin: 8px 8px 6px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.92);
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  text-align: center;
}

html.severance .sev-hospital-logo img {
  max-width: 100%;
  height: 40px;
  object-fit: contain;
  display: block;
  margin: 0 auto;
}
```

- [ ] **Step 4: Classic 테마에서 숨김 확인 (`x-show` 작동)**

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/css/severance.css
git commit -m "feat(v5): 사이드바 하단 용인세브란스 로고 카드 (Severance 전용)"
```

---

### Task 3.3: 프로필 badge 재스타일 + app-shell padding

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 프로필 + app-shell 규칙 추가**

```css
/* ─── App shell padding (유리 사이드바 여백 확보) ─── */
html.severance .app-shell {
  padding: 0;
}

/* ─── 프로필 badge ─── */
html.severance .profile-badge {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--sev-text);
}

html.severance .profile-badge:hover {
  background: rgba(255, 255, 255, 0.1);
}
```

- [ ] **Step 2: 브라우저 확인**

- [ ] 프로필 카드가 로고 아래 자연스럽게 위치
- [ ] hover 시 살짝 밝아짐

- [ ] **Step 3: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 프로필 badge Severance 톤 조정"
```

---

## Phase 4 — 스케줄 탭

### Task 4.1: 상단 헤더 (년월 + 생성/저장 버튼)

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 스케줄 탭 헤더 위치 확인**

```bash
grep -n "scheduleGenOptions\|stopGenerate\|생성\|saveSchedule" frontend/index.html | head -10
```

기존 컨트롤 영역을 래핑하는 컨테이너 클래스 확인.

- [ ] **Step 2: CSS 추가 — 년월 컨트롤 + 버튼 영역을 glass로**

```css
/* ─── 스케줄/사전입력 상단 컨트롤 바 ─── */
html.severance .content > .ym-bar,
html.severance .content .top-controls {
  background: var(--sev-glass-bg);
  backdrop-filter: blur(var(--sev-glass-blur));
  -webkit-backdrop-filter: blur(var(--sev-glass-blur));
  border: 1px solid var(--sev-glass-border);
  border-radius: 12px;
  padding: 10px 16px;
  box-shadow: var(--sev-glass-highlight);
}

html.severance .ym input {
  background: transparent;
  color: var(--sev-text);
  border: none;
}

html.severance .ym-lbl,
html.severance .ym-nav {
  color: var(--sev-text-sub);
}
```

실제 HTML에 `ym-bar` 또는 `top-controls` 클래스가 없을 수 있음 — grep으로 확인 후 래퍼 요소 적절히 선정.

- [ ] **Step 3: 버튼 그라디언트**

```css
html.severance .btn-primary {
  background: linear-gradient(135deg, #60a5fa, #3b82f6);
  border: 1px solid rgba(255, 255, 255, 0.3);
  color: #fff;
  box-shadow: 0 2px 8px rgba(96, 165, 250, 0.3);
}

html.severance .btn-primary:hover {
  background: linear-gradient(135deg, #93c5fd, #60a5fa);
  transform: translateY(-1px);
}

html.severance .btn-ghost {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: var(--sev-text);
}

html.severance .btn-ghost:hover {
  background: rgba(255, 255, 255, 0.15);
}
```

- [ ] **Step 4: 브라우저 확인 (스케줄 탭)**

- [ ] Severance Light/Dark 둘 다 년월 input 텍스트 또렷
- [ ] 저장 버튼이 그라디언트 + glow
- [ ] Classic Light/Dark에서는 v4 원형 유지

- [ ] **Step 5: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 스케줄 탭 상단 컨트롤 바 + 버튼 유리/그라디언트"
```

---

### Task 4.2: 근무표 그리드 래퍼 (반투명)

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 그리드 테이블 래퍼 클래스 확인**

```bash
grep -n "schedule-table\|prev-table\|<table" frontend/index.html | head -10
```

스케줄/사전입력의 `<table>` 래퍼 클래스 확인. 없으면 `.content table` 로 일괄 처리.

- [ ] **Step 2: 그리드 pane CSS 추가**

```css
/* ─── 근무표 그리드 래퍼 ─── */
html.severance .content table.tbl,
html.severance .content .grid-wrapper {
  background: var(--sev-grid-bg);
  backdrop-filter: blur(var(--sev-grid-blur));
  -webkit-backdrop-filter: blur(var(--sev-grid-blur));
  border-radius: 12px;
  border: 1px solid var(--sev-grid-border);
  padding: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.5);
  color: var(--sev-grid-text);
}

/* 셀 자체는 flat (블러 적용 X — 성능) */
html.severance .content table.tbl th,
html.severance .content table.tbl td {
  /* 배경은 기존 v4 app.css 규칙 유지 */
}

/* 다크 그리드 모드 */
html.severance.dark .content table.tbl,
html.severance.dark .content .grid-wrapper {
  background: var(--sev-grid-bg);  /* rgba(0,0,0,0.25) via 변수 */
  color: var(--sev-grid-text);
}
```

- [ ] **Step 3: 브라우저 확인**

- [ ] Severance Light: 그리드가 흰 반투명 유리 위에 렌더링
- [ ] Severance Dark: 그리드가 검정 반투명 유리, 텍스트는 밝은 회색
- [ ] Classic 테마: 영향 없음

- [ ] **Step 4: 스크롤 성능 체크**

Chrome DevTools → Performance → 20명×31일 그리드 스크롤 30초 녹화 → 60fps 유지 확인

- [ ] **Step 5: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 근무표 그리드 반투명 유리 래퍼 (라이트/다크)"
```

---

### Task 4.3: 시프트 색상 다크 모드 조정

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 기존 시프트 클래스 확인**

```bash
grep -n "schedule-cell-text\|shift-" frontend/css/app.css | head -20
```

D/E/N/OF/주/V/생/법 등 시프트 클래스 확인.

- [ ] **Step 2: 다크 모드 시프트 톤 조정 추가**

```css
/* ─── 다크 그리드에서 시프트 색상 밝은 톤 ─── */
html.severance.dark .shift-D,
html.severance.dark .shift-DC {
  background: rgba(59, 130, 246, 0.22);
  color: #93c5fd;
}

html.severance.dark .shift-E,
html.severance.dark .shift-EC {
  background: rgba(34, 197, 94, 0.22);
  color: #86efac;
}

html.severance.dark .shift-N,
html.severance.dark .shift-NC {
  background: rgba(251, 191, 36, 0.22);
  color: #fcd34d;
}

html.severance.dark .shift-OF {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.6);
}

html.severance.dark .shift-주 {
  background: rgba(129, 140, 248, 0.22);
  color: #c7d2fe;
}

html.severance.dark .shift-V {
  background: rgba(236, 72, 153, 0.2);
  color: #f9a8d4;
}

html.severance.dark .shift-법,
html.severance.dark .shift-공,
html.severance.dark .shift-특,
html.severance.dark .shift-생,
html.severance.dark .shift-병 {
  /* 각각 조정 — 필요 시 추가 */
}
```

실제 클래스명이 다르면 `getShiftStyle()` 동적 인라인 스타일인지 확인. 인라인이면 app.js의 해당 함수에 theme 분기 추가.

- [ ] **Step 3: 브라우저에서 Severance Dark로 전환 후 모든 시프트 색 확인**

- [ ] D/E/N: 파랑/초록/노랑 밝은 톤
- [ ] OF: 회색 연하게
- [ ] 주: 보라 연하게
- [ ] V/생/법 등: 가독성 확보

- [ ] **Step 4: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 다크 그리드용 시프트 색상 밝은 톤 조정"
```

---

### Task 4.4: 인쇄 스타일 (@media print)

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 인쇄 규칙 추가**

```css
/* ─── 인쇄: 네이비 배경 제거, flat white ─── */
@media print {
  html.severance body { background: #fff !important; color: #000 !important; }
  html.severance body::before { display: none !important; }
  html.severance .sidebar,
  html.severance .sev-hospital-logo,
  html.severance .sidebar-theme-picker { display: none !important; }
  html.severance .content table.tbl,
  html.severance .content .grid-wrapper {
    background: #fff !important;
    backdrop-filter: none !important;
    border: 1px solid #000 !important;
    color: #000 !important;
    box-shadow: none !important;
  }
}
```

- [ ] **Step 2: 인쇄 미리보기 확인**

Chrome 인쇄 프리뷰 (Ctrl+P) → Severance Light에서도 흰 배경 + 검정 텍스트 + 그리드 또렷

- [ ] **Step 3: Commit**

```bash
git add frontend/css/severance.css
git commit -m "feat(v5): 인쇄 시 네이비 제거 + flat 화이트 강제"
```

---

## Phase 5 — 나머지 탭

### Task 5.1: 사전입력 탭

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 사전입력 탭 구조 확인**

```bash
grep -n "activeTab==='preinput'\|prevSchedule" frontend/index.html | head -5
```

스케줄 탭과 거의 동일 구조. 그리드 규칙은 이미 Task 4.2에서 적용됨.

- [ ] **Step 2: 추가로 조정 필요한 영역 (메모/잠금/저장 패널)**

```css
/* 사전입력 저장 패널, 메모 배지 등 */
html.severance .prev-save-panel {
  background: var(--sev-glass-bg);
  backdrop-filter: blur(var(--sev-glass-blur));
  border: 1px solid var(--sev-glass-border);
  border-radius: 12px;
  color: var(--sev-text);
}

html.severance .note-badge,
html.severance .lock-badge {
  background: rgba(255, 255, 255, 0.15);
  color: var(--sev-text);
  border: 1px solid rgba(255, 255, 255, 0.25);
}
```

실제 클래스명은 grep으로 확인 후 맞춤.

- [ ] **Step 3: 브라우저 확인 — Severance Light/Dark에서 사전입력 탭 전체 렌더**

- [ ] **Step 4: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 사전입력 탭 저장 패널 · 메모/잠금 배지 유리"
```

---

### Task 5.2: 분석 탭 (히트맵 + 주휴 추천)

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 분석 탭 카드 래퍼 찾기**

```bash
grep -n "activeTab==='analysis'\|히트맵\|heatmap" frontend/index.html | head -5
```

- [ ] **Step 2: 카드 glass화**

```css
/* ─── 분석 탭 카드들 ─── */
html.severance .content .analysis-section,
html.severance .content .card-sm {
  background: var(--sev-glass-bg);
  backdrop-filter: blur(var(--sev-glass-blur));
  -webkit-backdrop-filter: blur(var(--sev-glass-blur));
  border: 1px solid var(--sev-glass-border);
  border-radius: 12px;
  color: var(--sev-text);
  box-shadow: var(--sev-glass-highlight);
}

/* 히트맵 셀은 기존 색상 유지 (의미 전달용) */
html.severance .heatmap-cell {
  /* app.css 규칙 그대로 */
}

/* 주휴 추천 "적용" 버튼 — tinted glass */
html.severance .juhu-apply-btn {
  background: rgba(96, 165, 250, 0.2);
  border: 1px solid rgba(96, 165, 250, 0.35);
  color: var(--sev-accent-hover);
}

html.severance .juhu-apply-btn:hover {
  background: rgba(96, 165, 250, 0.3);
}
```

- [ ] **Step 3: 브라우저 확인 — 분석 탭**

- [ ] 히트맵 자체 색은 유지(빨강/주황/초록)
- [ ] 카드 래퍼는 유리
- [ ] 주휴 추천 테이블 + 적용 버튼 일관성

- [ ] **Step 4: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 분석 탭 카드 유리 + 주휴 적용 버튼 tinted"
```

---

### Task 5.3: 설정 탭 (섹션 카드)

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 설정 탭 섹션 구조 확인**

```bash
grep -n "activeTab==='settings'\|settingsCollapse" frontend/index.html | head -10
```

- [ ] **Step 2: 섹션별 카드 스타일**

```css
/* ─── 설정 탭 섹션 카드 ─── */
html.severance [x-show*="activeTab==='settings'"] .card-sm,
html.severance .settings-section {
  background: var(--sev-glass-bg-strong);
  backdrop-filter: blur(var(--sev-glass-blur));
  -webkit-backdrop-filter: blur(var(--sev-glass-blur));
  border: 1px solid var(--sev-glass-border);
  border-radius: 14px;
  padding: 16px;
  margin-bottom: 12px;
  color: var(--sev-text);
}

html.severance .section-title {
  color: var(--sev-text);
}

/* 요일별 필요 인원 테이블 */
html.severance .content .req-table td {
  background: rgba(255, 255, 255, 0.04);
  color: var(--sev-text);
  border-color: rgba(255, 255, 255, 0.08);
}

/* input 필드 */
html.severance input[type="text"],
html.severance input[type="number"],
html.severance input[type="password"],
html.severance input:not([type]),
html.severance textarea,
html.severance select {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: var(--sev-text);
}

html.severance input:focus,
html.severance textarea:focus,
html.severance select:focus {
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--sev-accent);
  box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.25);
}

html.severance input::placeholder,
html.severance textarea::placeholder {
  color: var(--sev-text-dim);
}
```

- [ ] **Step 3: 브라우저 확인**

- [ ] 간호사 목록 · 규칙 · 요구인원 · 근무 · 배점 섹션 모두 glass 카드
- [ ] input 필드 유리 배경 + focus 시 파란 글로우

- [ ] **Step 4: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 설정 탭 섹션 유리 카드 + input 필드"
```

---

### Task 5.4: 저장 탭

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 저장 탭 리스트 아이템 클래스 확인**

```bash
grep -n "activeTab==='saved'\|savedSchedules" frontend/index.html | head -5
```

- [ ] **Step 2: 리스트 아이템 카드화**

```css
/* ─── 저장 탭 리스트 아이템 ─── */
html.severance .saved-item,
html.severance [x-show*="activeTab==='saved'"] .card-sm {
  background: var(--sev-glass-bg);
  backdrop-filter: blur(var(--sev-glass-blur));
  border: 1px solid var(--sev-glass-border);
  border-radius: 10px;
  color: var(--sev-text);
  padding: 12px 16px;
  margin-bottom: 8px;
}

html.severance .saved-item:hover {
  background: rgba(255, 255, 255, 0.12);
}
```

- [ ] **Step 3: 브라우저 확인 — 저장된 스케줄 목록 렌더**

- [ ] **Step 4: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 저장 탭 저장본 리스트 유리 카드"
```

---

## Phase 6 — 모달 & 오버레이

### Task 6.1: 모달 공용 스타일

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 모달 오버레이 + 컨테이너**

```css
/* ─── 모달 ─── */
html.severance .modal-bg {
  background: rgba(1, 51, 120, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

html.severance .modal {
  background: var(--sev-glass-bg-strong);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid var(--sev-glass-border);
  border-radius: 16px;
  color: var(--sev-text);
  box-shadow:
    0 20px 60px rgba(0, 0, 0, 0.4),
    var(--sev-glass-highlight);
}

/* 모달 내부 input은 이미 Task 5.3에서 처리됨 */

/* 모달 헤더 */
html.severance .modal h3 {
  color: var(--sev-text);
}

/* 모달 footer 버튼은 기존 버튼 규칙 계승 */
```

- [ ] **Step 2: 다양한 모달 확인**

- [ ] 간호사 추가 모달
- [ ] 근무 편집 모달 (셀 우클릭)
- [ ] 메모 모달
- [ ] 단축키 도움말 모달
- [ ] 배점 규칙 모달
- [ ] CSV 에러 모달
- [ ] 스케줄 비교 모달

각 모달이 Severance Light/Dark에서 자연스럽게 렌더.

- [ ] **Step 3: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 모든 모달 유리 배경 + 네이비 오버레이"
```

---

### Task 6.2: 프로필 선택 화면 (앱 shell 외부)

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 프로필 오버레이 규칙**

```css
/* ─── 프로필 선택 오버레이 ─── */
html.severance .profile-overlay {
  background: var(--sev-bg) !important;
}

html.severance .profile-overlay > div:first-child {
  background: var(--sev-glass-bg-strong) !important;
  backdrop-filter: blur(var(--sev-glass-blur));
  border: 1px solid var(--sev-glass-border) !important;
  color: var(--sev-text) !important;
}

html.severance .profile-overlay h2,
html.severance .profile-overlay label {
  color: var(--sev-text);
}
```

인라인 스타일을 쓰는 요소들이 있으면 `!important` 불가피.

- [ ] **Step 2: 브라우저 확인**

- [ ] 프로필 선택 화면에서 네이비 배경 + 유리 카드
- [ ] 입력 필드 가독성 확보

- [ ] **Step 3: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 프로필 선택 오버레이 Severance 톤"
```

---

## Phase 7 — Polish

### Task 7.1: 트랜지션 & 인터랙션

**Files:**
- Modify: `frontend/css/severance.css`

- [ ] **Step 1: 전환 효과 추가**

```css
/* ─── 테마 전환 애니메이션 ─── */
body, .sidebar, .sev-glass, .sev-glass-strong,
.modal, .modal-bg, .content table.tbl,
.content .card-sm, .content .analysis-section {
  transition:
    background-color 0.25s ease,
    border-color 0.25s ease,
    color 0.25s ease;
}

/* 그리드 셀은 트랜지션 제외 (1000+ 요소 리플로우 방지) */
html.severance .content table.tbl th,
html.severance .content table.tbl td,
html.severance .g-cell {
  transition: none;
}
```

- [ ] **Step 2: 토글 시 부드러운 전환 확인**

Theme Classic ↔ Severance 전환 시 0.25초 부드럽게 변함

- [ ] **Step 3: Commit**

```bash
git add frontend/css/severance.css
git commit -m "style(v5): 테마 전환 250ms 부드러운 애니메이션"
```

---

### Task 7.2: 사전입력 `주(juhu)` 셀 명시적 색

이미 `.shift-주` 규칙이 있으면 Task 4.3에서 처리됨. 없으면 JS의 동적 인라인 스타일 분기 확인.

- [ ] **Step 1: 주 셀 클래스 확인**

```bash
grep -n "shift === '주'\|shift-주" frontend/js/app.js frontend/css/app.css | head -5
```

- [ ] **Step 2: 동적 인라인이면 `getShiftStyle()` 수정**

`getShiftStyle(code)` 함수가 Severance 테마 체크하도록:

```javascript
getShiftStyle(code){
  const s = this.shiftMap.get(code);
  if(!s) return {};
  const isSev = this.theme === 'severance';
  const isDark = this.darkMode;
  if(isSev && isDark){
    // Task 4.3에서 정의한 색 또는 여기서 lookup
    const darkSev = { D:{bg:'rgba(59,130,246,0.22)',color:'#93c5fd'}, /* ... */ };
    return darkSev[code] || {background: s.color_bg, color: s.color_text};
  }
  return {background: s.color_bg, color: s.color_text};
},
```

- [ ] **Step 3: 브라우저 4가지 조합 테스트**

- [ ] **Step 4: Commit**

```bash
git add frontend/js/app.js
git commit -m "feat(v5): getShiftStyle 테마별 시프트 색 분기"
```

---

## Phase 8 — 검증 & 릴리즈

### Task 8.1: 4가지 조합 × 5탭 스모크 테스트

테스트 매트릭스:

| 조합 | 설정 | 사전입력 | 분석 | 스케줄 | 저장 |
|---|:-:|:-:|:-:|:-:|:-:|
| Classic Light | [ ] | [ ] | [ ] | [ ] | [ ] |
| Classic Dark | [ ] | [ ] | [ ] | [ ] | [ ] |
| Severance Light | [ ] | [ ] | [ ] | [ ] | [ ] |
| Severance Dark | [ ] | [ ] | [ ] | [ ] | [ ] |

- [ ] **각 셀별 확인 항목**
  - 렌더 깨짐 없음
  - 텍스트 가독성 확보
  - 버튼/input 상호작용 정상
  - 색 구분 확실

- [ ] **서버 기동 후 체크리스트 완주**

```bash
py main.py
```

4×5 = 20 케이스 모두 확인. 문제 발견 시 해당 Phase로 돌아가 수정.

---

### Task 8.2: 성능 프로파일링

- [ ] **Chrome DevTools Performance**
  1. 20명 × 31일 스케줄 표시
  2. Record 시작 → 스크롤 30초 → Stop
  3. 60fps 유지 확인 (dropped frames < 5%)

- [ ] **메모리 프로파일**
  1. Severance Light 상태에서 30분 대기
  2. Memory 탭에서 heap leak 확인

- [ ] 만약 성능 이슈 시 `--sev-glass-blur`를 `20px → 10px`로 낮춰 재측정

---

### Task 8.3: 기존 저장본 · 기능 회귀 확인

- [ ] **저장/불러오기 라운드트립** (Classic + Severance 각 1회)
- [ ] **스케줄 생성** (최소 1회 실제 솔브)
- [ ] **사전입력 편집** (키보드 D/E/N/W + 셀 우클릭 메모/잠금)
- [ ] **프로필 전환** (게스트 ↔ 기존 프로필)

---

### Task 8.4: 문서 업데이트

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/decisions.md`
- Modify: `MANUAL.md`
- Modify: `README.md`

- [ ] **CLAUDE.md에 v5 섹션 추가**

```markdown
## 테마 시스템 (v5+)

- **Classic**: 기존 v4 디자인 (블루 액센트 #2563eb)
- **Severance**: 용인세브란스병원 네이비(#013378) + Liquid Glass

각 테마는 Light/Dark 모드 지원. `html.severance` + `html.severance.dark` 클래스로 제어.
로직: `frontend/js/app.js` — `toggleTheme()`, localStorage 키 `theme`.
CSS: `frontend/css/severance.css` (app.css는 Classic 전용).
```

- [ ] **decisions.md 기록**

```markdown
### 1-13. Severance 네이비 브랜드 색상 채택 (v5.0.0, 2026-04-19)
- **결정**: 용인세브란스병원 공식 색 `#013378`를 Severance 테마 베이스.
- **이유**: 병원 브랜드 일관성. Classic(#2563eb)와 구분 가능.
- **참조**: docs/superpowers/specs/2026-04-19-v5-severance-theme-design.md
```

- [ ] **MANUAL.md에 테마 전환 섹션**

```markdown
## 테마 전환

사이드바 하단에서 `Classic` / `Severance` 테마 + `Light` / `Dark` 모드 전환:
- Classic: 기존 친숙한 디자인
- Severance: 용인세브란스병원 네이비 + 최신 Liquid Glass
```

- [ ] **Commit**

```bash
git add CLAUDE.md docs/decisions.md MANUAL.md
git commit -m "docs(v5): Severance 테마 시스템 문서화"
```

---

### Task 8.5: 오픈 이슈 해결 (스펙 Section 10)

- [ ] **이슈 1: 아이콘 교체 (emoji → lucide)** — 별도 task, 이번 v5에서는 유지. `docs/decisions.md`에 "v5.1에서 재검토"로 기록
- [ ] **이슈 2: 로고 높이 40px** — Task 3.2에서 결정됨 ✓
- [ ] **이슈 3: Classic 테마 색상 업데이트** — 완전 유지 (변경 없음) ✓
- [ ] **이슈 4: Theme picker 레이블** — "Classic" / "Severance" 영문 그대로 (Task 2.2) ✓

---

### Task 8.6: 버전을 v5.0.0 beta로 bump + 빌드

- [ ] **Step 1: 버전 다시 bump**

`5.0.0-alpha` → `5.0.0-beta` (4곳)

- [ ] **Step 2: `README.md` 다운로드 섹션 업데이트**

Severance 테마 스크린샷 포함. 다운로드 링크는 아직 없음 (빌드 후 추가).

- [ ] **Step 3: 빌드**

```bash
build.bat
```

예상: `dist/installer/NurseScheduler_Setup_v5.0.0-beta.exe`

- [ ] **Step 4: 태그 + 릴리즈 (베타)**

```bash
git tag v5.0.0-beta
git push origin v5-severance v5.0.0-beta
gh release create v5.0.0-beta dist/installer/NurseScheduler_Setup_v5.0.0-beta.exe \
  dist/NurseScheduler_v4_portable.zip \
  --prerelease \
  --title "v5.0.0-beta — Severance Theme" \
  --notes-file docs/superpowers/specs/2026-04-19-v5-severance-theme-design.md
```

- [ ] **Step 5: 베타 테스터에게 공유 (사용자 본인 1인)**

문제 없으면 Task 8.7로.

---

### Task 8.7: 정식 v5.0.0 릴리즈

- [ ] **Step 1: 버전 `5.0.0-beta` → `5.0.0`**
- [ ] **Step 2: `README.md` 최신 릴리즈 링크 업데이트**
- [ ] **Step 3: 최종 빌드 + 태그 `v5.0.0`**
- [ ] **Step 4: v5-severance → main PR 생성**

```bash
gh pr create --base main --head v5-severance \
  --title "v5.0.0 — Severance Theme" \
  --body "Spec: docs/superpowers/specs/2026-04-19-v5-severance-theme-design.md"
```

- [ ] **Step 5: PR 병합 후 `v5.0.0` 태그 + 릴리즈 생성 (정식)**

---

## 커밋 전략 요약

- 각 task마다 1 커밋 (평균 ~25 커밋 예상)
- 접두어: `feat(v5):`, `style(v5):`, `fix(v5):`, `docs(v5):`, `chore(v5):`
- 주요 Phase 끝날 때마다 브라우저에서 4×5 매트릭스 스모크 확인
- 문제 시 해당 Phase 안에서 수정, 다음 Phase로 진행 전 승인

---

## 위험 요소 & 완화

| 위험 | 완화 |
|---|---|
| Classic 회귀 (app.css 무심코 변경) | Phase 별 브라우저 확인, git diff 검토 |
| backdrop-filter 성능 | 그리드 셀 미적용, @supports 폴백 |
| 인라인 스타일 충돌 | `!important` 최소 사용, JS 분기(Task 7.2) |
| 다크 시프트 색 가독성 부족 | Task 4.3 수동 확인, 필요 시 명도 재조정 |
| localStorage 마이그레이션 실패 | Task 2.1 여러 상태로 테스트 (빈/classic/severance) |

---

## 참고

- 설계 스펙: [`docs/superpowers/specs/2026-04-19-v5-severance-theme-design.md`](../specs/2026-04-19-v5-severance-theme-design.md)
- 세션 노트: [`docs/session_notes/2026-04-19.md`](../../session_notes/2026-04-19.md)
- 현재 v4 주요 파일: `frontend/css/app.css` (816줄), `frontend/js/app.js` (2132줄), `frontend/index.html` (1668줄)
- 브랜치: `v5-severance` (origin tracked)
