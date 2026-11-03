# Testing

A fresh worktree has no `node_modules`: run `bun install` first, or `bun run typecheck` fails with `tsc: command not found`.

Run the whole suite with `bun run test:isolated`. It creates a database of its own on the Postgres server in `DATABASE_URL` (default: the local `weft-postgres` service), applies the migrations, runs `bun test --concurrent`, and drops the database afterwards. Every worktree, worker and CI job therefore gets its own schema and rows, and no run waits on another's locks.

- **Console output** is the failing test names (at most 20) and the pass/fail totals. The full log goes to `$TMPDIR/<database>.log`; `--verbose` streams it instead.
- **One file or name filter**: pass bun test arguments through, for example `bun run test:isolated packages/actions/test/modules.test.ts`.
- **Keep the database** for debugging with `--keep`; the script prints the `DATABASE_URL` to reuse, and you drop it yourself (no `psql` is needed): `bun -e 'import { SQL } from "bun"; const a = new SQL("postgres://weft:weft@localhost:54329/postgres"); await a.unsafe("drop database <name> with (force)"); await a.close()'`.
- **Never run `bun test` against the default shared `weft` database**: it is the development database, often behind on migrations, and parallel runs there fail each other with false failures.
- **Connection limit**: the server allows 100 connections for every run on the machine. Many parallel runs can hit `too many clients already`; rerun once the others finish, or add `--max-concurrency=2` to the arguments.

## Typecheck

`bun run typecheck`.

## Browser flows

`bun e2e/run-all.ts <name-filter>` runs the `e2e/*.e2e.ts` flows whose file name contains the filter (a plain substring, not a regex). Set `E2E_API_PORT` and `E2E_WEB_PORT` to free ports, and `CHROMIUM_PATH` to an installed Chromium (for example `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`) when Playwright's own download is missing. The flows start their own API and web servers and read `DATABASE_URL`, so point them at a database made with `--keep`. `ai.e2e.ts` needs `OPENAI_API_KEY`. `attachments.e2e.ts` uploads to S3 storage and needs a MinIO-compatible server on `localhost:9000` with the `weft-assets` bucket and the default `weft` / `weft-secret` keys: `docker compose up -d minio` (see `compose.yaml`).
