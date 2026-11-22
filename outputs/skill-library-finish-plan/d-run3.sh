#!/bin/bash
set -u
cd /Users/Shared/micah/Documents/koryphaios || exit 1
DIR=outputs/skill-library-finish-plan/campaign-d
for skill in "$@"; do
  echo "== START $skill $(date +%H:%M:%S)" >> "$DIR/queue3.log"
  bun run scripts/run-skill-v5-qualification-campaign.ts \
    --skill="$skill" --executor=codex --model=gpt-6-luna \
    --wall-clock-ms=420000 --concurrency=2 > "$DIR/$skill-r3.log" 2>&1
  echo "== END $skill exit=$? $(date +%H:%M:%S)" >> "$DIR/queue3.log"
done
echo "== DONE $(date +%H:%M:%S)" >> "$DIR/queue3.log"
