#!/usr/bin/env python3
"""Re-review skills that are blocked only by a failed blind review.

The campaign's --retry-failed flag stops a *failed* review from blocking its pair, so a pair
that already has a failing adjudication becomes eligible again. Every review is staged by the
campaign and persisted only through the sanctioned importer, one envelope at a time.
"""
import json
import os
import subprocess
import sys

REPO = "/Users/Shared/micah/Documents/koryphaios"
LOG = os.path.join(REPO, "outputs/skill-library-finish-plan/c-logs")


def run(cmd, out_path):
    with open(out_path, "w") as fh:
        subprocess.run(cmd, cwd=REPO, stdout=fh, stderr=subprocess.STDOUT)
    return out_path


def tail_json(path):
    raw = open(path).read()
    i = raw.rfind('{\n  "schemaVersion"')
    if i < 0:
        return None
    try:
        return json.loads(raw[i:])
    except Exception:
        return None


def main(skills):
    for skill in skills:
        out = os.path.join(LOG, f"rereview-{skill}.json")
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
        data = tail_json(out) or {}
        staged = data.get("stagedReviews") or []
        infra = data.get("infrastructureFailures") or 0
        print(
            f"{skill} staged={len(staged)} infra={infra} "
            f"available={data.get('availableAssignments')}",
            flush=True,
        )
        for item in staged:
            envelope = item.get("envelopePath")
            if not envelope:
                continue
            res = run(
                ["bun", "run", "scripts/run-skill-v5-blind-review.ts", f"--ingest={envelope}"],
                os.path.join(LOG, f"rereview-{skill}-ingest.json"),
            )
            text = open(res).read()
            ok = '"persistedReviews": 1' in text
            print(f"  ingest {os.path.basename(envelope)} -> {'persisted' if ok else 'refused'}",
                  flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
