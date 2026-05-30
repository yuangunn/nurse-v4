# CP-SAT 듀얼 솔버 — 설계 문서

- **상태**: 확정 (브레인스토밍 승인, 2026-05-30 / 스펙 리뷰 1회 반영)
- **버전 베이스라인**: v4.2.1
- **관련 메모리**: `plan_cpsat_migration.md`

## 1. 목표 · 동기

현재 스케줄 생성은 PuLP + HiGHS(MILP) 단일 엔진이다. 여기에 **CP-SAT
(`ortools.sat.python.cp_model`)를 두 번째 생성 엔진으로 추가**한다.

핵심 동기: **"어디서 충돌하는지 바로 알려준다."** CP-SAT의
`CpSolver.SufficientAssumptionsForInfeasibility()`는 1회 호출로 충돌하는 제약
집합을 반환한다 → 현재 `_diagnose_infeasibility()`의 13-phase 순차 재호출
방식을 보완.

> API 정확성: 메서드명은 `SufficientAssumptionsForInfeasibility()`
> (snake_case `sufficient_assumptions_for_infeasibility`). `Get…` 변형은 없음
> (ortools 9.14 기준 확인).

부차 동기: 9개 금지전환·주휴 순환 같은 조합 제약에서 CP-SAT propagation이
MILP 선형화보다 빠를 수 있음.

## 2. 범위 (결정 사항)

| 항목 | 결정 |
|---|---|
| CP-SAT 역할 | **완전 듀얼 솔버** — 스케줄을 직접 생성하는 두 번째 엔진 |
| 솔버 선택 | 생성 패널의 **사용자 토글** (기본 HiGHS) |
| 진행 UX | **완전 패리티** — 중지·실시간 진행률·로그 스트리밍 |
| 아키텍처 | **A. 병렬 네이티브 구현** (공유 베이스 + 엔진별 서브클래스) |
| 진단 | **독립 충돌 분석 서비스** — 어느 엔진이든 infeasible이면 CP-SAT assumptions 분석 가능 |
| 배포 | ortools **오프라인 번들 가능 조건부 수용** (Phase 0 게이트) |
| **완화(relaxation)** | **v1에서 CP-SAT 미지원** — 아래 §3.1 참조 (HiGHS 전용 유지) |

비목표(YAGNI): 자동 폴백, 두 솔버 동시 레이스, HiGHS 제약/목적 코드의 어댑터
리팩터링, **CP-SAT 완화 경로**.

## 3. 아키텍처 — 공유 베이스 + 엔진별 서브클래스

Approach A(병렬 네이티브)의 중복을 줄이기 위해 "제약 외" 셋업을 베이스로 추출한다.

```
server/
  scheduler_base.py    # _SchedulerBase: 엔진 무관 공통
                       #   - __init__ 데이터 파싱, _build_date_range (날짜 윈도잉 포함),
                       #     _nurse_active_on / _nurse_active_idx (재적), 주기/시니어리티
                       #   - prev_schedule / locked_cells / per_day_req / holidays 파싱
                       #   - shift 분류 상수 (WORK/DAY/EVENING/NIGHT/CHARGE/...)
                       #   - _PRE_FLEX (D↔DC 등 사전입력 유연 매핑) 상수
                       #   - _extract_solution(value_fn) — 값 읽기는 엔진별 value 콜백 주입
                       #   - _compute_nurse_scores, _fmt_* 헬퍼, 트레이니 프리셉터 복사
  scheduler.py         # NurseScheduler(_SchedulerBase) — 기존 PuLP/HiGHS (거의 무수정)
  scheduler_cpsat.py   # CpSatScheduler(_SchedulerBase) — cp_model 빌더 + solve + 콜백
  conflict_analyzer.py # analyze_conflicts(request) — CP-SAT assumptions 기반 (엔진 독립)
  solver_progress.py   # 솔버 무관 진행/취소 레지스트리 (§6) — _current_highs_instance 대체
```

**불변식**: 데이터/셋업 로직은 1벌(베이스). 제약·목적함수·solve 루프만 엔진별 2벌.
두 스케줄러 모두 `solve() -> Dict` 동일 반환 shape (success, schedule, message,
nurse_scores, mip_gap_percent 등). **단 `relaxed_cells`는 HiGHS만 채움(§3.1).**

> 리팩터 안전: `_build_date_range`·`_nurse_active_*`를 베이스로 올리는 것은
> 동작 불변 리팩터링이며, 각 단계 후 기존 `pytest` green을 확인한다. (이 이동은
> 테스트 하네스가 양 엔진을 다루기 위한 **선행 조건**이기도 하다 — §9.)

### 3.1 완화(relaxation) 경로 — v1 결정

HiGHS 경로는 infeasible 시 `_solve_with_relaxed_pre()`를 돌려 `relaxed_cells`와
`allow_pre_relax`/`allow_juhu_relax`/`unlimited_v`/`locked_cells` 계약을 따른다.

**v1 결정: CP-SAT는 완화 경로를 구현하지 않는다.** CP-SAT가 infeasible이면
완화 대신 **conflict_analyzer(정밀 충돌 분석)**를 자동 실행해 "무엇이 충돌인지"를
답한다 — 이게 CP-SAT의 가치 제안이다.

UI 영향: **CP-SAT 선택 시 완화/주휴완화 토글은 비활성(disabled) 처리**하고
툴팁으로 "CP-SAT는 완화 대신 정밀 충돌 분석을 제공" 안내. `unlimited_v`는 CP-SAT
목적함수에 동일 반영(완화 경로와 무관하므로 유지). 이 분기는 의도된 동작 차이로
문서화한다.

## 4. CP-SAT 모델 매핑

- **변수**: `x[nurse][day][shift]` = `model.NewBoolVar(...)`. 현재 0/1 모델이
  CP-SAT 부울에 그대로 적합.
- **선형 제약** (1일1근무·일별인원 정확충족·charge 요구·주휴/OF·V 월한도·월 야간
  한도·홀짝월 합산 등): `model.Add(sum(vars) <op> rhs)` 직역.
- **네이티브 강점 활용**:
  - 9개 금지전환 → 인접일 쌍에 `model.AddBoolOr([x1.Not(), x2.Not()])` 또는
    `AddForbiddenAssignments`.
  - 주휴 4주 순환 → 허용집합 / automaton.
  - 연속근무·연속야간 한도, 연속야간 후 휴무 → sliding-window `model.Add`.

### 4.1 비자명 제약 — 개별 포팅 항목 (각각 HiGHS 구현과 1:1 대조 검증)
- **charge 시니어리티** (`_c_charge_seniority`): 사전입력 고정 + 같은 듀티 내
  선임/후임 pairwise 게이팅. CP-SAT에서도 동일 pairwise 함의로 표현.
- **야간전담** (`_c_night_shift_nurses`): N/NC 전용 + 5일 윈도우 ≤3 + 당월 정확 14일
  + 여성·31일달 생 1회 클러스터.
- **생리휴가** (`_c_menstrual_leave`): 여성·공휴일 금지·월 한도.
- **`_PRE_FLEX`** (D↔DC 등 사전입력 유연 매핑): 변수 도메인 고정 시 동일 적용.
- **`locked_cells`**: 해당 셀 변수를 해당 코드로 하드 고정 (`x==1`).
- **holidays**: 공휴일 날짜의 OF/생/V 변수 도메인 차단 (`x==0`).
- **트레이니**: 제약이 아니라 **solve 후 프리셉터 기반 복사**(`_extract_solution`
  단계) — 베이스에서 공유, 엔진별 포팅 대상 아님.

### 4.2 목적함수 정수화
가중 선형합(scoring_rules). CP-SAT는 **정수 목적** 필요. **단일 전역 스케일 팩터
S(예: 1000)를 모든 항에 균일 적용** 후 round-half-up 정수화 → 항 간 상대 가중치
보존(개별 ×100 금지). 형평성 `range_var`(min/max 야간차, 음수 가중치 포함)도 동일
S로 스케일. `model.Maximize(Σ S·wᵢ·termᵢ)`.

## 5. 솔버 선택 · 오케스트레이션

- `GenerateRequest`에 `solver: Literal['highs','cpsat'] = 'highs'` 추가 (기본 highs
  → 기존 동작·기존 클라이언트 무손상).
- 생성 패널: 완화·V무제한 토글 옆에 `솔버 ◉ HiGHS  ○ CP-SAT`. CP-SAT 선택 시
  완화 토글 비활성(§3.1).
- `api.py /api/generate`: `request.solver`로 `NurseScheduler` vs `CpSatScheduler`
  인스턴스화. 동시생성 방지(409)·결과 보관·SSE·진행 폴링은 **§6의 솔버 무관
  레지스트리**를 통해 공통화.

## 6. 진행 · 중지 · 로그 패리티 — 솔버 무관 레지스트리 (리팩터 필요)

⚠️ **현 상태는 엔진 무관이 아니다.** `api.py`의 취소/진행/동시성/SSE는 전부 전역
`_current_highs_instance`(highspy 객체)에 키잉돼 있다:
`stop_generate()`→`h.cancelSolve()`, `/api/generate` 409 가드
`if _current_highs_instance is not None`, `get_generate_progress()`→
`h.getInfoValue("mip_gap"|"mip_node_count")`, `generate_stream()` 게이팅.
CpSatScheduler는 이 전역을 채우지 않으므로 **그대로 두면 중지 no-op·409 미발동·
진행 즉시 done**이 된다.

**→ 별도 단계로 솔버 무관 레지스트리를 도입한다** (`solver_progress.py`):
- 모듈 전역 `_current_solver`: `.cancel()` 와 `.progress() -> dict` 를 제공하는
  얇은 어댑터. `_TrackableHighs`(기존)와 CP-SAT 콜백이 각각 등록.
- api.py 4개 호출 지점(`stop_generate`/409 가드/`get_generate_progress`/
  `generate_stream`)을 `_current_solver` 기준으로 재작성.
- 진행 payload shape 유지: `{gap_percent, nodes, has_solution, is_running}`.
  CP-SAT엔 노드 개념이 없으므로 **`nodes`는 `NumBranches()`로 매핑**(또는 0).

**CP-SAT 콜백** (`cp_model.CpSolverSolutionCallback` 서브클래스):
- 새 incumbent마다 `ObjectiveValue()` / `BestObjectiveBound()`로 gap% 산출 →
  레지스트리 갱신, `_log_queue`에 로그 라인 push.
- 중지: 콜백 내 `_solve_cancelled` 확인 → `self.StopSearch()`.
- **UX 캐비엇(문서화)**: CP-SAT 콜백은 *개선된 incumbent에서만* 호출 → gap 갱신
  cadence가 HiGHS의 노드 폴링보다 성김(틱다운 대신 점프). 허용.

## 7. 진단 — 독립 충돌 분석 서비스 (핵심)

`server/conflict_analyzer.py` — `analyze_conflicts(request) -> {conflicts, message}`:
- 하드 제약만으로 CP-SAT 모델 구성.
- **assumption 입도 (결정)**: 셀 단위 핀포인트를 보존하기 위해
  - 셀 지목형 제약(금지전환·일별인원·charge)은 **per-(nurse, date) 또는
    per-(date, duty) assumption 리터럴**,
  - 주차 단위 제약(주휴/OF·연속근무·월 야간)은 **per-(nurse, week)** 리터럴.
  - 리터럴↔라벨 **역매핑 테이블**을 함께 구성(리터럴 → "간호사·날짜·제약" 한국어).
- `model.AddAssumptions([lits])` + `solver.Solve()` → INFEASIBLE이면
  `solver.SufficientAssumptionsForInfeasibility()` → 충돌 리터럴 집합 → 역매핑으로
  한국어 메시지 ("〈날짜/간호사/제약〉이 동시 충족 불가").

**호출 지점 (엔진 독립)**:
- CP-SAT 생성 infeasible → 자동으로 분석 결과 첨부.
- **HiGHS 생성 infeasible → 결과 카드에 "정밀 충돌 분석 (CP-SAT)" 버튼**
  → `POST /api/diagnose` (신규) → conflict_analyzer 실행 → 결과 표시.
- 기존 13-phase `_diagnose_infeasibility`는 즉시 결과로 유지(폴백/보완).

## 8. 배포 — ortools 오프라인 번들 (Phase 0 게이트)

- `requirements.txt`에 `ortools` 추가 (+~50MB; 설치파일 143MB → ~190MB+).
- ortools 휠은 네이티브 libs를 **자체 포함** → 런타임 인터넷 불필요(인트라넷 OK).
  단 PyInstaller가 네이티브 libs/데이터/protobuf를 정확히 수집해야 함.
- `NurseScheduler.spec`: 기존 `collect_all('highspy'/'pulp'/...)` 패턴에 맞춰
  `collect_all('ortools')` 추가. **추가로 필요할 수 있음**:
  `collect_dynamic_libs('ortools')`(`.libs` 누락 대비) +
  hiddenimports `google.protobuf`, `ortools.sat.python.cp_model_helper`.
- **게이트**: Phase 0에서 빌드된 `NurseScheduler.exe`를 **네트워크 차단 환경에서
  실행 → CP-SAT 생성 성공**을 증명. 실패 모드는 "훅 추가"이며, 그래도 안 되면
  CP-SAT 미출시(HiGHS 단독 유지)로 폴백.

## 9. 테스트

⚠️ **현 하네스는 HiGHS 하드코딩**: `tests/conftest.py`의 `solve_small`이
`LimitedScheduler(request).solve()`를 고정 호출, `LimitedScheduler(NurseScheduler)`가
HiGHS 서브클래스이며 `_build_date_range`를 오버라이드. `GenerateRequest`에 `solver`
필드 없음.

**→ 파라미터화 전 하네스 리팩터 (선행 조건)**:
1. `GenerateRequest.solver` 필드 추가(§5).
2. `_build_date_range` 윈도잉을 `_SchedulerBase`로 이동(§3) → `LimitedScheduler`가
   양 엔진에 적용 가능(믹스인) 하도록.
3. `solve_small` 픽스처를 `solver` 파라미터로 분기.

그 후 기존 불변식 테스트(9개 금지전환·charge 시니어리티·일별 인원 정확충족·V
한도·1일1근무·사전입력 유지)를 `@pytest.mark.parametrize("solver",["highs","cpsat"])`로
양 엔진 검증.

- **동등성 기준**: 비트 동일 아님. **모든 하드 제약 충족 + 목적값 comparable**
  (허용 gap 기준은 §12에서 수치 확정). CP-SAT·HiGHS는 점수 같은 다른 최적해 가능.
- **CI 시간**: CP-SAT 케이스도 작은 문제(≤7~14일)로 제한해 초 단위 유지.
- 신규: conflict_analyzer가 의도적 충돌 케이스에서 정확한 충돌 집합을 반환하는지.

## 10. 단계 (개략 — 상세 작업분해는 구현 계획에서)

0. **ortools 오프라인 번들 스파이크 (게이트)** — requirements+spec(`collect_all`/
   `collect_dynamic_libs`/protobuf hiddenimports) → 빌드 → 네트워크 차단 실행 검증.
   통과해야 진행.
1. `_SchedulerBase` 추출(`_build_date_range`·재적·셋업·`_extract_solution`·
   `_PRE_FLEX` 포함) — HiGHS 회귀 green 유지 (동작 불변).
2. **솔버 무관 진행/취소 레지스트리**(`solver_progress.py`) 도입 + api.py 4개 호출
   지점 재작성 — HiGHS 동작 보존 확인(§6).
3. **테스트 하네스 리팩터**(§9): `solver` 필드 + base 윈도잉 + `solve_small` 분기.
4. `CpSatScheduler` — 선형 제약 → 네이티브 제약(§4) → 비자명 제약(§4.1) → 목적
   정수화(§4.2) → 콜백/중지/진행 등록.
5. `conflict_analyzer`(assumptions, §7) + `POST /api/diagnose` + "정밀 충돌 분석" 버튼.
6. API `solver` 필드 노출 + 생성 패널 토글 + CP-SAT 시 완화 토글 비활성(§3.1, §5).
7. 파라미터화 테스트 + 동등성 검증(§9).
8. 최종 빌드·릴리즈 (버전 bump, README/CHANGELOG).

## 11. 위험 · 완화

| 위험 | 완화 |
|---|---|
| ortools 오프라인 번들 실패 | Phase 0 게이트 — 훅 추가 시도 후 안되면 미출시 폴백 |
| 진행/취소가 HiGHS 전역에 묶임 | 솔버 무관 레지스트리 단계(2)에서 분리, HiGHS 동작 보존 확인 |
| 테스트 하네스 HiGHS 고정 | 단계(3) 하네스 리팩터를 파라미터화 선행 조건으로 |
| 베이스 추출 중 HiGHS 회귀 | 각 단계 `pytest` green, 동작 불변 리팩터링 |
| 목적 정수화로 미세하게 다른 해 | 단일 전역 스케일 균일 적용 + 동등성 "유효+comparable" |
| 제약 로직 2벌 드리프트 | 파라미터화 테스트가 양 엔진 동시 검증 |
| 완화 토글이 CP-SAT에서 무의미 | UI에서 비활성 + 정밀 진단으로 대체(§3.1) |

## 12. 미해결 / 후속 (구현 계획에서 확정)

- conflict_analyzer 충돌 집합 → 한국어 메시지 변환 품질 (리터럴 라벨링 디테일).
- "comparable 목적값"의 정량 허용 gap%.
- 전역 스케일 팩터 S의 구체 값 (오버플로 vs 정밀도 균형).
