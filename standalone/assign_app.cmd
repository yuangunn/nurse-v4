@echo off
rem ── 어싸인 자동 배정 — GUI 프로그램처럼 실행 (주소창 없는 독립 창) ──
rem 같은 폴더의 assign.html 을 Edge/Chrome 앱 모드로 연다. 설치·인터넷 불필요.
set "URL=file:///%~dp0assign.html"
where msedge >nul 2>nul && (start "" msedge --app="%URL%" & exit /b)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="%URL%" & exit /b)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app="%URL%" & exit /b)
start "" "%URL%"
