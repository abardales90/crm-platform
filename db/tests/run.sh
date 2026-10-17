#!/usr/bin/env bash
# Builds a fresh database, applies all migrations, runs every test. Exits non-zero on any failure.
# Needs PGHOST/PGPORT/PGUSER set to a superuser. Usage: db/tests/run.sh [dbname]
set -euo pipefail
cd "$(dirname "$0")"
DB="${1:-crm_test_$$}"
export PGUSER="${PGUSER:-postgres}"
admin() { PGDATABASE=postgres psql -v ON_ERROR_STOP=1 -q "$@"; }
admin -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
trap 'admin -c "DROP DATABASE IF EXISTS '"$DB"'" >/dev/null 2>&1 || true' EXIT
export PGDATABASE="$DB"
../migrate.sh >/dev/null
OUT=$(mktemp)
run() { # file, role
  echo "--- $1 ${2:+(as $2)}"
  PGOPTIONS='-c client_min_messages=notice' psql -v ON_ERROR_STOP=1 -q ${2:+-U "$2"} -f "$1" 2>&1 | tee -a "$OUT" | sed -e 's/^psql:[^ ]* //' -e 's/^NOTICE:  //' || true
}
run 00_setup.sql
run 10_app_role.sql crm_test_app
run 20_readonly_and_admin.sql
pass=$(grep -c 'PASS:' "$OUT" || true)
fail=$(grep -Ec 'FAIL:|ERROR:' "$OUT" || true)
echo "== $pass passed, $fail failed"
[ "$fail" -eq 0 ]
