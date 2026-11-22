#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
for i in 1 2 3; do
  bun run scripts/run-skill-v5-qualification-campaign.ts \
    --skill=accessibility-verification \
    --scenario=accessibility-verification-full-task-2 \
    --force --executor=codex --model=gpt-6-luna \
    --wall-clock-ms=2400000 --concurrency=1 >> outputs/skill-library-finish-plan/campaign-d/access-loop.log 2>&1
  echo "=== access iteration $i $(date)" >> outputs/skill-library-finish-plan/campaign-d/access-loop.log
done
