# Handoff: 어싸인 배정표 — 화면 5개 최종본 + A4 출력양식

## Overview

nurse-v4 `standalone/assign.html`(어싸인 배정표 v3, 설치·인터넷 불필요 단일 파일)의 **화면 전체 리디자인 최종본**입니다.

디자인 언어는 저장소에 이미 있는 **YGinvest(한국 핀테크) 토큰** — `frontend/css/tokens.css` 의 딥 잉크 · 쿨그레이 페이퍼 · 흰 카드 · Pretendard 단일 서체 — 를 그대로 쓰고, 배정표에 필요한 만큼만 확장했습니다.

**칸 구조·클릭 동작·저장 파이프라인·xlsx 양식은 하나도 바뀌지 않습니다.** 순수 시각 작업입니다.

### 이미 구현된 부분 (2차 핸드오프에서 제외 가능)

CHANGELOG 「🎨 assign.html 디자인 리뉴얼」 기준으로 **주간 화면(scrWeek)과 A4 인쇄 시트는 이미 반영**되어 있습니다. 이 문서에도 명세를 그대로 남겨두었으니, 구현분과 대조해 어긋난 값만 맞추면 됩니다.

**이번에 새로 구현할 것은 나머지 4개 화면입니다: 시작 · 새 근무표 넣기 · 근무표 고치기 · 관리.**

### 사용자가 밝힌 불편 (리디자인의 판단 기준)

| 불편 | 처방 |
|---|---|
| 표가 빽빽해서 눈이 아프다 | 격자선을 `#9aa4b2` → `#EBEDF0` 로. 선 대신 여백·배경으로 구분 |
| D·E·N 구분이 잘 안 보인다 | 레일 셀에 근무색 배경 + 근무색 글자 |
| 오늘 날짜를 찾기 어렵다 | 오늘 열 `#EDF2FF` 틴트 + 날짜 옆 `오늘` 칩 |
| 지금 무엇을 눌러야 하는지 모르겠다 | 화면마다 주 동작 **하나만** 딥 잉크. 나머지는 흰 버튼·투명 버튼으로 2단계 낮춤 |
| 경고 메시지가 눈에 안 들어온다 | 텍스트 나열 → 개수 배지 + 항목 목록 카드 |
| 버튼 이모지·문구가 정돈되지 않았다 | 📋⚙🖨＋✏▶✔↩📂 **전부 제거**, 문구를 동사구로 통일 |
| 관리 화면이 너무 복잡하다 | `<details>` 9개 → 왼쪽 5묶음 목록 + 오른쪽 단일 패널 |

밀도 요구: **"지금처럼 한 화면에 다 보이는 게 최우선"** — 어느 화면도 행 수·칸 수를 늘리지 않았습니다.

---

## About the Design Files

`design/` 안의 파일은 **HTML로 만든 디자인 참조(프로토타입)** 입니다. 최종 모양과 의도를 보여주기 위한 것이고, 그대로 복사해 넣을 제품 코드가 아닙니다.

목표는 이 HTML 디자인을 **대상 코드베이스의 기존 환경에 맞춰 다시 구현**하는 것입니다. 이 프로젝트의 대상 환경은 특수합니다:

- `standalone/assign.html` — **빌드 없는 단일 HTML 파일**. 인라인 `<style>` 1개 + 바닐라 JS(문자열 템플릿으로 DOM 생성). 프레임워크·번들러·CDN 없음. 요구 브라우저 Chrome/Edge 103+, `file://` 실행. 저장소에는 없고 `scripts/build-assign-standalone.mjs` 가 코어 + xlsx 양식 + Pretendard base64 를 주입해 생성합니다.
- `frontend/` (본 앱 SPA) — Tailwind + Alpine.js, CSS는 `tokens.css → base.css → components.css → yginvest-skin.css` 순서. 이번 작업 대상은 아니지만 같은 토큰을 씁니다.

따라서 구현은 **`standalone/assign.html` 한 파일 안의 CSS 규칙 교체 + 렌더 함수의 마크업 수정**입니다. 새 의존성을 추가하지 마세요.

> 디자인 파일 열어보기: `design/*.dc.html` 을 브라우저로 그냥 열면 렌더됩니다(같은 폴더의 `support.js` 필요, 인쇄 시트는 `doc-page.js` 필요). 서체는 CDN Pretendard를 참조하므로 오프라인에서는 시스템 서체로 대체됩니다 — 실제 제품에는 아래 'Assets'대로 base64 내장하세요.
>
> ⚠️ 디자인 파일의 주간 표에서 방/이름 열이 50:50으로 보이는 것은 프로토타입 런타임이 `<colgroup>` 을 무시하기 때문입니다. **실제 구현에서는 아래 명세대로 `<colgroup>` (방 5.8% / 이름 6.8%)을 쓰세요** — 일반 브라우저에서는 정상 동작합니다.

## Fidelity

**High-fidelity (hifi).** 색·크기·간격·굵기 모두 최종값입니다. 아래 명세의 hex·px·pt·mm 값을 그대로 쓰세요. 임의로 다시 디자인하지 말고, 값이 애매하면 `design/` 파일의 해당 요소를 직접 열어 확인하세요.

---

## 공통 규칙 (5개 화면 전부)

**앱 셸**

| 항목 | 값 |
|---|---|
| 앱 배경 | `#F4F5F7` |
| 카드 | `#FFFFFF`, radius `14~16px`, shadow `0 1px 2px rgba(15,17,21,.04), 0 0 0 1px rgba(15,17,21,.04)` |
| 카드 링만 | `box-shadow: 0 0 0 1px #EBEDF0` (그림자 없는 보조 카드) |
| 기본 글자 | Pretendard Variable, `#0F1115` |

**Topbar** — `background:#fff; box-shadow: inset 0 -1px 0 #EBEDF0; padding:12px 20px; display:flex; align-items:center; gap:12px`
- 브랜드 마크: `22×22px`, radius `7px`, `background:#0F1115`
- 제목 "어싸인 배정표": `16px/800`, `letter-spacing:-0.02em`
- 현재 화면 이름 / 파일 정보: `13px`, `#8A93A1`
- 저장 상태 칩: `padding:3px 10px; border-radius:9999px; background:#ECF7F0; color:#1F8A5B; font:700 12px` (실패 시 `#FEEFEF` / `#C7384A`)
- 탭 2개(이모지 제거): 활성 `background:#F2F3F5; color:#0F1115` / 비활성 `background:transparent; color:#4A5160` — 공통 `font:700 14px; padding:8px 14px; border:none; border-radius:12px`

**버튼 3단계** — 한 화면에 딥 잉크는 **하나만**

| 단계 | 스타일 |
|---|---|
| 주 동작 | `background:#0F1115; color:#fff; border:none; border-radius:12~13px; font:800 15px; padding:11px 22px` |
| 보조 | `background:#fff; color:#0F1115; box-shadow:0 0 0 1px #DCE0E6; border:none; border-radius:12px; font:700 14px; padding:11px 18px` |
| 3단계 | `background:transparent; color:#8A93A1; font:700 14px` |

`transition: background-color .12s ease, transform .12s ease` + `:active{transform:scale(.98)}`. **표 셀에는 트랜지션 금지**(대형 표 리페인트 비용).

**글자 대비 규칙** — 이 제품의 주 사용자는 50대 비숙련 간호사입니다. **사용자가 읽어야 하는 모든 글자는 `#8A93A1` 이상**(흰 배경 대비 2.95:1 이상)으로 두세요. `#B8BFC9`(1.76:1)는 읽을 필요가 없는 표시 — `…` 축약, 비활성 `＋` 기호 — 에만 씁니다. 표 열 머리글·통계 라벨·범례 묶음 이름·상태 배지·요일 글자는 전부 정보이므로 `#8A93A1` 또는 `#4A5160`.

**입력** — `border:none; border-radius:11~12px; background:#F8F9FB; box-shadow: inset 0 0 0 1px #EBEDF0; padding:9px 12px`. 숫자에는 `font-variant-numeric: tabular-nums`.

**세그먼트 컨테이너** (주/월 이동) — `background:#fff; border-radius:12px; padding:3px; box-shadow:0 1px 2px rgba(15,17,21,.04), 0 0 0 1px rgba(15,17,21,.04)`, 내부 버튼 `background:transparent; color:#4A5160; border-radius:9px`

---

## 화면 01 — 주간 배정표 (`scrWeek`) *(구현 완료)*

**Purpose** — 병동 간호사가 이번 주 어싸인을 확인하고, 이름을 눌러 담당을 교체하고, 방 칸을 눌러 그날 병상을 수정하고, 맨 윗줄에 교육·행사를 입력하는 기본 화면.

**Layout** — topbar → `.screen`(max-width 1160px, 가운데) → 주 이동 툴바 → 경고 카드 → 표 카드 → 하단 힌트.

**주 이동 툴바** — `display:flex; align-items:center; gap:10px; margin-bottom:14px`
- 세그먼트: `◀ 지난주` / 주 표시 `2026. 8. 2 – 8. 8` (`800 17px`, `letter-spacing:-0.02em`, tabular-nums, `padding:0 16px`) / `다음주 ▶`
- `오늘`: 보조 버튼, `padding:9px 16px`
- 오른쪽: `근무표 고치기`(보조) · `새 근무표 넣기`(보조) · `이번 주 인쇄`(주 동작)

**경고 카드** (`#wkWarn`)
- `display:flex; gap:12px; padding:13px 16px; border-radius:14px; background:#FEEFEF; margin-bottom:14px`
- 개수 배지 `20×20px; border-radius:9999px; background:#C7384A; color:#fff; font:800 12px`
- 제목 `확인 필요` `800 14px #C7384A`
- 항목 `400 13px #4A5160; line-height:1.5`, 세로 `gap:4px`, 사람 말투로
- 0건이면 카드 숨김(기존 동작 유지)

**표** (`#wkTable`) — 칸 구조·colspan·rowspan·클릭 타깃 전부 유지
- 카드 `padding:10px`, 모든 셀 테두리 `1px solid #EBEDF0`
- colgroup: `40px, 56px, 그리고 7 × (5.8%, 6.8%)`
- 헤더 행 `44px`: 좌측 `교육/행사` `700 12px #8A93A1 line-height:1.4`
  - 요일 `700 12px` — 일 `#E84B5A`, 토 `#2563EB`, 평일 `#8A93A1`
  - 날짜 `800 16px; letter-spacing:-0.02em; tabular-nums`, 오늘은 accent
  - 오늘 칩 `padding:1px 7px; border-radius:9999px; background:#0F1115; color:#fff; font:800 10px`
  - 배경: 평일 `#F8F9FB`, 오늘 `#EDF2FF`
- 교육·행사 행 `28px`: `600 12px #B7791F`
- 근무 행 `34px`
  - 레일(rowspan): D `#EEF3FE`/`#1B4FC3` · E `#FEEFEF`/`#C7384A` · N `#EFEBFB`/`#5B3FB0`, `800 17px`
  - 라벨(A(CN)·B~E): `background:#F8F9FB; 700 13px #4A5160`
  - 방 셀 `600 12px #8A93A1 tabular-nums` / 이름 셀 `700 14px #0F1115 letter-spacing:-0.01em`
  - 오늘 열 `#EDF2FF`
  - 수동 담당 교체(`.ovd`) `box-shadow: inset 0 -2px 0 #C7384A` · 일별 방 수정(`.rov`) `inset 0 -2px 0 #1B4FC3` · 방 겹침(`.rdup`) `color:#C7384A; font-weight:700`
  - hover: 이름 `#EDF2FF`, 방 `#F2F3F5`, 교육·행사 `#FBF3E2`
- 중간번 행 `30px`: 라벨 `background:#FBF3E2; 700 12px #B7791F` / 값 `700 13px #4A5160`
- 하단 힌트 `400 12px #8A93A1`, `display:flex; gap:18px`, 끝에 범례 2개(`14×2px` 바) — 빨강 `수동 교체`, 파랑 `방 수정`

---

## 화면 02 — 시작 (`scrStart`) **← 신규**

**Purpose** — 데이터 파일(NAS의 JSON)을 열어 앱에 진입. 50대 비숙련 사용자가 **무엇을 먼저 눌러야 하는지** 1초 안에 알아야 하는 화면.

**Layout** — topbar(탭 없음) → 가운데 `520px` 칼럼, `padding:56px 20px 64px`, 세로 `gap:22px`

**1. 타이틀 블록** (`gap:6px`)
- `어싸인 배정표` — `800 26px; letter-spacing:-0.035em; line-height:1.2`
- `데이터 파일을 열면 바로 이번 주 배정표가 나옵니다.` — `14px #8A93A1; letter-spacing:-0.01em`

**2. 버튼 3개** (`gap:10px`, 전부 `width:100%`, `text-align:left`, `border-radius:16px`)

| 버튼 | 스타일 | 안쪽 구성 |
|---|---|---|
| `이어서 시작` | `padding:18px 22px; background:#0F1115; color:#fff` | 제목 `800 17px` + 부제 `600 12px rgba(255,255,255,.55)` = **파일명 · 마지막 연 시각** (`배정표_5A병동.json · 어제 오후 6:12`) + 우측 `→` `rgba(255,255,255,.5)` |
| `데이터 파일 열기` | `padding:15px 22px; background:#fff; box-shadow:0 0 0 1px #DCE0E6` | 좌 `700 15px` + 우 `600 12px #8A93A1` "공용 폴더에서 고르기" |
| `처음 시작` | `padding:15px 22px; background:transparent; color:#4A5160` | 좌 `700 15px` + 우 `600 12px #8A93A1` "새 데이터 파일 만들기" |

`이어서 시작`은 저장된 파일 핸들이 있을 때만 표시(기존 `#btnResume` 조건 유지). 없으면 `데이터 파일 열기`가 주 동작으로 승격(딥 잉크로 교체).

**3. 안내 단계 카드** — `padding:18px 20px; border-radius:16px; background:#fff; box-shadow:0 0 0 1px #EBEDF0`, 항목 세로 `gap:11px`
- 번호 배지 `19×19px; border-radius:9999px; background:#F2F3F5; color:#4A5160; font:800 11px`
- 본문 `13px; line-height:1.55; color:#4A5160; text-wrap:pretty`, 강조어만 `700 #0F1115`
- 문구(3단계):
  1. 파일은 공용 폴더(내부망 NAS)에 두면 **어느 컴퓨터에서나 같은 내용**을 봅니다.
  2. 브라우저가 "파일을 볼 수 있도록 허용하시겠습니까?" 라고 물으면 **허용**을 누르세요.
  3. 처음이라면 **처음 시작**으로 데이터 파일을 하나 만들어 공용 폴더에 두세요.

**4. 드롭 안내 띠** — `padding:12px 18px; border-radius:14px; background:#EDEFF3`, `＋` `800 12px #4A5160` + `600 12px #4A5160` "데이터 파일(.json)을 이 창에 끌어다 놓아도 열립니다."

**오류 표시** (`#startWarn`) — 파일 열기 실패·손상 파일 차단 시 드롭 띠 자리에 `background:#FEEFEF; color:#C7384A` 로 교체.

---

## 화면 03 — 새 근무표 넣기 (`scrPaste`) **← 신규**

**Purpose** — 엑셀 근무표를 붙여넣어 읽고, **연·월을 확인**한 뒤 저장. 연·월이 틀리면 이번 달을 덮어쓰는 자리라 확인 UI가 이 화면의 핵심입니다.

**Layout** — topbar → `padding:20px 22px 24px`, 세로 `gap:14px`

**1. 단계 카드 2개 + 드롭 영역** (`display:flex; gap:12px`)
- 단계 카드 (`flex:1`): `padding:18px 20px; border-radius:16px; background:#fff; shadow-card`, 안쪽 `display:flex; gap:14px`
  - 번호 배지 `26×26px; border-radius:9px; background:#0F1115; color:#fff; font:800 13px`
  - 제목 `700 15px; letter-spacing:-0.015em`
  - 키 칩 `padding:3px 10px; border-radius:8px; background:#F2F3F5; font:800 12px ui-monospace` + 설명 `12px #8A93A1`
  - 1: `엑셀에서 근무표를 마우스로 긁어 복사` / `Ctrl+C` / 이름과 날짜 줄까지 함께
  - 2: `이 창을 클릭한 다음 붙여넣기` / `Ctrl+V` / 바로 아래에 읽은 결과가 나옵니다
- 드롭 영역 (`flex:0 0 300px`): `border-radius:16px; background:#fff; box-shadow:0 0 0 1.5px #DCE0E6` (점선 대신 굵은 링), `＋ 엑셀 파일을 여기에 놓아도 됩니다` `700 13px #4A5160` + `12px #8A93A1` 이름 열과 날짜 줄은 자동으로 알아봅니다
  - 실제 드래그 오버 시: `box-shadow:0 0 0 2px #0F1115; background:#F8F9FB`

**2. 트레이닝 안내 띠** — `padding:11px 16px; border-radius:12px; background:#EDEFF3`, `12px #4A5160` + `/D /E /N` 칩(`background:#fff; color:#8A93A1; font:800 11px ui-monospace; border-radius:7px`) — "표시는 되지만 인력·어싸인에는 세지 않습니다"

**3. 읽은 결과 카드** (`#pvWrap` 영역) — `padding:20px 22px; border-radius:16px; background:#fff; shadow-card`, 세로 `gap:12px`
- 헤더: `✓` 배지 `19×19px; border-radius:9999px; background:#ECF7F0; color:#1F8A5B; font:800 11px` + `이렇게 읽었어요` `800 15px`
- **통계 3칸** (`display:flex; gap:10px`, 각 `flex:1; padding:14px 18px; border-radius:14px; background:#F8F9FB`)
  - 라벨 `800 11px; letter-spacing:.06em; color:#8A93A1` / 값 `800 20px; letter-spacing:-0.03em; tabular-nums`
  - `간호사` 16명 · `기간` 8/1 – 8/31 · `새 이름` 없음(있으면 `N명` + `#0F1115`, 없으면 `#8A93A1`)
- **연·월 확인 카드** — `display:flex; align-items:center; gap:14px; padding:14px 18px; border-radius:14px; background:#FBF3E2`
  - 제목 `800 13px #B7791F` — `이 근무표의 시작을 확인해주세요`
  - 설명 `12px #8A6A2A` — `날짜 줄에 연·월이 없어 자동으로 추정했습니다. 틀리면 이번 달을 덮어씁니다.`
  - 입력 2개 `padding:9px 12px; border-radius:11px; background:#fff; box-shadow:0 0 0 1px #E4CFA0; font:800 15px; text-align:center; tabular-nums` (연 `74px` / 월 `56px`), 단위 `700 13px #B7791F`
  - ⚠️ 날짜 줄에 연·월이 **있으면** 이 카드는 `background:#F8F9FB` + 회색 톤으로 낮추고 제목을 `읽은 시작`으로 (경고 아님)
- **미리보기 표** — `border-radius:12px; box-shadow:0 0 0 1px #EBEDF0`, 행 높이 `28px`
  - 헤더 `background:#F8F9FB`, 이름 열 `800 11px #8A93A1`, 날짜 `700 11px tabular-nums` (일 `#C7384A` / 토 `#1B4FC3` / 평일 `#4A5160`)
  - 이름 `700 12px #0F1115`, 셀은 `SHIFTS` 색 그대로 `800 11px`
  - 행 구분 `box-shadow: inset 0 -1px 0 #F2F3F5`
  - 넘치는 열/행은 `…` `#B8BFC9` 로 축약 (읽을 필요 없는 표시라 유일하게 허용)
- **액션** — `맞아요, 저장`(주 동작 `padding:12px 24px`) · `다시 붙여넣기`(보조) · `돌아가기`(3단계)

붙여넣기 전에는 결과 카드 전체를 숨김(기존 `#pvWrap` display 토글 유지).

---

## 화면 04 — 근무표 고치기 (`scrEdit`) **← 신규**

**Purpose** — 월별 근무표를 엑셀처럼 직접 고치는 편집 그리드. 키보드·드래그·undo가 핵심이라 **셀 자체는 최대한 건드리지 않습니다**.

**Layout** — topbar → `padding:18px 20px 20px`, 세로 `gap:12px`

**1. 툴바**
- 월 이동 세그먼트: `◀` `34×32px` / `2026년 8월` `800 16px; letter-spacing:-0.02em; tabular-nums; padding:0 14px` / `▶`
- 상태 칩 — `padding:8px 14px; border-radius:12px; background:#fff; box-shadow:0 0 0 1px #EBEDF0`
  - `이번 달` `800 11px; letter-spacing:.05em; #8A93A1`
  - `16명 · 496칸` `700 13px #0F1115`
  - 구분선 `1×12px #E4E7EC`
  - `인원 안 맞는 날 3일` `800 13px #C7384A` (0일이면 `정원 맞음` `#1F8A5B`)
- 오른쪽: `되돌리기`(보조) · `배정표 보기`(주 동작)

**2. 범례 바** — `padding:11px 16px; border-radius:12px; background:#fff; box-shadow:0 0 0 1px #EBEDF0`, `display:flex; gap:18px; flex-wrap:wrap`

기존 20개 나열 → **3묶음**. 묶음 이름 `800 11px; letter-spacing:.04em; #8A93A1`, 칩 `padding:2px 8px; border-radius:7px; font:800 11px` (색은 `SHIFTS` 그대로)

| 묶음 | 코드 |
|---|---|
| 근무 | `DC D D1 중 EC E NC N` |
| 휴무 | `OF 주 V 생 특 공 법 병 P1` |
| 트레이닝 — 인력 제외 | `/D /E /N` |

오른쪽 끝에 키 안내 `11px #8A93A1`: `셀 클릭 후 D E N O` · `드래그로 여러 칸` · `더블클릭 직접 입력` · `Ctrl+Z 되돌리기` (키는 `700 #4A5160`)

**3. 그리드** — `background:#fff; border-radius:14px; overflow:hidden; shadow-card`, 안쪽 `overflow:auto; max-height:560px`
- `border-collapse:separate; border-spacing:0` (sticky 때문에 collapse 불가 — 기존과 동일)
- 헤더 행 `38px`, `position:sticky; top:0`
  - 이름 열 헤더: `sticky left:0; z-index:4; background:#F8F9FB; min-width:92px; padding:0 14px; font:800 11px; letter-spacing:.05em; color:#8A93A1`, `box-shadow: inset -1px 0 0 #EBEDF0, inset 0 -1px 0 #EBEDF0`
  - 날짜: `min-width:34px`, 배경 평일 `#fff` / **주말 `#FAFBFC`**
    - 일자 `800 13px; tabular-nums; line-height:1.15` — 일 `#C7384A` / 토 `#1B4FC3` / 평일 `#0F1115`
    - 요일 `600 10px` — 일 `#C7384A` / 토 `#1B4FC3` / 평일 `#4A5160`
      ⚠️ 31칸 그리드에서 요일 글자는 날짜를 찾는 유일한 단서입니다. 현재 빌드도 평일은 진한 색을 상속하니 낮추지 마세요.
- 본문 행 `30px`
  - 이름 셀: `sticky left:0; z-index:2; background:#fff; padding:0 14px; font:700 13px; letter-spacing:-0.015em`, `box-shadow: inset -1px 0 0 #EBEDF0, inset 0 -1px 0 #F6F7F9`, `cursor:pointer`
  - 근무 셀: `min-width:34px; text-align:center; font:800 12px; cursor:cell; user-select:none; box-shadow: inset 0 -1px 0 #F6F7F9`, 색은 **`SHIFTS` 그대로**
  - 선택 셀 `outline:2px solid #0F1115; outline-offset:-2px` / 드래그 범위 `background: color-mix(in srgb, #0F1115 6%, transparent)` 오버레이
- 푸터 3행 `28px`, `position:sticky; bottom:0`
  - 라벨 `D 인원` `E 인원` `N 인원` — `background:#F8F9FB; padding:0 14px; font:800 11px`, 색은 각 근무색
  - 값: 맞으면 `600 11px #4A5160` 로 **숫자만**, 안 맞으면 `800 11px #C7384A` 로 **`실제/필요`** (예: `4/5`)
    — 인원 수는 이 푸터가 존재하는 이유입니다. 맞는 날 숫자도 반드시 읽혀야 합니다.
  - `box-shadow: inset 0 1px 0 #EBEDF0`

---

## 화면 05 — 관리 (`scrAdmin`) **← 신규, 가장 큰 변경**

**Purpose** — 병동 설정 9종. 현재 `<details>` 9개가 세로로 쌓여 "너무 복잡하다"는 지적을 받은 화면.

**구조 변경** — 아코디언 9개 → **왼쪽 목록(5묶음) + 오른쪽 단일 패널**. 한 번에 하나만 보입니다.

**Layout** — topbar → `display:flex; gap:16px; padding:18px 20px 22px; align-items:flex-start`

**왼쪽 목록** — `flex:0 0 244px; padding:14px 12px; border-radius:16px; background:#fff; shadow-card`, 묶음 사이 `gap:16px`
- 묶음 이름: `padding:0 10px 5px; font:800 11px; letter-spacing:.06em; color:#8A93A1`
- 항목: `padding:9px 10px; border-radius:11px; cursor:pointer; display:flex; gap:8px`
  - 이름 `13.5px; letter-spacing:-0.015em` — 활성 `700 #0F1115` + `background:#F2F3F5`, 비활성 `500 #4A5160` + `transparent`
  - 우측 상태 배지 `700 11px` — 활성 `#4A5160`, 비활성 `#8A93A1`
  - hover(비활성) `background:#F8F9FB`

| 묶음 | 항목 (배지) |
|---|---|
| 자주 쓰는 | 주간 배정표 내려받기 · 지난 어싸인 직접 입력 `16명` |
| 우리 병동 | 병실 목록 `14실` · 방 구성 · 요일별 필요 인원 |
| 간호사 | 간호사 관리 `16명` |
| 배정 규칙 | 배정 원칙 `3켬` · 수동 수정 관리 `7건` |
| 데이터 | 데이터 파일 |

배지는 현재 상태를 숫자로 — 열어보지 않아도 무엇이 설정돼 있는지 보이게 하는 장치입니다. `수동 수정 관리`는 0건이면 배지 없음.

**오른쪽 패널** — `flex:1; padding:20px 22px 22px; border-radius:16px; background:#fff; shadow-card`, 세로 `gap:12px`
- 패널 헤더: 제목 `800 18px; letter-spacing:-0.025em` + 설명 `13px #8A93A1; letter-spacing:-0.01em` (강조어 `700 #4A5160`) + 우측 보조 버튼
- 표 헤더 행 `30px`: `800 11px; letter-spacing:.05em; color:#8A93A1`, `box-shadow: inset 0 -1px 0 #EBEDF0`
- 표 본문 행 `42px`: `box-shadow: inset 0 -1px 0 #F6F7F9`
- 목록이 길면 하단에 `간호사 N명 더 있음` `12px #8A93A1` + 구분선 + `모두 보기` `700 12px #4A5160`

**패널 예시 — 간호사 관리** (디자인 파일에 그려진 패널)
- 설명: `가능한 근무를 켜고 끕니다. DC · EC · NC 를 켜면 그 시간대에 차지로 뽑힐 수 있습니다.`
- 열: `간호사 92px` / `가능 근무 300px` / `주지 않을 방 (나머지)`
- 이름 `700 14px; letter-spacing:-0.015em`
- **가능 근무 토글** — 기존 `O / ·` 텍스트를 칩으로 교체. `DC D EC E NC N` 6개, `min-width:38px; height:26px; border-radius:8px; font:800 11.5px; cursor:pointer`
  - 켜짐 `background:#0F1115; color:#fff`
  - 꺼짐 `background:#F8F9FB; color:#8A93A1; box-shadow: inset 0 0 0 1px #EBEDF0`
- **주지 않을 방** — 칩 `padding:3px 9px; border-radius:8px; background:#FEEFEF; color:#C7384A; font:700 11.5px` + 삭제 `×` `#E0A5AD`
  - 추가 버튼 `＋` `height:24px; padding:0 9px; border-radius:8px; color:#B8BFC9; box-shadow: inset 0 0 0 1px #EBEDF0` (글자가 아닌 기호라 예외)

**나머지 8개 패널** — 같은 규칙으로. 기존 컨트롤을 아래로 매핑:

| 기존 | 새 표현 |
|---|---|
| `.segbtn` 세그먼트 버튼 (지난 어싸인 A~E·D/E/N) | 위 '가능 근무 토글'과 동일 (켜짐 딥 잉크 / 꺼짐 회색) |
| `<input type="checkbox">` (배정 원칙 4개) | 행 단위 카드 + 우측 스위치, 설명은 `13px #8A93A1` 로 아래 줄 |
| 방 구성 / 병실 목록 / 요일별 필요 인원 표 | 위 '표 헤더/본문' 규칙, 숫자 입력은 공통 입력 스타일 |
| 파괴적 버튼 (모두 초기화) | 보조 버튼이되 글자 `#C7384A`, hover 시 `background:#FEEFEF` |

---

## Interactions & Behavior

**동작은 하나도 바뀌지 않습니다.** 아래는 반드시 그대로 유지해야 합니다.

- `#wkBody` 클릭 위임: `td.evt`(교육·행사 prompt) → `td.rm`(`openRoomPick`) → `td.nm`(`openPick`). `data-iso` / `data-p` / `data-l` / `data-n` 속성 유지.
- 담당 교체 픽커(`#pick`), 방 토글 픽커(`#rpick`) — 위치 계산(`e.pageX/pageY`), 큰 버튼 타깃 유지. 스타일만: 팝업 `background:#fff; border:none; border-radius:16px; box-shadow:0 10px 30px rgba(15,17,21,.10), 0 0 0 1px rgba(15,17,21,.04)`, 선택된 버튼 `background:#0F1115; color:#fff`.
- 주 이동(`moveWeek`), 오늘(`goToday`), 화면 전환(`show`), 인쇄(`printWeek`), 붙여넣기 파싱, 키보드 입력(`D/E/N/V/O`, 방향키, `Del`, `Ctrl+Z`/`Ctrl+Shift+Z`), 드래그 다중 선택, 40단계 undo.
- 파일 저장 파이프라인: `touch()` → 700ms 디바운스 → `writeStore()`, `#saveDot` 상태 3종(대기/저장중/실패) 유지.
- `visibilitychange` / `pagehide` 시 `flushSave()`.

## State Management

새 상태 없음. 관리 화면의 **선택된 패널**만 새 로컬 변수 하나(`adminPanel`, 기본값 `'seed'`)로 두고 `renderAdmin()` 안에서 분기하세요. `store` 에 저장하지 마세요(파일 스키마 불변).

- `store` (JSON 파일 스키마 — **변경 금지**): `order`, `cells`, `ovr`, `roomOv`, `events`, `seedManual`, `caps`, `req`, `rooms`, `banRooms`, `schemes`, `rules`, `rev`, `ver`
- `result` / `tlKeys` — `compute()` 결과 캐시, `recompute()` 로 갱신
- `wkSunday`, `edY`/`edM`, `curScr`, `pending`, `undoStack`

## Design Tokens

`frontend/css/tokens.css` 의 YGinvest 라이트 토큰이 원본입니다. 이번 화면에서 실제로 쓰는 값만:

```
/* 면 */
--paper      #F4F5F7   앱 배경
--paper-2    #EDEFF3   안내 띠
--card       #FFFFFF
--card-warm  #F8F9FB   라벨 셀·입력·통계 칸

/* 잉크 */
--ink        #0F1115   본문·강조·주 동작 (브랜드색 = 딥 잉크)
--ink-2      #4A5160
--ink-3      #8A93A1   보조 정보
--ink-4      #B8BFC9   ⚠ 정보가 아닌 표시에만 (… 축약, 비활성 ＋ 버튼). 흰 배경 대비 1.76:1 —
                       사용자가 읽어야 하는 글자에는 절대 쓰지 마세요
--ink-5      #D4D9E0

/* 선 */
--rule       #EBEDF0   표 격자·카드 링
--rule-2     #DCE0E6   버튼 링
--rule-soft  #F2F3F5   행 구분·비활성 배경
--rule-faint #F6F7F9   그리드 행 구분

/* 신호 (KR 관례: 빨강↑ 부족, 파랑↓ 여유) */
--up   #E84B5A   --down #2563EB
--ok   #1F8A5B / #ECF7F0
--warn #B7791F / #FBF3E2   (본문 #8A6A2A, 링 #E4CFA0)
--err  #C7384A / #FEEFEF   (삭제 × #E0A5AD)

/* 근무 */
D #1B4FC3 on #EEF3FE   E #C7384A on #FEEFEF
N #5B3FB0 on #EFEBFB   V #1F8A5B on #ECF7F0   OF #8A93A1 on #F2F3F5

/* 이번 작업의 확장값 */
오늘 열 배경     #EDF2FF
주말 열 배경     #FAFBFC   (고치기 그리드)
구분 헤더 배경   #E4E9F5   (인쇄)
화재/대피 배경   #FDECE4   글자 #C2410C
Team Play 배경  #FEF3F3

/* 반경 */
카드 16px · 표 카드 14px · 버튼 12~13px · 작은 칩 7~8px · 배지 9999px · 인쇄 블록 1.6mm

/* 그림자 */
--shadow-card 0 1px 2px rgba(15,17,21,.04), 0 0 0 1px rgba(15,17,21,.04)
--shadow-ring 0 0 0 1px #EBEDF0
--shadow-pop  0 10px 30px rgba(15,17,21,.10), 0 0 0 1px rgba(15,17,21,.04)

/* 서체 — Pretendard 단일 */
'Pretendard Variable', Pretendard, -apple-system, system-ui, sans-serif
화면: 10·11·12·13·14·15·16·17·18·26px (800/700/600/500)
letter-spacing: -0.01em(본문) ~ -0.035em(큰 제목) · 라벨은 +.05em
숫자에는 항상 font-variant-numeric: tabular-nums
키 표시(Ctrl+C 등)는 ui-monospace, SFMono-Regular, Menlo, monospace
```

`SHIFTS` 코드별 색은 현재 `assign.html` 값이 이미 토큰과 같은 계열이므로 **그대로 두세요**:
`DC #E2ECFD/#1B4FC3`, `D #EEF3FE/#1B4FC3`, `D1 #F0F6FF/#2563EB`, `중 #FBF3E2/#B7791F`, `EC #FCE3E5/#C7384A`, `E #FEEFEF/#C7384A`, `NC #E7E0F8/#5B3FB0`, `N #EFEBFB/#5B3FB0`, `OF #F2F3F5/#8A93A1`, `주 #EDEFF3/#4A5160`, `V #ECF7F0/#1F8A5B`, `생 #FCEAF1/#B83280`, `특 #F1ECFB/#6D4AC0`, `공 #E8F5EE/#1F8A5B`, `법 #FDEEE5/#C2410C`, `병 #FEEAEA/#C7384A`, `P1 #E3F4F4/#2C7A7B`, `/D /E /N #F5F7FA/#94A3B8`

---

## 화면 06 — A4 출력양식 *(구현 완료)*

`design/02_print_form_a4.dc.html`. 화면 리디자인과 독립적으로 봐도 됩니다.

**용지 규칙**
- A4 세로, **사방 여백 정확히 1cm**, 내용 영역 `190 × 277mm`, **한 장에 정확히**
- `@page { size: A4 portrait; margin: 0 }` + 시트에 `padding:10mm; box-sizing:border-box`
  ⚠️ 여백을 안쪽 요소의 `margin` 으로 주면 세로 마진이 페이지 박스 밖으로 collapse 되어 종이 위쪽에 붙습니다. **반드시 padding**으로.
- `-webkit-print-color-adjust:exact; print-color-adjust:exact`

**세로 블록 구성 — 합계가 항상 정확히 277mm**

| # | 블록 | 높이 |
|---|---|---|
| 1 | 제목 띠 | 9mm (`background:#0F1115`, radius 1.6mm) |
| 2 | 간격 | 2mm |
| 3 | 주간표 | `9 + eventH + 13×rowH + 6.5` — 기본 `eventH=20`, `rowH=7.2` → **129.1mm** |
| 4 | 간격 | 3mm |
| 5 | 물품체크 | 44.5mm (헤더 6.5 + 5행 × 7.6) |
| 6 | 간격 | 3mm |
| 7 | Team Play 띠 | 6.5mm |
| 8 | 간격 | 1.5mm |
| 9 | CPR 업무분담 | `277 − 112.5 − 주간표` — 기본 **35.4mm**, 행 = /5 |
| 10 | 간격 | 3mm |
| 11 | 화재발생시 | 내용 높이(`flex:0 0 auto`) |
| 12 | 신축 간격 | `flex:1 1 1.5mm` — 화재 블록이 남긴 높이를 흡수 |
| 13 | 대피 장소 띠 | 6.5mm |

내용 영역을 `display:flex; flex-direction:column; height:277mm` 로 두고 각 블록에 위 `flex-basis`. 11번만 `auto`, 12번만 신축 — 그래서 기관 지침 문구가 길어져 줄이 늘어도 총합이 277mm로 유지됩니다.

**열 너비** — 각 블록 첫 행 셀에 `width` 지정. `border-collapse:collapse` 라 실제 렌더 폭이 선언값보다 0.1~0.7mm 커지므로 **선언 합계를 190mm보다 3~5mm 작게** 두고 `table{width:100%}` 로 남은 폭을 비례 배분.

| 블록 | 열 |
|---|---|
| 주간표 | `22mm`(교육·행사, colspan 2) + 7 × `23.6mm`(요일별 colspan 2 → 방/이름 균등) |
| 물품체크 | `22 / 54 / 44 / 66` |
| CPR | `10.5 / 11.5 / 21 / 88 / 45` |
| 화재발생시 | `10.5 / D·E 82 / N = 176 − D·E` |

**글자 크기 (원본 4.5~8.4pt → 6.8~13pt 상향)**

| 요소 | 값 |
|---|---|
| 제목 | 13pt/800 `#fff` · 우측 기간 8pt/600 `rgba(255,255,255,.62)` |
| 요일 / 날짜 | 8pt/700 / 11pt/800 tabular-nums |
| 교육·행사 | 7pt/600 `#B7791F`, `vertical-align:top` |
| 레일 D·E·N | 11pt/800 |
| 라벨 A(CN)~E | 7.5pt/700 `#4A5160` on `#F8F9FB` |
| 방 / 이름 | 7.5pt/600 `#4A5160` / 9pt/700 `#0F1115` |
| 중간번 | 라벨 7.5pt/800 `#B7791F` on `#FBF3E2` · 값 8.5pt/700 |
| 구분 헤더 | 8.5pt/800 — 구분 `#E4E9F5`, D `#EEF3FE`/`#1B4FC3`, E `#FEEFEF`/`#C7384A`, N `#EFEBFB`/`#5B3FB0` |
| 물품체크 본문 / 세로라벨 | 7.5pt/600 lh 1.35 / 8pt/800 `#0F1115` on `#EDEFF3` |
| Team Play 띠 | 8pt/700 `#C7384A` on `#FEF3F3` |
| CPR 역할 / 설명 | `cprPt`(아래 공식) — 역할 800 `#C7384A`, 설명 600 `#0F1115` lh 1.35 |
| CPR 세로라벨 | 8pt/800 `#1F8A5B` on `#ECF7F0` |
| 화재 세로라벨 / 헤더 | 8pt/800 `#fff` on `#C7384A` / 8pt/800 `#C2410C` on `#FDECE4` |
| 화재 1행 / 2행 | `firePt`(기본 7pt)/600 `#C7384A` lh 1.4 · `firePt−0.2`/600 `#4A5160` lh 1.2 |
| 대피 장소 띠 | 7.5pt/700 `#C2410C` on `#FDECE4` |
| 셀 테두리 / 블록 링 | `0.25mm solid #DCE0E6` / `0 0 0 0.3mm #DCE0E6` |

**CPR 글자 크기 자동 계산** — CPR 칸은 2줄이 들어가야 하므로 블록 높이에서 역산:

```js
const cprRowH = cprH / 5;                                     // mm
const cprPt = Math.max(5.6, Math.min(7.5,
  Math.round((cprRowH - 1) / 2 / 1.35 / 0.3528 * 10) / 10));   // 1mm 패딩, lh 1.35, 1pt=0.3528mm
```

**원본 xlsx 색 → 새 색 매핑** (양식 문구는 그대로, 색만 교체)

| 원본 | 용도 | 새 값 |
|---|---|---|
| `#7030A0` | 제목 띠 | `#0F1115` |
| `#B4C6E7` | 구분 헤더 | `#E4E9F5` |
| `#D9E2F3` | 물품체크 세로라벨 | `#EDEFF3` |
| `#92D050` | CPR 세로라벨 | `#ECF7F0` + 글자 `#1F8A5B` |
| `#E2EFDA` | Team Play / 역할 라벨 | `#FEF3F3` / `#F8F9FB` |
| `#F8CBAD` | 화재 헤더·대피 | `#FDECE4` + 글자 `#C2410C` |
| `#FF0000` | 화재 세로라벨 / 강조 글자 | `#C7384A` |
| `#0000FF` | 토요일 등 | `#1B4FC3` |
| `#289B6E` / `#BF9000` / `#4472C4` | 기타 글자색 | `#1F8A5B` / `#B7791F` / `#1B4FC3` |

**조절 가능해야 하는 값** (기관 방침이 바뀔 수 있는 자리 — 상수로 빼두세요)
- 화재발생시 `D/E` 칸 너비 70~96mm (N 칸은 `176 − D/E` 자동)
- 화재 문구 글자 크기 5.6~7.6pt
- 주간표 근무 행 높이 6.2~7.2mm · 교육·행사 칸 높이 8~20mm
- 어느 조합이어도 세로 합계는 277mm로 유지되어야 합니다

---

## Assets

| 자산 | 출처 | 비고 |
|---|---|---|
| `assets/cpr-flow.png` | `병실 배정표.xlsx` 의 `xl/media/image1.png` | 524×579px. 인쇄 시트 CPR 블록 우측. **이미지 교체·재작성 금지** |
| Pretendard Variable | `frontend/fonts/PretendardVariable.woff2` (저장소에 있음, 2.06MB) | 단일 파일 오프라인 요구 → `@font-face { src: url(data:font/woff2;base64,…) format('woff2-variations') }` 로 내장 |

CDN·웹폰트 링크를 코드에 남기지 마세요. 병원 인트라넷에서 실행됩니다.

인쇄 시트의 문구·CPR 도해는 계속 **내장 xlsx 양식에서 읽는 구조를 유지**하세요(`getCellText(tpl.sheetXml, …)`). 코드에 하드코딩하면 기관 방침이 바뀔 때 양식만 갈아끼우는 경로가 막힙니다.

---

## 구현 순서 (standalone/assign.html)

주간 화면·인쇄 시트가 이미 반영돼 있으므로 **4~7번이 이번 작업**입니다.

1. ~~서체 base64 `@font-face`~~ *(완료)*
2. ~~기본값: `body` / `button` / `.pri` / `input` / `select` / `.dim`~~ *(완료)*
3. ~~셸: `.topbar` / `.screen` / `.card` / `.wknav`~~ *(완료)*
4. **`scrStart`** — `.box` / `.steps` 규칙 교체, 버튼 3개를 위계 있는 새 마크업으로. `#btnResume` 에 파일명·시각 부제 추가(핸들 메타에서 읽기). 없을 때 `데이터 파일 열기` 를 주 동작으로 승격.
5. **`scrPaste`** — `.guide` 를 단계 카드 2개 + 드롭 영역으로. `#pvInfo` 를 통계 3칸으로, `#pvYM` 을 노란 확인 카드로(연·월이 헤더에 있으면 회색 톤). `#pvWrap` 미리보기 표에 새 격자 적용. 버튼 이모지 제거.
6. **`scrEdit`** — 툴바에 상태 칩 추가, `#lgd` 를 3묶음 범례로(`SHIFTS` 를 그룹 배열로 재정의), sticky 헤더/이름 열 배경·그림자 교체, 주말 열 틴트, 푸터를 `실제/필요` 로. **셀 색·키 처리·드래그·undo 무변경.**
7. **`scrAdmin`** — `<details>` 9개를 왼쪽 목록 + 오른쪽 패널로 재구성. `adminPanel` 로컬 변수 + `renderAdmin()` 분기. `.segbtn` 을 켜짐/꺼짐 칩으로, 파괴적 버튼은 빨간 글자로. 항목 배지 숫자는 `store` 에서 직접 계산.
8. **픽커** — `#pick` / `#rpick` 을 shadow-pop + radius 16 + 선택 버튼 딥 잉크로.
9. **회귀 확인** — 아래 체크리스트.

### 절대 유지 (회귀 금지)

- `store` JSON 스키마와 `ver:3` / `rev` 증가 규칙, 저장 충돌 처리
- `tplB64`(xlsx 양식 base64)와 `downloadWeekXlsx()` 출력 — **바이트 단위로 동일**
- 양식 문구·CPR 이미지: xlsx 셀에서 읽는 방식
- 키보드·드래그·undo 동작, 클릭 타깃 크기(태블릿 44px 이상)
- 오프라인 단일 파일, Chrome 103+, `file://` 실행

### 확인 체크리스트

- [ ] 시작 화면에서 이어서 시작이 있을 때/없을 때 주 동작이 각각 하나만 딥 잉크인가
- [ ] 붙여넣기 후 연·월 확인 카드가 뜨고, 헤더에 연·월이 있으면 회색 톤으로 내려가는가
- [ ] 고치기 화면 범례가 3묶음으로 나오고 코드가 하나도 빠지지 않았는가
- [ ] 고치기 푸터가 맞는 날은 숫자만, 안 맞는 날만 `실제/필요` 빨강인가
- [ ] 관리 화면에서 9개 항목이 전부 왼쪽 목록에 있고 각 패널이 정상 동작하는가
- [ ] 관리 배지 숫자(16명·14실·3켬·7건)가 실제 `store` 값과 맞는가
- [ ] 주간 화면에서 오늘 열이 한눈에 보이는가 (배경 + `오늘` 칩)
- [ ] 경고 0건 / 1건 / 5건에서 카드가 각각 정상인가
- [ ] 이름 클릭 → 담당 교체, 방 클릭 → 병상 수정, 맨 윗줄 클릭 → 교육·행사 입력이 그대로 동작
- [ ] 수동 교체(빨강) / 방 수정(파랑) / 방 겹침(빨강 글자) 표시가 남아 있는가
- [ ] 근무표가 없는 주/달에서 빈 상태 안내가 정상
- [ ] `Ctrl+P` 와 `이번 주 인쇄` 모두 A4 1장, 사방 여백 1cm, 잘림 없음
- [ ] 인쇄 미리보기에서 화재 대응 문구가 모두 보이는가
- [ ] `이번 달 전체 인쇄(5~6장)` 에서 각 장이 독립적으로 1페이지인가
- [ ] `주간 배정표 파일(xlsx) 내려받기` 결과가 원본 양식과 동일한가
- [ ] 태블릿(1024px 폭)에서 툴바가 2줄로 접히되 표가 가로 스크롤 없이 들어오는가

## Files

```
design/
  01_screens_final.dc.html    화면 5개 최종본 (주간·시작·넣기·고치기·관리)
  02_print_form_a4.dc.html    A4 인쇄 시트 (사방 1cm, 277mm 정확 배분)
  support.js                  위 파일들을 브라우저에서 렌더하는 런타임
  doc-page.js                 인쇄 시트의 페이지 박스 컴포넌트
assets/
  cpr-flow.png                xlsx 에서 추출한 CPR 도해 (원본 그대로)
```

원본 코드 참조 위치 (yuangunn/nurse-v4, branch `main`):

| 대상 | 위치 |
|---|---|
| 화면 CSS·마크업·렌더 함수 | `standalone/assign.html` — 빌드 산출물이라 저장소에 없음. `scripts/build-assign-standalone.mjs` 참고 |
| 디자인 토큰 원본 | `frontend/css/tokens.css`, `frontend/css/yginvest-skin.css` |
| 서체 | `frontend/fonts/PretendardVariable.woff2` |
| 어싸인 코어 로직 | `frontend/js/modules/assign-core.js` |
| 출력양식 원본 | `병실 배정표.xlsx` (sheet1 `A1:Q34`, 병합·행높이·문구) |
