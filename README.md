# Weft

Weft is a self-hosted project management tool with a shared Action surface for its web UI, AI chat, CLI, and MCP clients.

## Requirements

- Bun 1.4+
- Docker with Compose

## First run

```sh
bun install
docker compose up -d postgres
bun run db:migrate
```

The Postgres service is the single shared development and test database (`weft-postgres`, port `54329`). By default the API and test harness connect with `postgres://weft:weft@localhost:54329/weft`; set `DATABASE_URL` to override it.

Run the API and web shell in separate terminals:

```sh
bun run dev:api
bun run dev:web
```

The web shell uses the generated Eden Treaty client and calls the registered `hello` Action at the API. Set `VITE_API_URL` if the API is not at `http://localhost:3000`.

## Tests

Apply migrations once, then run:

```sh
bun test
```

Bun runs tests concurrently. Database tests use the shared real Postgres service, create data through factories inside transactions, and roll each transaction back so test data cannot leak.

## Browser end-to-end flow

`bun run e2e` starts the API and web dev server, drives Chromium through sign-up, work item creation, a kanban drag, and URL-backed filters, then removes its rows. Set `CHROMIUM_PATH` to a Chromium binary if Playwright's own download is not installed.

## AI chat

Set `AI_PROVIDER` (`openai` or `anthropic`, default `openai`) and `AI_MODEL` (default `gpt-6-luna`), plus `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. The chat page is at `/<workspace-slug>/ai`. The AI only runs Read actions with the signed-in user's permissions.
