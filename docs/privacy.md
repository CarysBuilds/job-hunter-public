# Privacy

Job Hunter is local-first.

- Settings, profile, database, resume, logs, and Chrome profiles are stored locally.
- Cookies remain inside Chrome user-data directories.
- The app does not upload your job database.
- The app does not run scheduled background crawls.
- Platform crawling only starts after a manual user action.
- Greeting generation sends your resume and selected job description only to the LLM API you configure.
- The public build saves generated greetings as drafts and never sends them automatically.

Do not publish files from `%AppData%\JobHunter\data` or local `data/`.
