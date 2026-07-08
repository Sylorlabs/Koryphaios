#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV=test
export SESSION_TOKEN_SECRET="${SESSION_TOKEN_SECRET:-test_only_not_for_production_aaaaaaaaaa}"

while IFS= read -r -d '' test_file; do
  echo "Testing ${test_file}"
  bun test "$test_file"
done < <(find backend/__tests__ backend/src backend/test -type f -name '*.test.ts' -print0 | sort -z)
