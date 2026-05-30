# CP-SAT 듀얼 솔버 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 PuLP+HiGHS 단일 솔버에 OR-Tools CP-SAT를 두 번째 생성 엔진으로 추가하고, infeasible 시 충돌 제약을 1회 호출로 짚어주는 정밀 진단을 제공한다.

**Architecture:** 공유 `_SchedulerBase`(엔진 무관 데이터/셋업) + 엔진별 서브클래스(`NurseScheduler`=HiGHS 무손상, `CpSatScheduler`=cp_model). 진행/취소는 솔버 무관 레지스트리(`solver_progress.py`)로 분리. 진단은 독립 `conflict_analyzer.py`(assumptions API). 생성 패널 토글로 엔진 선택(기본 HiGHS).

**Tech Stack:** Python 3.12, FastAPI, PuLP 2.9/highspy 1.8 (기존), ortools 9.14 (신규), pytest, Alpine.js, PyInstaller.

**Spec:** `docs/superpowers/specs/2026-05-30-cpsat-dual-solver-design.md`

**전제:** 각 태스크 끝에서 `py -m pytest tests/`가 green이어야 다음으로 진행. HiGHS 경로는 어떤 단계에서도 깨지면 안 된다.

---

## Phase 0 — ortools 오프라인 번들 게이트 (BLOCKING)

이 게이트를 통과하지 못하면 CP-SAT 전체를 출시하지 않는다(HiGHS 단독 유지).

### Task 0: ortools 오프라인 번들 증명

**Files:**
- Modify: `requirements.txt`
- Modify: `NurseScheduler.spec`
- Create: `scripts/_spike_cpsat_offline.py` (검증용, 나중 삭제 가능)

- [ ] **Step 1: ortools 의존성 추가**

`requirements.txt` 끝에 추가:
```
ortools==9.14.6206
```
설치: `py -m pip install ortools==9.14.6206`

- [ ] **Step 2: 최소 CP-SAT 동작 스파이크 작성**

`scripts/_spike_cpsat_offline.py`:
```python
"""ortools가 (인터넷 없이) 임포트·풀이 되는지 최소 확인."""
from ortools.sat.python import cp_model

def main():
    m = cp_model.CpModel()
    xs = [m.NewBoolVar(f"x{i}") for i in range(5)]
    m.Add(sum(xs) == 2)
    s = cp_model.CpSolver()
    st = s.Solve(m)
    assert st in (cp_model.OPTIMAL, cp_model.FEASIBLE), st
    print("CPSAT_OK", sum(int(s.Value(x)) for x in xs))

if __name__ == "__main__":
    main()
```

- [ ] **Step 3: 로컬 실행 확인**

Run: `py scripts/_spike_cpsat_offline.py`
Expected: `CPSAT_OK 2`

- [ ] **Step 4: PyInstaller hook 추가**

현재 spec(NurseScheduler.spec:7-27)은 `pkg_datas, pkg_binaries, pkg_hiddenimports = collect_all('pkg')` 후 `Analysis(binaries=highspy_binaries + ...)` 식으로 합친다. 동일 패턴으로:

(a) import 라인(7행)에 `collect_dynamic_libs` 추가:
```python
from PyInstaller.utils.hooks import collect_all, collect_submodules, collect_dynamic_libs
```
(b) collect_all 블록(16행 아래)에 추가:
```python
ort_datas, ort_binaries, ort_hiddenimports = collect_all('ortools')
ort_dynlibs = collect_dynamic_libs('ortools')
```
(c) `Analysis(...)` 인자 식에 합치기 (`+=` 아님 — 인라인 식에 항 추가):
```python
    binaries=highspy_binaries + crypto_binaries + pulp_binaries + ort_binaries + ort_dynlibs,
    datas=[ ... ] + highspy_datas + crypto_datas + pulp_datas + ort_datas,
    hiddenimports=[ ... ] + highspy_hiddenimports + crypto_hiddenimports + pulp_hiddenimports
        + ort_hiddenimports + ['google.protobuf', 'ortools.sat.python.cp_model_helper'],
```

- [ ] **Step 5: 빌드 → 네트워크 차단 실행 (게이트)**

Run: `build.bat` (PyInstaller 단계까지) → `dist/NurseScheduler/NurseScheduler.exe`를 네트워크 차단(어댑터 비활성/방화벽) 상태에서 기동, `/health` 확인 + 게스트로 작은 CP-SAT 생성 1회.
Expected: 서버 기동 + CP-SAT 생성 성공. 실패 시 hiddenimports/`collect_dynamic_libs` 보강 후 재시도. 그래도 실패면 **STOP — 사용자에게 보고, CP-SAT 미출시 폴백**.

- [ ] **Step 6: Commit**

```bash
git add requirements.txt NurseScheduler.spec scripts/_spike_cpsat_offline.py
git commit -m "build: ortools 의존성 + PyInstaller 오프라인 번들 hook (Phase 0 게이트)"
```

---

## Phase 1 — `_SchedulerBase` 추출 (동작 불변 리팩터)

### Task 1: 엔진 무관 셋업을 베이스로 추출

**Files:**
- Create: `server/scheduler_base.py`
- Modify: `server/scheduler.py` (NurseScheduler가 _SchedulerBase 상속)
- Test: `tests/` (기존 전부 — 회귀 가드)

- [ ] **Step 1: 베이스 클래스 생성**

`server/scheduler_base.py`에 `_SchedulerBase`를 만들고, **현재 `NurseScheduler.__init__` 본문 전체(scheduler.py:43-140)를 베이스로 이동**한다 — 생성자에 HiGHS 전용 로직은 없으므로 통째로 옮긴다. 따라서 다음 인스턴스 속성이 전부 베이스에서 세팅됨(누락 시 CpSatScheduler `AttributeError`): `self.req, self.per_day_req, self.prev, self.locked_cells, self.holidays, self.weeks, self._shifts, self.SOLVER_SHIFTS`(및 WORK/DAY/EVENING/NIGHT/CHARGE/REST/LEAVE 분류), `self.scoring_rules, self.rules, self.mip_gap, self.time_limit, self.prev_month_nights, self.unlimited_v, self.allow_pre_relax, self.allow_juhu_relax, self._PRE_FLEX, self.all_dates, self.T, self.N` 등.
함께 이동할 메서드: `_cycle_day_offset`/`_CYCLE_REF`, `_build_date_range`(날짜 윈도잉 포함), `_nurse_active_on`, `_nurse_active_idx`, `_fmt_nurse_label`, `_fmt_date`, `_compute_nurse_scores`, `_extract_solution`(아래 Step 2), 트레이니 프리셉터 복사(순수 dict 조작 — 솔버 무관).
`NurseScheduler(_SchedulerBase)`로 변경하고 `NurseScheduler.__init__`은 제거(또는 `super().__init__(request)`만). HiGHS 전용(`_c_*`, `_build_objective`, `solve`, `_solve_with_relaxed_pre`, `_diagnose_infeasibility` 및 그 `_scan_*` 헬퍼)은 그대로 둠.

- [ ] **Step 2: `_extract_solution` 일반화 (상수 셀 패스스루 보존)**

현재 `_extract_solution`(scheduler.py:2673-2732)은 셀이 상수(0/1)면 그대로 쓰고 변수면 `pulp.value(v)`를 읽는다 — 이 분기를 보존하고 변수 읽기만 콜백화:
```python
val = v if isinstance(v, (int, float)) else value_fn(v)
```
HiGHS 주입: `value_fn = lambda v: round(pulp.value(v) or 0)` (None 흡수).
CP-SAT 주입: `value_fn = lambda v: solver.Value(v)`.
트레이니 프리셉터 복사 블록은 솔버 무관이므로 변경 없음.

- [ ] **Step 3: 회귀 테스트 실행**

Run: `py -m pytest tests/ -q`
Expected: 11 passed (동작 불변).

- [ ] **Step 4: Commit**

```bash
git add server/scheduler_base.py server/scheduler.py
git commit -m "refactor: _SchedulerBase 추출 (엔진 무관 셋업) — 동작 불변"
```

---

## Phase 2 — 솔버 무관 진행/취소 레지스트리

### Task 2: `solver_progress.py` 도입 + api.py 호출지점 재작성

**Files:**
- Create: `server/solver_progress.py`
- Modify: `server/api.py` (`stop_generate`, 409 가드, `get_generate_progress`, `generate_stream`, `_TrackableHighs`)
- Test: `tests/test_solver_progress.py` (신규)

- [ ] **Step 1: 실패 테스트 작성**

`tests/test_solver_progress.py`:
```python
from server import solver_progress as sp

def test_registry_default_idle():
    sp.clear()
    assert sp.get_progress()["is_running"] is False

def test_register_and_progress():
    sp.clear()
    class Fake:
        def cancel(self): self.cancelled = True
        def progress(self): return {"gap_percent": 1.5, "nodes": 10, "has_solution": True, "is_running": True}
    f = Fake()
    sp.register(f)
    assert sp.get_progress()["gap_percent"] == 1.5
    sp.request_cancel()
    assert f.cancelled is True
    sp.clear()
    assert sp.get_progress()["is_running"] is False
```

- [ ] **Step 2: 실패 확인**

Run: `py -m pytest tests/test_solver_progress.py -q`
Expected: FAIL (module not found).

- [ ] **Step 3: 레지스트리 구현**

`server/solver_progress.py`: 모듈 전역 `_current`(어댑터: `.cancel()`, `.progress()->dict`), `register(adapter)`, `clear()`, `get_progress()->dict`(없으면 idle 기본), `request_cancel()`, `is_running()`. payload shape `{gap_percent, nodes, has_solution, is_running}` 유지.

- [ ] **Step 4: 테스트 통과 확인**

Run: `py -m pytest tests/test_solver_progress.py -q` → PASS

- [ ] **Step 5: api.py를 레지스트리 기준으로 재작성**

`_TrackableHighs`가 `solver_progress.register(adapter)` 하도록(어댑터의 `.cancel()`→`cancelSolve()`, `.progress()`→`getInfoValue` 기반). `stop_generate`/409 가드/`get_generate_progress`/`generate_stream`를 `_current_highs_instance` 대신 `solver_progress.*` 사용으로 교체. 기존 `_current_highs_instance`는 어댑터 내부로 격리.

- [ ] **Step 6: 전체 회귀 + 수동 HiGHS 생성 확인**

Run: `py -m pytest tests/ -q` → 13+ passed. 그리고 `py main.py`로 띄워 게스트 HiGHS 생성 1회 — 진행률·중지 동작 확인.

- [ ] **Step 7: Commit**

```bash
git add server/solver_progress.py server/api.py tests/test_solver_progress.py
git commit -m "refactor: 솔버 무관 진행/취소 레지스트리 — api.py를 _current_highs_instance에서 분리"
```

---

## Phase 3 — 테스트 하네스 양 엔진 대응

### Task 3: `solver` 필드 + 하네스 분기

**Files:**
- Modify: `server/models.py` (`GenerateRequest.solver`)
- Modify: `tests/conftest.py` (`solve_small` 분기, `LimitedScheduler` 베이스 윈도잉)
- Test: `tests/conftest.py` 자체 + 기존 테스트

- [ ] **Step 1: `GenerateRequest.solver` 추가**

`server/models.py`:
```python
solver: Literal["highs", "cpsat"] = "highs"
```
(`from typing import Literal` 확인)

- [ ] **Step 2: conftest 윈도잉을 베이스 활용형으로**

`tests/conftest.py`의 `LimitedScheduler`를 `_SchedulerBase`의 `_build_date_range`를 오버라이드하는 믹스인으로 재구성. `solve_small(request, days, solver="highs")`가 `solver`에 따라 `NurseScheduler` 또는 `CpSatScheduler`(Phase 4 후 존재)를 윈도잉 적용해 인스턴스화. Phase 3 시점엔 `cpsat` 분기는 `pytest.skip("CpSatScheduler 미구현")`로 가드.

- [ ] **Step 3: 회귀 확인**

Run: `py -m pytest tests/ -q`
Expected: 기존 통과 유지 (highs 경로 불변, cpsat 분기는 skip).

- [ ] **Step 4: Commit**

```bash
git add server/models.py tests/conftest.py
git commit -m "test: GenerateRequest.solver 필드 + 하네스 양엔진 분기(cpsat는 skip 가드)"
```

---

## Phase 4 — `CpSatScheduler` 구현

각 서브태스크는 "HiGHS 대응 메서드와 1:1" 원칙. 끝마다 해당 불변식 테스트를 cpsat로 켜서 green 확인.

### Task 4a: 골격 + 선형 하드 제약 + solve

**Files:**
- Create: `server/scheduler_cpsat.py`
- Test: `tests/test_constraints.py` (parametrize 확장)

- [ ] **Step 1: 골격**

`CpSatScheduler(_SchedulerBase)`: `__init__`에서 `cp_model.CpModel()`, `x[nid][d][shift]=NewBoolVar`. `solve()->Dict`(베이스 반환 shape). 우선 제약 없이 feasible 확인용.

- [ ] **Step 2: 선형 하드 제약 포팅**

`_c_one_shift_per_day`, `_c_shift_eligibility`, `_c_daily_requirements`(정확충족 `==`), `_c_charge_requirements`, `_c_weekly_off`, `_c_max_v_per_month`, `_c_max_night_per_month`, `_c_max_night_two_month`를 `model.Add(sum(...) <op> rhs)`로. 각각 scheduler.py의 동명 메서드를 참조해 동일 의미.

- [ ] **Step 3: conftest cpsat 분기 활성화 + smoke/일별인원/1일1근무/V한도 테스트 parametrize**

`@pytest.mark.parametrize("solver",["highs","cpsat"])`를 `test_smoke_solve_succeeds`, `test_daily_requirements_exact_match`, `test_one_shift_per_day`, `test_v_per_month_limit`에 적용.

- [ ] **Step 4: 실행**

Run: `py -m pytest tests/test_constraints.py -q`
Expected: 해당 테스트 cpsat·highs 양쪽 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/scheduler_cpsat.py tests/conftest.py tests/test_constraints.py
git commit -m "feat(cpsat): CpSatScheduler 골격 + 선형 하드 제약 + 기본 테스트 parametrize"
```

### Task 4b: 네이티브 조합 제약 (금지전환·주휴순환·연속)

- [ ] **Step 1: 금지전환** — 인접일 쌍 9종에 `model.AddBoolOr([a.Not(), b.Not()])`. test_no_forbidden_transitions를 cpsat parametrize.
- [ ] **Step 2: 연속근무/연속야간/연속야간 후 휴무** — sliding-window `model.Add`. (해당 불변식 테스트 있으면 parametrize, 없으면 신규 1개.)
- [ ] **Step 3: 주휴 4주 순환** — 허용집합/automaton. (사전입력 주휴 유지 테스트 parametrize.)
- [ ] **Step 4: 실행** — `py -m pytest tests/test_constraints.py -q` 양엔진 PASS.
- [ ] **Step 5: Commit** — `feat(cpsat): 네이티브 조합 제약 (금지전환·연속·주휴순환)`

### Task 4c: 비자명 제약 (§4.1)

- [ ] **Step 1: charge 시니어리티** (`_c_charge_seniority` 대응 pairwise 함의). test_charge_goes_to_senior parametrize.
- [ ] **Step 2: 야간전담** (`_c_night_shift_nurses`: N/NC 전용·5일≤3·당월 14일·여성31일 생1회).
- [ ] **Step 3: 생리휴가** (`_c_menstrual_leave`).
- [ ] **Step 4: `locked_cells`(=1 고정)·holidays(OF/생/V=0)·`_PRE_FLEX` 도메인 고정.**
- [ ] **Step 5: 실행** — 전체 test_constraints 양엔진 PASS.
- [ ] **Step 6: Commit** — `feat(cpsat): 비자명 하드 제약 (시니어리티·야간전담·생휴·잠금·공휴일)`

### Task 4d: 목적함수 정수화

- [ ] **Step 1:** scoring_rules 가중합을 **단일 전역 스케일 S로 균일** 정수화(형평성 range_var 포함), `model.Maximize`. **S는 고정 1000이 아니라 실제 최대 절대 점수에서 산출**해 int64 안전 마진 확보 — 현재 점수는 ±20100(menstrual), ±5000(preBonusLeave) 등:
```python
max_abs = max(abs(s) for s in all_term_weights) or 1
S = max(1, 10**6 // max_abs)        # 항 크기 ~1e6 상한
```
모든 항에 동일 S 적용 + round-half-up. 셀 수×항 합산이 2^53 미만이어야 함(아래 테스트).
- [ ] **Step 2:** mip_gap 대응 `solver.parameters.relative_gap_limit`, time_limit `max_time_in_seconds`.
- [ ] **Step 3: 동등성 + 오버플로 테스트** — `tests/test_equivalence.py` 신규: (a) 동일 입력에 highs/cpsat 모두 모든 하드제약 충족 + 목적값 comparable(허용 gap), (b) 정수화 목적 상한이 `< 2**53`임을 assert (오버플로 가드). 작은 문제로.
- [ ] **Step 4: 실행** — PASS.
- [ ] **Step 5: Commit** — `feat(cpsat): 목적함수 정수화 + 동등성 테스트`

---

## Phase 5 — 진단 (conflict_analyzer) + `/api/diagnose`

### Task 5: assumptions 기반 충돌 분석

**Files:**
- Create: `server/conflict_analyzer.py`
- Modify: `server/api.py` (`POST /api/diagnose`)
- Test: `tests/test_diagnostics.py` (확장)

- [ ] **Step 1: 실패 테스트** — `tests/test_diagnostics.py`에 의도적 충돌(예: 일별 요구 > 가용) 입력 → `analyze_conflicts(req)`가 비어있지 않은 충돌 집합 + 한국어 메시지 반환.
- [ ] **Step 2: 실패 확인** — `py -m pytest tests/test_diagnostics.py -k conflict -q` → FAIL.
- [ ] **Step 3: 구현** — ⚠️ Phase 4의 CpSatScheduler 모델은 제약이 **무조건(`model.Add`)** 걸려 있어 assumption으로 끌 수 없다. conflict_analyzer는 **자체 모델**을 새로 만들고, 각 하드 제약 그룹을 enforce 리터럴로 게이팅한다:
```python
lit = model.NewBoolVar(label)          # per-(nurse,date) 또는 per-(nurse,week)
model.Add(<constraint>).OnlyEnforceIf(lit)
reverse[lit.Index()] = ("간호사/날짜/제약" 한국어 라벨)
```
모든 lit을 `model.AddAssumptions(list(lits))` → `solver.Solve(model)` → `INFEASIBLE`이면 `solver.SufficientAssumptionsForInfeasibility()`(인덱스 리스트 반환) → `reverse`로 역매핑 → 한국어 메시지. 입도: 셀 지목형(금지전환·일별인원·charge)=per-(nurse,date)/per-(date,duty), 주차형(주휴/OF·연속·월야간)=per-(nurse,week).
- [ ] **Step 4: 통과 확인** — PASS.
- [ ] **Step 5: API** — `POST /api/diagnose`(body=GenerateRequest) → `analyze_conflicts`. CP-SAT 생성 infeasible 시 결과에 자동 첨부.
- [ ] **Step 6: 실행 + Commit** — `py -m pytest tests/ -q` → all green. `feat: conflict_analyzer (CP-SAT assumptions) + /api/diagnose`

---

## Phase 6 — 진행/중지/로그 콜백 + API/UI 토글

### Task 6a: CP-SAT 콜백 패리티

**Files:** Modify `server/scheduler_cpsat.py`, `server/solver_progress.py`

- [ ] **Step 1:** `_TrackableCpSatCb(cp_model.CpSolverSolutionCallback)` — incumbent마다 `self.ObjectiveValue()`/`self.BestObjectiveBound()`로 gap%·best, `self.NumBranches()`→nodes, `_log_queue` push. 콜백 진입 시 `_solve_cancelled`면 `self.StopSearch()`.
  - **취소 계약(중요)**: 콜백은 *개선 incumbent에서만* 호출되므로 `StopSearch()`는 다음 incumbent까지 지연될 수 있다. 따라서 `solver_progress.register(adapter)`의 `adapter.cancel()`은 (1) `_solve_cancelled=True` 세팅 + (2) **하드 백스톱으로 `solver.parameters.max_time_in_seconds`를 항상 설정**(time_limit)해 취소 상한을 보장한다. 이 지연 특성을 코드 주석/스펙(§6 캐비엇)과 일치시킨다.
  - gap/bound는 `CpSolver`의 것이지 콜백 전용 메서드가 아님에 유의 — solve 종료 후 최종 gap은 `solver` 객체에서 읽어 `_last_*`에 보관.
- [ ] **Step 2:** 수동 검증 — `py main.py` → CP-SAT 큰 생성 1회: 진행률 갱신·중지 버튼·로그 스트림 동작.
- [ ] **Step 3: Commit** — `feat(cpsat): 진행/중지/로그 콜백 패리티`

### Task 6b: 생성 패널 솔버 토글

**Files:** Modify `frontend/index.html`, `frontend/js/app.js`

- [ ] **Step 1:** app.js state `solver:'highs'` + generate payload에 `solver:this.solver`.
- [ ] **Step 2:** 생성 패널에 `솔버 ◉HiGHS ○CP-SAT` 라디오. CP-SAT 선택 시 완화/주휴완화 토글 `:disabled` + 안내 툴팁(§3.1).
- [ ] **Step 3:** HiGHS-infeasible 결과 카드에 "정밀 충돌 분석 (CP-SAT)" 버튼 → `/api/diagnose` 호출 → 결과를 진단 영역에 표시.
- [ ] **Step 4:** 프리뷰 검증(라이트/다크, 토글 동작, 버튼). 콘솔 에러 0.
- [ ] **Step 5: Commit** — `feat: 생성 패널 솔버 토글 + 정밀 충돌 분석 버튼`

---

## Phase 7 — 전체 회귀 + 동등성 게이트

### Task 7: 양엔진 파라미터화 전수 통과

- [ ] **Step 1:** `tests/` 전체에서 엔진 무관 불변식 테스트가 highs·cpsat 양쪽 parametrize 됐는지 점검(누락 보완).
- [ ] **Step 2:** Run `py -m pytest tests/ -q` → 전부 green (cpsat 케이스 포함).
- [ ] **Step 3: Commit** — `test: 양엔진 파라미터화 전수 통과`

---

## Phase 8 — 빌드 · 릴리즈

### Task 8: 버전 bump + 빌드 + 배포

- [ ] **Step 1:** 버전 4.3.0 동기화 (electron/package.json, preload.js, installer/setup.iss, frontend/index.html brand-ver + about, README, CHANGELOG). README 주요기능에 "듀얼 솔버(CP-SAT) + 정밀 충돌 분석" 추가(저장된 릴리즈 규칙).
- [ ] **Step 2:** PR→merge→tag `v4.3.0`.
- [ ] **Step 3:** `build.bat` → `gh release create v4.3.0` + Setup.exe·portable.zip 업로드 (오프라인 번들 규칙).
- [ ] **Step 4:** 메모리 업데이트(project_status, plan_cpsat_migration 완료 처리).

---

## 참고
- 각 Phase 끝 `py -m pytest tests/ -q` green 필수. HiGHS 경로 회귀 금지.
- 동등성 기준: 비트 동일 아님 — 하드제약 충족 + 목적값 comparable(허용 gap은 Task 4d에서 확정).
- Phase 0 실패 시 전체 중단 + 사용자 보고.
