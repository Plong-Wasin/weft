## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/` (gitignored). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Testing

Tests, typecheck and browser flows run through `bun run test:isolated`, not bare `bun test`. See `docs/agents/testing.md`.
