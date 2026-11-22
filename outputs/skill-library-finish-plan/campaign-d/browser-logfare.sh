#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
source outputs/skill-library-finish-plan/logfare-env.sh
LOG=outputs/skill-library-finish-plan/campaign-d/browser-logfare.log
bun run scripts/run-skill-v5-qualification-campaign.ts \
  --skill=web-interface --scenario=web-interface-full-task-async-operations-console \
  --force --executor=opencode-logfare-agentic --model=deepseek-v4.1-flash-1017 \
  --concurrency=1 --wall-clock-ms=1800000 >> "$LOG" 2>&1
echo "=== browser probe done $(date)" >> "$LOG"
