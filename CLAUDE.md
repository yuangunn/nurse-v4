# NurseScheduler v2 — 프로젝트 문서

## 개요
간호사 3교대 근무표 자동 생성 앱. Windows 로컬 실행, 포터블 EXE + ZIP 배포, Inno Setup 설치마법사 지원.
인트라넷 환경(인터넷 없음)에서도 동작.

---

## 기술 스택

| 구분 | 기술 |
|------|------|
| 백엔드 | Python 3.11 + FastAPI + uvicorn |
| 스케줄링 엔진 | PuLP 2.9 + HiGHS (Python 바인딩: `highspy`) |
| 데이터 저장 | SQLite (`%APPDATA%\NurseScheduler\nurse_scheduler.db`) |
| 프론트엔드 | HTML + Tailwind CSS CDN + Alpine.js CDN |
| 패키징 | PyInstaller |
| 설치마법사 | Inno Setup |

> **중요**: `pulp.HiGHS_CMD` (실행파일 필요) 대신 `pulp.HiGHS` (Python 바인딩, `highspy` 패키지) 사용.
> `pulp.HiGHS_CMD`는 highs.exe 경로 문제로 동작하지 않음.

---

## 프로젝트 구조

```
nurse-v2/
├── main.py                  # 진입점: uvicorn 서버 + 브라우저 자동 오픈
├── server/
│   ├── api.py               # FastAPI 라우터
│   ├── scheduler.py         # HiGHS MIP 스케줄링 엔진
│   ├── database.py          # SQLite CRUD
│   └── models.py            # Pydantic 데이터 모델
├── frontend/
│   └── index.html           # 반응형 SPA (4탭)
├── installer/
│   └── setup.iss            # Inno Setup 스크립트
├── requirements.txt
└── CLAUDE.md                # 이 파일
```

---

## 실행 방법

```bash
# 개발 환경
cd c:\Users\Helios_Neo_18\nurse-v2
pip install -r requirements.txt
py main.py
# → http://localhost:5757 자동 오픈
```

포트 충돌 시 5758, 5759 순으로 시도.

---

## 근무 유형 정의

| 코드 | 이름 | 시간 | 비고 |
|------|------|------|------|
| DC | Day Charge | 06:00~14:00 | 차지 간호사 |
| D | Day | 06:00~14:00 | |
| D1 | Day1 | 08:30~17:30 | 상근/교육 |
| EC | Evening Charge | 14:00~22:00 | 차지 간호사 |
| E | Evening | 14:00~22:00 | |
| 중 | 중간번 | 11:00~19:00 | E→중 전환 순방향 |
| NC | Night Charge | 22:00~익일 06:00 | 차지 간호사 |
| N | Night | 22:00~익일 06:00 | |
| OF | Off | — | 주간 필수 1회 |
| 주 | 주휴 | — | 주간 필수 1회 (법정 주휴일) |
| V | 연차 | — | 월 최대 1회 (hard) |
| 생 | 생리휴가 | — | 여성 간호사 |
| 특 | 특별휴가 | — | |
| 공 | 공적업무 | — | 전날 N 배정 회피 (soft) |
| 법 | 법정공휴일 | — | |
| 병 | 병가 | — | |

### 근무 분류
- **WORK_SHIFTS**: DC, D, D1, EC, E, 중, NC, N
- **DAY_SHIFTS**: DC, D
- **DAY1_SHIFTS**: D1
- **EVENING_SHIFTS**: EC, E
- **MIDDLE_SHIFTS**: 중
- **NIGHT_SHIFTS**: NC, N
- **CHARGE_SHIFTS**: DC, EC, NC
- **REST_SHIFTS**: OF, 주 (휴무)
- **LEAVE_SHIFTS**: V, 생, 특, 공, 법, 병 (휴가)

---

## 스케줄링 제약 규칙

### Hard Constraints (반드시 지켜야 함)

| 제약 | 설명 |
|------|------|
| 1일 1근무 | 모든 간호사는 하루에 정확히 1개의 근무 |
| 일별 인원 **정확** 충족 | D/E/N 각 시간대 요구 인원과 **정확히 일치** (초과 배정 불가) |
| Charge 필수 | 매일 DC/EC/NC 각 1명 이상 |
| **Charge 시니어리티** | DC/EC/NC는 해당 듀티(D/E/N)에서 seniority 가장 낮은(선임) 간호사에게만 배정. 더 선임이 같은 듀티에 일반 근무(D/E/N)로 배정될 경우 후임은 Charge 불가. |
| 근무 자격 | capable_shifts에 없는 근무 배정 불가 |
| E→D 금지 | Evening 다음날 Day 불가 (역순, 14h 간격) |
| E→D1 금지 | Evening 다음날 D1 불가 |
| N→E 금지 | Night 다음날 Evening 불가 (역순) |
| N→D 금지 | Night 다음날 Day 불가 (역순) |
| N→D1 금지 | Night 다음날 D1 불가 (역순) |
| N→중 금지 | Night 다음날 중간번 불가 (역순, 22:00→익일 11:00 = 13h 간격) |
| N→OF→D 금지 | `noNOD` ON: Night→Off→Day 패턴 금지 |
| 주휴 1회/주 | 매주 정확히 주(주휴) 1회 |
| OF 1회/주 | 매주 정확히 OF 1회 |
| 최대 연속 근무 | 기본 6일 이하 (설정 변경 가능) |
| 최대 연속 야간 | 기본 3일 이하 (설정 변경 가능) |
| V 월 최대 횟수 | 기본 월 1회 이하 (hard) |

> **허용 전환** (순방향): D→E→N (8h 이상 간격 보장)
> 중간번(19:00 퇴근) → N(다음날 22:00 출근) = 27h 간격 → 순방향, 정상

### Soft Constraints (목적함수 페널티/보상)

| 항목 | 가중치 | 방향 |
|------|--------|------|
| 공 전날 N 배정 | -40 | 페널티 |
| D→N 전환 | -30 | 페널티 |
| 순방향 D→E, E→N | +20 | 보상 |
| 동일 근무 연속 | +15 | 보상 |
| 연속 휴일 | +30 | 보상 |
| 야간 공정 배분 | range 최소화 | 균형 |
| 희망 근무 반영 | +50 | 보상 |
| V 사용 | -500 | 페널티 (마지막 수단) |
| 생 사용 (여성) | +80 | 보상 (월 1회 권장, hard 상한 유지) |

---

## 주휴 순환 로직

**주휴(週休)**: 법정 주휴일. 1~4주기 동안 동일 요일 유지 후 5주차부터 1일씩 당겨짐.

### 사용자 요일 코드 → Python weekday 매핑
```
사용자: 0=일, 1=월, 2=화, 3=수, 4=목, 5=금, 6=토
Python: 0=월, 1=화, 2=수, 3=목, 4=금, 5=토, 6=일
변환:   {0:6, 1:0, 2:1, 3:2, 4:3, 5:4, 6:5}
```

### 순환 계산
```python
cycle = week_idx // 4          # 0, 0, 0, 0, 1, 1, 1, 1, 2, ...
effective_day = (juhu_day - cycle) % 7   # 4주마다 1일 당기기
```

### 간호사별 설정
- `juhu_day`: None(임의) 또는 0~6 (요일 고정)
- `juhu_auto_rotate`: True(4주 순환) / False(고정 유지)

### 12일 공백 자동 보정
일요일(0)에서 토요일(6) 전환 시 12일 공백 발생.
기존 `maxConsecutiveWork`(최대 연속 근무 6일) 제약이 자동으로 OF 배정을 강제하므로 별도 처리 불필요.

---

## 요일별 필요 인원 (기본값)

| 요일 | D | E | N |
|------|---|---|---|
| 월 | 4 | 5 | 3 |
| 화 | 5 | 5 | 3 |
| 수 | 5 | 5 | 3 |
| 목 | 5 | 5 | 3 |
| 금 | 5 | 4 | 3 |
| 토 | 3 | 3 | 2 |
| 일 | 3 | 4 | 3 |

D/E/N 수치는 charge 포함 총 인원. (예: D=4 → DC 1명 + D 3명)

---

## 간호사 예시 데이터 (시드)

18명, A/B/C 그룹 각 6명, 그룹당 여4+남2. 이름 앞 `*`는 임시 예시 데이터.

| ID | 이름 | 그룹 | 성별 |
|----|------|------|------|
| a0~a3 | *김지현 등 | A | female |
| a4~a5 | *김준혁 등 | A | male |
| b0~b3 | *최은혜 등 | B | female |
| b4~b5 | *박정호 등 | B | male |
| c0~c3 | *장소연 등 | C | female |
| c4~c5 | *정성민 등 | C | male |

---

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | `/` | 프론트엔드 서빙 |
| GET | `/health` | 상태 확인 |
| GET | `/api/nurses` | 간호사 목록 |
| POST | `/api/nurses` | 간호사 추가/수정 |
| DELETE | `/api/nurses/{id}` | 간호사 삭제 |
| POST | `/api/nurses/reorder` | 순서 변경 |
| GET | `/api/rules` | 규칙 조회 |
| POST | `/api/rules` | 규칙 저장 |
| GET | `/api/requirements` | 요일별 인원 조회 |
| POST | `/api/requirements` | 요일별 인원 저장 |
| POST | `/api/generate` | 스케줄 생성 |
| POST | `/api/generate/stop` | 생성 중지 (cancelSolve) |
| GET | `/api/generate/progress` | 생성 진행 상황 (폴링) |
| GET | `/api/generate/stream` | SSE 실시간 로그 스트리밍 |
| GET | `/api/generate/result` | 마지막 생성 결과 조회 (새로고침 복구용) |
| POST | `/api/estimate` | 예상 소요시간 조회 |
| GET | `/api/shifts` | 근무 목록 |
| POST | `/api/shifts` | 근무 추가/수정 |
| DELETE | `/api/shifts/{code}` | 근무 삭제 |
| GET | `/api/scoring_rules` | 배점 규칙 목록 |
| POST | `/api/scoring_rules` | 배점 규칙 추가/수정 |
| DELETE | `/api/scoring_rules/{id}` | 배점 규칙 삭제 |
| GET | `/api/schedules` | 저장된 스케줄 목록 |
| POST | `/api/schedules` | 스케줄 저장 |
| GET | `/api/schedules/{id}` | 스케줄 불러오기 |
| DELETE | `/api/schedules/{id}` | 스케줄 삭제 |
| GET | `/api/prev_schedules` | 사전입력 저장 목록 |
| POST | `/api/prev_schedules` | 사전입력 저장 |
| GET | `/api/prev_schedules/{id}` | 사전입력 불러오기 |
| DELETE | `/api/prev_schedules/{id}` | 사전입력 삭제 |

---

## 프론트엔드 탭 구성

1. **설정 탭**: 간호사 관리 (추가/수정/삭제/순서 변경), 규칙 설정, 요일별 인원 설정
2. **사전입력 탭**: 년월 선택 + 근무표 선입력 (D/E/N/OF/주/V/생/특/공/법/병)
   - 💾 버튼으로 사전입력 서버 저장/불러오기/삭제 패널 토글
   - 저장 시 이름 지정 가능, 목록에서 불러오기/삭제
   - 셀 배경색: 근무 종류별 shift-X CSS 클래스를 `<td>` 전체에 적용
3. **스케줄 탭**: 년월 선택 + 스케줄 생성 결과 표시, 셀 직접 편집
   - 생성 시 예상 소요시간 + 경과시간 표시, 로딩 프로그레스 바
   - 생성 완료 표: 주기 헤더, 요일별 배경색, 셀 배경색 적용 (사전입력 탭과 동일)
   - 표 하단 `<tfoot>`: 매일 낮/저녁/야간/휴무 인원수 표시
4. **저장 탭**: 생성된 스케줄 저장/불러오기

> 사전입력과 스케줄 탭은 년월 선택이 연동됨.
> 토요일 이후(일요일 시작 전) 열 경계에 굵은 선 표시.

---

## Infeasible 진단 단계

스케줄 생성 실패 시 `_diagnose_infeasibility()`가 단계별로 원인 파악:

1. Phase 1: 근무 자격만
2. Phase 2: + 하루 1근무
3. Phase 3: + 역순 전환 금지
4. Phase 4: + 일별 인원 충족
5. Phase 5: + Charge 필수 → **주차별 세부 분석**: 각 주 필요 슬롯 vs 가용 슬롯 비교, 빡빡한 주/날짜 ★ 표시
6. Phase 6: + 주휴/OF
7. Phase 7: + 연속 제약

> Phase 5 실패 시 `[주차별 분석]` 섹션에서 과부하 주차와 인원 부족 날짜를 구체적으로 표시.

---

## 데이터베이스

**위치**: `%APPDATA%\NurseScheduler\nurse_scheduler.db`

**테이블**:
- `nurses`: 간호사 정보 (juhu_day, juhu_auto_rotate 포함)
- `rules`: 규칙 key-value 저장
- `requirements`: 요일별 필요 인원 JSON
- `schedules`: 저장된 근무표 (year, month, data JSON)
- `prev_schedules`: 사전입력 저장 (year, month, name, data JSON) — 사전입력 탭에서 저장/불러오기/삭제

> DB 삭제 후 재시작 시 18명 예시 간호사 + 기본 요구사항 자동 삽입.

---

## 패키징 (배포 빌드)

```bash
pip install pyinstaller
pyinstaller --onedir --windowed ^
  --add-data "frontend;frontend" ^
  --hidden-import=highspy ^
  --hidden-import=pulp ^
  --name NurseScheduler ^
  main.py
```

결과: `dist/NurseScheduler/NurseScheduler.exe`

### 배포 형태
- **포터블**: `dist/NurseScheduler/` 폴더를 ZIP으로 압축 → 압축 풀고 EXE 실행
- **설치 버전**: Inno Setup으로 `installer/setup.iss` 컴파일 → `NurseScheduler_Setup.exe`

---

## highspy 1.8.1 콜백 API

> **중요**: highspy 1.8.1에서 `setLogCallback()` 메서드가 제거됨.
> 대신 `cbLogging.subscribe(fn)` 방식 사용. 콜백 이벤트는 `event.message`로 로그 수신.

```python
# 구 API (동작 안 함)
# self.setLogCallback(lambda _, msg: ...)

# 신 API (highspy 1.8.1+)
def _on_log(event):
    msg = getattr(event, "message", "")
    ...
self.cbLogging.subscribe(_on_log)
```

`setCallback(fn, user_data)`도 있지만 모든 내부 이벤트("MIP check limits" 등)를
쏟아내므로 사용하지 않음. `cbLogging.subscribe()`가 로그 전용 콜백.

---

## 솔버 중지 및 새로고침 복구

### 중지 (cancelSolve)
- `POST /api/generate/stop` → `_TrackableHighs` 인스턴스의 `cancelSolve()` 호출
- PuLP가 `kInterrupt` 상태를 반환 → `LpStatus`에 매핑 안 됨
- 해결: `prob.solve()` 예외 처리 + 변수에 값이 할당되어 있으면 feasible solution으로 인정

### 새로고침 복구
- `_last_generate_result` 전역 변수에 마지막 생성 결과 보관
- `GET /api/generate/result` → `running` / `done` / `idle` 반환
- 프론트엔드 `init()` 시 자동 감지: 진행 중이면 SSE 재접속 + 폴링, 완료면 결과 복원

### 동시 생성 방지
- `POST /api/generate` 진입 시 이전 솔버가 돌고 있으면 409 에러 반환
- "이미 생성이 진행 중입니다. 중지 후 다시 시도하세요."

---

## 솔버 로그 UI

- 생성 중/완료/오류 모든 상태에서 솔버 로그 확인 가능
- 로그창 높이 420px, B&B 헤더 설명 테이블 포함
- 로그 항목은 `{id, msg}` 객체 + 고유 키로 렌더링 (Alpine.js `shift()` 렌더링 이슈 방지)
- 300줄 초과 시 `slice(-200)`으로 일괄 트리밍

---

## 성능 참고 (18명 × 31일 기준)

- 주휴만 사전입력 (81건): ~5분 (300초), Optimal
- 사전입력 많을수록 자유 변수 감소 → 속도 향상
- `mip_gap=0.02` (2% 오차 허용) 설정 시 조기 종료 가능
- CPU 싱글코어 성능이 핵심 (HiGHS는 기본 싱글스레드)
- GPU 사용 안 함

---

## 알려진 주의사항

- `pulp.HiGHS_CMD` 사용 금지 → `pulp.HiGHS` (Python 바인딩) 사용
- 소프트 제약 보조변수는 당월 날짜 쌍에만 적용 (문제 크기 최소화)
- solver timeLimit: 프론트엔드에서 설정 가능 (기본 20분, 최대 60분)
- 일별 인원 제약은 `==` (정확히 일치) — 초과 배정 불가
- __pycache__ 구버전 캐시로 인한 오류 발생 시: 서버 완전 종료 후 `__pycache__` 폴더 삭제
- 포트 5757 점유 시 완전히 종료 후 재시작 필요 (기존 uvicorn 프로세스 확인)
