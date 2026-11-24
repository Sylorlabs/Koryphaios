#!/bin/bash
# Serialize every command that writes .koryphaios/skills/evaluations.json.
# Usage: scripts/with-skill-ledger-lock.sh <command> [args...]
lock="${KORY_SKILL_LEDGER_LOCK:-/tmp/kory-skill-ledger.lock}"
until mkdir "$lock" 2>/dev/null; do
  holder=$(cat "$lock/pid" 2>/dev/null)
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$lock"; continue; fi
  sleep 5
done
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT INT TERM
"$@"
