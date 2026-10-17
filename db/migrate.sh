#!/usr/bin/env bash
# Applies db/migrations/*.sql in order, once each, inside one transaction per file.
# Usage: PGHOST=... PGPORT=... PGUSER=... PGDATABASE=... ./db/migrate.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/migrations"

psql -v ON_ERROR_STOP=1 -q -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );"

for f in "$DIR"/*.sql; do
  name="$(basename "$f")"
  done_already="$(psql -At -c "SELECT 1 FROM schema_migrations WHERE filename = '$name'")"
  if [ -n "$done_already" ]; then
    echo "skip   $name"
    continue
  fi
  echo "apply  $name"
  psql -v ON_ERROR_STOP=1 -q --single-transaction -f "$f" \
       -c "INSERT INTO schema_migrations (filename) VALUES ('$name')"
done
echo "done"
