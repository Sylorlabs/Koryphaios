#!/usr/bin/env bash
# Read-only orchestration helper for one skill: deterministic rounds, regression
# closure, and blind review staging. It never ingests a review; ingestion stays a
# manual step so a review of a failed pair cannot land.
set -u
skill="${1:?skill name required}"
root="/Users/Shared/micah/Documents/koryphaios"
log="$root/outputs/skill-library-finish-plan/campaign/x-$skill.log"
cd "$root" || exit 1
: > "$log"

gate_regr() {
  bun run --no-env-file scripts/tmp-one.ts "$skill" 2>/dev/null \
    | grep -o 'regr=[0-9]*' | head -1 | cut -d= -f2
}
gate_state() {
  bun run --no-env-file scripts/tmp-one.ts "$skill" 2>/dev/null | grep -o '\[[a-z-]*\]' | head -1
}

echo "=== $skill round 1" >> "$log"
bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts \
  --skill="$skill" --executor=codex --model=gpt-5.6-sol \
  --wall-clock-ms=900000 --force --concurrency=1 2>&1 \
  | grep -E '"type":"(progress|summary)"' >> "$log"

for attempt in 1 2 3; do
  regr="$(gate_regr)"
  echo "=== $skill regressions after round: ${regr:-?} (state $(gate_state))" >> "$log"
  if [ -z "$regr" ] || [ "$regr" = "0" ]; then break; fi
  echo "=== $skill open-regressions attempt $attempt" >> "$log"
  bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts \
    --skill="$skill" --executor=codex --model=gpt-5.6-sol \
    --open-regressions --wall-clock-ms=900000 --concurrency=1 2>&1 \
    | grep -E '"type":"(progress|summary)"' >> "$log"
done

echo "=== $skill final: $(gate_state) regr=$(gate_regr)" >> "$log"
echo "=== $skill staging blind review" >> "$log"
KORY_SKILL_BLIND_REVIEWER_PROVIDER=logfare bun run --no-env-file \
  scripts/run-skill-v5-blind-review-campaign.ts --skill="$skill" \
  --reviewer-adapter=scripts/kory-logfare-stateless-reviewer \
  --reviewer-model=deepseek-v4.1-flash-1017 --concurrency=1 --retry-failed \
  --max-reviewer-attempts=3 2>&1 | grep -E '"reviewed"|"failures"' >> "$log"
echo "=== $skill done" >> "$log"
