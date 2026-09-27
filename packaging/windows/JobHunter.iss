#define MyAppName "Job Hunter Friend"
#define MyAppVersion GetEnv("JOB_HUNTER_VERSION")
#if MyAppVersion == ""
#define MyAppVersion "0.1.0"
#endif
#define SourceRoot GetEnv("JOB_HUNTER_STAGE")
#if SourceRoot == ""
#define SourceRoot "..\\..\\staging\\windows"
#endif
#define OutputRoot GetEnv("JOB_HUNTER_OUTPUT")
#if OutputRoot == ""
#define OutputRoot "..\\..\\artifacts\\windows"
#endif

[Setup]
AppId={{9856887E-2D10-4F22-BF66-9D5ED41EF054}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\JobHunterFriend
DefaultGroupName=Job Hunter Friend
OutputDir={#OutputRoot}
OutputBaseFilename=JobHunter-Friend-Setup-x64
Compression=lzma
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
DisableProgramGroupPage=yes

[Files]
Source: "{#SourceRoot}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\launcher\*"; DestDir: "{app}\launcher"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Job Hunter Friend"; Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\launcher\job-hunter-launcher.js"""; WorkingDir: "{app}"
Name: "{userdesktop}\Job Hunter Friend"; Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\launcher\job-hunter-launcher.js"""; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts"; Flags: checkedonce

[Run]
Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\launcher\job-hunter-launcher.js"""; WorkingDir: "{app}"; Description: "Launch Job Hunter"; Flags: nowait postinstall skipifsilent
