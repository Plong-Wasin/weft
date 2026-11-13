# Running Weft in production

This guide is for the person who runs a Weft instance for a company. It covers the settings, HTTPS, health checks, logs, backups, restores, upgrades and rollback. The first-run steps are in the [README](../README.md#self-hosting-with-docker-compose).

## 1. Settings

Copy `.env.example` to `.env` and set these before the first start. The `api`, `worker` and `migrate` services refuse to start while a secret is missing or still has a placeholder value.

| Variable | What it does | How to set it |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Signs login sessions | Required. `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | Password of the database user `weft` | Required. Use hex or other URL-safe characters, because it is placed inside `DATABASE_URL` |
| `S3_SECRET_KEY` | Password of the file store (MinIO) | Required. `openssl rand -hex 32` |
| `API_PUBLIC_URL` | Public address of the API, used by the browser | The address people type, for example `https://weft.example.com` |
| `WEB_ORIGIN` | Address of the web app; must match what people open | For example `https://weft.example.com` |
| `WEFT_PUBLIC_URL` | Public root address when one domain serves everything | See section 2 |
| `TRUSTED_PROXY_HOPS` | How many reverse proxies sit in front of the API | `1` behind Caddy or one proxy; `0` for direct access |
| `ALLOW_SIGNUP` | Whether anyone can create an account | `false` once every employee has an account |
| `ALLOW_WORKSPACE_CREATION` | Whether members can create new workspaces | `false` for a single-company instance |
| `DEFAULT_LANGUAGE` | Language for people who have not chosen one (`en` or `th`) | Empty keeps the browser's choice |
| `AI_PROVIDER`, `AI_MODEL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | The AI assistant | Set the key for the provider you use; without one the assistant is off |
| `ASSET_MAX_BYTES` | Largest upload in bytes | Default 5 MiB |
| `S3_BUCKET`, `S3_ACCESS_KEY` | File store bucket and user | Defaults work; change `S3_ACCESS_KEY` with the secret |

Keep `.env` out of version control and out of backups you share.

## 2. HTTPS behind a reverse proxy

Use one public address for everything: set `WEFT_PUBLIC_URL` to the public origin and `SITE_ADDRESS` to its host name, then start both compose files:

```sh
docker compose -f compose.yaml -f compose.proxy.yaml up -d --build
```

To make every later `docker compose` command (and `scripts/restore.sh`) use both files, put `COMPOSE_FILE=compose.yaml:compose.proxy.yaml` in `.env` or your shell profile. `scripts/restore.sh` refuses to run against a stack started with the proxy file when the command it would use does not load that file, because the stack would come back with every port open.

The bundled Caddy service serves HTTPS for `SITE_ADDRESS` and is the only published port. Do not publish the API, MinIO or the database port on the internet: a caller that reaches the API directly can send its own `x-forwarded-for` header and bypass the proxy's address checks.

If you use another proxy (nginx, a cloud load balancer), it must:

- terminate HTTPS and forward `/actions/`, `/api/`, `/mcp`, `/.well-known/`, `/published/` to the API or MCP service;
- forward `/live` as a WebSocket (the proxy must pass the `Upgrade` and `Connection` headers);
- forward the file store bucket path (`/<S3_BUCKET>/`) to MinIO;
- add one `x-forwarded-for` entry per proxy hop, and set `TRUSTED_PROXY_HOPS` to the number of proxies.

See [ADR 0006](adr/0006-single-origin-deployment-behind-caddy.md) for the routing.

## 3. Non-root user

The API, worker, live, MCP and migrate services run from the `server` image as the `bun` user (the Dockerfile sets `USER bun`), not as root. The web image is served by nginx. Postgres and MinIO run their own images with their own users.

## 4. Health checks

Two endpoints answer without signing in:

- `GET /api/health/live` returns `{"status":"ok"}` while the API process answers. Use it to see whether the process is alive.
- `GET /api/health/ready` checks the database and the file store. It returns `200` with `"status":"ok"` when both answer, and `503` with `"status":"unavailable"` otherwise. Each dependency is listed as `"ok"` or `"unreachable"`, for example:

```json
{"status":"unavailable","checks":{"database":"ok","storage":"unreachable"}}
```

The response never includes error text, passwords or keys. The `api` service in `compose.yaml` runs the readiness check every 10 seconds, so `docker compose ps` shows `healthy` or `unhealthy`. When `unhealthy` appears, check the file store and database first (`docker compose ps postgres minio`).

Through the public proxy, anyone can read these two endpoints. They reveal only whether each dependency answers.

## 5. Logs and request ids

The API writes one JSON line per request to standard output (`docker compose logs api`). Each line has `time`, `service`, `level` (`info`, `warn` or `error`), `requestId`, `method`, `path`, `status` and `durationMs`.

- Each response carries an `x-request-id` header. Quote that value when you report a problem.
- A caller (for example the proxy) may send its own `x-request-id`; Weft keeps it when it uses only letters, digits, `.`, `_` and `-`, and replaces it otherwise.
- To find every line of one request:

```sh
docker compose logs api | grep '"requestId":"PASTE-THE-ID-HERE"'
```

Error lines carry the error name and code, not the message, because database messages can contain query values. Look up the request in the logs by its id, then find the matching code in the source.

A published link's token is written as `/published/:token`, never in full.

## 6. Backups

`scripts/backup.sh` backs up the database and the uploaded files into a new folder. Run it on the machine that runs the stack, from the repository folder:

```sh
scripts/backup.sh                       # creates backups/weft-<UTC time>
scripts/backup.sh /mnt/safe/weft-2026-11-13
```

The folder contains:

| File | What it is |
| --- | --- |
| `database.dump` | The database |
| `uploads.tar.gz` | The uploaded files (the MinIO data volume) |
| `migration-level.txt` | How many database migrations were applied when the backup was made |
| `SHA256SUMS` | Checksums; the restore checks them first |

Things to know:

- The file store stops for a few seconds while its data is copied, so an upload is never half written. Users may see upload errors during that time. Schedule backups for a quiet hour.
- The script needs the `alpine:3.20` image to copy the volume. Pull it once on the machine, or allow Docker to pull it when the backup runs.
- A backup on the same disk does not protect you from losing that disk. Copy each folder to another machine and keep it for as long as your policy needs.
- The backup folder holds your data and your secrets (`.env` is not included, but the database holds sessions and tokens). Restrict who can read it.

To run a backup every night at 02:00 with cron, add a line like this to the crontab of the user who runs Docker, with the path to the repository:

```cron
0 2 * * * cd /opt/weft && scripts/backup.sh /mnt/safe/weft-$(date -u +\%Y\%m\%d) >> /var/log/weft-backup.log 2>&1
```

## 7. Restores

Restore only into the machine and stack the backup came from, or into a fresh stack:

```sh
scripts/restore.sh /mnt/safe/weft-2026-11-13
```

The script checks the checksums first. Then it stops when the instance already has data (users, work items or uploaded files), and prints that it changed nothing. To replace the data on purpose:

```sh
scripts/restore.sh /mnt/safe/weft-2026-11-13 --replace-live-database
```

With the flag, the script builds the images from the checked-out code (a failed build stops it before anything changes), stops the app services, replaces the database and uploads with the backup, runs the `migrate` service and starts the stack again. The app services and the file store stop first. Before it deletes anything it copies the live database and the live uploads to `backups/pre-restore-<time>.dump` and `backups/pre-restore-<time>-uploads.tar.gz`, and stops if the database copy cannot be read back. The drop and the restore run as one database transaction, so an error there leaves the live database as it was. If the script fails later (while restoring uploads or migrating), the database is already the backup: the script says so, and you run it again with `--replace-live-database` instead of starting the stack. The compressed and the uncompressed copy of the backup are both written inside the database container's `/tmp` while it runs, so keep free disk space for about three times the size of `database.dump`. **Everything written after the backup was made is lost** unless you recover it from those copies. Make a fresh backup first if there is any chance you need the current data.

**Restoring a backup from an older version.** A backup made at an older migration level restores the same way. `migrate` then applies the newer migrations, so the database reaches the level of the code you run. Check `migration-level.txt` in the folder to see the level the backup was made at. A backup made at a newer migration level than the code you run may not restore correctly: check out the newer version first.

**Rehearse a restore before you need one.** On a second machine (or a second compose project name), run `scripts/restore.sh` on a recent backup, open the app, sign in, and check a work item and an uploaded file. Keep the output as your record. Do this after every change to the backup procedure.

## 8. Upgrades

1. Back up first: `scripts/backup.sh`.
2. Get the new code: `git pull`.
3. Rebuild and start: `docker compose up -d --build`. The `migrate` service runs the new migrations before the API starts.
4. Check readiness: `docker compose ps` shows `healthy` for `api`, and `curl -fsS https://<your-host>/api/health/ready` returns `"status":"ok"`.

Release note: Runtime Runs (Claude and Codex CLIs on a Daemon) and cache tokens now count toward an Agent's monthly token budget, so an Agent that ran on a Runtime may reach its budget sooner than before.

When Codex does not report its model, cost stays unknown and the person can set the model on the Agent.

If the migrate service fails, the API does not start on the new code. Read its log with `docker compose logs migrate`, fix the cause and run `docker compose up -d --build` again, or roll back (section 9).

## 9. Rollback

Migrations only move forward: the repository has no "down" migrations. So a rollback means returning to the older code and the database from before the upgrade:

1. Check out the previous version: `git checkout <previous-tag-or-commit>`.
2. If the version you checked out has no `scripts/restore.sh`, or an older one, copy the current script into the checkout first: `git show <current-version>:scripts/restore.sh > scripts/restore.sh`. Then restore the backup you took in step 1 of the upgrade: `bash scripts/restore.sh <folder> --replace-live-database` (with `bash`, because a copied file has no execute permission). It rebuilds the images from the checked-out code, migrates the restored database with that code and starts the stack.
3. Open the app and check your data.

Data written between the upgrade and the rollback is lost. Rollback is the reason step 1 of the upgrade matters.
