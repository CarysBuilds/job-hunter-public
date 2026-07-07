# Contributing

Thanks for helping improve Job Hunter.

Before opening a pull request:

1. Run `npm run typecheck`.
2. Run `npm test`.
3. Run `npm run build`.
4. Run `npm run scan:sensitive`.

Do not commit private data, platform cookies, resumes, local databases, logs, or installer staging output.

Platform adapters should stay conservative: user login, manual trigger, clear error messages, and no automatic messaging.
