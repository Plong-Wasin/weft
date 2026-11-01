# Visual reference harness

> UI screenshots (Plane references, Weft captures, goldens, per-ticket review shots) are never committed. They live in `.local/visual/` of the main checkout, shared by every worktree (override with `VISUAL_DIR`). Regenerate Plane and external references with the commands below.

Compares Weft screens with Plane's, at 1440px and 390px, light theme.

## Prerequisites

- `bun install`, and a Chromium for Playwright. Set `CHROMIUM_PATH` to a Chromium binary if Playwright's own download is missing.
- Docker, for Plane. Weft needs `DATABASE_URL` pointing at a migrated Postgres (never a shared stale database).

## Commands

| Command | What it does |
| --- | --- |
| `bun run visual:plane` | Starts Plane if `PLANE_URL` (default `http://localhost:8088`) is down, seeds it, captures `.local/visual/plane/` |
| `bun run visual:weft` | Starts Weft's API and web app, seeds them, captures `.local/visual/weft/` (gitignored) |
| `bun run visual:compare` | Same capture, then compares each shot with `.local/visual/goldens/`; exits 1 past the drift threshold |
| `bun tools/visual/cli.ts weft --update-goldens` | Capture, then replace the goldens (do this only after the user approves the look) |
| `bun tools/visual/cli.ts external` | Downloads the Wiki and AI reference images to `.local/visual/external/`, with `sources.json` holding each source URL |
| `bun run visual:review` | Writes `.local/visual/review.html`: Plane left, Weft right, a missing shot flagged in red |

Options for `weft`: `--routes <file>` (a route list in the format of `routes.json`), `--threshold <ratio>` (default `0.005`, the share of pixels allowed to differ by more than 8 per colour channel).
Environment: `E2E_API_PORT` / `E2E_WEB_PORT` (Weft ports, default 3199 / 5299), `WEFT_API_URL` + `WEFT_WEB_URL` (use servers that already run), `PLANE_URL`, `PLANE_DIR`, `PLANE_EMAIL`, `PLANE_PASSWORD`.

## Plane

`PLANE_DIR` is a folder holding Plane's `docker-compose.yml` and `.env` (the output of Plane's `setup.sh`). It defaults to `~/plane-try`, then the sibling `../plane` checkout. The command only runs `docker compose up -d`; it never stops or removes containers.
The seed signs in (creating the account on first run), finishes onboarding, and creates workspace `weft-ui-reference`, project `REF`, six work items, labels, a cycle, a module, a view, a page and an intake item.

## Route list

`routes.json` lists each screen once with a `plane` and a `weft` path template. Placeholders: `{slug}`, `{projectId}` (Plane), `{key}` (Weft), `{workItem}`, `{cycleId}`, `{moduleId}`, `{viewId}`, `{pageId}`, `{wikiPageId}`. A `null` path, or a placeholder without a value, means that side has no screen yet; the review page flags it. Every screen in scope has a Weft path; `e2e/responsive.e2e.ts` fails when one loses it. `"auth": false` captures signed out.

## Notes

- Weft shots use a fresh account and workspace each run. Relative dates ("3 days ago", cycle dates) can drift between days; the threshold absorbs small drift, and the first golden after a date-sensitive change may need `--update-goldens`.
- Plane's Wiki and AI are not in the local checkout; their references are Plane's public docs images (`external-sources.json`).
