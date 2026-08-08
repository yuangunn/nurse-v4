@echo off
rem ── 어싸인 배정표 단일 exe 빌드 (Windows) ────────────────────────────────
rem   준비:  .NET 8 SDK  (winget install Microsoft.DotNet.SDK.8)
rem   사용:  build.cmd          런타임까지 품은 단일 exe (아무 PC에서나 실행)
rem          build.cmd lite     작은 exe (.NET 8 데스크톱 런타임이 깔린 PC 전용)
setlocal
cd /d "%~dp0"

if not exist "..\assign.html" (
  echo [!] ..\assign.html 이 없습니다. 리포 루트에서  node scripts\build-assign-standalone.mjs  먼저 실행하세요.
  exit /b 1
)

if /i "%~1"=="lite" (
  dotnet publish AssignApp.csproj -c Release -r win-x64 --self-contained false ^
    -p:PublishSingleFile=true -p:DebugType=none -p:AllowedReferenceRelatedFileExtensions=none -o dist
) else (
  dotnet publish AssignApp.csproj -c Release -r win-x64 --self-contained true ^
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true ^
    -p:EnableCompressionInSingleFile=true -p:DebugType=none ^
    -p:AllowedReferenceRelatedFileExtensions=none -o dist
)
if errorlevel 1 (echo [!] 빌드 실패 & exit /b 1)

echo.
echo  완료:  %~dp0dist\어싸인배정표.exe
echo  이 파일 하나만 병동 공용 폴더에 두면 됩니다.
endlocal
