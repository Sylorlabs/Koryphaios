#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios || exit 1
run() {
  local label="$1"; shift
  echo "===== START $label $(date -u +%H:%M:%S)"
  bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts "$@" \
    --executor=codex --model=gpt-6-luna --concurrency=1 --wall-clock-ms=480000 \
    > outputs/skill-library-finish-plan/campaign-k/logs/$label.log 2>&1
  echo "===== DONE $label exit=$? $(date -u +%H:%M:%S)"
}
run pricing-monetization-qual-v512 --skill=pricing-monetization
run pricing-monetization-regr-v512 --skill=pricing-monetization --open-regressions
run procurement-vendor-evaluation-regr --skill=procurement-vendor-evaluation --open-regressions
run startup-operations-regr --skill=startup-operations --open-regressions
echo "===== WAVE 2 COMPLETE $(date -u +%H:%M:%S)"
