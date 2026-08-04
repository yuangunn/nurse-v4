# Handoff: 어싸인 배정표 — 화면 리디자인(1a) + A4 출력양식 재설계

## Overview

nurse-v4 의 `standalone/assign.html`(어싸인 배정표 v3, 설치·인터넷 불필요 단일 파일)을 대상으로 한 두 가지 작업입니다.

1. **주간 배정표 화면(scrWeek) 리디자인** — 표의 칸 구조·클릭 동작은 그대로 두고, 색·글꼴·신호(오늘/경고/D·E·N)만 정돈. 확정 방향은 **1a(보수적)**.
2. **인쇄 출력양식 재설계** — `buildPrintArea()` 가 만드는 화면 인쇄용 시트를 A4 한 장(사방 여백 1cm)에 정확히 맞도록 재설계. 양식에 들어가는 **문구와 CPR 도해 이미지는 원본 그대로**, 색·글꼴·간격만 변경.

디자인 언어는 이 저장소에 이미 있는 **YGinvest(한국 핀테크) 토큰** — `frontend/css/tokens.css` 의 딥 잉크 · 쿨그레이 페이퍼 · 흰 카드 · Pretendard 단일 서체 — 를 그대로 쓰고, 배정표에 필요한 만큼만 확장했습니다.

### 사용자가 밝힌 불편 (리디자인의 판단 기준)

- 표가 빽빽해서 눈이 아프다 / D·E·N 구분이 잘 안 보인다
- 오늘 날짜를 찾기 어렵다 / 지금 무엇을 눌러야 하는지 모르겠다
- 경고 메시지가 눈에 안 들어온다
- 버튼 이모지·문구가 정돈되지 않았다
- 관리 화면이 너무 복잡하다 *(← 아직 미작업. 아래 '남은 작업' 참고)*

밀도 요구: **"지금처럼 한 화면에 다 보이는 게 최우선"** — 1a 는 행 수·칸 수를 늘리지 않습니다.

---

## About the Design Files

`design/` 안의 파일은 **HTML로 만든 디자인 참조(프로토타입)** 입니다. 최종 모양과 동작 의도를 보여주기 위한 것이고, 그대로 복사해 넣을 제품 코드가 아닙니다.

목표는 이 HTML 디자인을 **대상 코드베이스의 기존 환경에 맞춰 다시 구현**하는 것입니다. 이 프로젝트의 대상 환경은 특수합니다:

- `standalone/assign.html` — **빌드 없는 단일 HTML 파일**. 인라인 `<style>` 1개 + 바닐라 JS(문자열 템플릿으로 DOM 생성). 프레임워크·번들러·CDN 없음. 요구 브라우저 Chrome/Edge 103+, `file://` 실행.
- `frontend/` (본 앱 SPA) — Tailwind + Alpine.js, CSS는 `tokens.css → base.css → components.css → yginvest-skin.css` 순서. 이번 작업 대상은 아니지만, 같은 토큰을 쓰므로 나중에 스킨 동기화가 필요하면 여기가 짝입니다.

따라서 구현은 **`standalone/assign.html` 한 파일 안의 CSS 규칙 교체 + 렌더 함수의 마크업 수정**입니다. 새 의존성을 추가하지 마세요.

> 디자인 파일 열어보기: `design/*.dc.html` 을 브라우저로 그냥 열면 렌더됩니다(같은 폴더의 `support.js` 필요, 인쇄 시트는 `doc-page.js` 필요). 서체는 CDN Pretendard를 참조하므로 오프라인에서는 시스템 서체로 대체됩니다 — 실제 제품에는 아래 '`Assets`'대로 base64 내장하세요.

## Fidelity

**High-fidelity (hifi).** 색·크기·간격·굵기 모두 최종값입니다. 아래 명세의 hex·px·pt·mm 값을 그대로 쓰세요. 임의로 다시 디자인하지 말고, 값이 애매하면 `design/` 파일의 해당 요소를 직접 열어 확인하세요.

---

## Screens / Views

### 0. `design/00_current_screens_recreation.dc.html` — 현재 화면 (Before)

현재 `assign.html` 5개 화면(주간 배정표 · 시작 · 새 근무표 넣기 · 근무표 고치기 · 관리)을 현재 CSS 값 그대로 재현한 파일입니다. 비교·회귀 확인용이며 구현 대상이 아닙니다.

### 1. `design/01_week_assign_options_1a1b1c.dc.html` — 주간 배정표 시안 3안

`1a`(확정) / `1b` / `1c` 가 나란히 있습니다. **구현 대상은 `1a` 뿐**입니다. 1b·1c는 기각된 대안이니 참고만 하세요.

**Purpose** — 병동 간호사가 이번 주 어싸인(방 배정)을 확인하고, 이름을 눌러 담당을 교체하고, 방 칸을 눌러 그날 병상을 수정하고, 맨 윗줄에 교육·행사를 입력하는 기본 화면.

**Layout** — 기존 구조 유지: 상단 고정 topbar → `.screen`(max-width 1160px, 가운데 정렬) → 주 이동 툴바 → 경고 카드 → 표 카드 → 하단 힌트.

#### 1a 컴포넌트 명세

**앱 셸**
| 항목 | 값 |
|---|---|
| 앱 배경 | `#F4F5F7` |
| 카드 | `#FFFFFF`, radius `14px`, shadow `0 1px 2px rgba(15,17,21,.04), 0 0 0 1px rgba(15,17,21,.04)` |
| 기본 글자 | Pretendard Variable, `#0F1115` |

**Topbar** — `background:#fff; box-shadow: inset 0 -1px 0 #EBEDF0; padding:12px 20px; display:flex; align-items:center; gap:12px`
- 브랜드 마크: `22×22px`, radius `7px`, `background:#0F1115`
- 제목 "어싸인 배정표": `16px/800`, `letter-spacing:-0.02em`, `#0F1115`
- 파일 정보: `13px`, `#8A93A1` (예: `5A병동 · 배정표_5A병동.json`)
- 저장 상태 칩: `padding:3px 10px; border-radius:9999px; background:#ECF7F0; color:#1F8A5B; font:700 12px`
- 오른쪽 탭 버튼 2개(이모지 제거): 활성 `배정표` = `background:#F2F3F5; color:#0F1115; font:700 14px; padding:8px 14px; border:none; border-radius:12px` / 비활성 `관리` = `background:transparent; color:#4A5160`

**주 이동 툴바** — `display:flex; align-items:center; gap:10px; margin-bottom:14px`
- 세그먼트 컨테이너: `background:#fff; border-radius:12px; padding:3px; box-shadow:0 1px 2px rgba(15,17,21,.04), 0 0 0 1px rgba(15,17,21,.04)`
  - `◀ 지난주` / `다음주 ▶`: `font:700 15px; color:#4A5160; padding:8px 14px; border:none; border-radius:9px; background:transparent`
  - 주 표시 `2026. 8. 2 – 8. 8`: `font:800 17px; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; padding:0 16px`
- `오늘`: `font:700 14px; padding:9px 16px; border-radius:12px; background:#fff; box-shadow:0 0 0 1px #DCE0E6`
- 오른쪽 3개 (순서: 보조 → 보조 → 주 동작)
  - `근무표 고치기`, `새 근무표 넣기` (ghost): `font:700 14px; padding:11px 18px; border:none; border-radius:12px; background:#fff; box-shadow:0 0 0 1px #DCE0E6`
  - `이번 주 인쇄` (primary): `font:800 15px; padding:11px 22px; border:none; border-radius:12px; background:#0F1115; color:#fff`
- **모든 버튼에서 이모지(📋 ⚙ 🖨 ＋ ✏ ▶ ✔ ↩ 📂) 제거**, 문구는 동사구로 통일

**경고 카드** (`#wkWarn`) — 현재는 `textContent` 에 `⚠ 확인 필요\n· …` 를 넣지만, 구조화 필요
- `display:flex; gap:12px; padding:13px 16px; border-radius:14px; background:#FEEFEF; margin-bottom:14px`
- 개수 배지: `20×20px; border-radius:9999px; background:#C7384A; color:#fff; font:800 12px`
- 제목 `확인 필요`: `font:800 14px; color:#C7384A; letter-spacing:-0.01em`
- 항목: `font:400 13px; color:#4A5160; line-height:1.5`, 세로 `gap:4px`
- 문구는 사람 말투로 다듬기 (예: `8/5 노아름 — E는 가능 근무가 아닙니다. 관리 > 간호사 관리에서 확인하세요.`)
- 경고 0건이면 카드 자체를 숨김(현재 동작 유지)

**표** (`#wkTable`) — 칸 구조·colspan·rowspan·클릭 타깃 전부 유지
- 컨테이너 카드: `padding:10px`
- 모든 셀 테두리: `1px solid #EBEDF0` *(기존 `#9aa4b2` 를 교체 — 격자가 옅어지는 것이 "눈이 아프다"의 핵심 처방)*
- colgroup: `40px, 56px, 그리고 7 × (5.8%, 6.8%)`
- 헤더 행 (높이 `44px`): 좌측 `교육/행사` = `font:700 12px; color:#8A93A1; line-height:1.4`
  - 요일: `font:700 12px` — 일 `#E84B5A`, 토 `#2563EB`, 평일 `#8A93A1`
  - 날짜: `font:800 16px; letter-spacing:-0.02em; font-variant-numeric:tabular-nums`, 오늘은 `#0F1115` 대신 accent
  - 오늘 칩: `padding:1px 7px; border-radius:9999px; background:#0F1115; color:#fff; font:800 10px`, 텍스트 `오늘`
  - 헤더 배경: 평일 `#F8F9FB`, 오늘 `#EDF2FF`
- 교육·행사 행 (높이 `28px`): `font:600 12px; color:#B7791F`, 오늘 열 `#EDF2FF`
- 근무 행 (높이 `34px` — 기본값)
  - 레일 셀(`rowspan`): D `background:#EEF3FE; color:#1B4FC3` / E `#FEEFEF` `#C7384A` / N `#EFEBFB` `#5B3FB0`, `font:800 17px`
  - 라벨 셀(A(CN)·B·C·D·E): `background:#F8F9FB; font:700 13px; color:#4A5160`
  - 방 셀: `font:600 12px; color:#8A93A1; font-variant-numeric:tabular-nums`
  - 이름 셀: `font:700 14px; letter-spacing:-0.01em; color:#0F1115`
  - 오늘 열: `background:#EDF2FF` *(기존 `#fffef2` 는 거의 안 보였음)*
  - 수동 담당 교체(`.ovd`): `box-shadow: inset 0 -2px 0 #C7384A`
  - 일별 방 수정(`.rov`): `box-shadow: inset 0 -2px 0 #1B4FC3`
  - 방 겹침(`.rdup`): `color:#C7384A; font-weight:700` (기존 유지)
  - hover: 이름 `#EDF2FF`, 방 `#F2F3F5`, 교육·행사 `#FBF3E2`
- 중간번 행 (높이 `30px`): 라벨 `background:#FBF3E2; font:700 12px; color:#B7791F` / 값 `font:700 13px; color:#4A5160`
- 하단 힌트: `font:400 12px; color:#8A93A1`, `display:flex; gap:18px`, 끝에 범례 2개(`14×2px` 색 바 + 라벨) — 빨강 `수동 교체`, 파랑 `방 수정`

### 2. `design/02_print_form_a4.dc.html` — 병실 배정표 인쇄 (A4)

**Purpose** — 주간 배정표 + 병동 상비 지침(물품체크 · CPR 업무분담 · 화재발생시)을 A4 한 장에 인쇄해 병동에 게시. 현재 `printWeek()` → `buildPrintArea()` 가 만드는 `.sheet` 를 대체합니다.

**용지 규칙 (사용자 요구)**
- A4 세로, **사방 여백 정확히 1cm**, 내용 영역 `190 × 277mm`, **한 장에 정확히 맞을 것**
- `@page { size: A4 portrait; margin: 0 }` + 시트 자체에 `padding:10mm; box-sizing:border-box`
  ⚠️ 여백을 안쪽 요소의 `margin` 으로 주면 세로 마진이 페이지 박스 밖으로 collapse 되어 종이 위쪽에 붙습니다. **반드시 padding**으로.
- `-webkit-print-color-adjust:exact; print-color-adjust:exact`

**세로 블록 구성 — 합계가 항상 정확히 277mm**

| # | 블록 | 높이 | 비고 |
|---|---|---|---|
| 1 | 제목 띠 | 9mm | `background:#0F1115`, radius 1.6mm |
| 2 | 간격 | 2mm | |
| 3 | 주간표 | `9 + eventH + 13×rowH + 6.5` | 기본 `eventH=20`, `rowH=7.2` → **129.1mm** |
| 4 | 간격 | 3mm | |
| 5 | 물품체크 | 44.5mm | 헤더 6.5 + 5행 × 7.6 |
| 6 | 간격 | 3mm | |
| 7 | Team Play 띠 | 6.5mm | |
| 8 | 간격 | 1.5mm | |
| 9 | CPR 업무분담 | `277 − 112.5 − 주간표` | 기본 **35.4mm**, 행 = /5 |
| 10 | 간격 | 3mm | |
| 11 | 화재발생시 | 내용 높이(auto) | 기본 약 28mm |
| 12 | 신축 간격 | `flex:1 1 1.5mm` | 화재 블록이 남긴 높이를 흡수 |
| 13 | 대피 장소 띠 | 6.5mm | |

구현: 내용 영역을 `display:flex; flex-direction:column; height:277mm` 로 두고 각 블록에 위 `flex-basis` 를 줍니다. 11번만 `flex:0 0 auto`, 12번만 `flex:1 1 1.5mm` — 그래서 지침 문구가 길어져 줄이 늘어도 총합이 277mm로 유지됩니다.

**열 너비** (각 블록의 첫 행 셀에 `width` 지정. `border-collapse:collapse` 라 실제 렌더 폭이 선언값보다 0.1~0.7mm 커지므로 **선언 합계를 190mm보다 3~5mm 작게** 두고 `table{width:100%}` 로 남은 폭을 비례 배분시킵니다.)

| 블록 | 열 |
|---|---|
| 주간표 | `22mm`(교육·행사, colspan 2) + 7 × `23.6mm`(요일별 colspan 2 → 방/이름 균등 분할) |
| 물품체크 | `22 / 54 / 44 / 66` (구분 / D / E / N) |
| CPR | `10.5 / 11.5 / 21 / 88 / 45` (세로라벨 / A(CN)·B~E / 역할 / 설명 / 도해) |
| 화재발생시 | `10.5 / D·E 82 / N = 176 − D·E` |

**글자 크기 (원본 4.5~8.4pt → 6.8~13pt 로 상향)**

| 요소 | 값 |
|---|---|
| 제목 | 13pt/800 `#fff` · 우측 기간 8pt/600 `rgba(255,255,255,.62)` |
| 요일 / 날짜 | 8pt/700 / 11pt/800 tabular-nums |
| 교육·행사 | 7pt/600 `#B7791F`, `vertical-align:top` |
| 레일 D·E·N | 11pt/800 |
| 라벨 A(CN)~E | 7.5pt/700 `#4A5160`, `background:#F8F9FB` |
| 방 / 이름 | 7.5pt/600 `#4A5160` / 9pt/700 `#0F1115` |
| 중간번 | 라벨 7.5pt/800 `#B7791F` on `#FBF3E2` · 값 8.5pt/700 `#4A5160` |
| 구분 헤더 | 8.5pt/800 — 구분 `#E4E9F5`, D `#EEF3FE`/`#1B4FC3`, E `#FEEFEF`/`#C7384A`, N `#EFEBFB`/`#5B3FB0` |
| 물품체크 본문 | 7.5pt/600, line-height 1.35 |
| 물품체크 세로라벨 | 8pt/800 `#0F1115` on `#EDEFF3` |
| Team Play 띠 | 8pt/700 `#C7384A` on `#FEF3F3` |
| CPR 역할 / 설명 | `cprPt` (아래 공식), 역할은 800 `#C7384A`, 설명은 600 `#0F1115` line-height 1.35 |
| CPR 세로라벨 | 8pt/800 `#1F8A5B` on `#ECF7F0` |
| 화재 세로라벨 | 8pt/800 `#fff` on `#C7384A` |
| 화재 D/E·N 헤더 | 8pt/800 `#C2410C` on `#FDECE4` |
| 화재 1행 / 2행 | `firePt`(기본 7pt)/600 `#C7384A` lh 1.4 · `firePt−0.2`/600 `#4A5160` lh 1.2 |
| 대피 장소 띠 | 7.5pt/700 `#C2410C` on `#FDECE4` |
| 셀 테두리 / 블록 링 | `0.25mm solid #DCE0E6` / `0 0 0 0.3mm #DCE0E6` |

**CPR 글자 크기 자동 계산** — CPR 칸은 2줄이 들어가야 하므로 블록 높이에서 역산합니다:

```js
const cprRowH = cprH / 5;                                     // mm
const cprPt = Math.max(5.6, Math.min(7.5,
  Math.round((cprRowH - 1) / 2 / 1.35 / 0.3528 * 10) / 10));   // 1mm 패딩, lh 1.35, 1pt=0.3528mm
```

**원본 xlsx 색 → 새 색 매핑** (양식 문구는 그대로, 색만 교체)

| 원본 | 용도 | 새 값 |
|---|---|---|
| `#7030A0` | 제목 띠 | `#0F1115` |
| `#B4C6E7` (hBlue) | 구분 헤더 | `#E4E9F5` |
| `#D9E2F3` (lBlue) | 물품체크 세로라벨 | `#EDEFF3` |
| `#92D050` (green) | CPR 세로라벨 | `#ECF7F0` + 글자 `#1F8A5B` |
| `#E2EFDA` (lGreen) | Team Play / 역할 라벨 | `#FEF3F3` / `#F8F9FB` |
| `#F8CBAD` (peach) | 화재 헤더·대피 | `#FDECE4` + 글자 `#C2410C` |
| `#FF0000` (fire) | 화재 세로라벨 | `#C7384A` |
| `#FF0000` (ftRed) | 강조 글자 | `#C7384A` |
| `#0000FF` (ftBlue) | 토요일 등 | `#1B4FC3` |
| `#289B6E` / `#BF9000` / `#4472C4` | 기타 글자색 | `#1F8A5B` / `#B7791F` / `#1B4FC3` |

---

## Interactions & Behavior

**동작은 하나도 바뀌지 않습니다.** 이번 작업은 순수 시각 작업이며, 아래는 반드시 그대로 유지해야 합니다.

- `#wkBody` 의 클릭 위임: `td.evt`(교육·행사 prompt) → `td.rm`(`openRoomPick`) → `td.nm`(`openPick`). `data-iso` / `data-p` / `data-l` / `data-n` 속성 유지.
- 담당 교체 픽커(`#pick`), 방 토글 픽커(`#rpick`) — 위치 계산(`e.pageX/pageY`), 큰 버튼 타깃 유지. 스타일만 새 토큰으로 맞추세요(팝업: `background:#fff; border:none; border-radius:16px; box-shadow:0 10px 30px rgba(15,17,21,.10), 0 0 0 1px rgba(15,17,21,.04)`; 선택된 버튼 `background:#0F1115; color:#fff`).
- 주 이동(`moveWeek`), 오늘(`goToday`), 화면 전환(`show`), 인쇄(`printWeek`), 붙여넣기 파싱, 키보드 입력(`D/E/N/V/O`, 방향키, `Del`, `Ctrl+Z`/`Ctrl+Shift+Z`), 드래그 다중 선택, 40단계 undo.
- 파일 저장 파이프라인: `touch()` → 700ms 디바운스 → `writeStore()`, `#saveDot` 문구(`저장 중…` / `⚠ 저장 실패`) — 문구를 새 칩 스타일로 바꾸되 상태 3종(대기/저장중/실패)은 유지.
- `visibilitychange` / `pagehide` 시 `flushSave()`.

트랜지션은 절제해서: 버튼 `transition: background-color .12s ease, transform .12s ease` + `:active{transform:scale(.98)}` 정도. 표 셀에는 트랜지션을 넣지 마세요(대형 표에서 리페인트 비용).

## State Management

새 상태 없음. 기존 전역 상태를 그대로 씁니다.

- `store` (JSON 파일에 그대로 저장되는 스키마 — **변경 금지**): `order`, `cells`, `ovr`, `roomOv`, `events`, `seedManual`, `caps`, `req`, `rooms`, `banRooms`, `schemes`, `rules`, `rev`, `ver`
- `result` / `tlKeys` — `compute()` 결과 캐시, `recompute()` 로 갱신
- `wkSunday`(주간 화면 기준 일요일), `edY`/`edM`(고치기 화면 연·월), `curScr`, `pending`(붙여넣기 미리보기), `undoStack`
- 경고 목록은 `renderWeek()` 안에서 매번 계산되는 지역 배열(`w`) — 카드 구조로 바꿀 때 이 배열을 그대로 항목으로 뿌리면 됩니다.

## Design Tokens

`frontend/css/tokens.css` 의 YGinvest 라이트 토큰이 원본입니다. 이번 화면에서 실제로 쓰는 값만:

```
/* 면 */
--paper      #F4F5F7   앱 배경
--paper-2    #EDEFF3
--card       #FFFFFF
--card-warm  #F8F9FB   라벨 셀·입력 배경

/* 잉크 */
--ink        #0F1115   본문·강조 (브랜드색 = 딥 잉크, 파랑/네이비 아님)
--ink-2      #4A5160
--ink-3      #8A93A1   보조 정보
--ink-4      #B8BFC9
--ink-5      #D4D9E0

/* 선 */
--rule       #EBEDF0   표 격자
--rule-2     #DCE0E6   버튼 링·인쇄 격자
--rule-soft  #F2F3F5

/* 신호 (KR 관례: 빨강↑ 부족, 파랑↓ 여유) */
--up   #E84B5A   --down #2563EB
--ok   #1F8A5B / #ECF7F0
--warn #B7791F / #FBF3E2
--err  #C7384A / #FEEFEF

/* 근무 */
D #1B4FC3 on #EEF3FE   E #C7384A on #FEEFEF
N #5B3FB0 on #EFEBFB   연차 #1F8A5B on #ECF7F0   오프 #8A93A1 on #F2F3F5

/* 이번 작업에서 추가한 확장값 */
오늘 열 배경     #EDF2FF
구분 헤더 배경   #E4E9F5
화재/대피 배경   #FDECE4   글자 #C2410C
Team Play 배경  #FEF3F3

/* 반경 */
카드 20px · 카드-sm 16px · 표 카드 14px · 버튼 12px · 칩 9999px · 인쇄 블록 1.6mm

/* 그림자 */
--shadow-card 0 1px 2px rgba(15,17,21,.04), 0 0 0 1px rgba(15,17,21,.03)
--shadow-pop  0 10px 30px rgba(15,17,21,.10), 0 0 0 1px rgba(15,17,21,.04)

/* 서체 — Pretendard 단일 */
'Pretendard Variable', Pretendard, -apple-system, system-ui, sans-serif
화면: 12·13·14·16·17px (800/700/600) · letter-spacing -0.01 ~ -0.04em(큰 숫자)
인쇄: 6.8·7·7.5·8·8.5·9·11·13pt
숫자에는 항상 font-variant-numeric: tabular-nums
```

`SHIFTS` 코드별 색(고치기 화면 셀·범례)은 현재 `assign.html` 값이 이미 토큰과 같은 계열이므로 **그대로 두세요**(`DC #E2ECFD/#1B4FC3`, `D #EEF3FE/#1B4FC3`, `EC #FCE3E5/#C7384A`, `E #FEEFEF/#C7384A`, `중 #FBF3E2/#B7791F`, `NC #E7E0F8/#5B3FB0`, `N #EFEBFB/#5B3FB0`, `OF #F2F3F5/#8A93A1`, `주 #EDEFF3/#4A5160`, `V #ECF7F0/#1F8A5B` …).

## Assets

| 자산 | 출처 | 비고 |
|---|---|---|
| `assets/cpr-flow.png` | 업로드된 `병실 배정표.xlsx` 의 `xl/media/image1.png` | 524×579px. 인쇄 시트 CPR 블록 우측. **이미지 교체·재작성 금지** |
| Pretendard Variable | `frontend/fonts/PretendardVariable.woff2` (저장소에 이미 있음, 2.06MB) | 단일 파일 오프라인 요구 → `@font-face { src: url(data:font/woff2;base64,…) format('woff2-variations') }` 로 내장. base64 후 약 2.7MB 증가(사용자 승인됨) |

인쇄 시트의 CPR 도해도 같은 방식으로 base64 `data:image/png` 인라인이 필요합니다(현재 `buildPrintArea` 는 xlsx 템플릿에서 뽑은 blob URL을 씁니다 — 그 경로를 유지해도 됩니다).

CDN·웹폰트 링크를 코드에 남기지 마세요. 병원 인트라넷에서 실행됩니다.

---

## 구현 순서 (standalone/assign.html)

1. **서체** — `<style>` 맨 위에 base64 `@font-face` 추가, `:root{font-family:...}` 를 Pretendard 우선으로 교체.
2. **기본값** — `body`(배경 `#F4F5F7`, 글자 `#0F1115`), `button`(border 제거 → `box-shadow:0 0 0 1px #DCE0E6`, radius 12, 700), `.pri`(`#1976d2` → `#0F1115`), `input/select`(radius 12, `background:#F8F9FB`, `box-shadow: inset 0 0 0 1px #EBEDF0`), `.dim`(`#8A93A1`) 교체.
3. **셸** — `.topbar`, `.screen`, `.card`(radius 14 + shadow-card, border 제거), `.wknav` 규칙 교체.
4. **표** — `#wkTable` 규칙 전면 교체(위 명세). `.todayCol` → `#EDF2FF`. `.ovd`/`.rov`/`.rdup` 유지.
5. **`renderWeek()` 마크업** — 날짜 헤더를 요일/날짜 2단으로 나누고 오늘 열에 `오늘` 칩 삽입, 버튼 문구에서 이모지 제거. 나머지 루프·`data-*`·colspan은 손대지 않음.
6. **경고 카드** — `#wkWarn` 을 `textContent` 대신 `innerHTML`(배지 + 항목 목록)로. 문구를 사람 말투로 다듬기. 0건이면 숨김 유지.
7. **픽커** — `#pick` / `#rpick` 을 shadow-pop + radius 16 + 선택 버튼 딥 잉크로.
8. **인쇄** — `@page{margin:0}`, `.sheet` CSS 전면 교체, `buildPrintArea()` 의 `H` 높이 맵을 위 블록 표로 교체하고 열 너비를 첫 행 셀 `width` 로 지정. **`getCellText(tpl.sheetXml, …)` 로 문구를 읽어오는 구조는 그대로** — 문구를 코드에 하드코딩하지 마세요(기관 방침이 바뀌면 xlsx만 갈아끼우면 되도록).
9. **회귀 확인** — 아래 체크리스트.

### 절대 유지 (회귀 금지)

- `store` JSON 스키마와 `ver:3` / `rev` 증가 규칙, 저장 충돌 처리
- `tplB64`(xlsx 양식 base64)와 `downloadWeekXlsx()` 출력 — **바이트 단위로 동일**해야 함. 화면·인쇄 리디자인이 엑셀 양식에 영향을 주면 안 됩니다.
- 양식 문구·CPR 이미지: xlsx 셀에서 읽는 방식 유지
- 키보드·드래그·undo 동작, 클릭 타깃 크기(모바일/태블릿 44px 이상)
- 오프라인 단일 파일, Chrome 103+, `file://` 실행

### 확인 체크리스트

- [ ] 주간 화면에서 오늘 열이 한눈에 보이는가 (배경 + `오늘` 칩)
- [ ] 경고 0건 / 1건 / 5건에서 카드가 각각 정상인가
- [ ] 이름 클릭 → 담당 교체, 방 클릭 → 병상 수정, 맨 윗줄 클릭 → 교육·행사 입력이 그대로 동작
- [ ] 수동 교체(빨강 밑줄) / 방 수정(파랑 밑줄) / 방 겹침(빨강 글자) 표시가 남아 있는가
- [ ] 근무표가 없는 주에서 빈 상태 안내가 정상
- [ ] `Ctrl+P` 와 `이번 주 인쇄` 모두 A4 1장, 사방 여백 1cm, 잘림 없음
- [ ] 인쇄 미리보기에서 화재 대응 문구 4줄이 모두 보이는가
- [ ] `이번 달 전체 인쇄(5~6장)` 에서 각 장이 독립적으로 1페이지인가
- [ ] `⚙ 관리 > 주간 배정표 파일(xlsx) 내려받기` 결과가 원본 양식과 동일한가
- [ ] 태블릿(1024px 폭)에서 툴바가 2줄로 접히되 표가 가로 스크롤 없이 들어오는가

## 남은 작업 (이번 핸드오프 범위 밖)

사용자가 요청했지만 아직 디자인되지 않은 화면 4개입니다. 같은 토큰·같은 규칙(격자 옅게, 이모지 제거, 라벨은 `#8A93A1`, 주 동작 1개만 딥 잉크)으로 이어가면 됩니다.

1. **시작 화면(scrStart)** — 버튼 3개의 위계 정리(이어서 시작 = primary), 안내문을 단계 목록으로
2. **새 근무표 넣기(scrPaste)** — 1·2 단계 안내를 스텝 카드로, 미리보기 표에 새 격자 적용
3. **근무표 고치기(scrEdit)** — 셀 색은 `SHIFTS` 유지, sticky 헤더/이름 열 배경만 새 토큰, 인원 부족/초과 빨강 유지
4. **관리(scrAdmin)** — 사용자가 "너무 복잡하다"고 지적. `<details>` 8개를 자주 쓰는 3개(지난 어싸인 · xlsx 내려받기 · 방 구성)와 그 외로 그룹핑하고, 세그먼트 버튼(`.segbtn`)을 새 토큰으로 정리하는 방향 권장

## Files

```
design/
  00_current_screens_recreation.dc.html   현재 5개 화면 재현 (Before, 비교용)
  01_week_assign_options_1a1b1c.dc.html   주간 배정표 시안 3안 — 1a 확정
  02_print_form_a4.dc.html                A4 인쇄 시트 (사방 1cm, 277mm 정확 배분)
  support.js                              위 파일들을 브라우저에서 렌더하는 런타임
  doc-page.js                             인쇄 시트의 페이지 박스 컴포넌트
assets/
  cpr-flow.png                            xlsx 에서 추출한 CPR 도해 (원본 그대로)
```

원본 코드 참조 위치 (yuangunn/nurse-v4, branch `main`):

| 대상 | 위치 |
|---|---|
| 화면 CSS·마크업·렌더 함수 | `standalone/assign.html` (인라인 `<style>`, `renderWeek`, `buildPrintArea`, `renderAdmin`, `renderEditGrid`) |
| 디자인 토큰 원본 | `frontend/css/tokens.css`, `frontend/css/yginvest-skin.css` |
| 서체 | `frontend/fonts/PretendardVariable.woff2` |
| 출력양식 원본 | 업로드된 `병실 배정표.xlsx` (sheet1 `A1:Q34`, 병합·행높이·문구) |
