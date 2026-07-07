#define MyAppName "Job Hunter"
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
AppId={{A50B4A4D-4C27-49D8-9E58-99D673C64501}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\JobHunter
DefaultGroupName=Job Hunter
OutputDir={#OutputRoot}
OutputBaseFilename=JobHunter-Setup-x64
Compression=lzma
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
DisableProgramGroupPage=yes

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Job Hunter"; Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\launcher\job-hunter-launcher.js"""; WorkingDir: "{app}"
Name: "{commondesktop}\Job Hunter"; Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\launcher\job-hunter-launcher.js"""; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts"; Flags: checkedonce

[Run]
Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\launcher\job-hunter-launcher.js"""; WorkingDir: "{app}"; Description: "Launch Job Hunter"; Flags: nowait postinstall skipifsilent
