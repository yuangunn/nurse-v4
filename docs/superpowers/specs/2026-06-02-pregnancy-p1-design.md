# 임산부 P1 휴무 + 모성보호 기능 설계

**작성일:** 2026-06-02
**상태:** 승인됨 (사용자 brainstorming 확정)

## 목표
임산부 간호사에게 **모성보호 휴무(P1)**를 자동 배치하고, 임신 기간 동안 **야간근무**와
**생리휴가 의무**를 면제한다. 간호사 편집(솔버 자동) + 사전입력(수동) 양쪽에서 동작.

## 확정된 결정 (사용자)
- **배치**: 간호사 편집에서 임산부+기간 설정 → 솔버가 매주 P1 1회 자동(하드). 사전입력 수동 배치도 허용.
- **기간**: 간호사별 날짜 구간 2개 직접 입력 — 임신초기 / 출산전.
- **P1 횟수**: 완전한 주(7일 주기)마다 정확히 1회. 부분 주 ≤1. (weeklyOff와 동일 패턴)
- **야간**: 임신 전 기간(임신~출산) N·NC 배정 금지.
- **생리휴가**: 임산부는 월 1회 생(生) 면제 (의무 해제 + 배정 금지). 임신 중 생리 없음.

## 데이터 모델
`Nurse` (models.py) 추가:
```python
is_pregnant: bool = False
pregnancy: Dict = {}   # {"early":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"},
                       #  "late": {"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}}
```
DB (database.py): `nurses`에 `is_pregnant INTEGER DEFAULT 0` + `pregnancy TEXT DEFAULT '{}'`
마이그레이션. row→dict / save 매핑 추가.

## 새 근무 코드 P1
`_seed_shifts` 16→17종: `P1` · "임부휴무" · period=`rest` · 색 청록(`#E3F4F4`/`#2C7A7B`).
- `period=rest` → `REST_SHIFTS` 자동 포함 → 휴무 분류 → 완화/처방에서 보호(`is_protected_timeoff` 편입).
- 공휴일에도 배정 가능(OF 금지 룰과 별개).
- 자유 변경 가능(설정 → 근무 정의).

## 기간 해석 (핵심)
- **P1 구간**: 초기 `[early.start, early.end]`, 말기 `[late.start, late.end]` — 각 구간에 완전히 포함된 주마다 P1 1회.
- **야간 제외 구간**: `[early.start, late.end]` 전체 (중기 포함). "임신~출산" 부합.
- **생 면제**: 임신 구간이 대상 월과 겹치면 그 달 생 의무 해제 + 생 배정 금지.

## 제약 (HiGHS · CP-SAT · conflict_analyzer 3곳 패리티)
P1은 **임산부 + P1 구간 날짜**에서만 변수 허용, 그 외 0 고정(생=여성만 게이팅과 동일).
| 제약 | 내용 | 강도 |
|------|------|:--:|
| P1 주1회 | 임산부 P1 구간 완전 포함 주마다 P1 == 1, 부분 주 ≤1 | 하드 |
| 야간 제외 | 임신 구간 `[early.start,late.end]` 동안 N·NC == 0 | 하드 |
| 야간전담 해제 | 임산부로 표시된 달은 is_night_shift 자동 무시(정규 취급) | 자동 |
| 생 면제 | 임신-중-달이면 생 의무 해제 + 생 == 0 | 자동 |

## 헬퍼 (scheduler_base)
- `_parse_pregnancy(nurse)` → {"early":(start,end)|None, "late":(...)|None} (date 객체)
- `_preg_window_on(nurse, dt)` → dt가 초기/말기 구간 내 (P1 허용)
- `_preg_span_on(nurse, dt)` → dt ∈ [early.start, late.end] (야간 제외)
- `_preg_active_in_month(nurse)` → 임신 구간이 대상 월과 겹침 (생 면제/야간전담 해제)

## UI (간호사 수정 모달, index.html + nurse-manage.js)
트레이니/로테이션 카드 패턴으로 "임산부 (모성보호)" 카드:
- ☑ 임산부 토글 + 임신초기 [시작~종료] + 출산전 [시작~종료]
- ⓘ 매주 P1 1회 자동 · 임신~출산 야간 제외 · 생리휴가 면제
- 간호사 목록 🤰 배지. 사전입력 팔레트/범례에 P1 자동 노출.

## 진단/충돌분석
- P1 주1회·야간제외 게이팅 편입 → infeasible 핀포인트.
- MCS: P1은 휴무라 높은 보호비용(연차류 준함) → 함부로 제거 안 함.

## 테스트 (tests/test_pregnancy.py, 양 엔진 parametrize)
1. 임산부 구간 주마다 P1 정확히 1회
2. 임신 기간 N/NC 0건
3. 비임산부 P1 0건
4. 사전입력 P1 존중
5. 임산부 생(生) 0건 + 생 의무 미발동

## 영향 파일
models.py · database.py · scheduler_base.py · scheduler_highs_constraints.py ·
scheduler_cpsat.py · conflict_analyzer.py · index.html · nurse-manage.js ·
tests/test_pregnancy.py(신규) · CLAUDE.md · docs/decisions.md
