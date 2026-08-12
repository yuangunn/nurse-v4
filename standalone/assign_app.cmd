@echo off
rem ── 어싸인 자동 배정 — GUI 프로그램처럼 실행 (주소창 없는 독립 창) ──
rem 같은 폴더의 .html 을 Edge/Chrome 앱 모드로 연다. 설치·인터넷 불필요.
rem 파일 이름은 찾아서 쓴다 — 병동에서 이름을 바꿔 둬도(예: 어싸인 자동배정.html) 그대로 열린다.
rem
rem 전용 프로필(--user-data-dir)을 쓰는 이유:
rem   병원 PC는 브라우저를 닫을 때 사이트 데이터를 지우도록 설정된 경우가 많다.
rem   그러면 '저장 연결'해 둔 파일 기억이 매번 지워져 다시 골라야 한다.
rem   전용 프로필을 내 PC 계정 폴더에 두면 그 기억이 남는다 (NAS 아님 —
rem   NAS에 두면 여러 PC가 동시에 열 때 프로필이 잠겨 안 열린다).
set "PAGE="
for %%F in ("%~dp0*.html") do if not defined PAGE set "PAGE=%%~nxF"
if not defined PAGE (
  echo 이 폴더에 배정표 .html 파일이 없습니다.
  pause & exit /b 1)
set "URL=file:///%~dp0%PAGE%"
set "PROF=%LOCALAPPDATA%\NurseAssign\browser"
rem --app 은 호출할 때마다 따로 따옴표로 감싼다 — 파일 이름에 띄어쓰기가 있어도 깨지지 않게
set "OPT=--user-data-dir=%PROF% --no-first-run --no-default-browser-check"

where msedge >nul 2>nul && (start "" msedge --app="%URL%" %OPT% & exit /b)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="%URL%" %OPT% & exit /b)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app="%URL%" %OPT% & exit /b)
rem 전용 프로필 실행이 막혀 있으면 그냥 기본 브라우저로 (자동 열림은 그대로 동작)
start "" "%URL%"
