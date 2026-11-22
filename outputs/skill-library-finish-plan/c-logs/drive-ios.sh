#!/bin/bash
cd /Users/Shared/micah/Documents/koryphaios
export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
export KORY_IOS_EVAL_DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
export KORY_IOS_EVAL_IPHONE_UDID=4ADB02EE-1CC6-4433-909A-1B1F247FA068
export KORY_IOS_EVAL_IPAD_UDID=331D33CB-8128-48E8-AC93-76D36ED2123B
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
L=outputs/skill-library-finish-plan/c-logs
for round in 1 2 3; do
  for scenario in ios-swiftui-full-task-1-individual ios-swiftui-full-task-2-individual; do
    bun run scripts/run-skill-v5-qualification-campaign.ts --skill=ios-swiftui --scenario=$scenario \
      --force --executor=codex --model=gpt-6-luna --concurrency=1 --wall-clock-ms=1800000 \
      >> "$L/d24-ios-round$round.log" 2>&1
    echo "round $round $scenario done $(date +%H:%M:%S)" >> "$L/d24-ios-progress.log"
  done
  bun run ./.gate-probe.ts ios-swiftui >> "$L/d24-ios-gate.log" 2>/dev/null
  status=$(bun run ./.gate-probe.ts ios-swiftui 2>/dev/null | python3 -c "
import sys,json
row=json.loads([l for l in sys.stdin if l.strip().startswith('{')][0])
print(row['status'], row['passRate'], 'integ' if any('integrity' in r for r in row['reasons']) else 'clean')")
  echo "gate $status" >> "$L/d24-ios-progress.log"
  case "$status" in
    *clean*ready*|*ready*clean*) exit 0 ;;
  esac
  if ! echo "$status" | grep -q "integ"; then
    rate=$(echo "$status" | awk '{print $2}')
    if python3 -c "import sys; sys.exit(0 if float('$rate')>=0.8 else 1)"; then exit 0; fi
  fi
done
