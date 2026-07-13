#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV=test
export SESSION_TOKEN_SECRET="${SESSION_TOKEN_SECRET:-test_only_not_for_production_aaaaaaaaaa}"

# Each test file runs in its own Bun process. Give each process a fresh SQLite
# database so state from a previous file cannot leak into the next one (notes
# aliases and FTS rows made this especially visible). Keeping the databases in
# one temporary directory also lets SQLite create its WAL/SHM sidecars safely.
test_db_dir="$(mktemp -d)"
trap 'rm -rf "$test_db_dir"' EXIT
test_index=0

while IFS= read -r -d '' test_file; do
  echo "Testing ${test_file}"
  test_index=$((test_index + 1))
  DATABASE_URL="sqlite://${test_db_dir}/${test_index}.db" bun test \
    --preload ./backend/test/setup-db.ts "$test_file"
done < <(find backend/__tests__ backend/src backend/test -type f -name '*.test.ts' -print0 | sort -z)
