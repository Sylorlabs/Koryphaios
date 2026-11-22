#!/bin/bash
# Driver for group C qualification campaigns.
# Pass 1: current-contract full-task pairs. Pass 2: explicit regression attempts.
cd /Users/Shared/micah/Documents/koryphaios || exit 1
LOG=outputs/skill-library-finish-plan/c-logs
MODEL=gpt-6-luna
for skill in "$@"; do
  echo "=== $(date -u +%FT%TZ) normal $skill" >> "$LOG/driver.log"
  bun run scripts/run-skill-v5-qualification-campaign.ts --skill="$skill" --executor=codex \
    --model=$MODEL --reasoning-effort=medium --concurrency=2 --wall-clock-ms=420000 \
    > "$LOG/$skill.normal.json" 2> "$LOG/$skill.normal.err"
  echo "normal $skill exit=$?" >> "$LOG/driver.log"
  echo "=== $(date -u +%FT%TZ) open-regressions $skill" >> "$LOG/driver.log"
  bun run scripts/run-skill-v5-qualification-campaign.ts --skill="$skill" --executor=codex \
    --model=$MODEL --reasoning-effort=medium --concurrency=2 --wall-clock-ms=420000 --open-regressions \
    > "$LOG/$skill.regr.json" 2> "$LOG/$skill.regr.err"
  echo "regr $skill exit=$?" >> "$LOG/driver.log"
done
echo "ALL DONE $(date -u +%FT%TZ)" >> "$LOG/driver.log"
