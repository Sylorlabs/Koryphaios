#!/bin/bash
# Round driver: regression attempts only, then a plain pass for skills whose
# pass rate is the blocker.
cd /Users/Shared/micah/Documents/koryphaios || exit 1
LOG=outputs/skill-library-finish-plan/c-logs
MODEL=gpt-6-luna
for skill in "$@"; do
  echo "=== $(date -u +%FT%TZ) r2-regr $skill" >> "$LOG/driver.log"
  bun run scripts/run-skill-v5-qualification-campaign.ts --skill="$skill" --executor=codex \
    --model=$MODEL --concurrency=2 --wall-clock-ms=420000 --open-regressions \
    > "$LOG/$skill.r2regr.json" 2> "$LOG/$skill.r2regr.err"
  echo "r2-regr $skill exit=$?" >> "$LOG/driver.log"
  echo "=== $(date -u +%FT%TZ) r2-normal $skill" >> "$LOG/driver.log"
  bun run scripts/run-skill-v5-qualification-campaign.ts --skill="$skill" --executor=codex \
    --model=$MODEL --concurrency=2 --wall-clock-ms=420000 \
    > "$LOG/$skill.r2normal.json" 2> "$LOG/$skill.r2normal.err"
  echo "r2-normal $skill exit=$?" >> "$LOG/driver.log"
done
echo "ROUND2 DONE $(date -u +%FT%TZ)" >> "$LOG/driver.log"
