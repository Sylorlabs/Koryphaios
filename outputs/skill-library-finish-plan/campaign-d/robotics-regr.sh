#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
source outputs/skill-library-finish-plan/logfare-env.sh
LOG=outputs/skill-library-finish-plan/campaign-d/robotics-regr.log
bun run scripts/run-skill-v5-qualification-campaign.ts \
  --skill=robotics-control --open-regressions --executor=logfare-text-patch \
  --wall-clock-ms=2400000 --concurrency=2 >> "$LOG" 2>&1
echo "=== regressions done $(date)" >> "$LOG"
