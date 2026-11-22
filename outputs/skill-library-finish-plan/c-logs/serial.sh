#!/usr/bin/env bash
# Serial closure rounds: one campaign at a time so no run hits the 420s budget.
set -u
L=outputs/skill-library-finish-plan/c-logs
skill="$1"; scenario="$2"; rounds="${3:-3}"
for i in $(seq 1 "$rounds"); do
  echo "== round $i $skill $scenario $(date -u +%H:%M:%SZ)"
  ./"$L"/target-drive.sh "$skill" "$scenario" 1 >> "$L/serial-$skill.log" 2>&1
done
echo "SERIAL DONE $skill $(date -u +%H:%M:%SZ)"
