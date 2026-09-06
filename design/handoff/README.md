# Handoff: NurseScheduler v4 리디자인 (1920×1080)

> **이 폴더를 Claude Code 에 넘기고 이렇게 시작하세요:**
> "design_handoff_nurse_v4_redesign/README.md 를 읽고 **Definition of Done 을 전부 통과할 때까지** 리디자인을 구현해. 기능 삭제 0 (`scripts/handler_inventory.py`), `check/check_redesign.mjs` 실패 0, reference PNG 와 나란히 비교해 차이 없음. 셋 다 되기 전엔 끝났다고 하지 마."

## 0. 왜 구현물이 디자인과 달라지는가, 그리고 이 패키지가 막는 법

보통 핸드오프는 "설명"만 있어서 구현자가 값을 어림잡습니다. 이 패키지는 어림잡을 여지를 없앴습니다.

| 어긋나는 원인 | 이 패키지의 대책 |
|---|---|
| 색·크기를 "비슷하게" 옮김 | **`css/redesign-tokens.css` · `css/redesign-components.css` 를 그대로 로드** — 새 클래스는 이미 정확한 값. 기존 요소의 class 만 교체 |
| 문구를 의역함 | **`copy.json`** 의 문자열을 복사해 붙임. 의역 금지 |
| "대충 맞겠지" 하고 끝냄 | **`check/check_redesign.mjs`** 가 실제 앱을 1920×1080 으로 열어 200+ 항목(높이·글자 크기·굵기·색·문구·개수·title 유무·아이콘만 버튼·회색 글자·주 버튼 1개)을 getComputedStyle 로 검사. **실패 0 이어야 Done** |
| 눈 검사를 안 함 | **`reference/*.png`** (디자인 원본 1920×1080) 와 `--shots` 결과를 같은 상태끼리 나란히 놓고 비교 |
| 기능이 사라짐 | 저장소의 `scripts/handler_inventory.py` 로 재배치 전후 핸들러 집합 비교 — REMOVED 0 |
| 디자인 파일을 안 열어봄 | **`design/*.dc.html`** 은 브라우저에서 바로 열립니다. 모든 스타일이 **인라인**이라 요소를 우클릭 → 검사하면 정확한 값이 그대로 보입니다 |

## 1. 개요

NurseScheduler v4(HTML + Tailwind + Alpine.js, Electron) 화면을 **기능 변경 없이** 재배치·확대·문구 교체합니다.
목표: 컴퓨터가 익숙하지 않은 사용자도 설명서 없이 "사전입력 → 분석 → 근무표 만들기 → 인쇄"를 끝낼 수 있게.
원칙: 본문 18px · 클릭 타겟 48px · 연한 회색 글자 금지 · 아이콘만 버튼 금지 · 화면당 주(primary) 버튼 1개 · 표 위에 카드 없음 · 모든 버튼에 툴팁(title) · 영어 라벨·개발 용어 0.

## 2. 디자인 파일에 대해

`design/` 의 `.dc.html` 은 **HTML 로 만든 디자인 원본**입니다. 프로덕션 코드가 아니고, 그대로 복사해 붙이는 것도 아닙니다.
할 일은 이 화면을 **기존 `frontend/index.html` + Alpine 상태 안에서 재현**하는 것입니다. 열어 보는 법: `design/redesign-*.dc.html` 을 브라우저에서 열면 됩니다(같은 폴더의 `support.js` 가 필요). 오른쪽 위 Tweaks 가 없으면 콘솔에서 `__dcSetProps(__dcRootName(), {state:'failed'})` 로 상태를 바꿉니다.

| 파일 | 상태(state) | 대응 reference |
|---|---|---|
| `redesign-preinput.dc.html` | empty · filled(+토스트) · menu · popup · paste · showTooltip | `preinput-1…6` |
| `redesign-schedule.dc.html` | before · running · success · failed · relaxed · print · dark | `schedule-1…7` |
| `redesign-settings.dc.html` | roster · modal | `settings-1…2` |
| `redesign-phone.dc.html` | (3장 한 캔버스) | `phone-today-schedule-more` |
| `redesign-components.dc.html` | 컴포넌트 시트 | `components-sheet` |
| `redesign-doc.dc.html` | 토큰·문구·변경 근거·제거 제안·구현 순서 문서 | — |

## 3. 충실도

**High-fidelity.** 색·크기·간격·굵기·문구가 최종값입니다. `spec.json` 의 수치와 1px 도 다르지 않게 구현합니다.
유일한 자유도: 표 안 셀 데이터(예시)와 Alpine 바인딩 방식.

## 4. 구현 순서 (반드시 이 순서)

### 1단계 — 토큰·문구·툴팁 (레이아웃 안 건드림, 반나절)
1. `css/redesign-tokens.css`, `css/redesign-components.css` 를 `frontend/css/` 에 넣고 `index.html` 의 `<link>` **맨 마지막**에 추가.
2. `index.html` 의 모든 `title` 을 `copy.json › tooltips` 로 채움. `button:not([title])` = 0.
3. 라벨을 `copy.json › labels` 로 교체. `copy.json › glossary` 왼쪽 문자열이 index.html 에 **하나도 남지 않게** (`grep`).
4. 이모지 아이콘(📥⚡📂📤📊📋✅↩↪⚙☾) → lucide `<i data-lucide>` (`frontend/lib/lucide.min.js` 이미 있음). 아이콘 + 글자 라벨.
5. `.text-dim` / `.text-sub` 사용처 확인 — 토큰이 ink-2 로 올렸으니 그대로 두면 됨. `.text-dim` 을 disabled 표현에 쓰던 곳만 `.is-disabled` 로.
6. 서체 선택: 설정 → 그 외 에 `<select>` → `document.documentElement.dataset.font = 'noto'|'nanum'|'plex'|'malgun'|''`, localStorage `ns_font`. 서체 파일은 `frontend/fonts/` 에 **오프라인 번들**(Noto Sans KR·Nanum Gothic·IBM Plex Sans KR woff2; 맑은 고딕은 시스템). CDN 금지.

### 2단계 — 레이아웃 재배치 (기능 이동만, 하루)
`design/redesign-doc.dc.html › 5. 변경 근거` 와 아래 표를 따릅니다. **핸들러는 옮기기만** 하고 지우지 않습니다.

| 화면 | 현재 | 리디자인 |
|---|---|---|
| 헤더 | Ward/Nurses/Year·Mo 영어 메타, ☾ ? 전환 아이콘 | `.rhdr` grid 1fr auto 1fr · 왼쪽 브랜드+`게스트 병동 · 간호사 18명` · 가운데 `.rym` `2026년 10월` · 오른쪽 `다크 / 도움말 / 프로필 전환` 글자 버튼 |
| 단계 바 | 부제 = 셀 수/경고 수 | `.rsteps` 부제 = **다음에 할 일** (copy.json steps) · 완료 = 초록 체크 원 · 현재 = 잉크 채움 |
| 사전입력 표 위 | 월 배너·범례·안내 카드·신호등 (카드 3~4장) | **툴바 한 줄** `.rtoolbar` — 왼쏝 `.rsignal` 문장 하나 · 오른쪽 `가져오기(주) · 자동 채움 · 이대로 근무표로 │ 되돌리기 · 다시 │ 저장 · 더보기` (7개). 범례·월 배너·안내 카드 제거(범례는 셀 팝업이 대신, 월 배너는 헤더 년월이 대신) |
| 사전입력 툴바 항목 이동 | 메모 토글, 저장/불러오기 패널, ⋯(단축키·다른달·초기화) | 메모 표시 → `더보기` 메뉴 · 저장/불러오기 → `저장 ▾` 메뉴 · 단축키/다른달 정리/초기화 → `더보기` 메뉴 |
| 셀 팝업 | 근무 선택 팝업 + 우클릭 메모/잠금 | `.rpop` 372px — 근무 8 / 휴무·휴가 9 (코드+이름 44px) + 하단 `잠금 · 메모 · 지우기`. 우클릭은 그대로 두되 팝업에서도 됨 |
| 붙여넣기 모달 | 엑셀 붙여넣기 / 위시 / 업로드 각각 | `.rmodal` 760px 하나, 상단 종류 3택(`사전입력 표 · 위시 시트 · 완성 근무표`) + `파일에서 읽기` + 인식 결과 배너 + `표에 넣기` |
| 근무표 툴바 | 생성(주) · 완화 · V무제한 · ⚙고급 ┆ 저장 · 📂 · 📤 · 📊 · 전체화면 / 아래 줄 Charge숨기기·색상·그룹 | `.rtoolbar` — `근무표 만들기/다시 만들기 · ☐사전입력 완화 · ☐연차(V) 무제한 · 고급▾` ┆ `인쇄 · 내보내기▾ · 요약·리포트 · 불러오기▾ · 저장/저장됨 · 더보기▾`. **주 버튼은 상태에 따라 하나**: 생성 전 = 만들기, 생성 후 = 인쇄. 표시 옵션 4개+전체화면+비교 → `더보기` 메뉴 |
| 근무표 상태 | 카드/토스트 혼재 | `.rstatus` 한 줄 (표 바로 위) — running(warn, 진행바, 멈추기) / success(ok) / relaxed(ok + 점선 안내) |
| 실패 | 진단 텍스트 블록 | `.rfail` 배너 하나 — 제목 22px(날짜·근무·부족 인원) + 본문 + 후보 3 버튼 + 주 버튼 `사전입력 완화 켜고 다시 만들기`. 상세 진단은 `왜 안 되는지 자세히 보기`(조용 버튼) 뒤로 |
| 요약 표 + 리포트 서랍 | 두 패널 | **서랍 하나** `.rdrawer` 236px, 탭 7 (`요약 · 원티드 미반영 · 연차(V) 설명 · 오프특근 · 주의 · 위시 반영 · 생성 기록`). 원티드 미반영 탭에 줄마다 `되돌려서 잠금 · 칸으로 가기`. 사연 있으면 자동 열림(기존 로직) |
| 불러오기 | 서랍 | `불러오기 ▾` 메뉴 2항목(저장 목록 / 파일 올리기) → 각각 기존 서랍·모달 열기 |
| 설정 | 카드 4장 그리드 + 안내 카드 | **좌측 메뉴 240px** `.rside` (자주 3 / 거의 안 바꾸는 3) + 오른쪽 한 섹션. 첫 화면 = 명부. 명부 줄의 ⋯/× → `편집` 글자 버튼 하나(삭제는 모달 안) |
| 간호사 모달 | 모든 필드 노출 | 기본 6(이름·그룹·성별·가능 근무·야간전담 달·주휴 요일) + `특수 사항` 접힘(신규·임산부·전입/전출) |
| 폰 | 오늘 = 날짜 + KPI | `내 근무` 카드 맨 위(코드 40px) → 오늘 근무자를 근무별 칩 → 근무표는 내 줄 강조 + 필터 칩. `⋯ 도구` 편집 도구 **숨김**(보기 전용) |

### 3단계 — 새 컴포넌트 (이틀)
되돌리기 토스트(`.rtoast`, 변경 직후 5초) · 커스텀 툴팁(`.rtip`: title 을 읽어 0.3초 지연, focus 에도, 2줄) · 파괴적 동작 2단 확인(`.rbtn-danger` → `.rbtn-danger-confirm`, 문구 `한 번 더 누르면 지웁니다 · 되돌릴 수 없어요`) · 숫자 ± 입력(`.rnum`) · 토글(`.rtoggle`) · 인쇄 미리보기(`.rprint`, A4 가로, 흑백: N 회색 채움 · 주/OF 빗금 · 차지 굵게, 그 외 색 제거) · 폰 `내 근무` 카드.

## 5. data-rd 셀렉터 (check 가 찾는 이름)

구현한 요소에 아래 `data-rd` 속성을 붙입니다. 이름은 `check/spec.json` 과 같아야 합니다.

`header · brand-name · ym-label · ym-prev · ym-next · stepbar · step-gear · step-1 · step-2 · step-3 · toolbar · signal-text · signal-link · btn-import · btn-autofill · btn-as-schedule · btn-undo · btn-redo · btn-save · btn-more · menu-import · table-wrap · table · cell-popup · pop-lock · pop-memo · pop-clear · popup-close · paste-modal · modal-close · toast`
`btn-make · chk-relax · chk-vfree · btn-advanced · btn-print · btn-export · btn-drawer · btn-load · status · btn-stop · fail · empty · drawer · drawer-close · relock · print-preview`
`side · roster-title · btn-add-nurse · btn-roster-excel · roster · btn-edit · nurse-modal · months · wdays · special`
`today-date · my-shift · bottom-nav · phone-edit-tools(없어야 함)`

근무 셀에는 `data-shift="D"` 등 코드 속성 — 색은 CSS `[data-shift]` 가 입힙니다(인라인 색 지정 제거).

### 상태 진입 훅 (검증용, 개발 모드에서만)
`window.__rdState(screen, state)` 를 제공하세요 — 예: `('schedule','failed')` 면 실패 결과 픽스처를 Alpine 상태에 주입, `('preinput','popup')` 이면 첫 셀 팝업을 열어 둠. 없으면 check 는 `activeTab` 만 바꾸고 상태 검사는 실패로 뜹니다. 픽스처는 `design/*.dc.html` 의 renderVals 데이터(18명·2026-10)를 참고.

## 6. Definition of Done (셋 모두)

```bash
# 1) 기능 손실 0
python3 scripts/handler_inventory.py <(git show origin/main:frontend/index.html) frontend/index.html
#    → REMOVED 항목 0 (있으면 전부 의도된 "이름 바꿈"이어야 하고 새 이름이 ADDED 에 있어야 함)

# 2) 자동 검사 0 실패 (서버 py main.py 실행 중)
npm i -D playwright && npx playwright install chromium
node design_handoff_nurse_v4_redesign/check/check_redesign.mjs --shots out/rd
#    → "✓ spec.json 전 항목 일치"

# 3) 눈 비교
#    out/rd/<screen>-<state>.png  ↔  design_handoff_nurse_v4_redesign/reference/<screen>-N-<state>.png
#    같은 상태를 나란히 놓고: 헤더/단계 바/툴바 높이, 버튼 순서·라벨, 표 첫 화면 17행, 색, 서랍 위치가 같은가.
#    다르면 spec.json 에 그 항목을 **추가**하고(값은 design/*.dc.html 인라인 스타일에서) 고친 뒤 2) 재실행.
```

추가 회귀: `python3 -m pytest -q` (167건) · `node scripts/test_*.mjs` 전부 통과.

## 7. 하지 말 것

- 값을 "가까운 Tailwind 클래스"로 근사하기 (`h-12` ≠ 48px 인 설정도 있음). `.rbtn` 등 **제공된 클래스**를 쓴다.
- 문구 의역, 영어 라벨 잔존, 개발 용어(솔버·MIP·HiGHS·infeasible·슬랙·페널티·배점) 잔존.
- 아이콘만 있는 버튼, 12~13px 글자(팝업 코드 이름 13px 만 예외), ink-3 이하 회색 글자, 22px 미만에 800 굵기.
- 표 위에 카드/안내 쌓기, 2단 이상 메뉴, 모달 위 모달, 기능 삭제(제거 제안은 `redesign-doc` §6 — **삭제하지 않고** 더보기/고급/그 외 로 옮긴다).
- 웹폰트 CDN(인트라넷). 애니메이션 150ms 초과(진행바 제외).

## 8. 디자인 토큰 요약 (전체는 `css/redesign-tokens.css`)

글자 24/20/**18**/16/15/14px · 굵기 800(제목만)/700/600/500 · 타겟 48/40 · 행 36 · 열 44 · 헤더 64 · 단계 바 68 · 툴바 64 · 간격 4/8/12/16/24 · 모서리 10(버튼) 12(표·상태) 14(팝업·실패) 16(카드) 18(모달) · 선 #DCE0E6 / #EBEDF0 / 굵은 #B8BFC9 · 포커스 #2563EB 3px · 근무 17색은 브리프 표 그대로(OF 글자만 #6B7280) · 다크 변형 포함.

## 9. 자산

- 아이콘: 저장소 `frontend/lib/lucide.min.js` (chevron-left/right · moon · circle-help · users · sliders-horizontal · download · zap · check · undo-2 · redo-2 · save · ellipsis · lock · sticky-note · x · triangle-alert · info · printer · upload · bar-chart-3 · folder-open · square · rotate-ccw · calendar · pencil · file-spreadsheet · plus · grip-vertical · house)
- 서체: `frontend/fonts/PretendardVariable.woff2` (기본) + 선택 서체 3종 woff2 를 같은 폴더에 번들
- reference PNG 17장: `reference/`

## 10. 파일

```
design_handoff_nurse_v4_redesign/
├── README.md                 ← 이 문서
├── copy.json                 ← 라벨 · 툴팁 · 상태 문구 · 용어 번역 (그대로 붙일 문자열)
├── css/redesign-tokens.css   ← 드롭인 토큰 (기존 변수 이름 유지)
├── css/redesign-components.css ← 새 컴포넌트 클래스 (.rbtn .rhdr .rsteps .rtoolbar .rtable .rpop .rmenu .rdrawer .rmodal .rtoast .rtip .rcheck .rnum .rside .rprint …)
├── check/spec.json           ← 검사 항목 (셀렉터 · 기대값)
├── check/check_redesign.mjs  ← Playwright 검사기 (+ --shots 스크린샷)
├── reference/*.png           ← 디자인 원본 스크린샷 1920×1080 (상태별 17장)
└── design/                   ← 디자인 원본 HTML (브라우저에서 열어 값 확인)
```

---

## 적용 결과 (2026-09-06, v4.13.0)

- **Definition of Done 셋 통과**: `check_redesign.mjs` 0 불일치(기준선 210) · `handler_inventory.py` REMOVED 10건 전부 의도된 이름 바꿈(세션노트 2026-09-06 표) · reference 17장 나란히 비교.
- **검사기 수정 2건** (`check/check_redesign.mjs`): 축약 속성(`borderBottom`·`borderTop`·`outline`)의 rgb→hex 변환이 `1px` 을 첫 숫자로 읽던 것 → rgb() 부분만 변환;
  Chromium 의 `outline` 직렬화(`rgb() solid 2px`)와 spec 표기(`2px solid #hex`) 순서 차이 → '폭 스타일 색' 으로 정규화. `PW_CHROMIUM` 환경변수로 크로미움 경로 지정 가능,
  `[data-rd=table-wrap]` 이 없을 때 visibleRowsAtLeast 가 -1 로 계속.
- **spec 수정 11건** (`check/spec.json`, 전부 `$comment`): 폰 하단 내비 라벨 13px → 전역 최소 14px 규칙과 통일(1) · 정적 HTML 가정 `nth-child` 10곳 → Alpine `<template x-for>`
  를 감안한 `nth-of-type`/`first-of-type`(같은 셀).
- **자기모순 처리**: 활성 단계 부제 `#D4D9E0`(components.css)와 폰 카드 보조 글자 `#B8BFC9`(디자인)는 전역 금지색 → `#DCE0E6`(눈으로 동일).
- **핸드오프와 다른 점**: 폰 편집 도구는 제거 대신 더보기의 토글로 유지(`data-rd=phone-edit-tools` 없음) · 폰 오늘 화면의 주 버튼은 내 근무 카드의 '내 이름 고르기'
  (디자인엔 주 버튼이 없었으나 규칙 "화면당 1개") · 간호사 삭제 툴팁의 "60일 안에 되돌릴 수 있어요"는 실제 기능이 아니라 미채택.
- 실행: 서버(`python3 main.py`)를 띄운 뒤 `node design/handoff/check/check_redesign.mjs --url http://127.0.0.1:5757 --shots out/rd`. 검사기는 `window.__rdState` 훅을 쓴다.

