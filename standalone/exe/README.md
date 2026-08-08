# 어싸인 배정표 — 도우미 exe (준비 단계)

## 왜 만드나

`assign.html` 을 브라우저로 그냥 열면(`file://`) **파일에 쓰려면 매번** 사용자가
파일을 고르고 "편집을 허용할까요?" 에 답해야 한다. 브라우저 보안 규칙이라
HTML 안에서는 우회할 방법이 없다. (읽기는 `assign-data.js` 자동 열림으로 이미 0클릭)

도우미가 `http://127.0.0.1` 로 화면을 띄워 주면 그 제약 자체가 사라진다.

| | 브라우저로 직접 (file://) | 도우미 exe |
|---|---|---|
| 켤 때 폴더 고르기 | 없음 (assign-data.js 자동 열림) | 없음 |
| 수정·저장 | 세션마다 [저장 연결] 1번 | **없음 — 바로 저장** |
| 데이터 파일 위치 | assign.html 과 같은 폴더 | `assign.ini` 로 NAS 경로 지정 가능 |
| 설치 | 불필요 | 불필요 (exe 파일 하나) |
| 걸림돌 | — | 서명 없는 exe 정책 |

## 구성

```
assign_server.py   도우미 본체 (표준 라이브러리만 사용)
build_exe.bat      PyInstaller 단일 파일 빌드 (Windows에서 실행)
```

동작:
1. 빈 포트를 잡아 `127.0.0.1` 에만 바인딩하고 `assign.html` 을 서빙
2. `GET /api/data`, `PUT /api/data` 로 데이터 파일 읽기·쓰기
   (임시 파일에 쓴 뒤 교체 — 저장 중 전원이 나가도 원본이 깨지지 않는다)
3. 다른 PC가 먼저 저장했으면 `409` 로 알려 주고 화면에서 판단
   (덮어쓰기 / 백업 내려받기) — file:// 방식과 동일한 규칙
4. Edge/Chrome 을 앱 창(`--app`)으로 띄우고, 창을 닫아 핑이 3분간 끊기면 스스로 종료
5. 매 실행마다 난수 토큰을 만들어 URL 에 실어 보낸다. 토큰 없는 요청은 403 —
   같은 PC 의 다른 프로그램·웹페이지가 데이터를 건드리지 못한다.

## 빌드

Windows 에서:

```bat
py -m pip install pyinstaller
node scripts\build-assign-standalone.mjs      REM assign.html 최신화 (리포 루트에서)
standalone\exe\build_exe.bat
```

결과: `standalone\exe\dist\어싸인배정표.exe`

## 배포·사용

1. `어싸인배정표.exe` 를 병동 공용 폴더(NAS)에 둔다.
2. 데이터 파일 위치를 바꾸려면 exe 옆에 `assign.ini` 를 만든다:
   ```ini
   data=\\nas\간호부\5A병동\assign-data.json
   ```
   (없으면 exe 옆 `assign-data.json`)
3. exe 를 두 번 누르면 배정표 창이 바로 뜬다. 고치면 그대로 저장된다.

`assign.html` 은 exe 안에 들어 있지만, exe 옆에 `assign.html` 을 따로 두면
**그쪽을 먼저 읽는다** — 화면만 바뀐 새 버전은 exe 재빌드 없이 교체할 수 있다.

## 알려진 걸림돌

- **서명 없는 exe**: SmartScreen 경고("Windows의 PC 보호"), AppLocker/EDR 차단 가능.
  코드 서명 인증서를 받거나, 병원 정보팀에 해시 화이트리스트를 요청하는 게 정석.
  그 전까지는 `file://` + 자동 열림 방식이 통과율이 높다.
- **방화벽**: 루프백(127.0.0.1)만 열기 때문에 보통 방화벽 창이 뜨지 않는다.
  뜬다면 "취소" 해도 동작한다(외부 접속을 안 쓰므로).
- **NAS 경로**: 그 PC 에서 해당 경로가 보여야 한다(드라이브 매핑 또는 UNC 권한).

## 왜 Python + PyInstaller 인가

이 리포가 이미 PyInstaller 로 본 앱을 빌드하고 있어 도구를 새로 들이지 않아도 된다.
대신 단일 파일 exe 는 실행할 때 임시 폴더에 풀리느라 첫 실행이 1~3초 걸린다.
그게 거슬리면 같은 API 를 Go 로 다시 쓰면 8MB 안팎에 즉시 실행되는 exe 가 된다
(로직이 200줄 남짓이라 이식 부담이 작다). 지금은 검증된 쪽을 먼저 둔다.
