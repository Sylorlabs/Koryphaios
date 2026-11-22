#!/bin/bash
# A campaign that records how every attempt ended and keeps going.
# Measured twice: the process receives SIGTERM (exit 143) after roughly ten minutes from somewhere
# outside this work. An arm needs forty to seventy minutes, so the only way to obtain one is to let a
# later attempt run past that point. Attempts are recorded individually, and an attempt that completes
# ends the series, so no pair is repeated after it has produced evidence.
cd /Users/Shared/micah/Documents/koryphaios || exit 2
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.config/opencode/opencode.json'))['provider']['logfare']['options']['apiKey'])")
export KORY_SKILL_EVAL_MODEL="${KORY_SKILL_EVAL_MODEL:-deepseek-v4.1-flash-1017}"
export KORY_SKILL_EVAL_LOGFARE_API_KEY="$KEY"
export KORY_SKILL_EVAL_DESKTOP_VM=1
export KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER="$PWD/scripts/kory-vm-desktop-driver.sh"
export KORY_SKILL_EVAL_TAURI_CLI="$PWD/desktop/node_modules/.bin/tauri"
export PATH="$HOME/.cargo/bin:$PATH"
export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
TAG="$1"; SKILL="$2"; SCENARIO="${3:-}"
RECORD="outputs/skill-library-finish-plan/c-logs/$TAG.jsonl"
for attempt in $(seq 1 12); do
  started=$(date +%s)
  bun run scripts/run-skill-v5-qualification-campaign.ts --executor=opencode-logfare-agentic \
    --skill="$SKILL" ${SCENARIO:+--scenario=$SCENARIO} --force --allow-watcher-backend \
    --concurrency=1 --wall-clock-ms=4500000 \
    > "outputs/skill-library-finish-plan/c-logs/$TAG.$attempt.log" 2>&1
  status=$?
  ended=$(date +%s)
  printf '{"attempt":%d,"skill":"%s","exit":%d,"seconds":%d,"at":"%s"}\n' \
    "$attempt" "$SKILL" "$status" "$((ended-started))" "$(date -u +%FT%TZ)" >> "$RECORD"
  [ "$status" -eq 0 ] && exit 0
  sleep 20
done
exit 1
