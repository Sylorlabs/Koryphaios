#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
source outputs/skill-library-finish-plan/logfare-env.sh
LOG=outputs/skill-library-finish-plan/campaign-d/logfare-subject.log
for skill in web-interface nextjs-engineering svelte-engineering; do
  echo "=== $skill start $(date)" >> "$LOG"
  bun run scripts/run-skill-v5-qualification-campaign.ts \
    --skill="$skill" --force --executor=logfare-text-patch \
    --wall-clock-ms=2400000 --concurrency=2 >> "$LOG" 2>&1
  echo "=== $skill done $(date)" >> "$LOG"
done
