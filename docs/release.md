# Friend Windows Build

Use Node 24.x. This branch builds only the friend edition and does not update the public release.

1. `npm ci --ignore-scripts`
2. `npx --no-install playwright install chromium`
3. `npm run check`
4. On Windows, run `npm run package:windows` and build `packaging/windows/JobHunter.iss` with Inno Setup.
5. `npm run scan:sensitive -- --include-build`
6. `npm run smoke:windows`

The workflow uploads one installer, `JobHunter-Friend-Setup-x64.exe`, as an Actions artifact. It does not publish a Release.

The installer contains only app code, documentation, production dependencies, its launcher and Node runtime. Do not include local settings, resumes, databases, templates, Chrome profiles, logs or diagnostics.
