#!/bin/bash
# Wait for the provider to answer before spending an arm on it. A campaign started into an outage
# records infrastructure failures and burns its retries, so the health of the endpoint decides when
# the run starts, not the clock.
cd /Users/Shared/micah/Documents/koryphaios || exit 2
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.config/opencode/opencode.json'))['provider']['logfare']['options']['apiKey'])")
MODEL="${1:-deepseek-v4.1-flash-1017}"; TAG="$2"; SKILL="$3"; SCENARIO="${4:-}"
LOG="outputs/skill-library-finish-plan/c-logs/$TAG.health.log"
for attempt in $(seq 1 600); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 https://logfare.ai/v1/chat/completions \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":4,\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}]}")
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$MODEL" "$code" >> "$LOG"
  if [ "$code" = "200" ]; then
    exec "$(dirname "$0")/run-vm-campaign.sh" "$TAG" "$SKILL" "$SCENARIO"
  fi
  sleep 150
done
exit 3
