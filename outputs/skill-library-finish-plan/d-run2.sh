#!/bin/bash
set -u
cd /Users/Shared/micah/Documents/koryphaios || exit 1
DIR=outputs/skill-library-finish-plan/campaign-d
for skill in svelte-engineering angular-engineering accessibility-practice terminal-interface; do
  echo "===== START $skill $(date +%H:%M:%S)" >> "$DIR/queue2.log"
  bun run scripts/run-skill-v5-qualification-campaign.ts \
    --skill="$skill" --open-regressions --executor=codex --model=gpt-6.1-sol \
    --wall-clock-ms=480000 --concurrency=2 > "$DIR/$skill-regr2.log" 2>&1
  echo "===== END $skill exit=$? $(date +%H:%M:%S)" >> "$DIR/queue2.log"
done
echo "===== QUEUE2 DONE $(date +%H:%M:%S)" >> "$DIR/queue2.log"
