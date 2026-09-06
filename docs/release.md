# Release Checklist

Before publishing, use Node 24.x and run the same gate used by both release jobs:

1. `npm ci --ignore-scripts`
2. `npm run check`
3. `npm run scan:sensitive`
4. On Windows: `npm run package:windows`, build the Inno Setup installer, run `npm run smoke:windows`, and create its SHA-256 file.
5. On macOS: `npm run package:macos` and `npm run smoke:macos`.
6. `npm run scan:sensitive -- --include-build`

`npm run check` includes the Node version guard, dependency lifecycle and pinned Action guards, source/test type checks, ESLint, coverage, build, high-severity dependency audit, and worker E2E.

Release assets are intentionally platform-specific:

- Windows x64: `JobHunter-Setup-x64.exe`
- Windows SHA-256: `JobHunter-Setup-x64.exe.sha256`
- macOS Universal (Apple Silicon + Intel): `JobHunter-macOS-Universal-v<version>.dmg`
- macOS SHA-256: `JobHunter-macOS-Universal-v<version>.dmg.sha256`

Check the installer contents:

- No `.env`
- No SQLite database
- No resume
- No logs
- No Chrome profile
- No diagnostics
- No local user path

The public repository must be initialized from a clean directory and must not copy private `.git` history.
