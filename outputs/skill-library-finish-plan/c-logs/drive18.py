#!/usr/bin/env python3
"""Drive every runnable blocked skill toward ready, one evidenced round at a time.

Rules this driver will not break:
  * it never writes the ledger: pairs go through the qualification campaign and
    reviews through the sanctioned importer only;
  * a fresh pair is forced, never reused, so a review binds to an artifact that
    was actually produced under the current contract;
  * when a skill makes no progress in two consecutive rounds it is dropped, so a
    failing loop cannot quietly depress its own standing.
"""
import json
import os
import subprocess
import sys
import time

REPO = "/Users/Shared/micah/Documents/koryphaios"
LOG = os.path.join(REPO, "outputs/skill-library-finish-plan/c-logs")
DEADLINE = time.time() + float(os.environ.get("DRIVE_HOURS", "7.5")) * 3600
MAX_ROUNDS = int(os.environ.get("DRIVE_ROUNDS", "5"))

# react-engineering and literature-research are being driven by other agents in
# this same worktree; my campaigns only collide with theirs, so this driver leaves
# them alone rather than racing for the same pairs.
TARGETS = [
    "integration-implementation",
    "novel-ui-toolkit",
    "ios-swiftui",
]


def gate(skill):
    out = subprocess.run(
        ["bun", "run", "./.gate-probe.ts", skill], cwd=REPO, capture_output=True, text=True
    ).stdout
    for line in out.splitlines():
        if line.strip().startswith("{"):
            return json.loads(line)
    return {"status": "probe-failed", "reasons": []}


def scenarios(skill):
    found = []
    for root, _dirs, files in os.walk(os.path.join(REPO, "skills-v5", skill)):
        for name in files:
            if not name.endswith(".json"):
                continue
            try:
                text = open(os.path.join(root, name)).read()
            except OSError:
                continue
            for token in text.split('"id": "')[1:]:
                candidate = token.split('"')[0]
                if candidate.startswith(skill + "-full-task") and candidate not in found:
                    found.append(candidate)
    return sorted(found)


def run(cmd, log_name):
    with open(os.path.join(LOG, log_name), "w") as fh:
        return subprocess.run(cmd, cwd=REPO, stdout=fh, stderr=subprocess.STDOUT).returncode


def pairs(skill, tasks, stamp):
    ok = 0
    for task in tasks:
        if time.time() > DEADLINE:
            return ok
        log = f"{stamp}-{skill}-pair-{task.split('-')[-1]}.log"
        run(
            [
                "bun", "run", "scripts/run-skill-v5-qualification-campaign.ts",
                f"--skill={skill}", f"--scenario={task}", "--force",
                "--executor=codex", "--model=gpt-6-luna",
                "--concurrency=1", "--wall-clock-ms=1200000",
            ],
            log,
        )
        text = open(os.path.join(LOG, log)).read()
        if '"completed": 1' in text:
            ok += 1
        print(f"    pair {task}: {'completed' if '\"completed\": 1' in text else 'blocked-or-failed'}", flush=True)
    return ok


def review(skill, stamp):
    log = f"{stamp}-{skill}-review.json"
    run(
        [
            "bun", "run", "scripts/run-skill-v5-blind-review-campaign.ts",
            f"--skill={skill}",
            "--reviewer-adapter=scripts/kory-logfare-stateless-reviewer",
            "--reviewer-model=deepseek-v4.1-flash-1017",
            "--concurrency=1", "--retry-failed", "--max-per-skill=2",
            "--reasoning-effort=low",
        ],
        log,
    )
    raw = open(os.path.join(LOG, log)).read()
    start = raw.rfind('{\n  "schemaVersion"')
    data = json.loads(raw[start:]) if start >= 0 else {}
    staged = data.get("stagedReviews") or []
    persisted = 0
    for item in staged:
        envelope = item.get("envelopePath")
        if not envelope:
            continue
        ingest = f"{stamp}-{skill}-ingest.json"
        run(["bun", "run", "scripts/run-skill-v5-blind-review.ts", f"--ingest={envelope}"], ingest)
        if '"persistedReviews": 1' in open(os.path.join(LOG, ingest)).read():
            persisted += 1
    print(f"    review: staged={len(staged)} persisted={persisted} infra={data.get('infrastructureFailures')}", flush=True)
    return persisted


def main():
    stamp = "d19"
    results = {}
    for skill in TARGETS:
        if time.time() > DEADLINE:
            results[skill] = "deadline"
            continue
        tasks = scenarios(skill)
        stale = 0
        last = None
        for round_index in range(1, MAX_ROUNDS + 1):
            if time.time() > DEADLINE:
                break
            state = gate(skill)
            print(f"{skill} round {round_index}: {state.get('status')} pass={state.get('passRate')}", flush=True)
            if state.get("status") == "ready":
                break
            progressed = False
            # Pairs and a review never share a round: a review staged against one
            # pair is refused as stale the moment a newer pair for that case lands.
            do_pairs = (state.get("pairedCats", {}) or {}).get("full-task", 0) < 2 or (
                round_index % 2 == 1 and state.get("status") == "blocked"
            )
            if do_pairs:
                progressed = pairs(skill, tasks, f"{stamp}r{round_index}") > 0 or progressed
            else:
                progressed = review(skill, f"{stamp}r{round_index}") > 0 or progressed
            now = gate(skill)
            # Progress means the gate moved: more reviews staged for the same
            # artifact is not progress, and counting them as such let a failing
            # skill loop forever.
            key = (
                now.get("status"),
                round(now.get("passRate") or 0, 3),
                now.get("openRegr"),
                (now.get("pairedCats", {}) or {}).get("full-task", 0),
            )
            if key == last or not progressed:
                stale += 1
            else:
                stale = 0
            last = key
            if stale >= 2:
                print(f"{skill}: stopping after {round_index} rounds without progress", flush=True)
                break
        results[skill] = gate(skill).get("status")
        print(f"{skill} -> {results[skill]}", flush=True)
    with open(os.path.join(LOG, "d19-summary.json"), "w") as fh:
        json.dump({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "results": results}, fh, indent=1)


if __name__ == "__main__":
    main()
