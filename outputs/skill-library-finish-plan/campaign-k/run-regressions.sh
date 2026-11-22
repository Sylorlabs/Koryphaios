#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios || exit 1
for s in business-case-analysis customer-success contract-analysis documents-communication reference-communication marketing-strategy; do
  echo "===== START $s $(date -u +%H:%M:%S)"
  bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts \
    --skill=$s --executor=codex --model=gpt-6-luna --open-regressions \
    --concurrency=1 --wall-clock-ms=480000 \
    > outputs/skill-library-finish-plan/campaign-k/logs/$s-regr.log 2>&1
  echo "===== DONE $s exit=$? $(date -u +%H:%M:%S)"
done
echo "===== ALL REGRESSIONS COMPLETE $(date -u +%H:%M:%S)"
