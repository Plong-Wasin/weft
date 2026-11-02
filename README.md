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

If legacy `wiki_page_projects` links exist, `db:migrate` refuses to run until you first review `bun run db:migrate:wiki-pages -- --dry-run`, then run `bun run db:migrate:wiki-pages -- --apply` to migrate those links.

The Postgres service is the single shared development and test database (`weft-postgres`, port `54329`). By default the API and test harness connect with `postgres://weft:weft@localhost:54329/weft`; set `DATABASE_URL` to override it.

Run the API, live server, and web shell in separate terminals:

```sh
bun run dev:api
bun run dev:live
bun run dev:web
```

The web app calls the API's registered Actions. Set `VITE_API_URL` if the API is not at `http://localhost:3000`, and `VITE_LIVE_URL` if the live WebSocket is not at `ws://localhost:3002`.

## Self-hosting with docker compose

```sh
cp .env.example .env   # set the three secrets (openssl rand -hex 32), then URLs and AI settings
docker compose up -d --build
```

`BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD` and `S3_SECRET_KEY` have no usable default: the `api`, `worker` and `migrate` services run with `NODE_ENV=production` and exit with a message naming the variable while one of them is unset or still a placeholder. Postgres and the MinIO console only listen on `127.0.0.1`. Use hex or other URL-safe characters in `POSTGRES_PASSWORD` (it is placed inside `DATABASE_URL`), and note that a Postgres volume created earlier with the old default password keeps that password: run `docker compose down -v` for a trial instance or change the password inside the database.

One command starts Postgres, MinIO (`pgsty/silo`, bucket created on start), a one-shot `migrate` service, the `api`, the Yjs `live` server, the `worker`, and the `web` app. `api` and `worker` wait for `migrate` to finish, so migrations run on every start. Open `WEB_ORIGIN` (default `http://localhost:8080`), sign up, and create the first workspace; that works from an empty volume. `docker compose down -v` removes all data.

The browser talks to the API, the live WebSocket, and MinIO directly, so `API_PUBLIC_URL` (baked into the web bundle at build time) and `S3_PUBLIC_ENDPOINT` must be URLs the browser can reach, and `WEB_ORIGIN` must match the address you open. Rebuild (`--build`) after changing `API_PUBLIC_URL`.

#### Single-origin deployment with Caddy

To serve the web app, API, MCP and assets on one root domain, set `WEFT_PUBLIC_URL` to the public origin and `SITE_ADDRESS` to its hostname in `.env`, then start both compose files:

```sh
# .env
WEFT_PUBLIC_URL=https://weft.example.com
SITE_ADDRESS=weft.example.com

docker compose -f compose.yaml -f compose.proxy.yaml up -d --build
```

Caddy obtains and renews HTTPS certificates automatically for public domains. Both variables are required; compose refuses to start without them. For a local trial, use `WEFT_PUBLIC_URL=https://localhost` and `SITE_ADDRESS=localhost`; the local certificate is not publicly trusted. The override needs Docker Compose 2.24.4 or newer and publishes only Caddy (80/443) to the network; the loopback-only Postgres and MinIO console ports stay. It sets `TRUSTED_PROXY_HOPS=1` for Caddy directly exposed to clients; behind another proxy or a CDN, raise it to match the number of hops. The proxy override leaves the plain `docker compose up` deployment unchanged, but the reserved workspace slugs (`api`, `actions`, `mcp`, `live`, `published`, `p` and the bucket name) are rejected in every deployment shape. Only root-domain hosting is supported: path prefixes such as `https://example.com/weft/` are not supported. Existing workspace slugs that collide with reserved paths or the configured asset bucket are not renamed automatically; check the collision query in [ADR 0006](docs/adr/0006-single-origin-deployment-behind-caddy.md) before enabling the proxy.

Run the end-to-end proxy smoke with `scripts/smoke-proxy.sh`. It starts an isolated stack with both compose files, exercises login, an Action, SSE, an asset upload/download and MCP metadata through the public proxy, then removes its containers and volumes. Browser checks remain manual: verify OAuth navigation with an installed PWA, paste an image into the editor, and complete OAuth authorize/consent in a browser.

### Environment reference

All variables go in `.env`; defaults are in `.env.example`.

| Area | Variable | Default | Meaning |
| --- | --- | --- | --- |
| Security | `BETTER_AUTH_SECRET` | dev value | Session signing secret, 32+ characters. Change it. |
| Security | `POSTGRES_PASSWORD` | `weft` | Database password. |
| URLs | `WEB_PORT`, `API_PORT` | `8080`, `3000` | Host ports for web and api. |
| URLs | `WEB_ORIGIN` | `http://localhost:8080` | Address of the web app (CORS and trusted origin). |
| URLs | `API_PUBLIC_URL` | `http://localhost:3000` | Address of the API as the browser sees it. |
| Single-origin proxy | `WEFT_PUBLIC_URL` | unset | Public root origin. Required with `compose.proxy.yaml` (compose refuses to start without it); derives auth, web and asset URLs. Leave unset for the default multi-port stack. |
| Single-origin proxy | `SITE_ADDRESS` | unset | Hostname served by Caddy. Required with `compose.proxy.yaml`. Public domains receive automatic HTTPS certificates. Root-domain only; path prefixes are unsupported. |
| Signup | `ALLOW_SIGNUP` | `true` | `false` stops open registration. The first user can always register. |
| Workspaces | `ALLOW_WORKSPACE_CREATION` | `true` | `false` stops users creating workspaces. The first user can always create one. |
| AI | `AI_PROVIDER` | `openai` | `openai` or `anthropic`. |
| AI | `AI_MODEL` | `gpt-6-luna` | Model id for the provider. |
| AI | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | empty | Key for the chosen provider. |
| AI | `AI_WEB_SEARCH` | `on` | `off` removes the chat's Web search switch. Web search uses the model provider's own search tool, so it exists only for `openai` and `anthropic`, and each chat starts with it off. |
| AI | `AI_REQUESTS_PER_MINUTE` | `20` | Per-user AI request limit; over the limit the API returns 429 `rate_limited`. |
| Storage | `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | MinIO address as the browser sees it. |
| Storage | `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `weft`, `weft-secret` | MinIO root credentials, also used by the API. Change the secret. |
| Storage | `S3_BUCKET`, `S3_REGION` | `weft-assets`, `us-east-1` | Bucket (created on start) and region. |
| Limits | `ASSET_MAX_BYTES` | `5242880` | Maximum upload size (5 MB). |
| Ports | `POSTGRES_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT` | `54329`, `9000`, `9001` | Host ports of the bundled services. |

## Planning structure and query (phase 2)

- **Cycles**: time-boxed periods per project (name, start and end date). Status (upcoming, active, completed) is computed from the dates. A work item is in at most one Cycle; unfinished items of a finished Cycle move on with `transfer_cycle_items`; only a completed Cycle can be archived. Overlapping dates give a warning, not an error.
- **Modules**: topics per project (status, lead, members, optional dates). A work item can be in many Modules.
- **Intake**: `submit_intake_item` puts a work item into the project's Intake, in the hidden `Triage` state. It stays out of lists, boards, search, Cycles, and Modules until a project Admin or Member accepts it; reject, snooze, and duplicate keep it hidden. The submitter is notified of the decision.
- **Relations**: `blocks` / `blocked_by`, `duplicate`, and `relates_to` between two work items of one project; both items record the change in Activity.
- **Replies**: a comment can have replies one level deep; the parent's author is notified. A comment has a copyable link, and the work item shows comments and Activity in one filterable timeline.
- **Query language (PQL)**: `list_work_items` takes `query`; `search_work_items` takes `pql` plus `projectId` (its `query` is free text). The Cycle and Module pages take a query too. Syntax, fields, and examples are in `docs/mcp.md`.
- **Toggles**: Cycles, Modules, and Intake are per-project settings (`set_project_features`, project Admin), on by default. Turning one off hides its menu and refuses its Actions; the data is kept. There is no new environment variable.
- **AI, CLI, MCP**: every phase 2 Action is in the registry, so the CLI (`weft --help` lists the commands) and MCP expose all of them. The AI chat sees all of them except `list_comment_versions`; its Write tools only propose a Confirmation card. See `docs/mcp.md` and `docs/ai-eval.md`.

## Tests

Apply migrations once, then run:

```sh
bun test
```

Bun runs tests concurrently. Database tests use the shared real Postgres service, create data through factories inside transactions, and roll each transaction back so test data cannot leak.

## Assets (uploads)

Files live in S3-compatible storage (`docker compose up minio` starts a MinIO-compatible server with the `weft-assets` bucket). The client calls `request_asset_upload`, POSTs the file to the returned presigned form, then calls `complete_asset_upload`. Settings: `ASSET_MAX_BYTES` (default 5 MB), `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` (what browsers reach, defaults to `S3_ENDPOINT`), `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`. Only png, jpeg, gif and webp are shown inline; every other type, SVG and HTML included, is served as an attachment.

## Web UI

The web app reproduces Plane's visible design in Weft's own components (ADR-0003): app rail, contextual sidebar and top bar, light and dark themes, Plane's URL shapes, and the list, board, and spreadsheet Layouts with Views, Cycles, Modules, Intake, Wiki, Pages, AI (page and sidecar), and settings screens. Tailwind v4 consumes the design tokens in `apps/web/src/tokens.css`; React Router owns the routes (`apps/web/src/routes.ts` lists every URL); every label goes through the locale system in English and Thai. Below 768px the rail and sidebar collapse into a drawer, peek panels fill the screen, and wide tables scroll sideways inside their own container.

## Browser end-to-end flows

`bun run e2e` runs every `e2e/*.e2e.ts` flow in turn (`bun e2e/run-all.ts [name-filter]` runs a subset; `bun e2e/<name>.e2e.ts` runs one). Each flow starts its own API and web dev server (`E2E_API_PORT`, `E2E_WEB_PORT`) against `DATABASE_URL`. Set `CHROMIUM_PATH` to a Chromium binary if Playwright's own download is not installed. `e2e/responsive.e2e.ts` opens every screen in `tools/visual/routes.json` at 1440px and 390px and fails on a page error or sideways page scroll.

## Visual review against Plane

`tools/visual/` captures Plane and Weft at 1440px and 390px and writes a side-by-side page (`bun run visual:plane`, `bun run visual:weft`, `bun run visual:review`; see `tools/visual/README.md`). Screenshots and goldens stay out of git, in `.local/visual/` of the main checkout. Approve a screen by updating the goldens (`bun tools/visual/cli.ts weft --update-goldens`); `bun run visual:compare` then fails on drift.

## AI chat

Set `AI_PROVIDER` (`openai` or `anthropic`, default `openai`) and `AI_MODEL` (default `gpt-6-luna`), plus `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. The chat page is at `/<workspace-slug>/ai`. The AI runs Read actions immediately and proposes Write actions (work items, wiki pages, Cycles, Modules, Intake, Relations, comment replies, project feature toggles) as Confirmation cards; everything runs with the signed-in user's permissions.
