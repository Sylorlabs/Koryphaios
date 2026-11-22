#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
stamp() { date -u +%H:%M:%S; }
echo "START fulltask $(stamp)"
bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts --skill=architecture-planning --skill=feature-implementation --executor=codex --model=gpt-6-luna --concurrency=2 --wall-clock-ms=420000
echo "EXIT fulltask=$? $(stamp)"
echo "START regressions $(stamp)"
bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts --skill=architecture-planning --skill=feature-implementation --open-regressions --executor=codex --model=gpt-6-luna --concurrency=2 --wall-clock-ms=420000
echo "EXIT regressions=$? $(stamp)"
