# Configuration

Most configuration is available from the web setup screen.

Advanced environment variables can be placed in `.env` during development:

- `PORT`
- `APP_DATA_DIR`
- `LLM_ENABLED`
- `LLM_API_BASE`
- `LLM_API_KEY`
- `LLM_MODEL`
- `CRAWL_KEYWORDS`
- `CRAWL_CITY_CODE`
- `BOSS_CDP_PORT`
- `LIEPIN_CDP_PORT`
- `ZHAOPIN_CDP_PORT`

Runtime files:

- `settings.json`: platform, city, keywords, LLM settings.
- `profile/profile.json`: candidate profile and scoring preferences.
- `profile/resume.md`: resume text used only for greeting draft generation.
