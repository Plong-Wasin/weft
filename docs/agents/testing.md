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
- **Timeouts and retries.** Each attempt gets ten minutes (`editor-parity` alone takes over five). A timed-out attempt reports the flow name and stops the flow's process tree and every process with that attempt's inherited ownership marker, with their descendants. The tree covers Chromium, which overwrites its environment and so loses the marker; the marker covers a process whose parent already exited. `e2e/shutdown.test.ts` checks a frozen Chromium when one is installed. If processes remain after SIGTERM, the runner repeats discovery and sends SIGKILL until they exit or cleanup reaches its deadline. Failed attempts get one retry after the first queue completes. Busy ports are reported immediately.
- **Durations.** The runner prints each attempt's duration and records successful production runs in `.local/e2e/durations.json` to schedule the longest flows first. Use `--workers=N` to override the default.
- **Default workers.** Three when `/proc/meminfo` shows at least 10 GiB of `MemAvailable` at the start of the run, otherwise (or without `/proc/meminfo`) two. `e2e/workers.ts` holds the rule.
- **Screenshots.** Review screenshots are off by default: set `E2E_SHOTS=1` to write them. Screenshots that record a defect are written either way. Take them through `saveShot` in `e2e/shots.ts`, and pass `{ failed: true }` for a defect. The older per-flow variables (`PHONE_LAYOUT_SHOTS`, `AGENT_LABEL_SCREENSHOT`, `E2E_SHOT_DIR` and the like) still turn on their own flow's screenshots without `E2E_SHOTS`. A folder that a flow prints holds its files only when screenshots were written.

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

### Coverage after the second round of speed changes

| Removed or replaced | What still covers it |
| --- | --- |
| `design-entry-work-items`: no page-level horizontal scroll | `layout-stability` for sign-in, home, the work item list and the work item page (page and `main` width); `viewports` for archives and workspace views. Both include 1440 and 390 px. The flow keeps its toolbar-row and clipped-control checks. |
| `viewports`: `rendered-screen` on the 19 screens that `layout-stability` opens (sign-in, home, projects, inbox, the five layouts, peek, work item page, cycles, modules, views, intake, workspace settings, Wiki page, analytics overview, AI) | `layout-stability` waits for data of each screen |
| `viewports`: `no-horizontal-page-scroll` on those screens | `layout-stability`'s page and `main` width checks |
| `viewports`: `top-controls-not-clipped`, `primary-control-visible`, `no-sibling-control-overlap` on those screens | Moved to `e2e/screen-checks.ts`, run by `layout-stability` on each of its screens |
| `layout-stability`: dark mode at 1024, 820, 768, 844 and 667 px wide | Light mode at those sizes and dark mode at 1440 and 390 px |
| `work-item-type-icons`: the click that reopened the peek after a reload | The URL reopens the peek; the same assertion on its type icon follows |

Two things are no longer swept. On those 19 screens the checks below 1440 px now run with touch emulation only (`viewports` also opened them with a mouse at those widths). The AI screen is checked with AI switched on, not off. `viewports` still sweeps the other 15 routes at all seven sizes with a mouse, and keeps the phone list-fit, touch-target, blank-tap and short-height checks.

With a stylesheet that pushed the `main` buttons off screen and overlapped grouped ones, `layout-stability` failed with 426 defects and `viewports` with 93, `top-controls-not-clipped`, `primary-control-visible` and `no-sibling-control-overlap` among them in both.

### Benchmark of the second round

Measured on 2026-11-27 with `bun e2e/run-all.ts --slow --workers=3`, Bun 1.4.2, Chromium 1255, the shared local Postgres and S3 services, on one host with 12 CPUs and 27 GiB, the two runs back to back. Other agent sessions shared the host.

| Runner | Wall time | Flows passed | Load average (mean / peak) | `MemAvailable` (start / lowest) |
| --- | ---: | ---: | ---: | ---: |
| Before (`e53e9bb7`) | 12m 07s | 119/119 | 5.8 / 11.6 | 16498 / 12413 MiB |
| After | 10m 36s | 119/119 (`agent-access` needed the retry) | 6.8 / 15.7 | 16527 / 12648 MiB |

Flow times, before and after: `layout-stability` 125s and 81s, `planning-detail-layout` 83s and 9s, `viewports` 76s and 36s, `planning-phone-layout` 60s and 8s, `design-entry-work-items` 27s and 7s.

Load changes these numbers a lot: an earlier run of the changed suite under a mean load of 13.7 (peak 24.5) took 13m 26s.

**Memory headroom for three workers.** Over four full runs at three workers, `MemAvailable` fell by 3.9 to 6.6 GiB from its starting value (lowest seen: 7929 MiB, from 14519 MiB). The 10 GiB threshold for three workers leaves at least 3 GiB.

### Waits that a flow needs

- **A screen to measure.** `settle(page, ...ready)` from `e2e/settle.ts` waits for something the screen draws from its data, no loading placeholder, `document.fonts.ready` and two animation frames. Do not wait for `networkidle`: the live connection and polling make it run to its timeout.
- **Wiki editor.** It is read-only until its first sync with the live server, and keys sent to it before then are dropped. Playwright's `click` and `focus` do not wait for that, so locate the editor as `.ProseMirror[contenteditable="true"]` before you click or type.

## Where layout is checked

`layout-stability` opens its screens at seven sizes (light everywhere, dark at 1440 and 390 only) and checks layout shift, row heights, still geometry, sideways scroll and the checks in `e2e/screen-checks.ts` (top controls inside the viewport, no overlapping sibling controls, first control of `main` visible). `viewports` runs the same screen checks on the routes of `tools/visual/routes.json` that `layout-stability` does not open, and keeps the touch-target, blank-tap, short-height overlay and phone list-fit checks. A route added to the manifest is swept by `viewports` unless its name is added to `inLayoutStability` there.

## Real Runtime acceptance

`bun scripts/real-runtime-acceptance.ts [--cli claude|codex] [--model <cli model>] [--only 1,2,3,4,5] [--out <dir>] [--keep]` drives the Wake chain through a real agent CLI. It is not part of `bun run test:isolated`: it spends model tokens and needs a ready CLI (`weft daemon probe`) and `CHROMIUM_PATH`. It makes its own database, API server, web server and Daemon (config and session folders under `--out`, default `/tmp/weft-acceptance-09`), runs the five scenarios of the agent-wake-chain acceptance (ping-pong to depth 6, Follow-up Run, resumed Session and a new one after a failed Run, sub-items closed, switch off) plus folder cleanup, saves screenshots of the Runs panel and the timeline at 1440 and 390 px to `<out>/shots`, and writes what it observed to `<out>/log.md`. Its rules also run with a fake CLI in `apps/api/test/runtime-wake-chain.test.ts`, which belongs to the normal suite. The Run's shell finds `weft` in `<out>/bin`, a wrapper for this checkout's CLI: a `weft` on your PATH may belong to another checkout.
