# Release Checklist

Before publishing:

1. `npm install`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`
5. `npm run scan:sensitive`
6. `npm run package:windows`

Check the installer contents:

- No `.env`
- No SQLite database
- No resume
- No logs
- No Chrome profile
- No diagnostics
- No local user path

The public repository must be initialized from a clean directory and must not copy private `.git` history.
