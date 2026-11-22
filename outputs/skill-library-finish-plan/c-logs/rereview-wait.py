#!/usr/bin/env python3
"""Wait for the blind reviewer endpoint to stop returning 503, then re-review.

The reviewer provider answers /v1/models but every chat completion returns
503 Service temporarily unavailable, so no review can be dispatched. This polls
the exact model the campaign uses and only starts the campaign once that model
answers a real completion. Nothing is written to the ledger here: staged reviews
are persisted later through the sanctioned importer.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = "/Users/Shared/micah/Documents/koryphaios"
MODEL = "deepseek-v4.1-flash-1017"
BASE = "https://logfare.ai/v1"


def api_key():
    from_env = os.environ.get("KORY_LOGFARE_API_KEY", "").strip()
    if from_env:
        return from_env
    with open(os.path.join(REPO, "config.json")) as fh:
        config = json.load(fh)
    key = config.get("provider", {}).get("logfare", {}).get("options", {}).get("apiKey")
    return (key or "").strip()


def probe(key):
    body = json.dumps(
        {
            "model": MODEL,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 8,
            "reasoning_effort": "none",
        }
    ).encode()
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return resp.status, resp.read(200)
    except urllib.error.HTTPError as err:
        return err.code, err.read(200)
    except Exception as err:  # network failure
        return 0, str(err).encode()[:200]


def main(skills):
    key = api_key()
    deadline = time.time() + 75 * 60
    while time.time() < deadline:
        status, body = probe(key)
        print(f"{time.strftime('%H:%M:%S')} probe {status} {body[:80]!r}", flush=True)
        if status == 200:
            print("reviewer healthy; starting re-review", flush=True)
            return subprocess.call(
                [sys.executable, os.path.join(REPO, "outputs/skill-library-finish-plan/c-logs/rereview.py"), *skills],
                cwd=REPO,
            )
        time.sleep(300)
    print("reviewer still unavailable after 75 minutes", flush=True)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
