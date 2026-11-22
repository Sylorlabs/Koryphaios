#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
for i in 1 2 3 4; do
  bun run scripts/run-skill-v5-qualification-campaign.ts \
    --skill=novel-ui-toolkit \
    --scenario=novel-ui-toolkit-full-task-1-individual \
    --force --executor=codex --model=gpt-6-luna \
    --wall-clock-ms=2400000 --concurrency=1 >> outputs/skill-library-finish-plan/campaign-d/novel-t1-loop.log 2>&1
  echo "=== t1 iteration $i $(date)" >> outputs/skill-library-finish-plan/campaign-d/novel-t1-loop.log
done
