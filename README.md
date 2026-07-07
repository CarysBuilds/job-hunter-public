# Job Hunter

Job Hunter is a Windows-first local assistant for job discovery, matching, and application tracking.

It opens official recruiting websites in your own Chrome profile, lets you manually trigger searches, stores results in a local SQLite database, and scores jobs against a profile you configure on first launch.

## Windows Quick Start

1. Download `JobHunter-Setup-x64.exe` from GitHub Releases.
2. Install it without administrator privileges.
3. Open Job Hunter from the Start Menu or desktop shortcut.
4. Complete the setup screen: target roles, city, salary, experience, keywords, and optional LLM API.
5. Click a platform login button, finish login in Chrome, then click a crawl button.

The first public release targets Windows 10/11 x64. macOS development commands still work for contributors, but the packaged user experience is Windows-first.

## Privacy Boundary

- Your database, resume, logs, Chrome profiles, and settings stay on your machine.
- The app does not export cookies.
- Recruiting platforms are accessed only after you manually log in and manually trigger a crawl.
- Greeting text generation sends your configured resume and the selected job description only to the LLM API you configure.
- The public build only generates greeting drafts. It does not automatically send messages.

See [docs/privacy.md](docs/privacy.md) for details.

## Developer Setup

```bash
npm install
npm run typecheck
npm test
npm run build
npm run scan:sensitive
```

Run the local web app:

```bash
npm run mock
npm run dev
```

Open <http://localhost:3000>.

## Packaging

Windows packaging lives in `packaging/windows/` and is assembled with:

```bash
npm run build
npm run scan:sensitive
npm run package:windows
```

On Windows CI, GitHub Actions builds `JobHunter-Setup-x64.exe` and publishes it as a release artifact.

## Platform Support

- BOSS: primary supported path.
- Liepin and Zhaopin: experimental adapters; they use slower default delays and may require manual verification.
- All platform access is manual and local.

## Repository Safety

This public repository is designed to be initialized from a clean directory and must not inherit private Git history. Do not commit:

- `.env`
- SQLite databases
- resumes
- logs
- Chrome profiles
- diagnostics
- installer staging output

Run `npm run scan:sensitive` before committing or creating a release.
