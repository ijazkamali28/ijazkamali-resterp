#!/usr/bin/env bash
# Logical backup of the application database (custom format, compressed) + SHA-256 checksum.
# Usage: scripts/backup.sh [output_dir]       (reads DATABASE_OWNER_URL from env or .env)
# Schedule: hourly on branch servers, every 15 min + WAL archiving (PITR) on the cloud database.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
: "${DATABASE_OWNER_URL:?DATABASE_OWNER_URL is required}"
OUT_DIR="${1:-${BACKUP_DIR:-./backups}}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NODE="${NODE_TYPE:-cloud}${NODE_BRANCH_CODE:+-$NODE_BRANCH_CODE}"
FILE="$OUT_DIR/restaurant_erp_${NODE}_${STAMP}.dump"

# write to a temp file and rename only on success, so a failed run never leaves a usable-looking archive
TMP="$FILE.partial"
trap 'rm -f -- "$TMP"' EXIT
pg_dump --format=custom --compress=6 --no-owner --no-privileges --serializable-deferrable \
        --file="$TMP" "$DATABASE_OWNER_URL"
pg_restore --list "$TMP" > /dev/null           # structural sanity check of the archive
mv -- "$TMP" "$FILE"
(cd "$OUT_DIR" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256")
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"

# retention: remove local archives older than RETENTION_DAYS (copy off-site before relying on this)
find "$OUT_DIR" -name 'restaurant_erp_*.dump*' -type f -mtime +"$RETENTION_DAYS" -print -delete
