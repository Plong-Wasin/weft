# Testing

A fresh worktree has no `node_modules`: run `bun install` first, or `bun run typecheck` fails with `tsc: command not found`.

Run the whole suite with `bun run test:isolated`. It migrates a template database once on the Postgres server in `DATABASE_URL` (default: the local `weft-postgres` service), then runs the test files on 8 workers that take files from one queue. Each file runs as its own `bun test --concurrent --max-concurrency=4` process on a database of its own, copied from the template and dropped afterwards, so committed rows never leak from one file into the next and no run waits on another's locks. The default run is aimed at about 2 minutes on 12 cores; `bun run test:slow` adds the slow files.

- **Timing-sensitive files** (`timingSensitive` in `scripts/test-isolated.ts`: the Written form converter limits, the schema-only migration and the Daemon black-box test) assert deadlines of a few seconds against real CPU time. They fail when the machine is loaded, so they run after the queue, two at a time (one at a time with `--workers=2` or fewer, as on a two-core CI runner). Add a file there when it fails only in the full run and passes alone.
- **Slow files** (`slow` in the same script: five Written form files (fair queue, probation, pool fairness, fuzz, worker) and the backfill) take over four minutes of test time between them and are left out of the default run. `bun run test:slow` runs the whole suite with them; run it after changing the Written form converter, its queue or the backfill.
- **CI-like run**: `bun run test:ci-like` pins the run to two cores with two workers, which is what the GitHub runner has. Run it before pushing a change that touches the daemon, runs, the Written form converter or any test with a deadline: a race that never shows on a 12-core machine fails there. It needs `taskset` (Linux).
- **Workers**: `--workers=N` changes the count (default: CPU count minus 4, at most 8). Fewer workers on a busy machine; more than 8 starves the database and trips the 5 s test timeout.
- **Environment**: the script pins `ALLOW_SIGNUP=true` and `ALLOW_WORKSPACE_CREATION=true` for the test process, because Bun loads your `.env` and a closed gate there made tests that create workspaces fail. A test that needs a closed gate passes its own `gates` to `createApp`.
- **Console output** is the failing test names with their file and the pass/fail totals. The full output goes to one log per worker, `$TMPDIR/weft_test_<worktree>_<id>_<worker>.log`. In GitHub Actions, a failing test also prints the last 80 lines (up to 12,000 characters) from that test file in a grouped log section; credentialed PostgreSQL URLs are redacted, and no log artifacts are uploaded. `--verbose` streams a single-file run instead.
- **One file or name filter**: pass bun test arguments through, for example `bun run test:isolated packages/actions/test/modules.test.ts`; that runs one process on one database.
- **Keep the database** for debugging with `--keep`; the script prints the `DATABASE_URL` to reuse, and you drop it yourself (no `psql` is needed): `bun -e 'import { SQL } from "bun"; const a = new SQL("postgres://weft:weft@localhost:54329/postgres"); await a.unsafe("drop database <name> with (force)"); await a.close()'`.
- **Never run `bun test` against the default shared `weft` database**: it is the development database, often behind on migrations, and parallel runs there fail each other with false failures.
- **Connection limit**: Compose starts Postgres with 300 shared connections. On hosts with an existing server, check its limit with `SHOW max_connections`.

## Typecheck

`bun run typecheck`.

## Browser flows

`bun e2e/run-all.ts [name-filter ...]` runs local browser flows. Filters match substrings of the file name. Use `--slow` for the full suite, including `editor-parity` and `responsive`. An exact filter also selects either slow flow.

The runner migrates a database template once and copies it for each flow. The API and live servers start fresh for each flow. Most flows share one web build, copied with each worker's API and live ports. Their browser contexts block service workers so application requests reach the corresponding servers and Playwright routes. `mermaid-diagrams.e2e.ts` builds once with its actual ports and checks that the production service worker takes control. Use `--dev` to run flows against Vite while debugging. Flows that explicitly exercise production output still use a production build.

- **Environment.** `DATABASE_URL` defaults to the local `weft-postgres` service. Set `CHROMIUM_PATH` to an installed Chromium when Playwright's browser download is missing. `attachments.e2e.ts` needs an S3-compatible server on `localhost:9000` with the `weft-assets` bucket and the default `weft` / `weft-secret` keys. See the MinIO service in `compose.yaml`.
- **Ports.** `E2E_PORT_BASE` defaults to a hash of the checkout name. The API port for zero-based worker N is the base plus twice N, the live port is the API port plus 10000, and the web port is the API port plus 20000. The last worker's web port must stay below 65535. A busy port fails the flow and names the listener. Server readiness verifies that the process started by the flow owns the listening socket. For a direct invocation of a flow file, set `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_LIVE_PORT` and point `DATABASE_URL` at an isolated database made with `--keep`.
- **Timeouts and retries.** Each attempt gets ten minutes (`editor-parity` alone takes over five). A timed-out attempt reports the flow name and stops processes with that attempt's inherited ownership marker, including detached Chromium children. If processes remain after SIGTERM, the runner repeats discovery and sends SIGKILL until they exit or cleanup reaches its deadline. Failed attempts get one retry after the first queue completes. Busy ports are reported immediately.
- **Durations.** The runner prints each attempt's duration and records successful production runs in `.local/e2e/durations.json` to schedule the longest flows first. Use `--workers=N` to override the default.

The API fixture in `e2e/harness.ts` creates the account, workspace and optional project for flows that start after onboarding, then reuses the authenticated storage state in Playwright. `auth-onboarding.e2e.ts`, `auth-submit-guard.e2e.ts` and `signup-language.e2e.ts` cover UI sign-up and onboarding. `project-features.e2e.ts` covers project creation and shape. `agents.e2e.ts` creates a project through the UI, checks that public visibility is saved by default and verifies that a Guest can see it in the sidebar. `project-key.e2e.ts` and `project-general.e2e.ts` cover project keys and visibility permissions.

### Coverage after the speed changes

All 116 flow files remain and no test block was removed. These assertions or actions changed:

| Removed or replaced | What still covers it |
| --- | --- |
| `responsive`: Tooltip fixture imported from the Vite dev server (a build has no `/node_modules/.vite`), with its `Help` / `Helpful detail` strings, the exact `2px` outline and `[data-popup-open]` | The same flow tabs to the real sidebar toggle and checks focus, a visible focus indicator, the tooltip text and Escape dismissal |
| `routes`: string equality of color tokens and `.875rem` | The same checks compare the parsed colors and the normalized length |
| `auth-submit-guard`, `sign-in-limits`: their own web build and its exit-code check | `e2e/web-build.ts` throws on a failed build and both flows use the shared build. `mermaid-diagrams` keeps its own unmodified build to exercise service worker activation. |
| UI sign-up, workspace and project creation in flows that start after onboarding (`e2e/harness.ts` now creates them through the API) | `auth-onboarding`, `auth-submit-guard`, `signup-language` (sign-up and onboarding), `agents`, `project-features`, `project-key`, `project-general` (projects and visibility) |
| `reference-picker`: a click into the Wiki editor, now `focus()` | The same flow still types into the editor and checks the picker; `block-menu` and `editor-parity` click into it |
| Fixed sleeps | A condition wait on the same focus, geometry, dialog, URL or stored content. A check that something did not happen keeps its sleep (`kanban`'s replayed move) |

### Local benchmark

Measured on 2026-11-27 with `bun e2e/run-all.ts --slow --workers=2`, Bun 1.4.2, Chromium 1255 and the shared local Postgres and S3 services, on the same host. Each wall time includes setup, all 116 flows, retries, and cleanup.

| Runner | Workers | Wall time | Passed after retry |
| --- | ---: | ---: | ---: |
| Before (`5ff3b923`) | 2 | 22m 59s | 114/116 (`views`, `ai-switch` failed) |
| After | 2 | 15m 08s | 116/116 (`mention-popups` needed the retry) |

The run is 7m 51s (34%) shorter. `editor-parity` takes about 310s of it on one page. A flow can still miss a wait on its first attempt, which the retry absorbs.

## Real Runtime acceptance

`bun scripts/real-runtime-acceptance.ts [--cli claude|codex] [--model <cli model>] [--only 1,2,3,4,5] [--out <dir>] [--keep]` drives the Wake chain through a real agent CLI. It is not part of `bun run test:isolated`: it spends model tokens and needs a ready CLI (`weft daemon probe`) and `CHROMIUM_PATH`. It makes its own database, API server, web server and Daemon (config and session folders under `--out`, default `/tmp/weft-acceptance-09`), runs the five scenarios of the agent-wake-chain acceptance (ping-pong to depth 6, Follow-up Run, resumed Session and a new one after a failed Run, sub-items closed, switch off) plus folder cleanup, saves screenshots of the Runs panel and the timeline at 1440 and 390 px to `<out>/shots`, and writes what it observed to `<out>/log.md`. Its rules also run with a fake CLI in `apps/api/test/runtime-wake-chain.test.ts`, which belongs to the normal suite. The Run's shell finds `weft` in `<out>/bin`, a wrapper for this checkout's CLI: a `weft` on your PATH may belong to another checkout.
