; ═══════════════════════════════════════════════════════════════
;  NurseScheduler v4 — Inno Setup Script (Electron 데스크톱 앱)
;  빌드: ISCC setup.iss (또는 build.bat 자동 실행)
;  사전: electron-packager로 ..\dist\electron\NurseScheduler-win32-x64\ 생성
; ═══════════════════════════════════════════════════════════════

#define AppName "NurseScheduler"
#define AppVersion "4.9.0"
#define AppPublisher "Hospital Nursing Team"
#define AppExeName "NurseScheduler.exe"
#define AppSourceDir "..\dist\electron\NurseScheduler-win32-x64"

[Setup]
AppId={{F3C2A1B4-7D8E-4F6A-B3C2-A1D8E4F6A3B2}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} v{#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist\installer
OutputBaseFilename=NurseScheduler_Setup_v{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
; 업데이트 시 실행 중인 앱을 Restart Manager로 정상 종료 (파일 잠김/재부팅 요구 방지)
CloseApplications=yes
RestartApplications=no
UninstallDisplayName={#AppName} v{#AppVersion}
UninstallDisplayIcon={app}\{#AppExeName}
SetupIconFile=..\build\icon.ico

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕화면 바로가기 만들기"; GroupDescription: "추가 옵션:"; Flags: checkedonce
Name: "startmenuicon"; Description: "시작 메뉴 바로가기 만들기"; GroupDescription: "추가 옵션:"; Flags: checkedonce

[Files]
Source: "{#AppSourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\{#AppName} 제거"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon
Name: "{userstartmenu}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: startmenuicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{#AppName} 실행"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 사용자 데이터(%AppData%\NurseScheduler\)는 보존 — 프로필/DB 유지
Type: filesandordirs; Name: "{app}"

[Code]
{ 기존 설치(같은 AppId)의 제거 명령 경로를 레지스트리에서 읽는다. }
function GetUninstallString(): String;
var
  sKey: String;
  sUnInstall: String;
begin
  sKey := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{F3C2A1B4-7D8E-4F6A-B3C2-A1D8E4F6A3B2}_is1';
  sUnInstall := '';
  if not RegQueryStringValue(HKLM, sKey, 'UninstallString', sUnInstall) then
    RegQueryStringValue(HKCU, sKey, 'UninstallString', sUnInstall);
  Result := sUnInstall;
end;

{ 설치 직전: 실행 중인 앱을 강제 종료하고, 이전 버전을 조용히 제거(orphan 정리)한다.
  - Electron 앱과 Python 자식 프로세스 모두 이미지명이 NurseScheduler.exe → /T로 트리까지 종료.
  - 사용자 데이터(%AppData%\NurseScheduler\: 프로필·DB)는 제거 대상이 아님(보존). }
procedure CurStepChanged(CurStep: TSetupStep);
var
  sUnInst: String;
  iResult: Integer;
begin
  if CurStep = ssInstall then
  begin
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM {#AppExeName} /T', '',
         SW_HIDE, ewWaitUntilTerminated, iResult);
    Sleep(800);
    sUnInst := GetUninstallString();
    if sUnInst <> '' then
    begin
      sUnInst := RemoveQuotes(sUnInst);
      Exec(sUnInst, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '',
           SW_HIDE, ewWaitUntilTerminated, iResult);
      Sleep(500);
    end;
  end;
end;

procedure InitializeWizard;
begin
  WizardForm.Caption := '{#AppName} v{#AppVersion} 설치';
end;
