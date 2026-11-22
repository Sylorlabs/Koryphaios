#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
source outputs/skill-library-finish-plan/logfare-env.sh
LOG=outputs/skill-library-finish-plan/campaign-d/robotics.log
for i in 1 2; do
  bun run scripts/run-skill-v5-qualification-campaign.ts \
    --skill=robotics-control --force --executor=logfare-text-patch \
    --wall-clock-ms=2400000 --concurrency=2 >> "$LOG" 2>&1
  echo "=== robotics iteration $i done $(date)" >> "$LOG"
done
