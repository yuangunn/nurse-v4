# CP-SAT 듀얼 솔버 — 설계 문서

- **상태**: 확정 (브레인스토밍 승인, 2026-05-30)
- **버전 베이스라인**: v4.2.1
- **관련 메모리**: `plan_cpsat_migration.md`

## 1. 목표 · 동기

현재 스케줄 생성은 PuLP + HiGHS(MILP) 단일 엔진이다. 여기에 **CP-SAT
(`ortools.sat.python.cp_model`)를 두 번째 생성 엔진으로 추가**한다.

핵심 동기: **"어디서 충돌하는지 바로 알려준다."** CP-SAT의
`GetSufficientAssumptionsForInfeasibility()`는 1회 호출로 충돌하는 제약
집합을 반환한다 → 현재 `_diagnose_infeasibility()`의 13-phase 순차 재호출
방식을 대체/보완.

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

비목표(YAGNI): 자동 폴백, 두 솔버 동시 레이스, HiGHS 코드의 어댑터 리팩터링.

## 3. 아키텍처 — 공유 베이스 + 엔진별 서브클래스

Approach A(병렬 네이티브)의 중복을 줄이기 위해 "제약 외" 셋업을 베이스로 추출한다.

```
server/
  scheduler_base.py    # _SchedulerBase: 엔진 무관 공통
                       #   - 날짜 범위 / 재적(전입·전출) / 주기 / 시니어리티
                       #   - prev_schedule / locked_cells / per_day_req 파싱
                       #   - shift 분류 상수 (WORK/DAY/EVENING/NIGHT/CHARGE/...)
                       #   - _extract_solution (값 읽기는 엔진별 value() 주입)
                       #   - _compute_nurse_scores, _fmt_* 헬퍼
  scheduler.py         # NurseScheduler(_SchedulerBase) — 기존 PuLP/HiGHS (거의 무수정)
  scheduler_cpsat.py   # CpSatScheduler(_SchedulerBase) — cp_model 빌더 + solve + 콜백
  conflict_analyzer.py # analyze_conflicts(request) — CP-SAT assumptions 기반 (엔진 독립)
```

**불변식**: 데이터/셋업 로직은 1벌(베이스). 제약·목적함수·solve 루프만 엔진별 2벌.
두 스케줄러 모두 `solve() -> Dict` 동일 반환 shape (success, schedule, message,
nurse_scores, mip_gap_percent 등) — api.py·프론트는 엔진 무관.

### 경계 (각 단위의 책임)

- `_SchedulerBase`: "스케줄 문제의 데이터 표현" — 입력 → 정규화된 날짜·간호사·
  사전입력·요구 구조. 솔버를 모름.
- `NurseScheduler`: "HiGHS로 푼다" — 기존 동작 보존.
- `CpSatScheduler`: "CP-SAT로 푼다" — cp_model 변수/제약/목적/콜백/추출.
- `conflict_analyzer`: "왜 안 풀리나" — 하드 제약에 assumption 달고 충돌 집합 반환.
  생성 엔진과 독립 (HiGHS-infeasible에도 호출 가능).

## 4. CP-SAT 모델 매핑

- **변수**: `x[nurse][day][shift]` = `model.NewBoolVar(...)`. 현재 0/1 모델이
  CP-SAT 부울에 그대로 적합.
- **선형 제약** (1일1근무·일별인원 정확충족·charge 요구·주휴/OF·V 월한도·월 야간
  한도·홀짝월 합산 등): `model.Add(sum(vars) <op> rhs)` 직역.
- **네이티브 강점 활용**:
  - 9개 금지전환 → 인접일 쌍에 `model.AddForbiddenAssignments` 또는 `AddBoolOr` 부정.
  - 주휴 4주 순환 → 허용집합 / automaton.
  - 연속근무·연속야간 한도, 연속야간 후 휴무 → sliding-window `model.Add`.
- **목적함수**: 가중 선형합 (scoring_rules). CP-SAT는 **정수 목적** 필요 →
  가중치 정수화 (대부분 이미 정수: preBonusLeave=5000 등; 형평성 range·소수
  가중치는 ×100 등으로 스케일 후 정수화). `model.Maximize(...)`.
- **시니어리티/charge**, **야간전담**, **생리휴가**, **트레이니** 등 나머지
  하드 제약도 HiGHS 구현과 1:1 대응되는 CP-SAT 제약으로 포팅.

## 5. 솔버 선택 · 오케스트레이션

- `GenerateRequest`에 `solver: Literal['highs','cpsat'] = 'highs'` 추가 (기본 highs
  → 기존 동작 유지).
- 생성 패널: 완화·V무제한 토글 옆에 `솔버 ◉ HiGHS  ○ CP-SAT`.
- `api.py /api/generate`: `request.solver`로 `NurseScheduler` vs `CpSatScheduler`
  인스턴스화. 동시생성 방지(409)·결과 보관(`_last_generate_result`)·SSE·진행 폴링은
  공통 코드 재사용.

## 6. 진행 · 중지 · 로그 패리티

HiGHS는 `highspy.Highs` 전역 몽키패치(`_TrackableHighs`)로 구현돼 있다. CP-SAT는
평행 경로를 둔다:

- **콜백**: `cp_model.CpSolverSolutionCallback` 서브클래스(`_TrackableCpSatCb`)가
  새 incumbent/bound마다 `_solve_progress`(gap%·best·has_solution)와 `_log_queue`를
  갱신 → 기존 SSE(`/api/generate/stream`) + 2초 폴링(`/api/generate/progress`)이
  그대로 동작.
- **중지**: 콜백 내부에서 `_solve_cancelled` 확인 → `self.StopSearch()`
  (HiGHS `cancelSolve()` 대응). `/api/generate/stop`은 엔진 무관 신호.
- **gap**: CP-SAT는 `ResponseStats`/콜백의 best objective + best bound로 gap% 산출.

## 7. 진단 — 독립 충돌 분석 서비스 (핵심)

`server/conflict_analyzer.py`:
- 입력: `GenerateRequest` (또는 그 일부).
- CP-SAT 모델을 하드 제약만으로 구성하되, 각 하드 제약(또는 제약 그룹)에
  **assumption 부울 리터럴**을 부여.
- `model.AddAssumptions([...])` + `solver.Solve()` → INFEASIBLE이면
  `solver.SufficientAssumptionsForInfeasibility()` 호출 → 충돌 제약 집합 반환.
- 충돌 집합을 사람이 읽는 한국어 메시지로 변환
  ("〈날짜/간호사/제약〉이 동시 충족 불가").

**호출 지점 (엔진 독립)**:
- CP-SAT 생성이 infeasible → 자동으로 분석 결과 첨부.
- **HiGHS 생성이 infeasible → 결과 카드에 "정밀 충돌 분석 (CP-SAT)" 버튼**
  → `/api/diagnose` (신규) 호출 → conflict_analyzer 실행 → 결과 표시.
- 기존 13-phase `_diagnose_infeasibility`는 즉시 결과로 유지(폴백/보완).

## 8. 배포 — ortools 오프라인 번들 (Phase 0 게이트)

- `requirements.txt`에 `ortools` 추가 (+~50MB; 설치파일 143MB → ~190MB+).
- ortools 휠은 네이티브 libs를 **자체 포함** → 런타임 인터넷 불필요(인트라넷 OK).
  단 PyInstaller가 네이티브 libs/데이터를 수집해야 함.
- `NurseScheduler.spec`: `collect_all('ortools')` (binaries + datas + hiddenimports)
  추가.
- **게이트**: Phase 0에서 빌드된 `NurseScheduler.exe`를 **네트워크 차단 환경에서
  실행 → CP-SAT 생성 성공**을 증명. 실패 시 CP-SAT 미출시(HiGHS 단독 유지)로 폴백.

## 9. 테스트

- 기존 `tests/`를 **양 엔진 파라미터화**:
  `@pytest.mark.parametrize("solver", ["highs", "cpsat"])` → 동일 하드제약 불변식
  (9개 금지전환·charge 시니어리티·일별 인원 정확충족·V 한도·1일1근무·사전입력 유지)을
  CP-SAT 결과에도 검증.
- **동등성 기준**: 비트 동일 아님. **모든 하드 제약 충족 + 목적값 comparable
  (gap 내)**. (CP-SAT·HiGHS는 점수 같은 다른 최적해를 낼 수 있음.)
- CP-SAT 전용 신규 테스트: conflict_analyzer가 의도적 충돌 케이스에서 정확한
  충돌 집합을 반환하는지.

## 10. 단계 (개략 — 상세 작업분해는 구현 계획에서)

0. **ortools 오프라인 번들 스파이크 (게이트)** — requirements+spec → 빌드 →
   네트워크 차단 실행 검증. 통과해야 진행.
1. `_SchedulerBase` 추출 — HiGHS 회귀 green 유지 (리팩터링만, 동작 불변).
2. `CpSatScheduler` 제약·목적·solve (선형 제약 → 네이티브 제약 → 목적 정수화).
3. `conflict_analyzer` (assumptions) + `/api/diagnose` + "정밀 충돌 분석" 버튼.
4. 진행/중지/로그 콜백 패리티.
5. API `solver` 필드 + 생성 패널 토글.
6. 파라미터화 테스트 + 동등성 검증.
7. 최종 빌드·릴리즈 (버전 bump, README/CHANGELOG).

## 11. 위험 · 완화

| 위험 | 완화 |
|---|---|
| ortools 오프라인 번들 실패 | Phase 0 게이트 — 실패 시 미출시 폴백 |
| 베이스 추출 중 HiGHS 회귀 | 각 단계 `pytest` green 확인, 동작 불변 리팩터링 |
| 목적 정수화로 미세하게 다른 해 | 동등성 기준을 "유효 + comparable"로 정의 |
| 제약 로직 2벌 드리프트 | 파라미터화 테스트가 양 엔진 동시 검증 → 드리프트 즉시 감지 |
| ortools 번들 크기/빌드 시간 증가 | 사용자 수용 (오프라인 조건부) |

## 12. 미해결 / 후속

- conflict_analyzer의 충돌 집합 → 한국어 메시지 변환 품질 (제약 그룹 단위 라벨링).
- CP-SAT 목적함수가 HiGHS와 "comparable"한지의 정량 기준(허용 gap%) 확정.
