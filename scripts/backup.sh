#!/usr/bin/env bash
# Back up the Weft database and uploaded files into a new folder on the machine that runs the compose stack.
#
# Usage: scripts/backup.sh [backup-folder]
#   The folder defaults to backups/weft-<UTC time>. It must not exist yet.
#
# The folder receives:
#   database.dump      the database (Postgres custom format, read by pg_restore)
#   uploads.tar.gz     the file store (the MinIO data volume)
#   migration-level.txt how many database migrations were applied when the backup was made
#   SHA256SUMS         checksums that scripts/restore.sh checks before it touches anything
#
# The file store stops for a few seconds while its data is copied, so no upload is half written.
# Copy the folder off the machine too; a backup on the same disk does not survive a lost disk.
# SHA256SUMS catches a damaged copy, not a tampered one: the checksums sit beside the files.
# The database and the uploads are saved a moment apart while the app runs, so they are not a point-in-time pair.
#
# WEFT_COMPOSE and WEFT_DOCKER replace the docker commands (used by the tests); WEFT_MINIO_VOLUME names the volume if the project name differs.
set -Eeuo pipefail
# The dump holds password hashes, sessions and tokens: only the person running the backup may read it.
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
read -ra compose <<< "${WEFT_COMPOSE:-docker compose}"
read -ra docker <<< "${WEFT_DOCKER:-docker}"
volume="${WEFT_MINIO_VOLUME:-${COMPOSE_PROJECT_NAME:-weft}_weft-minio-data}"

# A wrong volume name would make docker create an empty volume and the backup would look fine while holding no uploads.
if ! "${docker[@]}" volume inspect "$volume" > /dev/null 2>&1; then
  echo "Not started: the file store volume $volume does not exist. Set WEFT_MINIO_VOLUME to its name (see docker volume ls)." >&2
  exit 1
fi

backup_dir="${1:-backups/weft-$(date -u +%Y%m%dT%H%M%SZ)}"
if [[ -e "$backup_dir" ]]; then
  echo "Not started: $backup_dir already exists. Give a new folder name." >&2
  exit 1
fi
mkdir -p "$backup_dir"
backup_dir="$(cd "$backup_dir" && pwd)"

echo "1/3 Saving the database..."
"${compose[@]}" exec -T postgres pg_dump -U weft -d weft --format=custom --no-owner > "$backup_dir/database.dump"

echo "2/3 Saving uploaded files. The file store pauses for a moment..."
"${compose[@]}" stop minio > /dev/null
trap '"${compose[@]}" start minio > /dev/null' EXIT
"${docker[@]}" run --rm -v "$volume:/data:ro" -v "$backup_dir:/backup" alpine:3.20 tar -C /data -czf /backup/uploads.tar.gz .
trap - EXIT
"${compose[@]}" start minio > /dev/null

echo "3/3 Recording the migration level and checksums..."
"${compose[@]}" exec -T postgres psql -U weft -d weft -tAc 'select count(*) from drizzle.__drizzle_migrations' | tr -d '[:space:]' > "$backup_dir/migration-level.txt"
(cd "$backup_dir" && sha256sum database.dump uploads.tar.gz > SHA256SUMS)

echo "Backup written to $backup_dir (database at migration level $(cat "$backup_dir/migration-level.txt"))."
echo "Copy this folder to another machine before you rely on it."
