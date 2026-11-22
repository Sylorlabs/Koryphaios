#!/usr/bin/env python3
"""Produce the paired evidence the remaining blocked skills actually lack.

For each skill the campaign is asked for one fresh full-task pair per scenario, then a blind
review is staged for whatever pair exists at the current contract and persisted through the
sanctioned importer. Nothing is written to the ledger by hand.
"""
import json
import os
import subprocess
import sys

REPO = "/Users/Shared/micah/Documents/koryphaios"
LOG = os.path.join(REPO, "outputs/skill-library-finish-plan/c-logs")

TASKS = {
    "react-engineering": [
        "react-engineering-full-task-1-individual",
        "react-engineering-full-task-2-individual",
    ],
    "accessibility-verification": [
        "accessibility-verification-full-task-1",
        "accessibility-verification-full-task-2",
    ],
    "market-competitive-research": [
        "market-competitive-research-full-task-1-individual",
        "market-competitive-research-full-task-2-individual",
    ],
    "factual-research": [
        "factual-research-full-task-1-individual",
        "factual-research-full-task-2-individual",
    ],
}


def run(cmd, out_path):
    with open(out_path, "w") as fh:
        return subprocess.run(cmd, cwd=REPO, stdout=fh, stderr=subprocess.STDOUT).returncode


def pair(skill, scenario):
    out = os.path.join(LOG, f"d17-{skill}-{scenario.split('-')[-2]}.log")
    code = run(
        [
            "bun",
            "run",
            "scripts/run-skill-v5-qualification-campaign.ts",
            f"--skill={skill}",
            f"--scenario={scenario}",
            "--force",
            "--executor=codex",
            "--model=gpt-6-luna",
            "--concurrency=1",
            "--wall-clock-ms=900000",
        ],
        out,
    )
    text = open(out).read()
    ok = '"completed": 1' in text
    print(f"  pair {scenario} -> {'completed' if ok else 'failed'}", flush=True)
    return ok


def review(skill):
    out = os.path.join(LOG, f"d17-{skill}-review.json")
    run(
        [
            "bun",
            "run",
            "scripts/run-skill-v5-blind-review-campaign.ts",
            f"--skill={skill}",
            "--reviewer-adapter=scripts/kory-logfare-stateless-reviewer",
            "--reviewer-model=deepseek-v4.1-flash-1017",
            "--concurrency=1",
            "--retry-failed",
            "--max-per-skill=2",
            "--reasoning-effort=low",
        ],
        out,
    )
    raw = open(out).read()
    i = raw.rfind('{\n  "schemaVersion"')
    data = json.loads(raw[i:]) if i >= 0 else {}
    staged = data.get("stagedReviews") or []
    print(f"  review {skill} staged={len(staged)} infra={data.get('infrastructureFailures')}",
          flush=True)
    for item in staged:
        envelope = item.get("envelopePath")
        if not envelope:
            continue
        ing = os.path.join(LOG, f"d17-{skill}-ingest.json")
        run(["bun", "run", "scripts/run-skill-v5-blind-review.ts", f"--ingest={envelope}"], ing)
        print(f"    ingest {'persisted' if '\"persistedReviews\": 1' in open(ing).read() else 'refused'}",
              flush=True)


def main(skills):
    for skill in skills:
        print(skill, flush=True)
        for scenario in TASKS.get(skill, []):
            pair(skill, scenario)
        review(skill)


if __name__ == "__main__":
    main(sys.argv[1:])
