# Docker deployment

## Install

Copy `docker/.env.example` to `docker/.env`, set a long unique URL-safe `POSTGRES_PASSWORD` (letters, digits, `_` and `-`), then start the single-origin app:

```sh
cp docker/.env.example docker/.env
# Edit docker/.env and set POSTGRES_PASSWORD.
docker compose --env-file docker/.env -f docker/compose.yml up -d
```

Open `http://localhost:8080`. The app serves the web shell, `/api/v1`, `/health/live` and `/health/ready` from this origin. PostgreSQL is private to the Compose network. The app image runs as UID 10001 and contains the Rust server, prebuilt web assets, `git` and `git-lfs`; Node is only used in the image build.

The `migrate` service waits for PostgreSQL and applies migrations under a PostgreSQL advisory lock. The app starts after that one-shot service succeeds and checks migrations under the same lock before reporting ready. The baseline supports one app replica.

## Development

Start the backend and database as above, then launch the Vite development server with the same relative API and health paths:

```sh
docker compose --env-file docker/.env -f docker/compose.yml -f docker/compose.dev.yml up web
```

Open `http://localhost:5173`. Vite forwards `/api` and `/health` to the app while browser requests remain relative to the dev origin.

## Upgrade

Back up the data volumes first, check out the desired release, then rebuild and recreate the services:

```sh
git checkout <release-tag>
docker compose --env-file docker/.env -f docker/compose.yml up -d --build --remove-orphans
```

Compose runs the migration service before replacing the app. Keep the prior release checkout until the upgrade is confirmed.

## Reverse proxy

Terminate TLS at a proxy and forward the public hostname to the app's HTTP port. For Caddy, adapt `docker/proxy/Caddyfile` and attach Caddy to the Compose network. Keep Web, API, health, and future file/WebSocket routes on this same hostname; do not configure CORS or separate API hostnames. If exposing the app port directly is not desired, remove the `ports` mapping and publish it only to the proxy network.

## Persistent and backup data

Named volumes store `postgres_data` (PostgreSQL), `attachments` (uploaded files), and `vault_repositories` (Vault git repositories, including Git LFS objects). Back up all three together during maintenance; also preserve `docker/.env`, which contains the database credentials and future encryption keys. A database-only snapshot cannot restore attachments or Vault repositories.

Example volume listing:

```sh
docker volume ls --filter label=com.docker.compose.project
```
