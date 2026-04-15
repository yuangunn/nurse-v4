@echo off
REM ═══════════════════════════════════════════════════════════════
REM  NurseScheduler v4 - 원클릭 빌드 스크립트
REM  사용법: build.bat
REM  결과: dist\NurseScheduler\NurseScheduler.exe
REM        dist\installer\NurseScheduler_Setup_v4.0.exe (ISCC 있을 때)
REM        dist\NurseScheduler_v4_portable.zip
REM ═══════════════════════════════════════════════════════════════

setlocal
chcp 65001 > nul
echo.
echo ════════════════════════════════════════════════
echo  NurseScheduler v4 빌드 시작
echo ════════════════════════════════════════════════
echo.

REM 1. 기존 빌드 정리
echo [1/5] 이전 빌드 정리 중...
if exist build rmdir /s /q build
if exist dist\NurseScheduler rmdir /s /q dist\NurseScheduler
if exist dist\installer rmdir /s /q dist\installer
echo       완료

REM 2. 의존성 확인
echo [2/5] Python 의존성 확인 중...
py -m pip install -q -r requirements.txt
py -m pip install -q pyinstaller
echo       완료

REM 3. PyInstaller 빌드
echo [3/5] PyInstaller 빌드 중... (1~3분 소요)
py -m PyInstaller NurseScheduler.spec --noconfirm --log-level WARN
if errorlevel 1 (
    echo.
    echo ✗ 빌드 실패
    exit /b 1
)
echo       완료: dist\NurseScheduler\NurseScheduler.exe

REM 4. 포터블 ZIP 생성
echo [4/5] 포터블 ZIP 생성 중...
powershell -NoProfile -Command "Compress-Archive -Path 'dist\NurseScheduler\*' -DestinationPath 'dist\NurseScheduler_v4_portable.zip' -Force"
echo       완료: dist\NurseScheduler_v4_portable.zip

REM 5. Inno Setup 설치파일 빌드 (설치되어 있으면)
echo [5/5] Inno Setup 설치파일 빌드 중...
set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"
if exist "%ISCC%" (
    "%ISCC%" installer\setup.iss
    echo       완료: dist\installer\NurseScheduler_Setup_v4.0.exe
) else (
    echo       건너뜀 ^(Inno Setup 미설치 - https://jrsoftware.org/isdl.php^)
)

echo.
echo ════════════════════════════════════════════════
echo  ✓ 빌드 완료
echo ════════════════════════════════════════════════
echo.
echo  결과물:
echo   • dist\NurseScheduler\NurseScheduler.exe  ^(직접 실행^)
echo   • dist\NurseScheduler_v4_portable.zip     ^(포터블 배포용^)
if exist "%ISCC%" echo   • dist\installer\NurseScheduler_Setup_v4.0.exe ^(설치 버전^)
echo.
endlocal
