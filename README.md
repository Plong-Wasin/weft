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

## Self-hosting with docker compose

```sh
cp .env.example .env   # set the three secrets (openssl rand -hex 32), then URLs and AI settings
docker compose up -d --build
```

`BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD` and `S3_SECRET_KEY` have no usable default: the `api`, `worker` and `migrate` services run with `NODE_ENV=production` and exit with a message naming the variable while one of them is unset or still a placeholder. Postgres and the MinIO console only listen on `127.0.0.1`. Use hex or other URL-safe characters in `POSTGRES_PASSWORD` (it is placed inside `DATABASE_URL`), and note that a Postgres volume created earlier with the old default password keeps that password: run `docker compose down -v` for a trial instance or change the password inside the database.

One command starts Postgres, MinIO (`pgsty/silo`, bucket created on start), a one-shot `migrate` service, the `api`, the `worker`, and the `web` app. `api` and `worker` wait for `migrate` to finish, so migrations run on every start. Open `WEB_ORIGIN` (default `http://localhost:8080`), sign up, and create the first workspace; that works from an empty volume. `docker compose down -v` removes all data.

The browser talks to the API and to MinIO directly, so `API_PUBLIC_URL` (baked into the web bundle at build time) and `S3_PUBLIC_ENDPOINT` must be URLs the browser can reach, and `WEB_ORIGIN` must match the address you open. Rebuild (`--build`) after changing `API_PUBLIC_URL`.

### Environment reference

All variables go in `.env`; defaults are in `.env.example`.

| Area | Variable | Default | Meaning |
| --- | --- | --- | --- |
| Security | `BETTER_AUTH_SECRET` | dev value | Session signing secret, 32+ characters. Change it. |
| Security | `POSTGRES_PASSWORD` | `weft` | Database password. |
| URLs | `WEB_PORT`, `API_PORT` | `8080`, `3000` | Host ports for web and api. |
| URLs | `WEB_ORIGIN` | `http://localhost:8080` | Address of the web app (CORS and trusted origin). |
| URLs | `API_PUBLIC_URL` | `http://localhost:3000` | Address of the API as the browser sees it. |
| Signup | `ALLOW_SIGNUP` | `true` | `false` stops open registration. The first user can always register. |
| Workspaces | `ALLOW_WORKSPACE_CREATION` | `true` | `false` stops users creating workspaces. The first user can always create one. |
| AI | `AI_PROVIDER` | `openai` | `openai` or `anthropic`. |
| AI | `AI_MODEL` | `gpt-6-luna` | Model id for the provider. |
| AI | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | empty | Key for the chosen provider. |
| AI | `AI_REQUESTS_PER_MINUTE` | `20` | Per-user AI request limit; over the limit the API returns 429 `rate_limited`. |
| Storage | `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | MinIO address as the browser sees it. |
| Storage | `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `weft`, `weft-secret` | MinIO root credentials, also used by the API. Change the secret. |
| Storage | `S3_BUCKET`, `S3_REGION` | `weft-assets`, `us-east-1` | Bucket (created on start) and region. |
| Limits | `ASSET_MAX_BYTES` | `5242880` | Maximum upload size (5 MB). |
| Ports | `POSTGRES_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT` | `54329`, `9000`, `9001` | Host ports of the bundled services. |

## Tests

Apply migrations once, then run:

```sh
bun test
```

Bun runs tests concurrently. Database tests use the shared real Postgres service, create data through factories inside transactions, and roll each transaction back so test data cannot leak.

## Assets (uploads)

Files live in S3-compatible storage (`docker compose up minio` starts a MinIO-compatible server with the `weft-assets` bucket). The client calls `request_asset_upload`, POSTs the file to the returned presigned form, then calls `complete_asset_upload`. Settings: `ASSET_MAX_BYTES` (default 5 MB), `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` (what browsers reach, defaults to `S3_ENDPOINT`), `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`. Only png, jpeg, gif and webp are shown inline; every other type, SVG and HTML included, is served as an attachment.

## Browser end-to-end flow

`bun run e2e` starts the API and web dev server, drives Chromium through sign-up, work item creation, a kanban drag, and URL-backed filters, then removes its rows. Set `CHROMIUM_PATH` to a Chromium binary if Playwright's own download is not installed.

## AI chat

Set `AI_PROVIDER` (`openai` or `anthropic`, default `openai`) and `AI_MODEL` (default `gpt-6-luna`), plus `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. The chat page is at `/<workspace-slug>/ai`. The AI runs Read actions immediately and proposes Write actions as Confirmation cards; everything runs with the signed-in user's permissions.
