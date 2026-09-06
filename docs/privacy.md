# Privacy

Job Hunter is local-first.

- Settings, profile, database, resume, logs, and Chrome profiles are stored locally.
- The local web server binds to `127.0.0.1:17321` by default and validates the socket address, Host, Origin, `Sec-Fetch-Site`, and a private write-request marker.
- Cookies remain inside Chrome user-data directories.
- The app does not upload your job database.
- The app does not run scheduled background crawls.
- Platform crawling only starts after a manual user action.
- When an LLM API is configured, job matching and greeting generation send your resume and the relevant job description to that API. Without an API, resume matching remains local.
- The public build saves generated greetings as drafts and never sends them automatically.
- Greeting drafts are rejected when privacy scanning finds contact, identity, banking, or URL data, or when the scanner fails.
- On macOS/Linux, private directories use mode `0700` and private files use `0600`.
- API responses do not reveal raw local file paths or model keys.

Do not publish files from `%AppData%\JobHunter\data`, `~/Library/Application Support/JobHunter/data`, or local `data/`.
