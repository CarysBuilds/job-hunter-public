# Design

Job Hunter has four local subsystems:

- Web UI and API: Express serves the local interface.
- Crawlers: platform adapters use a user-controlled Chrome profile and CDP.
- Scoring: rules plus optional LLM semantic extraction score jobs against the configured profile.
- Store: schema 2 SQLite persists jobs, page checkpoints, crawl observations, source health, append-only application events, JD versions, company profiles, and contact-state projections.

The public version keeps automation conservative:

- no scheduled crawling
- no exported cookies
- no automatic greeting send
- generated greetings are saved as `drafted`
- every write API requires the local request marker
- crawl pages commit atomically and retries skip committed pages

User-specific scoring inputs live in `profile/profile.json`, not in source code.
