#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
for i in 1 2 3; do
  bun run scripts/run-skill-v5-qualification-campaign.ts \
    --skill=accessibility-verification --force --executor=opencode-logfare-agentic \
    --wall-clock-ms=3000000 --concurrency=2 \
    >> outputs/skill-library-finish-plan/campaign-d/access-loop4.log 2>&1
  echo "=== access4 iteration $i $(date)" >> outputs/skill-library-finish-plan/campaign-d/access-loop4.log
done
