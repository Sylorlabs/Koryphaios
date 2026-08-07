#!/usr/bin/env python3
"""
Aggregate grading results into a benchmark.json and benchmark.md.

Usage:
    python -m aggregate_benchmark <workspace>/iteration-N --skill-name <name>

Reads grading.json and timing.json from each eval's run directories,
produces benchmark.json and benchmark.md in the iteration directory.
"""

import argparse
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path


def load_grading(run_dir: Path):
    grading_path = run_dir / "grading.json"
    if not grading_path.exists():
        return None
    return json.loads(grading_path.read_text())


def load_timing(run_dir: Path):
    timing_path = run_dir / "timing.json"
    if not timing_path.exists():
        return None
    return json.loads(timing_path.read_text())


def aggregate_config(config_dir: Path, config_name: str):
    """Aggregate all eval results for one configuration (with_skill, without_skill, etc.)."""
    eval_results = []

    for eval_dir in sorted(config_dir.iterdir()):
        if not eval_dir.is_dir():
            continue
        # Look for run directories under this eval that match the config
        run_dir = eval_dir / config_name
        if not run_dir.exists():
            # Also check eval_dir itself if it IS the run dir
            if eval_dir.name == config_name:
                run_dir = eval_dir
            else:
                continue

        grading = load_grading(run_dir)
        timing = load_timing(run_dir)

        if grading is None:
            continue

        expectations = grading.get("expectations", [])
        passed = sum(1 for e in expectations if e.get("passed"))
        total = len(expectations)
        pass_rate = passed / total if total > 0 else 0.0

        eval_result = {
            "eval_name": grading.get("eval_name", eval_dir.name),
            "assertions_passed": passed,
            "assertions_total": total,
            "pass_rate": pass_rate,
        }

        if timing:
            eval_result["tokens"] = timing.get("total_tokens")
            eval_result["duration_seconds"] = timing.get("total_duration_seconds")

        eval_results.append(eval_result)

    if not eval_results:
        return None

    pass_rates = [e["pass_rate"] for e in eval_results]
    tokens = [e["tokens"] for e in eval_results if e.get("tokens") is not None]
    durations = [e["duration_seconds"] for e in eval_results if e.get("duration_seconds") is not None]

    aggregate = {
        "mean_pass_rate": statistics.mean(pass_rates) if pass_rates else 0.0,
        "stddev_pass_rate": statistics.stdev(pass_rates) if len(pass_rates) > 1 else 0.0,
        "mean_tokens": statistics.mean(tokens) if tokens else None,
        "mean_duration_seconds": statistics.mean(durations) if durations else None,
    }

    return {
        "config": config_name,
        "evals": eval_results,
        "aggregate": aggregate,
    }


def compute_delta(configs):
    """Compute the delta between the first two configs."""
    if len(configs) < 2:
        return {}

    c1, c2 = configs[0]["aggregate"], configs[1]["aggregate"]
    delta = {}

    if c1.get("mean_pass_rate") is not None and c2.get("mean_pass_rate") is not None:
        delta["pass_rate_delta"] = round(c1["mean_pass_rate"] - c2["mean_pass_rate"], 4)

    if c1.get("mean_tokens") is not None and c2.get("mean_tokens") is not None:
        delta["token_delta"] = c1["mean_tokens"] - c2["mean_tokens"]

    if c1.get("mean_duration_seconds") is not None and c2.get("mean_duration_seconds") is not None:
        delta["duration_delta_seconds"] = round(
            c1["mean_duration_seconds"] - c2["mean_duration_seconds"], 2
        )

    return delta


def generate_markdown(benchmark: dict) -> str:
    lines = [f"# Benchmark: {benchmark['skill_name']}", ""]
    lines.append(f"Iteration: {benchmark['iteration']}")
    lines.append(f"Generated: {benchmark['generated_at']}")
    lines.append("")

    for config in benchmark["configs"]:
        agg = config["aggregate"]
        lines.append(f"## {config['config']}")
        lines.append("")
        lines.append(f"- Mean pass rate: {agg['mean_pass_rate']:.1%} (±{agg['stddev_pass_rate']:.1%})")
        if agg.get("mean_tokens"):
            lines.append(f"- Mean tokens: {agg['mean_tokens']:.0f}")
        if agg.get("mean_duration_seconds"):
            lines.append(f"- Mean duration: {agg['mean_duration_seconds']:.1f}s")
        lines.append("")

        lines.append("| Eval | Passed | Total | Pass Rate | Tokens | Duration |")
        lines.append("|------|--------|-------|-----------|--------|----------|")
        for e in config["evals"]:
            tokens = f"{e['tokens']:.0f}" if e.get("tokens") else "-"
            dur = f"{e['duration_seconds']:.1f}s" if e.get("duration_seconds") else "-"
            lines.append(
                f"| {e['eval_name']} | {e['assertions_passed']} | {e['assertions_total']} | "
                f"{e['pass_rate']:.0%} | {tokens} | {dur} |"
            )
        lines.append("")

    delta = benchmark.get("delta", {})
    if delta:
        lines.append("## Delta (with_skill vs baseline)")
        lines.append("")
        for key, val in delta.items():
            lines.append(f"- {key}: {val}")
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Aggregate grading results into benchmark.json and benchmark.md."
    )
    parser.add_argument("workspace", help="Path to iteration-N directory")
    parser.add_argument("--skill-name", required=True, help="Name of the skill being evaluated")
    args = parser.parse_args()

    workspace = Path(args.workspace)
    if not workspace.exists():
        print(f"Error: workspace not found: {workspace}", file=sys.stderr)
        sys.exit(1)

    # Discover configs by scanning eval directories
    config_names = set()
    for eval_dir in workspace.iterdir():
        if not eval_dir.is_dir() or eval_dir.name.startswith("."):
            continue
        for sub in eval_dir.iterdir():
            if sub.is_dir() and (sub / "grading.json").exists():
                config_names.add(sub.name)
        # Also check if eval_dir itself has grading.json
        if (eval_dir / "grading.json").exists():
            config_names.add(eval_dir.name)

    if not config_names:
        print(f"Error: no grading.json files found under {workspace}", file=sys.stderr)
        sys.exit(1)

    # Order: with_skill/new_skill first, then without_skill/old_skill
    priority = ["with_skill", "new_skill", "without_skill", "old_skill"]
    ordered = sorted(config_names, key=lambda c: priority.index(c) if c in priority else len(priority))

    configs = []
    for name in ordered:
        result = aggregate_config(workspace, name)
        if result:
            configs.append(result)

    benchmark = {
        "skill_name": args.skill_name,
        "iteration": int(workspace.name.split("-")[-1]) if "-" in workspace.name else 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "configs": configs,
        "delta": compute_delta(configs),
    }

    benchmark_path = workspace / "benchmark.json"
    benchmark_path.write_text(json.dumps(benchmark, indent=2))
    print(f"Wrote {benchmark_path}")

    md_path = workspace / "benchmark.md"
    md_path.write_text(generate_markdown(benchmark))
    print(f"Wrote {md_path}")


if __name__ == "__main__":
    main()
