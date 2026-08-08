@echo off
rem ── 어싸인 배정표 도우미 exe 빌드 (Windows 에서 실행) ─────────────────────
rem   결과물: dist\어싸인배정표.exe  (단일 파일, assign.html 을 안에 품고 있음)
rem   실행 전:  py -m pip install pyinstaller
rem
rem   assign.html 을 exe 안에 넣지만, exe 옆에 assign.html 이 따로 있으면
rem   그쪽을 먼저 읽는다 — 화면만 고쳤을 땐 재빌드 없이 html 만 갈아끼우면 된다.
setlocal
cd /d "%~dp0"

if not exist "..\assign.html" (
  echo [!] ..\assign.html 이 없습니다. 먼저  node scripts\build-assign-standalone.mjs  를 실행하세요.
  exit /b 1
)

py -m PyInstaller --noconfirm --clean --onefile --noconsole ^
  --name "어싸인배정표" ^
  --icon "..\..\build\icon.ico" ^
  --add-data "..\assign.html;." ^
  --exclude-module tkinter --exclude-module unittest --exclude-module pydoc ^
  --exclude-module email --exclude-module xml --exclude-module lib2to3 ^
  assign_server.py
if errorlevel 1 (echo [!] 빌드 실패 & exit /b 1)

echo.
echo  완료:  %~dp0dist\어싸인배정표.exe
echo.
echo  배포할 때 같이 넣을 것 (선택):
echo    · assign.ini      데이터 파일 경로 지정 (없으면 exe 옆 assign-data.json)
echo    · assign-data.json  기존 데이터가 있다면
echo.
endlocal
