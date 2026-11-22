#!/bin/bash
# Targeted closure attempts: one open-regression scenario per skill, two rounds.
cd /Users/Shared/micah/Documents/koryphaios || exit 1
LOG=outputs/skill-library-finish-plan/c-logs
skill=$1; scen=$2; rounds=${3:-2}
for i in $(seq 1 $rounds); do
  echo "=== $(date -u +%FT%TZ) target $skill $scen r$i" >> "$LOG/driver.log"
  bun run scripts/run-skill-v5-qualification-campaign.ts --skill="$skill" --executor=codex \
    --model=gpt-6-luna --concurrency=1 --wall-clock-ms=420000 --open-regressions \
    --scenarios="$scen" > "$LOG/$skill.target$i.json" 2> "$LOG/$skill.target$i.err"
  echo "target $skill r$i exit=$?" >> "$LOG/driver.log"
done
