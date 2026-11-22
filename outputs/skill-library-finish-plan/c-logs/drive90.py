#!/usr/bin/env python3
"""Drive a list of already-ready skills to a pass rate of at least 0.9.

Only campaigns are used: no ledger writes, no threshold changes, no fixture edits. A round
is judged by the measured pass rate before and after. A skill stops when it reaches the
bar, when it stops improving, or when it has used its round budget. Progress is appended
to a state file so an interrupted run can be resumed.
"""
import json
import os
import subprocess
import sys

REPO = "/Users/Shared/micah/Documents/koryphaios"
LOG = os.path.join(REPO, "outputs/skill-library-finish-plan/c-logs")
BAR = float(os.environ.get("BAR", "0.9"))
MAX_ROUNDS = int(os.environ.get("MAX_ROUNDS", "8"))
WALL = os.environ.get("WALL", "900000")
STATE = os.path.join(LOG, "drive90-state.json")


def load_state():
    if os.path.exists(STATE):
        try:
            return json.load(open(STATE))
        except Exception:
            pass
    return {}


def save_state(state):
    with open(STATE, "w") as fh:
        json.dump(state, fh, indent=1, sort_keys=True)


def probe(skill):
    out = subprocess.run(
        ["bun", "run", "./.gate-probe.ts", skill],
        cwd=REPO, capture_output=True, text=True,
    ).stdout
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    return None


def campaign(skill, extra=()):
    cmd = ["bun", "run", "scripts/run-skill-v5-qualification-campaign.ts",
           f"--skill={skill}", "--executor=codex", "--model=gpt-6-luna",
           "--concurrency=1", f"--wall-clock-ms={WALL}", *extra]
    name = "regr" if "--open-regressions" in extra else "pair"
    path = os.path.join(LOG, f"d90-{skill}-{name}.out")
    with open(path, "w") as fh:
        subprocess.run(cmd, cwd=REPO, stdout=fh, stderr=subprocess.STDOUT)
    return path


def main(skills):
    state = load_state()
    for skill in skills:
        gate = probe(skill)
        if not gate:
            print(f"{skill} probe-failed", flush=True)
            continue
        rate = gate.get("passRate") or 0
        entry = state.setdefault(skill, {"start": rate, "rounds": 0})
        print(f"{skill} start pass={rate:.3f} status={gate['status']}", flush=True)
        while rate < BAR and entry["rounds"] < MAX_ROUNDS:
            if gate.get("status") != "ready":
                print(f"{skill} lost ready ({gate['status']}), stopping", flush=True)
                break
            before = rate
            if gate.get("openRegr", 0) > 0:
                campaign(skill, ("--open-regressions",))
                kind = "regression"
            else:
                campaign(skill)
                kind = "pair"
            entry["rounds"] += 1
            gate = probe(skill) or {}
            rate = gate.get("passRate") or 0
            entry["last"] = rate
            save_state(state)
            print(f"{skill} round {entry['rounds']} {kind}: {before:.3f} -> {rate:.3f} "
                  f"status={gate.get('status')} regr={gate.get('openRegr')}", flush=True)
            if rate <= before and entry["rounds"] >= 2:
                print(f"{skill} no longer improving, stopping", flush=True)
                break
        # A campaign can open a regression case it does not close. Restore the gate property
        # that was already true before this skill is reported on.
        closed = 0
        while gate.get("openRegr", 0) > 0 and closed < 3:
            campaign(skill, ("--open-regressions",))
            closed += 1
            gate = probe(skill) or {}
            print(f"{skill} regression repair {closed}: regr={gate.get('openRegr')} "
                  f"pass={(gate.get('passRate') or 0):.3f}", flush=True)
        rate = gate.get("passRate") or 0
        state[skill]["final"] = rate
        save_state(state)
        verdict = "reached" if rate >= BAR else "short"
        print(f"{skill} FINAL {verdict} pass={rate:.3f} rounds={entry['rounds']}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
