#!/usr/bin/env bash
# Restore a backup into a NEW, EMPTY database, verify it, and leave the switch-over to the operator.
# Usage: scripts/restore.sh <backup.dump> <target_database_name>
# Requires: DATABASE_OWNER_URL (any database on the target server; used to create the target)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
DUMP="${1:?backup file required}"; TARGET="${2:?target database name required}"
: "${DATABASE_OWNER_URL:?DATABASE_OWNER_URL is required}"
[[ "$TARGET" =~ ^[a-z0-9_]+$ ]] || { echo "invalid target database name"; exit 1; }

[ -f "$DUMP" ] || { echo "backup file not found: $DUMP"; exit 1; }
if [ -f "$DUMP.sha256" ]; then (cd "$(dirname "$DUMP")" && sha256sum --check --status "$(basename "$DUMP").sha256") || { echo "checksum mismatch: $DUMP"; exit 1; }
else echo "warning: no checksum file next to $DUMP"; fi
BASE_URL="${DATABASE_OWNER_URL%/*}"
psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -qc "create database $TARGET"
pg_restore --no-owner --role="$(psql "$DATABASE_OWNER_URL" -Atc 'select current_user')" --exit-on-error \
           --dbname="$BASE_URL/$TARGET" "$DUMP"
psql "$BASE_URL/$TARGET" -v ON_ERROR_STOP=1 -q -f scripts/sql/post-restore.sql
psql "$BASE_URL/$TARGET" -At -f scripts/sql/verify.sql
echo "restored into '$TARGET'. Point DATABASE_URL/DATABASE_OWNER_URL at it after review."
