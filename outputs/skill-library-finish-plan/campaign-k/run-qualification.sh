#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios || exit 1
for s in procurement-vendor-evaluation pricing-monetization startup-operations; do
  echo "===== START $s $(date -u +%H:%M:%S)"
  bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts \
    --skill=$s --executor=codex --model=gpt-6-luna \
    --concurrency=1 --wall-clock-ms=480000 \
    > outputs/skill-library-finish-plan/campaign-k/logs/$s-qual.log 2>&1
  echo "===== DONE $s exit=$? $(date -u +%H:%M:%S)"
done
echo "===== ALL QUALIFICATION COMPLETE $(date -u +%H:%M:%S)"
