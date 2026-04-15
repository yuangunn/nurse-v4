; ═══════════════════════════════════════════════════════════════
;  NurseScheduler v4 - Inno Setup Script
;  빌드: ISCC setup.iss  (또는 build.bat 자동 실행)
;  사전: PyInstaller로 ..\dist\NurseScheduler\ 생성 필요
; ═══════════════════════════════════════════════════════════════

#define AppName "NurseScheduler"
#define AppVersion "4.0"
#define AppPublisher "Hospital Nursing Team"
#define AppExeName "NurseScheduler.exe"

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
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName} v{#AppVersion}
UninstallDisplayIcon={app}\{#AppExeName}

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕화면 바로가기 만들기"; GroupDescription: "추가 옵션:"; Flags: checkedonce
Name: "startmenuicon"; Description: "시작 메뉴 바로가기 만들기"; GroupDescription: "추가 옵션:"; Flags: checkedonce

[Files]
Source: "..\dist\NurseScheduler\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\{#AppName} 제거"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon
Name: "{userstartmenu}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: startmenuicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{#AppName} 실행"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 사용자 데이터(%AppData%\NurseScheduler\)는 보존 — 언인스톨 후에도 DB/프로필 유지
Type: filesandordirs; Name: "{app}"

[Code]
procedure InitializeWizard;
begin
  WizardForm.Caption := '{#AppName} v{#AppVersion} 설치';
end;
