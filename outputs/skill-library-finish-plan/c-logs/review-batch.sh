#!/bin/bash
# Prepare, review and ingest one provenanced blind review per skill, serially. The reviewer answers a
# persisted prompt; the envelope carries its identity; ingest validates and stores it. A skill whose
# review is already stored is skipped by the importer itself, so re-running is safe.
cd /Users/Shared/micah/Documents/koryphaios || exit 2
OUT=outputs/skill-library-finish-plan/c-logs
MODEL="${KORY_REVIEW_MODEL:-gemma-4-26b}"
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.config/opencode/opencode.json'))['provider']['logfare']['options']['apiKey'])")
for skill in "$@"; do
  echo "== $skill $(date -u +%FT%TZ)"
  prep=$(bun run scripts/run-skill-v5-blind-review.ts --skill="$skill" --prepare-only --concurrency=1 --max-per-skill=1 2>/dev/null)
  ids=$(printf '%s' "$prep" | python3 -c "
import json,os,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for a in d.get('preparedAssignments') or []: print(a['assignmentId'], a['promptPath'])
")
  [ -z "$ids" ] && { echo "   no assignment prepared"; continue; }
  echo "$ids" | while read -r id path; do
    KORY_LOGFARE_API_KEY="$KEY" KORY_LOGFARE_REVIEWER_MODEL="$MODEL" \
      bun run scripts/kory-logfare-stateless-reviewer.ts < "$path" > "$OUT/rv-$id.json" 2> "$OUT/rv-$id.log"
    python3 - "$id" "$OUT/rv-$id.json" "$OUT/rv-$id.envelope.json" <<'PY'
import json,os,sys
aid, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src))
if not d.get('completed'):
    print('   reviewer did not complete:', aid); sys.exit(0)
json.dump({'schemaVersion':1,'reviewer':{'agentId':d['reviewerId'],'provider':'logfare','model':os.environ.get('KORY_REVIEW_MODEL','gemma-4-26b')},
           'reviews':[{'assignmentId':aid,'output':d['output']}]}, open(dst,'w'), indent=1)
print('   envelope', aid)
PY
    bun run scripts/run-skill-v5-blind-review.ts --ingest="$OUT/rv-$id.envelope.json" --concurrency=1 --max-per-skill=1 2>&1 | grep -E "EEXIST|persistedReviews|failedReviews" | head -2 | cut -c1-90
  done
done
echo "== batch done $(date -u +%FT%TZ)"
