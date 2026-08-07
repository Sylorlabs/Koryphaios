#!/usr/bin/env python3
"""
Run the skill description optimization loop.

Evaluates the current skill description against trigger eval queries,
then iteratively improves the description for better triggering accuracy.

Usage:
    python run_loop.py --eval-set <trigger-eval.json> --skill-path <path-to-skill> --model <model-id> --max-iterations 5 --verbose

The eval set is split 60% train / 40% held-out test. Each query is run 3 times
to get a reliable trigger rate. The best description is selected by test score
to avoid overfitting.
"""

import argparse
import json
import random
import subprocess
import sys
from pathlib import Path


def run_trigger_check(query: str, skill_path: str, model: str, skill_name: str = None):
    """
    Check whether a skill triggers for a given query.

    Uses codex CLI to simulate a session where the skill is available.
    Returns True if the skill was invoked, False otherwise.
    """
    # Read the skill's current description
    skill_md = Path(skill_path) / "SKILL.md"
    if not skill_md.exists():
        return None

    content = skill_md.read_text()
    # Extract description from frontmatter
    import re
    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return None

    try:
        import yaml
        frontmatter = yaml.safe_load(match.group(1))
        description = frontmatter.get("description", "")
        name = frontmatter.get("name", skill_name or "")
    except Exception:
        return None

    # Build a prompt that asks whether this skill should be triggered
    prompt = f"""You are evaluating whether a skill should be triggered for a user query.

Skill name: {name}
Skill description: {description}

User query: "{query}"

Based on the skill description, should this skill be triggered for this query?
Answer with exactly one word: YES or NO"""

    try:
        result = subprocess.run(
            ["codex", "-p", prompt, "--model", model],
            capture_output=True,
            text=True,
            timeout=30,
        )
        answer = result.stdout.strip().upper()
        return "YES" in answer
    except Exception as e:
        print(f"  Warning: trigger check failed: {e}", file=sys.stderr)
        return None


def evaluate_description(eval_set: list, skill_path: str, model: str, runs_per_query: int = 3):
    """Evaluate the current description against the eval set. Returns accuracy."""
    correct = 0
    total = 0

    for item in eval_set:
        query = item["query"]
        should_trigger = item["should_trigger"]

        triggers = []
        for _ in range(runs_per_query):
            result = run_trigger_check(query, skill_path, model)
            if result is not None:
                triggers.append(result)

        if not triggers:
            continue

        # Majority vote
        triggered = sum(triggers) > len(triggers) / 2
        if triggered == should_trigger:
            correct += 1
        total += 1

    return correct / total if total > 0 else 0.0


def propose_improvement(skill_path: str, train_set: list, failures: list, model: str):
    """Ask the model to propose an improved description based on failures."""
    skill_md = Path(skill_path) / "SKILL.md"
    content = skill_md.read_text()

    import re
    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    frontmatter_text = match.group(1)

    try:
        import yaml
        frontmatter = yaml.safe_load(frontmatter_text)
        current_desc = frontmatter.get("description", "")
        name = frontmatter.get("name", "")
    except Exception:
        return None

    failures_text = "\n".join(
        f"  Query: \"{f['query']}\" — should trigger: {f['should_trigger']}, but got: {f.get('got', 'unknown')}"
        for f in failures
    )

    prompt = f"""You are optimizing a skill description for better triggering accuracy.

Skill name: {name}
Current description: {current_desc}

The current description failed on these queries:
{failures_text}

Propose an improved description that:
1. Keeps the same length or shorter (max 1024 chars)
2. Better covers the should-trigger cases that are being missed
3. Better excludes the should-not-trigger cases that are incorrectly matching
4. Stays specific and concrete — include both what the skill does AND when to use it

Output ONLY the new description text, nothing else. No quotes, no explanation."""

    try:
        result = subprocess.run(
            ["codex", "-p", prompt, "--model", model],
            capture_output=True,
            text=True,
            timeout=60,
        )
        return result.stdout.strip()
    except Exception as e:
        print(f"  Warning: improvement proposal failed: {e}", file=sys.stderr)
        return None


def update_description(skill_path: str, new_description: str):
    """Update the skill's SKILL.md with a new description."""
    skill_md = Path(skill_path) / "SKILL.md"
    content = skill_md.read_text()

    import re
    # Replace the description in frontmatter
    def replace_desc(match):
        fm = match.group(1)
        try:
            import yaml
            data = yaml.safe_load(fm)
            data["description"] = new_description
            new_fm = yaml.dump(data, default_flow_style=False, sort_keys=False)
            return f"---\n{new_fm}---"
        except Exception:
            return match.group(0)

    new_content = re.sub(r"^---\n(.*?)\n---", replace_desc, content, count=1, flags=re.DOTALL)
    skill_md.write_text(new_content)


def main():
    parser = argparse.ArgumentParser(description="Optimize skill description for triggering.")
    parser.add_argument("--eval-set", required=True, help="Path to trigger-eval JSON")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--model", required=True, help="Model ID for evaluation")
    parser.add_argument("--max-iterations", type=int, default=5, help="Max optimization iterations")
    parser.add_argument("--verbose", action="store_true", help="Verbose output")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = args.skill_path

    # Split 60/40 train/test
    random.seed(42)
    shuffled = eval_set.copy()
    random.shuffle(shuffled)
    split = int(len(shuffled) * 0.6)
    train_set = shuffled[:split]
    test_set = shuffled[split:]

    print(f"Eval set: {len(eval_set)} queries ({len(train_set)} train, {len(test_set)} test)")
    print(f"Skill: {skill_path}")
    print(f"Model: {args.model}")
    print()

    best_score = 0.0
    best_description = None
    results = []

    for iteration in range(args.max_iterations):
        print(f"--- Iteration {iteration + 1} ---")

        # Evaluate on train set
        train_score = evaluate_description(train_set, skill_path, args.model)
        test_score = evaluate_description(test_set, skill_path, args.model)
        print(f"  Train score: {train_score:.1%}")
        print(f"  Test score: {test_score:.1%}")

        results.append({
            "iteration": iteration + 1,
            "train_score": train_score,
            "test_score": test_score,
        })

        # Read current description
        skill_md = Path(skill_path) / "SKILL.md"
        content = skill_md.read_text()
        import re
        match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
        try:
            import yaml
            fm = yaml.safe_load(match.group(1))
            current_desc = fm.get("description", "")
        except Exception:
            current_desc = ""

        if test_score > best_score:
            best_score = test_score
            best_description = current_desc
            print(f"  New best! (test score: {test_score:.1%})")

        if train_score >= 1.0:
            print("  Perfect train score — stopping.")
            break

        # Find failures on train set
        failures = []
        for item in train_set:
            result = run_trigger_check(item["query"], skill_path, args.model)
            if result is not None and result != item["should_trigger"]:
                failures.append({**item, "got": result})

        if not failures:
            print("  No failures on train set — stopping.")
            break

        if args.verbose:
            print(f"  Failures: {len(failures)}")

        # Propose improvement
        new_desc = propose_improvement(skill_path, train_set, failures, args.model)
        if new_desc and len(new_desc) <= 1024:
            update_description(skill_path, new_desc)
            print(f"  Updated description ({len(new_desc)} chars)")
        else:
            print("  No valid improvement proposed — stopping.")
            break

        print()

    # Restore best description
    if best_description and best_description != current_desc:
        update_description(skill_path, best_description)
        print(f"Restored best description (test score: {best_score:.1%})")

    # Output results
    output = {
        "best_description": best_description,
        "best_test_score": best_score,
        "iterations": results,
    }
    print()
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
