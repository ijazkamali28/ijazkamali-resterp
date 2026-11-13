#!/bin/sh
# Applies pending migrations, optionally loads demo data, then starts the API.
set -eu

echo "[entrypoint] applying database migrations"
npx tsx src/db/migrate.ts

if [ "${DEMO_SEED:-false}" = "true" ] && [ "${NODE_ENV:-}" = "production" ]; then
  echo "[entrypoint] DEMO_SEED ignored: demo data is never loaded when NODE_ENV=production"
elif [ "${DEMO_SEED:-false}" = "true" ]; then
  echo "[entrypoint] loading demo data (skipped if already present)"
  npx tsx db/seeds/seed.ts --if-empty
fi

echo "[entrypoint] starting: $*"
exec "$@"
