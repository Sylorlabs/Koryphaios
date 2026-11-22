#!/usr/bin/env python3
"""Drive a list of skills toward ready: campaigns, regression rounds, blind reviews.

Never edits the ledger directly; every write goes through the sanctioned campaign and
blind-review importer. Stops a skill after a fixed number of rounds so a failing
predicate is not ground down repeatedly.
"""
import json
import os
import subprocess
import sys
import time

REPO = "/Users/Shared/micah/Documents/koryphaios"
LOG = os.path.join(REPO, "outputs/skill-library-finish-plan/c-logs")
MAX_ROUNDS = int(os.environ.get("MAX_ROUNDS", "4"))
WALL = os.environ.get("WALL", "900000")


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
    with open(os.path.join(LOG, f"d15-{skill}-{name}.out"), "w") as fh:
        subprocess.run(cmd, cwd=REPO, stdout=fh, stderr=subprocess.STDOUT)
    return True


def blind(skill):
    subprocess.run(["bash", os.path.join(LOG, "blind-drive.sh"), skill], cwd=REPO,
                   capture_output=True, text=True)
    path = os.path.join(LOG, f"{skill}.blind.json")
    raw = open(path).read() if os.path.exists(path) else ""
    i = raw.rfind('{\n  "schemaVersion"')
    if i < 0:
        return "no-json"
    data = json.loads(raw[i:])
    staged = data.get("stagedReviews") or []
    if not staged:
        return "no-staged"
    envelope = staged[0]["envelopePath"]
    res = subprocess.run(["bun", "run", "scripts/run-skill-v5-blind-review.ts",
                          f"--ingest={envelope}"], cwd=REPO, capture_output=True, text=True)
    return "ingested" if '"persistedReviews": 1' in res.stdout else "ingest-failed"


def needs(gate, needle):
    return any(needle in r for r in gate.get("reasons", []) if "Excluded" not in r)


def main():
    skills = sys.argv[1:]
    for skill in skills:
        for rnd in range(1, MAX_ROUNDS + 1):
            gate = probe(skill)
            if gate is None:
                print(f"{skill} probe-failed", flush=True)
                break
            if gate["status"] == "ready":
                print(f"{skill} ready after round {rnd-1}", flush=True)
                break
            blind_missing = gate["blind"] == 0 or needs(gate, "blind review")
            if blind_missing and gate["pairedCats"]["full-task"] >= 2 and not needs(gate, "integrity"):
                outcome = blind(skill)
                print(f"{skill} round {rnd} blind {outcome}", flush=True)
                continue
            if gate["openRegr"] > 0:
                campaign(skill, ("--open-regressions",))
                print(f"{skill} round {rnd} regression campaign", flush=True)
                continue
            campaign(skill)
            print(f"{skill} round {rnd} pair campaign", flush=True)
        gate = probe(skill)
        if gate:
            print(f"{skill} FINAL {gate['status']} pass={gate['passRate']:.3f} "
                  f"blind={gate['blind']} regr={gate['openRegr']}", flush=True)


if __name__ == "__main__":
    main()
