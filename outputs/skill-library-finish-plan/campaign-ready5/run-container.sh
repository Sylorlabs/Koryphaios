#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios || exit 1
bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts \
  --skill=container-engineering --open-regressions --force --executor=codex \
  --concurrency=1 --wall-clock-ms=900000 \
  > outputs/skill-library-finish-plan/campaign-ready5/logs/container-forced2.log 2>&1
echo "CONTAINER_DONE exit=$? $(date -u +%H:%M:%S)"
