# Testing

A fresh worktree has no `node_modules`: run `bun install` first, or `bun run typecheck` fails with `tsc: command not found`.

Run the whole suite with `bun run test:isolated`. It migrates a template database once on the Postgres server in `DATABASE_URL` (default: the local `weft-postgres` service), then runs the test files on 8 workers that take files from one queue. Each file runs as its own `bun test --concurrent --max-concurrency=4` process on a database of its own, copied from the template and dropped afterwards, so committed rows never leak from one file into the next and no run waits on another's locks. The default run is aimed at about 2 minutes on 12 cores; `bun run test:slow` adds the slow files.

- **Timing-sensitive files** (`timingSensitive` in `scripts/test-isolated.ts`: the Written form converter limits, the schema-only migration and the Daemon black-box test) assert deadlines of a few seconds against real CPU time. They fail when the machine is loaded, so they run after the queue, two at a time. Add a file there when it fails only in the full run and passes alone.
- **Slow files** (`slow` in the same script: five Written form files (fair queue, probation, pool fairness, fuzz, worker) and the backfill) take over four minutes of test time between them and are left out of the default run. `bun run test:slow` runs the whole suite with them; run it after changing the Written form converter, its queue or the backfill.
- **Workers**: `--workers=N` changes the count (default: CPU count minus 4, at most 8). Fewer workers on a busy machine; more than 8 starves the database and trips the 5 s test timeout.
- **Environment**: the script pins `ALLOW_SIGNUP=true` and `ALLOW_WORKSPACE_CREATION=true` for the test process, because Bun loads your `.env` and a closed gate there made tests that create workspaces fail. A test that needs a closed gate passes its own `gates` to `createApp`.
- **Console output** is the failing test names with their file and the pass/fail totals. The full output goes to one log per worker, `$TMPDIR/weft_test_<worktree>_<id>_<worker>.log`. `--verbose` streams a single-file run instead.
- **One file or name filter**: pass bun test arguments through, for example `bun run test:isolated packages/actions/test/modules.test.ts`; that runs one process on one database.
- **Keep the database** for debugging with `--keep`; the script prints the `DATABASE_URL` to reuse, and you drop it yourself (no `psql` is needed): `bun -e 'import { SQL } from "bun"; const a = new SQL("postgres://weft:weft@localhost:54329/postgres"); await a.unsafe("drop database <name> with (force)"); await a.close()'`.
- **Never run `bun test` against the default shared `weft` database**: it is the development database, often behind on migrations, and parallel runs there fail each other with false failures.
- **Connection limit**: the server allows 100 connections for every run on the machine. Many parallel runs can hit `too many clients already`; rerun once the others finish, or run with `--workers=4`.

## Typecheck

`bun run typecheck`.

## Browser flows

`bun run e2e` (`bun e2e/run-all.ts [name-filter]`) runs the `e2e/*.e2e.ts` flows on 6 workers. The runner migrates a template database once; every flow gets a database copied from it and a pair of ports of its worker's own (`E2E_PORT_BASE`, default 33100; the web port is 20000 above the API port), so flows never share rows or ports. Set `CHROMIUM_PATH` to an installed Chromium (for example `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`) when Playwright's own download is missing. The whole run takes about 4 minutes on 12 cores.

- **A flow that fails is run once more** on the same workers. The run passes if the second attempt passes, and the report lists "passed only on the second run" so a flaky flow is visible. Fix such a flow by waiting for the condition it needs (a response, a visible state), never with a sleep.
- **Slow flows** (`slowFlows` in `e2e/run-all.ts`: `editor-parity`, `responsive`) are one long sequence each and set the length of the whole run, so the default run leaves them out. `bun run e2e:slow` adds them; run it after changing the editor or the layout of many screens. A name filter that names one of them runs it.
- **Flows must not share files.** Do not write `apps/web/dist` (`vite build`) from a flow: flows run side by side and would overwrite each other. Serve the web app with the dev server (`bunx vite --port ... --strictPort` with `VITE_API_URL`), or build into a folder of your own (`--outDir`) when the flow needs the built service worker.
- **New projects start in the Simple shape** (Cycles, Modules and Intake off) when made through the web form. A flow that needs them picks "Full" (`translate("projects.shapeFull")`) before it creates the project; the API's `create_project` defaults to Full.
- Flows read `DATABASE_URL` and the ports from the environment, so a single flow also runs on its own: `E2E_API_PORT=... E2E_WEB_PORT=... DATABASE_URL=<a database made with test-isolated --keep> bun e2e/<name>.e2e.ts`. `ai.e2e.ts` needs `OPENAI_API_KEY`. `attachments.e2e.ts` uploads to S3 storage and needs a MinIO-compatible server on `localhost:9000` with the `weft-assets` bucket and the default `weft` / `weft-secret` keys: `docker compose up -d minio` (see `compose.yaml`).
