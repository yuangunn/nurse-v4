# NurseScheduler v4 — 아키텍처 결정 · 네거티브 지식

> 컴팩팅/세션 재시작으로 잃기 쉬운 세부 맥락 보존용.
> "이 방법은 시도했는데 실패함" 같은 네거티브 지식 포함.
> 마지막 갱신: 2026-06-02

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

### 1-9. 소프트 제약 preBonus = 차등 (2026-08-20 정정)
- `preBonusLeave: 5000` > `preBonusOff: 3000`(OF·P1) > `preBonusWork: 500` > `preBonusRest: 300`(주휴,
  `allow_juhu_relax` 시에만 변수). 완화 시 **근무가 먼저**, 쉬는 날·휴가는 개인의 시간이라 늦게.
- 2단계 사전순: 1단계 '유지 보너스'만 gap 0으로 최대화(뒤집는 셀 수 확정) → 2단계 그 수준을
  하드로 고정하고 배점 최적화. 1단계 미증명 시 dom 가중 단일 솔브 폴백.
- 구버전 문서("쉬는 날 300, 가장 유연")는 코드와 달랐다 — `preBonusOff`는 코드에 getattr
  기본값으로만 있었고 모델·UI·매뉴얼에 없었다(M6 조사 F4). 2026-08-20 모델 필드·슬라이더 추가.
- **보호 채널은 잠금(🔒)뿐** — 메모는 기록용 (사용자 결정, 제1원칙 9).
- **파일**: `server/scheduler.py:_solve_with_relaxed_pre()`, `scheduler_cpsat.py` 완화, `models.py Rules`

### 1-10. 동시 생성 방지 = 409 에러
- `POST /api/generate` 진입 시 이전 솔버 실행 중이면 409 반환.

### 1-11. 라이선스 = All Rights Reserved (상업 사용 불가)
- 공개 리포지토리지만 사용·수정·배포 전반 금지.
- 외부망 환경에서 먼저 테스트 권장(README에 명시).

### 1-12. CSS 변수는 `--bg-card`, NOT `--card` (2026-04-19 확정)
- **결정**: 카드 배경은 항상 `var(--bg-card)` 사용.
- **이유**: `--card`는 정의되지 않았음. 과거 코드가 `var(--card, #fff)` 쓰면 fallback으로 항상 흰색이 돼서 다크모드가 깨짐 (프로필창·온보딩 모달 안 보임 버그 원인).

### 1-13. 임산부 모성보호 = 변수 게이팅 + P1 주1회 하드 (2026-06-02 확정)
- **결정**: 임산부 기능을 "새 제약 메서드 최소화 + 변수 도메인 게이팅" 방식으로 구현.
  - 새 근무 `P1`(임부휴무, period=rest, auto_assign=1). `_DEFAULT_SHIFTS`+DB seed+마이그레이션(INSERT OR IGNORE) 모두 추가.
  - **야간 제외·생 면제·P1 구간 제한은 전부 변수 게이팅**(`_preg_forbids`로 해당 셀 변수=0) — 별도 제약식 불필요. 야간/생 사전입력은 `_preg_effective_pre`로 드롭(사전입력 N 강제→infeasible 회피).
  - **유일한 양(positive) 제약 = P1 주1회**(`_c_pregnancy_p1_weekly`/`_cs_pregnancy_p1_weekly`): 구간 완전 포함 주 `==1`, 부분 주 `≤1` (weeklyOff 패턴).
- **이유**: 게이팅은 HiGHS 2곳(solve+relaxed)·CP-SAT 2곳(build_vars+relaxed)·conflict_analyzer(build_vars_mcs)에 헬퍼 호출 1줄씩만 추가하면 끝 → 5엔진경로 패리티가 단순·견고. P1을 SOLVER_SHIFTS에 두되 게이팅으로 비임산부·구간밖은 0.
- **야간 제외 구간 = `[early.start, late.end]` 전체**(중기 포함). 2구간 입력만으로 "임신~출산" 도출(별도 임신 전체구간 칸 없음).
- **임산부 달엔 `is_night_shift` 자동 해제**(`__init__`): 야간전담 14일 의무와 야간 면제 충돌 방지.
- **P1 보호등급 = OFF급**(`timeoff_class`→'off', `_OFF_CODES`={OF,P1}): 완화/MCS에서 근무보다 강하게 보호.
- **파일**: `models.py`(is_pregnant,pregnancy)·`database.py`(2컬럼+P1 seed/마이그)·`scheduler_base.py`(헬퍼 5종+게이팅+분류)·`scheduler_highs_constraints.py`·`scheduler.py`(solve/relaxed 게이팅)·`scheduler_cpsat.py`·`conflict_analyzer.py`·`frontend`(모달 카드+🤰배지). 테스트 `tests/test_pregnancy.py`(양엔진 10건).

### 1-14. 완전 확정 표 폴백 — 완성 번표는 '주어진 사실' (2026-08-19 확정)
- **결정**: 당월 재적 셀이 사전입력으로 **빈칸 없이** 채워져 있으면, 솔버가
  infeasible/타임아웃이어도 실패를 반환하지 않고 **표를 그대로 근무표로 확정**한다
  (`pinned_confirmed`, 점수 계산 포함). 앱 규칙과 다른 부분(일별 인원·전환·주별 OF·
  V/야간 한도·연속·야간전담 일수)은 `pinned_notes` **참고 목록**으로만 알린다.
- **이유**: 이미 만들어진(지나간) 번표는 검증 대상이 아니라 주어진 사실 — 인원 수치를
  대며 거부하면 사용자는 원인을 알 수 없다. 규칙은 솔버의 '자유 배정'을 제한하는
  것이지 사용자가 직접 확정한 표를 거부하는 장치가 아니다.
- **우선순위**: 완화(allow_pre_relax)를 명시로 켰으면 완화가 먼저(표를 고쳐서라도
  규칙을 맞추길 원한 것), 실패 시 폴백. 폴백은 진단보다 먼저.
- **파일**: `scheduler_base.py`(`_fully_pinned`/`_confirm_pinned_result`/`_pinned_rule_notes`),
  `scheduler.py`·`scheduler_cpsat.py` 실패 분기 4곳. 테스트 `tests/test_pinned_confirm.py`.
- **현황**: 1-15 사실-클램프 도입 후 완전 확정 표는 대부분 솔버가 **직접 성공**하므로
  이 폴백은 안전망(예: 타임아웃)으로만 남는다.

### 1-15. 사실-클램프 — 부분 확정 일반화 (2026-08-19 확정)
- **결정**: 1-14를 **부분 확정**까지 일반화. "2주차까지만 꽉 채우고 바꾸고 싶은 부분만
  비워서 생성"도 확정 부분은 검증하지 않는다 (사용자: "일단위로 근무표가 모두 차있다면
  그 일에만 확정하는 게 맞지 않을까"). 구현 의미론 2가지:
  - **스킵**: 제약에 걸리는 셀이 **전부 확정**이면 그 제약을 걸지 않는다 — 일 전체
    확정(일별 인원·charge·시니어리티, 변수도 리터럴화해 승격 플렉스 제거), 인접
    쌍/3셀 확정(금지 전환·NOD), 윈도우 확정(연속 근무/야간), 주 전체 확정(주 OF·P1),
    확정 휴식일(restAfterNight의 rest_d), 확정 셀 eligibility.
  - **클램프**: 확정+자유 혼합 카운트 제약은 상한(RHS)을 `max(규칙 한도, 확정분)`으로
    올린다 — 일별 인원, 주 OF/P1 bound, 월 V/야간/생/홀짝월, 야간전담 5일 윈도우·월간
    목표. 효과: 기존 확정(예: OF 2회)은 수용하되 **자유 셀이 위반을 더 늘리는 건 금지**.
- **비활성 조건**: `allow_pre_relax=True`면 `_pin={}`로 클램프 전체 OFF — 완화를 명시로
  켠 사용자는 "표를 고쳐서라도 규칙을 맞춰라"는 뜻 (1-14 우선순위와 동일).
- **안내**: strict 성공 결과에 `_attach_pin_notes()`가 `pinned_notes`(확정 사실 vs 앱
  규칙 차이: 인원/전환/OF/V/연속/restAfterNight/NOD/야간전담)를 덧붙인다. 확정 표가
  참이므로 성공해도 사용자는 차이를 안다.
- **진단과의 관계**: 진단 13단계는 `_c_*` 재사용이라 클램프가 자동 일관 — 확정만으로
  완결된 위반은 진단 대상에서도 빠진다(그건 이제 실패 원인이 아니므로 올바름).
  완화 경로에서 진단이 돌 땐 `_pin`이 비어 있어 종전대로 사전입력 직접 위반을 짚는다.
  `conflict_analyzer`의 `analyze()`/`suggest_correction()`은 **의도적으로 클램프
  미적용** — "이 표가 앱 규칙과 어디서 충돌하나"를 설명하는 도구라 사실 수용이
  아니라 전수 검사가 맞다. 단 **`check_feasibility()`(신호등 프로브)는 클램프 적용**
  (2026-08-19 후속 수정): 신호등은 '생성이 되는가'의 판정자라 엔진 의미론과 일치해야
  한다 — 미적용 시 엔진이 수용하는 입력(확정 OF 2회 주 등)에 거짓 빨강.
  주의: 프로브 2단계·CP-SAT 실패 시 정밀 분석의 원인 **라벨**은 여전히 무클램프
  게이티드 모델에서 나오므로, 클램프가 수용하는 항목이 라벨로 나올 수 있다(참고용).
- **파일**: `scheduler_base.py`(`_build_pin_index`/`_day_all_pinned`/`_pin_day_period_count`
  /`_pin_nurse_count`/`_attach_pin_notes`), `scheduler_highs_constraints.py` 12곳,
  `scheduler_cpsat.py` 미러 12곳. 테스트 `tests/test_partial_pin_facts.py`(신규),
  `test_exact_fit_characterization.py`·`test_carryover_characterization.py`·
  `test_diagnostics.py`·`test_solver_review_regression.py` 기대치 갱신.

### 1-16. 오프특근 — 휴무 공급이 모자랄 때의 마지막 수단 (2026-08-20, 3차 수정이 최종)
- **결정(현행, v4.10.0)**: 주 1회 OF는 **최대한 지키는 의무**다. 모델은

      Σ_{완전한 주} OF + s = bound        (s ∈ {0,1} = 오프특근 슬랙)
      목적함수 -= 1_000_000 × s

  상한(주 2회 금지)은 하드로 남고, 1회 의무는 **어떤 배점 조합보다 큰 페널티**로
  지킨다 → s는 "그러지 않으면 근무표가 성립하지 않을 때"만 켜진다. 켜진 주는
  결과 `off_teukgeun`(간호사·주차·기간)으로 보고하고 메시지에도 붙는다.
- **왜 이 모양인가 (사용자 재설명 원문 요지)**: "오프특근은 어쩔 수 없으면
  발생하는 거야. **경가·조가 등 휴무가 갑자기 많아진 경우에는 다른 근무자들이
  오프를 줄여가면서 근무를 뛰어야 한다**는 거고, 그에 대한 **최소한의 휴무 보장이
  주휴**인 거야." → 트리거는 **휴무 공급 부족**이지 공휴일이 아니다. 조건부 면제가
  아니라 '지킬 수 있으면 지키고, 못 지키면 반납하되 기록에 남긴다'가 맞는 모델.
- **두 번의 오답 (반복 금지)**:
  1. v4.8.0 — "당월 공휴일이 낀 완전한 주는 누구나 OF ≤1". 트리거를 공휴일로 오인.
  2. v4.9.0 — "그 주 공휴일에 법휴를 받았거나 근무한 사람만 면제". 여전히 공휴일
     기반이고, 게다가 연휴 달이 법휴 7~10명에도 안 풀렸다(CP-SAT UNKNOWN).
  둘 다 **제1원칙 3의 예시(공휴일이 몰린 주)를 조건으로 착각**한 것이다. 예시는
  "그런 주에 흔히 생긴다"는 뜻이지 "그런 주에만 허용된다"가 아니다.
- **부수 효과 (의도한 것)**: 주휴 슬랙이 모자란 구성은 이제 infeasible이 아니라
  '오프특근 n건'으로 생성된다. 진단 Phase 5의 '주간 휴무 공급 부족' 경로는 사실상
  도달하지 않으며, Phase 8 주간 산식도 의무 휴무를 주휴 1로만 센다.
  최소 보장(주휴)은 사전입력이라 엔진이 건드리지 않는다.
- **파일**: `scheduler_base._OFF_TEUKGEUN_PENALTY`/`_off_teukgeun_report`/
  `_attach_reports`, `_c_weekly_off`·`_cs_weekly_off`(슬랙), 양 엔진 목적함수,
  `conflict_analyzer._g_weekly_off`(상한만 게이팅), 진단 Phase 8,
  프론트 `solver.js`/`app.js`/`index.html`(⚠ 오프특근 패널).
  테스트 `test_constraints.py` 3종×양엔진(부족 시 최소한만 반납+리포트·여유 있으면
  전원 1회·공휴일 OF 금지 불변) + `test_diagnostics.py` 갱신.

### 1-17. 공휴일 인정 범위 = 생성 주기 (2026-08-20)
- **결정**: `self.holidays`를 **당월 프리픽스**가 아니라 **생성 주기 범위
  (`all_dates` = 전월 말·익월 초 패딩 포함)**로 거른다. 프론트 `autoFillHolidays`도
  주기 범위를 채운다.
- **이유**: 주기는 월 경계를 넘는데 공휴일만 당월로 잘라서, 월경계 주에 걸린 익월
  공휴일(신정·설날·삼일절 — 연 3~4회)을 **못 보고** ① 그 날에 OF/V/생을 배정하고
  (앱 자신의 "공휴일 OF 금지"를 어긴 표가 인쇄물로 나감) ② 오프특근 판정에서도
  빠졌다. 실측: 2027-01 주기 = 2026-12-27~2027-02-06, 마지막 주 1/31~2/6에 설날.
- **주의**: 한쪽만 고치면 다시 어긋난다 — 서버가 주기 범위를 인정해도 프론트가
  당월만 채우면 사용자는 익월 공휴일을 지정할 방법이 없고, 손으로 넣어도 예전엔
  서버가 버렸다. 테스트 `tests/test_holidays.py::test_holiday_scope_is_generation_cycle_not_month`.
- **참고**: 월경계 주의 OF 의무가 **당월 솔브에만** 걸리는 건 의도된 분업이다
  (전월 overflow는 제외 → 그 주를 온전히 계획하는 달이 한 번만 강제). 비대칭처럼
  보이지만 중복 강제·무강제를 피하는 올바른 설계 — 바꾸지 말 것.

### 1-18. 사전입력 경고는 '위반'이 아니라 '참고' (2026-08-20)
- **결정**: 프론트 라인트/분석탭 경고 중 **확정(사전입력) 셀만으로 결정되는 항목**은
  빨강 '위반'이 아니라 회색 '참고'(`prevPinNotes`, `type:'note'`)로 표시한다.
  빨강으로 남는 건 **알 수 없는 근무 코드** 하나뿐 — 그것만이 실제로 생성을 막는다.
- **이유**: 사실-클램프(1-15) 이후 엔진은 확정 셀의 규칙 위반을 **사실로 수용**한다
  (일별 인원은 `max(요구,확정)`으로 상향, 자격·전환·연속·NOD·주 OF는 확정이면 스킵).
  그런데 v4.7.0에선 신호등만 고치고 텍스트 경고는 그대로 둬서, 완성 번표를 붙여넣으면
  **🟢 신호등 + 빨간 경고 벽**이 동시에 떴다. 제1원칙 8("사전입력에는 사유가 있다")과도
  어긋난다 — 앱이 사람의 결정을 훈계하면 안 된다.
- **파일**: `grid-interactions.js`(`v`/`notes` 분리, `hasPinNote`), `app.js`(상태),
  `index.html`(참고 패널 + `g-pinnote` 셀), `components.css`, `analysis.js`(`type:'note'`).
  검증 `scripts/test_preinput_lint.mjs` 15 시나리오(버킷별 단언 + 오프특근 2건).

### 1-19. 나이트킵 달의 야간은 홀짝월 합산에서 제외 (2026-08-20)
- **결정**: 홀짝월 합산 야간(전월+당월 ≤ 11, 수면오프 회피 규칙)에서 **전월이 그
  간호사의 야간전담(나이트킵) 달이었다면 그 달 야간을 0으로 센다**. 제1원칙 7:
  "나이트킵 때 한 나이트는 수면오프와 전혀 연관 없는 나이트."
- **증상(수정 전)**: 1월 나이트킵(14N) → 2월 일반 전환 시
  `_two_month_rhs = max(0, 11 − 14) = 0` → **그 사람만 2월 야간 0회**. 야간 가능자가
  좁은 구성에서는 아예 infeasible("홀짝월 합산 야간 11회 제약 충돌")로 실패했다.
  기본값이 `maxNightTwoMonth=False`라 켠 병동에서만 드러난다.
- **두 곳에서 막는다**: ① 데이터 원천 `database.compute_prev_month_nights` —
  저장본에 함께 담긴 그 달 명부의 `night_months[YYYY-MM]`(없으면 `is_night_shift`)로
  나이트킵을 판정해 제외. ② 엔진 `_two_month_rhs` — 수기로 넣은 값·구버전 저장본도
  방어하도록 `_night_dedicated_in(nid, 전월)`이면 상한을 그대로 돌려준다.
  프론트 라인트(`grid-interactions.js`)·분석기 라벨도 같은 기준.
- **유지되는 것**: 일반 근무로 쌓은 전월 야간은 종전대로 합산에 들어간다(규칙 자체는
  그대로). 당월 나이트킵은 원래부터 이 제약에서 제외였다.
- 테스트: `test_night_dedicated.py`(전월 나이트킵 → 당월 야간 가능, 양 엔진 ·
  일반 전월 야간은 여전히 차감) + `test_wish_pipeline.py`(전월N 자동 인수인계 제외).

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

### 2-17. 테스트 폴백 shifts는 auto_assign 전부 True — 실서비스 재현 함정 (2026-08-18)
- **증상**: "주휴 없이 잉여 인력" 시나리오가 테스트에선 SUCCESS인데 실서비스에선 infeasible.
- **원인**: `request.shifts`가 비고 DB도 없으면 `_DEFAULT_SHIFTS` 폴백을 쓰는데 여기엔
  `auto_assign` 키가 없어 `s.get("auto_assign", True)` → **주·특·공·병·D1·중까지 전부
  솔버 배정 가능**이 된다. 실험에선 솔버가 '공'을 15칸 배정해 버렸다.
- **해결**: 실서비스 동작을 재현하는 테스트는 반드시 DB 시드와 같은 `ShiftDef` 목록을
  `GenerateRequest(shifts=...)`로 명시할 것 — `tests/test_exact_fit_characterization.py`의
  `PROD_SHIFTS` 참조. (기존 솔버 테스트 일부는 이 폴백 위에서 실서비스보다 관대하게 통과할
  수 있음을 유의.)

### 2-18. infeasible 진단의 '마지막 상한 단계' 오진 (2026-08-18, M4)
- **증상**: 잉여 인력이 쉴 코드가 없어(주휴 미입력) 실패한 케이스를 진단이
  "생리휴가(생) 제약 충돌"로 보고 — 사용자는 원인을 알 수 없다.
- **원인**: 13단계 누적 진단은 제약을 순서대로 쌓다 처음 infeasible이 된 단계를 원인으로
  보고한다. 휴무 부족은 V 무제한(→7단계 전)·생 무제한(→11단계 전)으로 흡수되다가
  마지막 상한(생 월1회)이 걸리는 단계에서 터진다 — 원인 귀속이 구조적으로 어긋남.
- **방향**: 단계 순서를 바꾸는 대신 Phase 5에 주간 휴무 산술 검사(솔버 불필요)를 넣어
  1급 원인으로 선판정 — `docs/milestones.md` M4 P1 참조.

---

### 2-19. `Requirements()` 파이덴틱 기본값은 3/3/3 — DB 시드 병동표가 아님 (2026-08-19)
- **증상**: 시뮬레이션/실험에서 `Requirements()`를 그대로 쓰면 전 요일 D3/E3/N3
  (하루 9명 근무)이 되어, 18명 로스터에선 매일 9명이 남는 극단 과잉공급 →
  쉴 코드 부족으로 **항상 infeasible** (M4 제1법칙 "인원이 남을수록 심해진다").
- **실서비스 기본값**: DB 시드(`database.py`) 월 4/5/3 · 화수목 5/5/3 · 금 5/4/3 ·
  토 3/3/2 · 일 3/4/3 — CLAUDE.md 표와 동일. 실험 재현 시 반드시 이 표를 명시할 것.
- 이 함정으로 2026-09 시뮬 1개월차가 원인 불명 infeasible로 보였음 (PROD_SHIFTS
  함정 2-17과 같은 계열 — 테스트/시뮬 기본값 ≠ 실서비스 기본값).

## 3. 사용자 정립 규칙 (명시 지시)

| 규칙 | 출처 |
|---|---|
| 사전 허가 질문 금지 | "왜 자꾸 물어보는거야?" |
| D/E/N 라벨 유지 (낮/저녁/야간 금지) | "누가 D/E/N을 낮/저녁/야간으로 바꾸래?" |
| 사이드바 로고 18px 고정 | "NurseScheduler v4 18px로 고정해줘" |
| 사이드바 메뉴 폰트 20–22px 범위 | 초기 지시 (이후 로고만 고정으로 변경) |
| 상업 사용 불가 라이선스 | "라이선스에 상업적 사용 불가능 넣을 수 있나?" |
| 외부망 사용 테스트 권장을 README에 포함 | 명시 요청 |
| **생휴(생)는 보장이 아니다** — "월초부터 월말까지 1회 주어질 **수 있다**"일 뿐, 스케줄상 안 나오면 못 받는 것이고 어쩔 수 없음. 강제 배정 금지 (월 ≤1 상한만) | 2026-08-19 "생휴는 무조건이 아닌데… 그 부분을 잘 기억해줘". 같은 날 야간전담 여성+31일달 '정확히 1회' 강제도 제거 완료 (양 엔진 + conflict_analyzer) |
| **완성된 번표는 검증 대상이 아니라 주어진 사실** — 사전입력이 빈칸 없이 확정돼 있으면 생성은 실패하지 않고 표를 그대로 확정한다. 규칙 차이는 알려주기만 | 2026-08-19 "빈칸 없이 채워넣었을 때 생성이 되어야 하잖아 … 해결해달라" → 완전 확정 표 폴백 (결정 1-14) |
| **확정은 부분이어도 사실** — "2주차까지만 꽉 채우고 나머지만 비워서 생성"도 확정 부분은 검증하지 않는다. 일 단위로 모두 차 있으면 그 일에만 확정 | 2026-08-19 "일단위로 근무표가 모두 차있다면 그 일에만 확정하는게 맞지 않을까?" → 사실-클램프 (결정 1-15) |
| **주휴는 사람이 결정한다** — OF→주 자동 변환 금지. 분석 탭에서 알려주기만 | 2026-08-19 "1번 기각. 주는 사람이 결정할거야. 분석 탭에서 분석해서 알려주든 하는게 좋을 것 같아" |
| **병동 도메인 제1원칙 8건** — 공휴일 운영·오프특근(휴무 부족 시)·최소 인원(토 4/3/2)·주휴 공휴일 배치 관행 없음(중복수당)·외과병동 구조·**나이트킵 야간은 수면오프와 무관**·원티드의 의미(사유 있음, V 대량 자동 사용 불가) | 2026-08-20 명시 — **CLAUDE.md 제1원칙 절이 원문**. 모든 세션 작업 전 필독 |
| **잉여 인원 처리 = 연차·휴가로 소진** — 일별 인원 `==`(정확 일치)는 현행 유지, 초과 출근 없음 | 2026-08-20 확인 질문 답변 |
| **차지 횟수는 공정성 항목이 아니다** — 시니어리티 높은 사람이 차지를 맡고, 그 부담은 어싸인에서 환자를 적게 보는 것으로 이미 균형 (제1원칙 9) | 2026-08-20 M6 조사 답변 — 차지 공정성 배점 제안 **기각** |
| **보호 채널은 잠금(🔒)뿐** — 셀 메모는 기록용, 보호 등급 상향 근거가 아니다 | 2026-08-20 M6 조사 답변 — "메모=사연" 보호 상향 **기각** |
| **오프특근 = 휴무 공급 부족 시의 마지막 수단** — 공휴일·법휴와 무관. 경가·조가 등으로 휴무가 몰리면 남은 사람이 오프를 반납하고 근무를 뛴다. 최소 보장은 주휴 (결정 1-16) | 2026-08-20 "오프특근은 어쩔수없으면 발생하는거야 … 그에대한 최소한의 휴무 보장이 주휴인거야" — v4.8.0·v4.9.0의 공휴일 기반 조건은 **둘 다 오답** |
| **사전입력 경고는 훈계가 아니라 참고** — 확정 셀만으로 결정되는 항목은 빨강 위반이 아니라 회색 참고. 빨강은 '알 수 없는 코드'뿐 (결정 1-18) | 2026-08-20 파인튜닝 항목 1 — 제1원칙 8(사전입력에는 사유가 있다)의 UI 반영 |

---

## 4. 주요 버전 이정표

| 버전 | 내용 |
|---|---|
| v4.0.0 | 초기 Electron 포팅 + 프로필 시스템 |
| v4.0.1 | 차등 보너스(preBonus) |
| v4.0.2 | 중간번 포함 9개 금지 전환 |
| v4.0.3 | UX 개선 (토스트 히스토리, Undo 카운터, 프린트 등) |
| v4.0.4 | PyInstaller `--windowed` stdout=None 수정 + em 기반 입력 폭 + 다크모드 카드 수정 (진행 중) |
