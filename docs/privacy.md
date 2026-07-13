# Privacy

Job Hunter is local-first.

- Settings, profile, database, resume, logs, and Chrome profiles are stored locally.
- The local web server binds to a loopback host by default and rejects non-local Host or write-origin headers.
- Cookies remain inside Chrome user-data directories.
- The app does not upload your job database.
- The app does not run scheduled background crawls.
- Platform crawling only starts after a manual user action.
- When an LLM API is configured, job matching and greeting generation send your resume and the relevant job description to that API. Without an API, resume matching remains local.
- The public build saves generated greetings as drafts and never sends them automatically.

Do not publish files from `%AppData%\JobHunter\data` or local `data/`.
