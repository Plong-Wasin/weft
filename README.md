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

## Assets (uploads)

Files live in S3-compatible storage (`docker compose up minio` starts a MinIO-compatible server with the `weft-assets` bucket). The client calls `request_asset_upload`, POSTs the file to the returned presigned form, then calls `complete_asset_upload`. Settings: `ASSET_MAX_BYTES` (default 5 MB), `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` (what browsers reach, defaults to `S3_ENDPOINT`), `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`. Only png, jpeg, gif and webp are shown inline; every other type, SVG and HTML included, is served as an attachment.
