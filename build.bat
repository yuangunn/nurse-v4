@echo off
REM ═══════════════════════════════════════════════════════════════
REM  NurseScheduler v4 - 원클릭 빌드 (Electron 데스크톱 앱)
REM  사용법: build.bat
REM  결과:
REM    dist\electron\NurseScheduler-win32-x64\       (Electron 번들)
REM    dist\NurseScheduler_v4_portable.zip           (포터블 ZIP)
REM    dist\installer\NurseScheduler_Setup_v4.0.exe  (설치 마법사)
REM ═══════════════════════════════════════════════════════════════

setlocal
chcp 65001 > nul
echo.
echo ════════════════════════════════════════════════
echo  NurseScheduler v4 Electron 빌드 시작
echo ════════════════════════════════════════════════
echo.

REM 1. 이전 빌드 정리 (build\NurseScheduler는 PyInstaller work dir, icon.ico 등 소스는 보존)
echo [1/6] 이전 빌드 정리 중...
if exist build\NurseScheduler rmdir /s /q build\NurseScheduler
if exist dist\NurseScheduler rmdir /s /q dist\NurseScheduler
if exist dist\electron rmdir /s /q dist\electron
if exist dist\installer rmdir /s /q dist\installer
if exist dist\NurseScheduler_v4_portable.zip del /q dist\NurseScheduler_v4_portable.zip
echo       완료

REM 2. Python 의존성 확인
echo [2/6] Python 의존성 확인 중...
py -m pip install -q -r requirements.txt
py -m pip install -q pyinstaller
echo       완료

REM 3. PyInstaller로 Python 서버 번들 생성
echo [3/6] Python 서버 번들 빌드 중... (1~3분)
py -m PyInstaller NurseScheduler.spec --noconfirm --log-level WARN
if errorlevel 1 (
    echo ✗ Python 빌드 실패
    exit /b 1
)
echo       완료: dist\NurseScheduler\

REM 4. Electron 의존성 설치
echo [4/6] Electron 의존성 확인 중...
cd electron
if not exist node_modules (
    call npm install --silent
    if errorlevel 1 (
        echo ✗ npm install 실패
        exit /b 1
    )
)

REM 5. Electron 패키지 빌드
echo [5/6] Electron 앱 패키지 중...
call node_modules\.bin\electron-packager.cmd . NurseScheduler --platform=win32 --arch=x64 --out=..\dist\electron --overwrite --app-version=4.0.0 --app-copyright="Hospital Nursing Team" --icon=..\build\icon.ico --extra-resource=..\dist\NurseScheduler
if errorlevel 1 (
    echo ✗ Electron 패키지 실패
    cd ..
    exit /b 1
)
cd ..
echo       완료: dist\electron\NurseScheduler-win32-x64\

REM 6. 포터블 ZIP + Inno Setup 설치파일
echo [6/6] 배포 산출물 생성 중...
powershell -NoProfile -Command "Compress-Archive -Path 'dist\electron\NurseScheduler-win32-x64\*' -DestinationPath 'dist\NurseScheduler_v4_portable.zip' -Force"
echo       완료: dist\NurseScheduler_v4_portable.zip

set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
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
echo   • dist\electron\NurseScheduler-win32-x64\NurseScheduler.exe  ^(직접 실행^)
echo   • dist\NurseScheduler_v4_portable.zip                         ^(포터블 배포^)
if exist "%ISCC%" echo   • dist\installer\NurseScheduler_Setup_v4.0.exe               ^(설치 마법사^)
echo.
endlocal
