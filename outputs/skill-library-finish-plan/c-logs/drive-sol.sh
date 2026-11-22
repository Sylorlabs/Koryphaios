#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios || exit 1
LOG=outputs/skill-library-finish-plan/c-logs
for skill in "$@"; do
  echo "=== $(date -u +%FT%TZ) sol-normal $skill" >> "$LOG/driver.log"
  bun run scripts/run-skill-v5-qualification-campaign.ts --skill="$skill" --executor=codex \
    --model=gpt-6.1-sol --concurrency=2 --wall-clock-ms=420000 \
    > "$LOG/$skill.solnormal.json" 2> "$LOG/$skill.solnormal.err"
  echo "sol-normal $skill exit=$?" >> "$LOG/driver.log"
  echo "=== $(date -u +%FT%TZ) sol-regr $skill" >> "$LOG/driver.log"
  bun run scripts/run-skill-v5-qualification-campaign.ts --skill="$skill" --executor=codex \
    --model=gpt-6.1-sol --concurrency=2 --wall-clock-ms=420000 --open-regressions \
    > "$LOG/$skill.solregr.json" 2> "$LOG/$skill.solregr.err"
  echo "sol-regr $skill exit=$?" >> "$LOG/driver.log"
done
echo "SOL DONE $(date -u +%FT%TZ)" >> "$LOG/driver.log"
