#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios || exit 1
for s in angular-engineering react-engineering literature-research container-engineering; do
  echo "===== START $s $(date -u +%H:%M:%S)"
  bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts \
    --skill=$s --open-regressions --force --executor=codex \
    --concurrency=1 --wall-clock-ms=900000 \
    > outputs/skill-library-finish-plan/campaign-ready5/logs/$s-forced-regr.log 2>&1
  echo "===== DONE $s exit=$? $(date -u +%H:%M:%S)"
done
echo "===== FORCED COMPLETE $(date -u +%H:%M:%S)"
