#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
export KORY_SKILL_EVAL_MODEL=deepseek-v4.1-flash-1017
export KORY_SKILL_EVAL_LOGFARE_API_KEY="lfu_UUiNDzS1IVj-FYLZ23f-bxZg07tx_FT7"
export KORY_SKILL_EVAL_DESKTOP_VM=1
export KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER="$PWD/scripts/kory-vm-desktop-driver.sh"
export KORY_SKILL_EVAL_TAURI_CLI="$PWD/desktop/node_modules/.bin/tauri"
export PATH="$HOME/.cargo/bin:$PATH"
export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
exec bun run scripts/run-skill-v5-qualification-campaign.ts --executor=opencode-logfare-agentic \
  --skill="$1" --force --allow-watcher-backend --concurrency=1 --wall-clock-ms=4500000
