#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
for i in 1 2 3; do
  bun run scripts/run-skill-v5-qualification-campaign.ts \
    --skill=novel-ui-toolkit \
    --scenario=novel-ui-toolkit-full-task-1-individual \
    --scenario=novel-ui-toolkit-full-task-2-individual \
    --force --executor=codex --model=gpt-6.1-sol --reasoning-effort=high \
    --wall-clock-ms=3600000 --concurrency=2 >> outputs/skill-library-finish-plan/campaign-d/novel-loop.log 2>&1
  echo "=== iteration $i done $(date)" >> outputs/skill-library-finish-plan/campaign-d/novel-loop.log
done
