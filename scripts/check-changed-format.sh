#!/usr/bin/env bash
set -euo pipefail

base="${1:-}"
if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  base="$(git rev-parse HEAD^)"
fi

mapfile -t files < <(
  git diff --name-only --diff-filter=ACMR "$base" HEAD -- \
    '*.ts' '*.tsx' '*.js' '*.jsx' '*.json' '*.md' '*.svelte' \
    | grep -Ev '^(frontend/build/|test-results/|playwright-report/)' || true
)

if ((${#files[@]})); then
  bunx prettier --check "${files[@]}"
fi
git diff --check "$base" HEAD
