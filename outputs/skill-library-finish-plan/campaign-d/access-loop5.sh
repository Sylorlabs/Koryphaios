#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
export KORY_SKILL_EVAL_LOGFARE_API_KEY="$(bun -e 'const c=require("./config.json");process.stdout.write(c.provider?.logfare?.options?.apiKey??"")')"
for i in 1 2; do
  bun run scripts/run-skill-v5-qualification-campaign.ts \
    --skill=accessibility-verification --force --executor=logfare-text-patch \
    --wall-clock-ms=3000000 --concurrency=2 \
    >> outputs/skill-library-finish-plan/campaign-d/access-loop5.log 2>&1
  echo "=== access5 iteration $i $(date)" >> outputs/skill-library-finish-plan/campaign-d/access-loop5.log
done
