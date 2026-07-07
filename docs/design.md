# Design

Job Hunter has four local subsystems:

- Web UI and API: Express serves the local interface.
- Crawlers: platform adapters use a user-controlled Chrome profile and CDP.
- Scoring: rules plus optional LLM semantic extraction score jobs against the configured profile.
- Store: SQLite persists jobs, lifecycle state, company profiles, and contact status.

The public version keeps automation conservative:

- no scheduled crawling
- no exported cookies
- no automatic greeting send
- generated greetings are saved as `drafted`

User-specific scoring inputs live in `profile/profile.json`, not in source code.
