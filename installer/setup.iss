; Inno Setup Script - NurseScheduler v2
; 빌드 전 PyInstaller로 dist\NurseScheduler\ 폴더를 먼저 생성해야 합니다.

#define AppName "NurseScheduler"
#define AppVersion "2.0"
#define AppPublisher "Hospital Nursing Team"
#define AppExeName "NurseScheduler.exe"

[Setup]
AppId={{F3C2A1B4-7D8E-4F6A-B3C2-A1D8E4F6A3B2}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
OutputDir=..\dist\installer
OutputBaseFilename=NurseScheduler_Setup_v{#AppVersion}
SetupIconFile=
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Tasks]
Name: "desktopicon"; Description: "바탕화면 바로가기 만들기"; GroupDescription: "추가 옵션:"; Flags: unchecked
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
; 사용자 데이터는 삭제하지 않음 (%AppData%\NurseScheduler)
Type: filesandordirs; Name: "{app}"

[Code]
procedure InitializeWizard;
begin
  WizardForm.Caption := 'NurseScheduler v2 설치';
end;
