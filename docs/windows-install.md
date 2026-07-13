# Windows Installation

Job Hunter V1 is packaged for Windows 10/11 x64.

## Install

1. Download `JobHunter-Setup-x64.exe` from GitHub Releases.
2. Run the installer.
3. Launch Job Hunter from the Start Menu or desktop shortcut.

The installer uses per-user locations:

- App files: `%LocalAppData%\Programs\JobHunter`
- User data: `%AppData%\JobHunter\data`
- Logs: `%AppData%\JobHunter\data\logs`
- Chrome profiles: `%AppData%\JobHunter\data\auth`

## Chrome

Chrome is not bundled. Job Hunter looks for Chrome in common Windows locations and also supports `CHROME_PATH`.

## Uninstall

Use Windows Apps settings or the Start Menu uninstall entry. User data may be kept so you can reinstall without losing jobs.

To remove all local data after uninstalling, close Job Hunter and its three Chrome windows, press `Win + R`, enter `%APPDATA%\JobHunter\data`, and delete that folder. Its usual full path is `C:\Users\<your-name>\AppData\Roaming\JobHunter\data`.
