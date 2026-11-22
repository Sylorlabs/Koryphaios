#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios || exit 1
LOG=outputs/skill-library-finish-plan/c-logs
for skill in "$@"; do
  echo "=== $(date -u +%FT%TZ) blind $skill" >> "$LOG/blind-driver.log"
  KORY_SKILL_BLIND_REVIEWER_PROVIDER=logfare bun run scripts/run-skill-v5-blind-review-campaign.ts \
    --skill="$skill" \
    --reviewer-adapter=scripts/kory-logfare-stateless-reviewer \
    --reviewer-model=deepseek-v4.1-flash-1017 \
    --concurrency=1 \
    > "$LOG/$skill.blind.json" 2> "$LOG/$skill.blind.err"
  echo "blind $skill exit=$?" >> "$LOG/blind-driver.log"
done
echo "BLIND DONE $(date -u +%FT%TZ)" >> "$LOG/blind-driver.log"
