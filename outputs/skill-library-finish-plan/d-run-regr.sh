#!/bin/bash
# Sequential regression-closure campaigns for the D group. One skill at a time.
set -u
cd /Users/Shared/micah/Documents/koryphaios || exit 1
DIR=outputs/skill-library-finish-plan/campaign-d
mkdir -p "$DIR"
for skill in "$@"; do
  echo "===== START $skill $(date +%H:%M:%S)" >> "$DIR/queue.log"
  bun run scripts/run-skill-v5-qualification-campaign.ts \
    --skill="$skill" --open-regressions --executor=codex --model=gpt-6-luna \
    --wall-clock-ms=420000 --concurrency=2 > "$DIR/$skill-regr.log" 2>&1
  echo "===== END $skill exit=$? $(date +%H:%M:%S)" >> "$DIR/queue.log"
done
echo "===== QUEUE DONE $(date +%H:%M:%S)" >> "$DIR/queue.log"
