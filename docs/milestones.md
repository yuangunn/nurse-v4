# NurseScheduler v4 — 마일스톤 (기능 로드맵)

> 세션이 바뀌어도 이어서 작업할 수 있도록 하는 로드맵.
> 항목마다 **배경 → 현재 상태 → 설계 → 남은 작업 → 파일 포인터** 순.
> 착수 전 [`decisions.md`](decisions.md)의 결정·네거티브 지식 확인, 완료하면 여기 상태 갱신 + 세션노트 기록.
> 마지막 갱신: 2026-08-18 (요청 출처: 2026-08-18 사용자 요청 3건)

상태 표기: ⬜ 대기 · 🔶 진행 중 · ✅ 코드 완료(릴리즈 대기) · 🚀 릴리즈됨

---

## M1. 기존 근무표를 저장 탭에 업로드 (엑셀 파일 or 붙여넣기) — ✅ 코드 완료 (2026-08-18)

### 배경 (사용자 요청)
이미 만들어져 있는(과거·수기) 번표를 앱에 넣으려면 사전입력 탭에 붙여넣고
"이대로 근무표로"를 거쳐 다시 저장해야 했다. **저장 탭에서 바로** 엑셀 파일 업로드
또는 붙여넣기로 저장 목록에 추가되게 해달라는 요청.

### 구현된 것
- **저장 탭 → [📥 근무표 업로드]** 버튼 → 기존 붙여넣기 모달을 `target='saved'`로 재사용.
  - 붙여넣기(Ctrl+V) 또는 **[📂 엑셀/CSV 파일 열기]** 둘 다 가능. 파일은 서버
    `POST /api/parse-table-file`(openpyxl)로 파싱해 같은 매칭 파이프라인에 공급.
    xlsx/xlsm/csv/tsv 지원, **병합 셀 값 전파**, 날짜 셀은 ISO 문자열로 변환,
    CSV는 CP949 폴백. 시트가 여러 개면 데이터 많은 시트 자동 선택 + 시트 선택 UI.
  - **저장 년월 자동 감지**: 날짜 헤더에 월이 있으면 다수 월을 앵커로 자동 설정
    (`_maybeAutoAnchor`), 수동 수정 가능. 저장 이름 입력란 포함.
  - 적용 시 `POST /api/schedules`로 바로 저장 — 인식된 셀 전체(`matched_all`)를
    schedule로, **표에서 역산한 일별 D/E/N 인원을 `prev_day_reqs`로 함께 저장**
    (불러온 뒤 재조정/재생성 시 이 표가 인원 기준이 되게). 솔버는 돌리지 않고
    점수는 비어 있음 (usePrevAsSchedule과 같은 철학).
  - 명부에 없는 이름은 기존 "＋ 간호사로 추가하고 다시 맞추기" 버튼 재사용.
- 구형 `.xls`(97-2003)는 **비지원** — 안내 토스트 (xlsx 재저장 또는 붙여넣기 유도).
- **멀티시트(연간 번표) 일괄 업로드** (2026-08-18 추가 요청): 시트가 2개 이상이면
  각 시트를 년월에 매핑하는 표가 떠서 체크·년/월 수정 후 **한 번에 월별 저장본 N건** 생성.
  감지 우선순위 = 시트 내용의 명시 월(다수) > 시트 이름(`1월`·`2026년 1월`·`2026-1`) >
  파일 이름 연도(`26년 번표.xlsx`→2026) > 보고 있는 년월. "통계" 같은 비근무 시트는
  월 미상으로 자동 체크 해제. 행 클릭 = 그 시트 미리보기, 단일 시트 파일은 기존 흐름 그대로
  (시트/파일 이름 년월은 앵커로만 반영). 핵심 함수: `_analyzeBatch`/`_applyBatchSaved`/
  `_parseSheetNameYM`/`_parseFileNameYear`, 매칭 코어는 `_matchGrid`로 순수화해 공유.

### 남은 작업
- [ ] 실제 병동 xlsx 양식으로 확인 (표 위 제목 행·비고 열 등 잡음이 매칭 점수를 얼마나 흔드는지)
- [ ] 모달 위 파일 드래그&드롭 (지금은 파일 선택 버튼만; CSV 가져오기의 `onCsvDrop` 패턴 참고)
- [ ] MANUAL.md에 사용법 추가, 버전 문자열·릴리즈 (`electron/package.json`, `installer/setup.iss`, `frontend/index.html`, `README.md`)

### 파일
| 파일 | 내용 |
|---|---|
| `server/api.py` | `POST /api/parse-table-file` + `_parse_xlsx_sheets`/`_parse_delimited_sheets`/`_cell_to_str` |
| `frontend/js/modules/paste-import.js` | `target='saved'` 분기, `_applyPasteSaved`, `_loadPasteFile`/`_selectPasteSheet`, `_maybeAutoAnchor` |
| `frontend/index.html` | 저장 탭 업로드 버튼, 모달의 파일 열기·년월/이름 입력·저장 미리보기 |
| `requirements.txt` / `NurseScheduler.spec` | `openpyxl` 의존성 + hiddenimports (`openpyxl`, `et_xmlfile`) |
| `tests/test_parse_table_file.py` | 엔드포인트 회귀 6건 (xlsx 날짜/병합, CP949, 구분자, 거부 케이스) |

---

## M2. 사전입력 붙여넣기 멀티월 적용 (1달 단위로 끊지 않기) — ✅ 코드 완료 (2026-08-18)

### 배경 (사용자 요청)
사전근무 엑셀 붙여넣기가 **보고 있는 달**에만 매칭되고 그 외 날짜는 버려졌다
(날짜 셀에서 일(日)만 뽑고 월은 무시). 복사해 온 표를 분석해서 **해당되는 일자에
모두** 적용되게 해달라는 요청 — 전월 말 이월 구간이나 두 달치 표가 대표 사례.

### 구현된 것 (날짜 해석 규칙 — `_parseDateCell` + `_resolveHeaderDates`)
1. **월 명시 셀은 그대로 해석**: `5/26`, `5월 26일`, `5.26`, `2026-05-26`,
   `2026년 5월 26일`. 연도가 없으면 앵커 년월에 가장 가까운 해(동률이면 과거).
2. **일자만 있는 셀은 문맥으로 월을 이음**: 앞선 월 명시 셀에서 순방향 전파
   (일자가 줄어들면 +1개월), 첫 명시 셀 앞은 역방향 전파 (일자가 늘면 -1개월).
3. **전부 일자만이면 run 분리**: 일자가 감소하는 지점을 월 경계로 보고,
   **1로 시작하는 첫 run = 앵커 년월**(없으면 첫 run), 앞 run은 한 달씩 이전,
   뒤 run은 한 달씩 다음. `26~31 | 1~30` (이월형), `1~30 | 1~31` (두 달 연속) 모두 처리.
   단일 run `1~31`은 기존과 동일하게 당월.
4. 실존하지 않는 날짜(2/30 등)는 무효 처리. 앵커 = 보고 있는 년월
   (저장탭 업로드에서는 모달의 년월 입력).
- 적용은 dayKey(`YYYY-MM-DD`) 전체 키라 당월 밖도 `prevSchedule`에 그대로 저장 —
  달을 바꾸면 보이고, 사전입력 서버 저장/자동복원도 전체가 함께 간다.
  위시(★)도 동일 (스케줄러가 주기 밖 위시 키는 원래 무시하므로 안전).
- **미리보기 강화**: `날짜 해석: 2026-05-26 ~ 2026-06-30` 범위 표시,
  월별 적용 건수 pill(`📅 2026년 5월 6건`), 당월 주기 밖 건수 경고 문구,
  적용 토스트에도 월별 건수.

### 남은 작업
- [ ] 없음 (실사용 피드백 대기). 헤더 없는 붙여넣기(fallback)와 커서 붙여넣기는
      기존대로 당월 한정 — 여기까지 멀티월로 넓힐지는 실제 필요가 생기면.

### 파일
| 파일 | 내용 |
|---|---|
| `frontend/js/modules/paste-import.js` | `_parseDateCell`(월·연도 인식), `_resolveHeaderDates`, `_matchPasteGrid`(월별 집계·주기 밖 카운트) |
| `frontend/index.html` | 날짜 해석 범위·월별 pill·주기 밖 경고 표시 |
| `scripts/test_paste_dates.mjs` | 날짜 해석 순수 로직 검증 (node, 30여 케이스) — `node scripts/test_paste_dates.mjs` |

---

## M3. 간호사 명부 CSV 입출력 대체 — 🔶 1차(xlsx 왕복) 완료 (2026-08-18) · 2차(명부 붙여넣기)는 백로그

### 배경 (사용자 요청)
"간호사 템플릿 csv로 저장하고 내보내는 게 너무 불편해. 다른 방식으로 해줄 수
있는지 알아봐줘." — 아래 조사에 따라 **권장 1차(A. xlsx 왕복)를 구현 완료**.

### 구현된 것 (1차 — xlsx 왕복)
- `GET /api/nurses/template.xlsx` / `GET /api/nurses/export.xlsx` — 같은 형식 공유
  (헤더 서식·열 폭·틀 고정 + **드롭다운**: 성별/야간전담/주휴요일/주휴로테이션/트레이닝
  + '작성 방법' 안내 시트). 내보내서 고치고 그대로 가져오는 왕복 편집.
- 가져오기: 기존 preview/diff 모달 그대로, 파일이 xlsx면 **매직 바이트(PK)로 자동 감지**
  (확장자·파일명 무관) → `_parse_xlsx_sheets` → '이름' 헤더 있는 시트 선택
  (`_pick_nurse_sheet_rows`) → 공통 행 파서. 날짜 셀은 ISO로, '여/남'도 기존처럼 인식.
- 리팩토링: `_parse_nurses_csv(text)` → `_parse_nurses_rows(rows)` (CSV·xlsx 공용,
  `#` 주석 행 무시 유지), `_decode_csv_input` → `_decode_nurse_table_rows`,
  내보내기 행 변환은 `_nurse_to_row`로 공용화. **CSV 경로는 호환 유지**
  (`/api/nurses/template`·`/api/nurses/export` 존치, 가져오기는 CSV도 그대로 받음).
- 프론트: 템플릿/내보내기 버튼이 xlsx를 받고, 가져오기 accept·드롭존이 xlsx 허용.
- 검증: `tests/test_nurse_xlsx.py` 5건 (템플릿 구조/드롭다운·내보내기 형식·xlsx 가져오기
  왕복(날짜 셀→ISO·여→female·시트 선택)·CSV 회귀·주석 행) + E2E(설정 탭 xlsx 가져오기 → 등록).

### 현행 흐름과 불편 지점
- 템플릿: `GET /api/nurses/template` → `#` 주석 안내 행이 붙은 CSV (14컬럼:
  id·이름·그룹·성별·가능근무·야간전담·시니어리티·주휴요일·주휴자동·트레이니·
  교육종료일·프리셉터ID·전입일·전출일).
- 가져오기: `POST /api/nurses/import/preview` → 추가/수정/삭제 diff 미리보기 → `import`.
  인코딩 자동 감지(utf-8-sig/cp949) 등은 이미 견고.
- **남는 불편은 CSV라는 형식 자체**:
  1. 엑셀에서 편집 후 "CSV로 저장" 단계 필요 — 형식 손실 경고 대화상자, 시트 1개 제한.
  2. `가능근무`가 쉼표 구분(`"DC,D,EC,E"`)이라 CSV 안에서 따옴표 감싸기 필요 — 손으로 만들면 잘 깨짐.
  3. `#` 주석 행이 엑셀 화면에서 어색하고 실수로 남기면 헷갈림.
  4. wishes·night_months·임신 구간은 CSV에 아예 없음 (부분 필드만 왕복).

### 대안 비교
| 안 | 내용 | 장점 | 비용 |
|---|---|---|---|
| **A. xlsx 왕복 (권장 1차)** | 템플릿/내보내기/가져오기를 `.xlsx`로 | "CSV로 저장" 단계·인코딩 문제 소멸. 성별/Y·N/요일에 **데이터 유효성 드롭다운**, 가능근무는 근무별 O/X 컬럼으로 분해 가능. M1에서 openpyxl·`/api/parse-table-file`이 이미 들어와 비용 급감 | 서버 엔드포인트 2개(template.xlsx/export.xlsx) + 가져오기를 rows→기존 `_parse_nurses_csv` 매칭 로직에 연결 |
| **B. 명부 붙여넣기 (권장 2차)** | 파일 없이 엑셀 범위 복사→붙여넣기로 명부 등록/일괄 수정 | 파일 자체가 사라짐 — 근무표 붙여넣기와 UX 통일. 이미 붙여넣기에서 간호사 자동 추가(f6c00e0)가 있어 자연 확장 | 헤더 컬럼 자동 매핑(이름/그룹/성별…) + 미리보기 모달. paste-import 인프라 재사용 |
| C. CSV 유지 + 소폭 개선 | 주석 행 제거, 안내를 화면으로 이동 | 최소 변경 | 1·2·4 불편이 그대로 |

### 남은 작업 (2차 — 백로그)
- [ ] **B. 명부 붙여넣기**: 설정 탭 간호사 섹션에 "표 붙여넣기" 버튼 → 컬럼 매핑
      미리보기 → 적용 (paste-import 인프라 재사용). 실사용에서 파일 왕복이 불편하다는
      피드백이 나오면 착수.
- [ ] MANUAL.md 갱신 (M1 잔여와 함께 릴리즈 전에).

### 파일 포인터 (착수 시 볼 곳)
`server/api.py` (`_NURSE_CSV_HEADER`/`_parse_nurses_csv`/`nurse_import_preview` ~440-840행 부근,
`_parse_xlsx_sheets` ~840행 부근) · `frontend/js/modules/schedule-features.js`
(CSV 입출력 UI, `csvImportPreview`) · `frontend/index.html` (CSV 가져오기 모달)

---

## 백로그 (세션 중 발견, 우선순위 낮음)
- 붙여넣기 모달 파일 DnD (M1 잔여와 동일)
- Alpine 템플릿 null-접근 콘솔 오류 27건 — 프로필 열 때부터 발생하는 기존 노이즈
  (`diagResult.*`, `wishReport.*`, `nurseModal.data.pregnancy.*` 등을 x-text가 가드 없이 참조).
  동작엔 지장 없으나 디버깅 시 시야를 가림. `?.` 가드 일괄 정리 후보.
- E2E 스모크 자동화 — 이번 세션에서 playwright로 게스트 진입→붙여넣기→저장까지
  검증하는 스크립트를 썼음 (레포 밖 스크래치). 반복될 것 같으면 `scripts/e2e_smoke.mjs`로 승격.
