#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into the compose stack on this machine.
#
# Usage: scripts/restore.sh <backup-folder> [--replace-live-database]
#
# Without --replace-live-database the restore stops, changing nothing, when the database already holds users or work items
# or the file store already has uploads. A running instance is therefore never overwritten by accident.
# With the flag, the app services stop, the database and uploads are replaced by the backup, the migrate service
# brings the restored database up to the level of this code, and the stack starts again.
# Everything written after the backup was made is lost.
#
# Restoring a backup made at an older migration level is supported: the live schemas are dropped first, so no newer table is left behind,
# and the migrate service then applies the newer migrations. The restore runs in one transaction: any error stops it.
# The app and the file store stop first, then the live database and uploads are copied to backups/pre-restore-* (WEFT_BACKUPS_DIR changes the folder).
#
# WEFT_COMPOSE and WEFT_DOCKER replace the docker commands (used by the tests); WEFT_MINIO_VOLUME names the volume if the project name differs.
set -Eeuo pipefail

usage() { echo "Usage: scripts/restore.sh <backup-folder> [--replace-live-database]" >&2; }

backup_dir=""
replace=false
for arg in "$@"; do
  case "$arg" in
    --replace-live-database) replace=true ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $arg" >&2; usage; exit 2 ;;
    *) backup_dir="$arg" ;;
  esac
done
if [[ -z "$backup_dir" ]]; then usage; exit 2; fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A relative backup folder is relative to where the operator stands, not to the repository.
if [[ -d "$backup_dir" ]]; then backup_dir="$(cd "$backup_dir" && pwd)"; fi
cd "$repo_root"
read -ra compose <<< "${WEFT_COMPOSE:-docker compose}"
read -ra docker <<< "${WEFT_DOCKER:-docker}"
volume="${WEFT_MINIO_VOLUME:-${COMPOSE_PROJECT_NAME:-weft}_weft-minio-data}"

if ! "${docker[@]}" volume inspect "$volume" > /dev/null 2>&1; then
  echo "Not restored: the file store volume $volume does not exist. Set WEFT_MINIO_VOLUME to its name (see docker volume ls)." >&2
  exit 1
fi

phase=before-changes
on_error() {
  [[ "$BASH_SUBSHELL" == 0 ]] || return 0
  case "$phase" in
    database-replaced) echo "The restore stopped after the database was replaced. Do NOT start the stack yet: run this script again with --replace-live-database. Copies of the previous data are in ${backups_dir:-backups}." >&2 ;;
    *) echo "The restore did not finish and the database was not replaced. Fix the error above, then run the restore again or start the stack with: docker compose up -d (use the same -f files as in production.md)" >&2 ;;
  esac
}
trap on_error ERR

# A stack started with compose.proxy.yaml must be restored with the same files, or it comes back with open ports and the wrong public address.
# The api container keeps its compose file list as a label, running or stopped; "config --services" says what this shell would start (caddy exists only in compose.proxy.yaml).
api_id="$("${compose[@]}" ps -a -q api 2>/dev/null | head -1 || true)"
running_files=""
if [[ -n "$api_id" ]]; then
  running_files="$("${docker[@]}" inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$api_id" 2>/dev/null || true)"
fi
if [[ "$running_files" == *compose.proxy.yaml* ]]; then
  # Read all of compose's output before looking for caddy: grep -q would close the pipe early and pipefail would then fail the check at random.
  services="$("${compose[@]}" config --services 2>/dev/null || true)"
  if [[ $'\n'"$services"$'\n' != *$'\n'caddy$'\n'* ]]; then
    echo "Not restored: this stack runs with compose.proxy.yaml, but compose could not be shown to load that file with the command this script uses (or it failed to read its configuration). Set COMPOSE_FILE=compose.yaml:compose.proxy.yaml (in .env or the shell, see docs/production.md section 2) and run again." >&2
    exit 2
  fi
fi

for file in database.dump uploads.tar.gz SHA256SUMS; do
  if [[ ! -f "$backup_dir/$file" ]]; then
    echo "Not restored: $backup_dir/$file is missing. Use a folder made by scripts/backup.sh." >&2
    exit 1
  fi
done
backup_dir="$(cd "$backup_dir" && pwd)"
if ! (cd "$backup_dir" && sha256sum --check --quiet SHA256SUMS); then
  echo "Not restored: a file in $backup_dir does not match SHA256SUMS. The backup is damaged or was changed." >&2
  exit 1
fi
echo "Backup checked. It was made at migration level $(cat "$backup_dir/migration-level.txt" 2>/dev/null || echo unknown)."

tables="$("${compose[@]}" exec -T postgres psql -U weft -d weft -tAc "select count(*) from information_schema.tables where table_schema = 'public'" | tr -d '[:space:]')"
# The migrate service creates empty tables on first start, so counting tables would make every started stack look live: count rows that people created.
rows=0
if [[ "$tables" != 0 ]]; then
  rows="$("${compose[@]}" exec -T postgres psql -U weft -d weft -tAc 'select (select count(*) from "user") + (select count(*) from work_items)' | tr -d '[:space:]')"
fi
# The file store creates its bucket folder and .minio.sys on first start, so only real uploaded files count as data.
entries="$("${docker[@]}" run --rm -v "$volume:/data:ro" alpine:3.20 sh -c "find /data -type f -not -path '/data/.minio.sys/*' | head -1 | wc -l" | tr -d '[:space:]')"
if [[ "$replace" != true && ( "$rows" != 0 || "$entries" != 0 ) ]]; then
  echo "Not restored: this instance already has data (users and work items: $rows, file store entries: $entries)." >&2
  echo "Restoring would delete that data. If that is what you want, run again with --replace-live-database." >&2
  exit 3
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backups_dir="${WEFT_BACKUPS_DIR:-$repo_root/backups}"
mkdir -p "$backups_dir"
backups_dir="$(cd "$backups_dir" && pwd)" # an absolute path, so docker mounts a folder, not a named volume

# Stop writers first, so the safety copies below hold everything that exists when the replacement starts.
# Build the images first: a build that fails (offline, registry down) must fail while nothing has been changed.
echo "Building the images from this checkout..."
"${compose[@]}" build > /dev/null

echo "Stopping the app services and the file store..."
"${compose[@]}" stop api live mcp worker web minio > /dev/null

if [[ "$rows" != 0 ]]; then
  safety="$backups_dir/pre-restore-$stamp.dump"
  ( umask 077; "${compose[@]}" exec -T postgres pg_dump -U weft -d weft --format=custom --no-owner > "$safety" )
  # A dump that cannot be read back is no safety copy: stop before anything is deleted.
  if ! "${compose[@]}" exec -T postgres pg_restore -f /dev/null < "$safety"; then
    echo "Not restored: the safety copy of the live database could not be read back. Nothing was deleted. Start the stack again with: docker compose up -d" >&2
    exit 1
  fi
  echo "The live database was saved to $safety before it is replaced."
fi
if [[ "$entries" != 0 ]]; then
  # Owned by the person running this script, so the copy can be read without sudo.
  "${docker[@]}" run --rm -e "OWNER=$(id -u):$(id -g)" -v "$volume:/data:ro" -v "$backups_dir:/out" alpine:3.20 sh -c "umask 077; tar -C /data -czf /out/pre-restore-$stamp-uploads.tar.gz . && chown \"\$OWNER\" /out/pre-restore-$stamp-uploads.tar.gz"
  echo "The live uploads were saved to $backups_dir/pre-restore-$stamp-uploads.tar.gz before they are replaced."
fi

echo "1/3 Restoring the database..."
# Drop and restore run in ONE transaction: any error rolls back and leaves the live database as it was.
# pg_restore first writes the whole backup as SQL, so an unreadable backup fails before the transaction starts.
"${compose[@]}" exec -T postgres sh -c 'cat > /tmp/weft-restore.dump' < "$backup_dir/database.dump"
"${compose[@]}" exec -T postgres sh -c 'set -e; trap "rm -f /tmp/weft-restore.dump /tmp/weft-restore.sql /tmp/weft-drop.sql" EXIT; pg_restore --no-owner -f /tmp/weft-restore.sql /tmp/weft-restore.dump; echo "drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;" > /tmp/weft-drop.sql; psql -U weft -d weft -v ON_ERROR_STOP=1 --single-transaction -f /tmp/weft-drop.sql -f /tmp/weft-restore.sql > /dev/null'
phase=database-replaced

echo "2/3 Restoring uploaded files..."
"${docker[@]}" run --rm -v "$volume:/data" -v "$backup_dir:/backup:ro" alpine:3.20 sh -c 'find /data -mindepth 1 -delete && tar -C /data -xzf /backup/uploads.tar.gz'
"${compose[@]}" start minio > /dev/null

echo "3/3 Applying migrations and starting the stack..."
"${compose[@]}" run --build --rm migrate
"${compose[@]}" up -d --build

echo "Restore finished. Open the app and check your data, then check http://localhost:3000/api/health/ready (or your public address)."
