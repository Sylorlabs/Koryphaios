#!/usr/bin/env bash
set -euo pipefail

# Sync provider icons from Simple Icons CDN into frontend/static/provider-icons.
# Usage:
#   ./scripts/sync-provider-icons.sh
#   ./scripts/sync-provider-icons.sh --dry-run

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

ICON_DIR="frontend/static/provider-icons"
BASE_URL="https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons"

# provider_key -> simple-icons slug
# Keep aliases mapped to same canonical file where appropriate.
declare -A MAP=(
  [openai]="openai"
  [codex]="openai"
  [anthropic]="anthropic"
  [google]="google"
  [chromeai]="googlechrome"
  [xai]="x"
  [copilot]="githubcopilot"
  [github-models]="github"
  [azure]="microsoftazure"
  [azurecognitive]="microsoftazure"
  [vertexai]="googlecloud"
  [bedrock]="amazonwebservices"
  [alibaba]="alibabacloud"
  [alibaba-cn]="alibabacloud"
  [qwen]="qwen"
  [vultr]="vultr"
  [wandb]="weightsandbiases"
  [llama]="meta"
)

ok=0
miss=0

for key in "${!MAP[@]}"; do
  slug="${MAP[$key]}"
  url="${BASE_URL}/${slug}.svg"
  out="${ICON_DIR}/${key}.svg"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY ${key} <= ${slug} (${url})"
    ok=$((ok + 1))
    continue
  fi

  if curl -L --fail --silent --show-error --retry 5 --retry-delay 2 "$url" -o "$out"; then
    echo "OK   ${key} <= ${slug}"
    ok=$((ok + 1))
  else
    echo "MISS ${key} <= ${slug}"
    miss=$((miss + 1))
  fi
done

echo
echo "Summary: ok=${ok} miss=${miss}"
if [[ "$miss" -gt 0 ]]; then
  exit 2
fi
