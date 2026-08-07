#!/usr/bin/env python3
"""
Generate a self-contained HTML review file for skill evaluation results.

Usage:
    python generate_review.py <workspace>/iteration-N --skill-name "my-skill"
    python generate_review.py <workspace>/iteration-N --skill-name "my-skill" --benchmark benchmark.json
    python generate_review.py <workspace>/iteration-N --skill-name "my-skill" --static output.html
    python generate_review.py <workspace>/iteration-N --skill-name "my-skill" --previous-workspace <workspace>/iteration-(N-1)

Produces a standalone HTML file that lets the user:
- Click through each test case's output (Outputs tab)
- See quantitative benchmark comparison (Benchmark tab)
- Leave per-eval feedback that saves to feedback.json

In headless/no-display environments, use --static to write a standalone HTML file.
The "Submit All Reviews" button downloads feedback.json as a file.
"""

import argparse
import base64
import html
import json
import sys
from datetime import datetime
from pathlib import Path


def load_eval_metadata(eval_dir: Path):
    meta_path = eval_dir / "eval_metadata.json"
    if meta_path.exists():
        return json.loads(meta_path.read_text())
    return None


def load_grading(run_dir: Path):
    path = run_dir / "grading.json"
    if path.exists():
        return json.loads(path.read_text())
    return None


def load_outputs(run_dir: Path):
    outputs_dir = run_dir / "outputs"
    if not outputs_dir.exists():
        return []
    files = []
    for f in sorted(outputs_dir.rglob("*")):
        if f.is_file():
            files.append(f)
    return files


def read_output_content(file_path: Path, max_chars=50000):
    """Read file content, attempting to render text files inline."""
    suffix = file_path.suffix.lower()
    try:
        if suffix in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
            data = file_path.read_bytes()
            mime = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp",
            }.get(suffix, "image/png")
            b64 = base64.b64encode(data).decode()
            return f'<img src="data:{mime};base64,{b64}" style="max-width:100%;border:1px solid #ddd;border-radius:4px;" />'
        elif suffix in (".md",):
            content = file_path.read_text(errors="replace")[:max_chars]
            return f'<pre style="white-space:pre-wrap;">{html.escape(content)}</pre>'
        elif suffix in (".json",):
            content = file_path.read_text(errors="replace")[:max_chars]
            try:
                parsed = json.loads(content)
                content = json.dumps(parsed, indent=2)
            except Exception:
                pass
            return f'<pre style="white-space:pre-wrap;">{html.escape(content)}</pre>'
        elif suffix in (".html", ".htm"):
            content = file_path.read_text(errors="replace")[:max_chars]
            return f'<iframe srcdoc="{html.escape(content)}" style="width:100%;height:400px;border:1px solid #ddd;" sandbox=""></iframe>'
        else:
            content = file_path.read_text(errors="replace")[:max_chars]
            return f'<pre style="white-space:pre-wrap;">{html.escape(content)}</pre>'
    except Exception as e:
        return f'<p><em>Could not read {file_path.name}: {e}</em></p>'


def collect_evals(workspace: Path):
    """Collect all eval directories and their run configs."""
    evals = []
    for eval_dir in sorted(workspace.iterdir()):
        if not eval_dir.is_dir() or eval_dir.name.startswith("."):
            continue
        meta = load_eval_metadata(eval_dir)
        if meta is None:
            # Try to infer from directory structure
            meta = {"eval_id": len(evals), "eval_name": eval_dir.name, "prompt": "", "assertions": []}

        configs = {}
        for sub in sorted(eval_dir.iterdir()):
            if not sub.is_dir():
                continue
            if (sub / "grading.json").exists() or (sub / "outputs").exists():
                configs[sub.name] = {
                    "grading": load_grading(sub),
                    "outputs": load_outputs(sub),
                    "output_dir": sub / "outputs",
                }

        evals.append({
            "dir": eval_dir,
            "metadata": meta,
            "configs": configs,
        })
    return evals


def generate_html(workspace: Path, skill_name: str, benchmark: dict = None, previous_workspace: Path = None):
    evals = collect_evals(workspace)

    # Load previous iteration feedback if available
    prev_feedback = {}
    if previous_workspace:
        prev_feedback_path = previous_workspace / "feedback.json"
        if prev_feedback_path.exists():
            try:
                prev_data = json.loads(prev_feedback_path.read_text())
                for r in prev_data.get("reviews", []):
                    prev_feedback[r.get("run_id", "")] = r.get("feedback", "")
            except Exception:
                pass

    # Build eval data for JS
    eval_data = []
    for ev in evals:
        meta = ev["metadata"]
        configs_data = {}
        for config_name, config_info in ev["configs"].items():
            output_files = []
            for f in config_info["outputs"]:
                rel = str(f.relative_to(config_info["output_dir"]))
                content = read_output_content(f)
                output_files.append({"name": rel, "content": content})

            grading = config_info.get("grading", {})
            expectations = grading.get("expectations", []) if grading else []

            configs_data[config_name] = {
                "outputs": output_files,
                "expectations": expectations,
                "overall": grading.get("overall", "") if grading else "",
            }

        eval_data.append({
            "eval_id": meta.get("eval_id", 0),
            "eval_name": meta.get("eval_name", "unknown"),
            "prompt": meta.get("prompt", ""),
            "configs": configs_data,
        })

    benchmark_json = json.dumps(benchmark) if benchmark else "null"
    eval_data_json = json.dumps(eval_data)
    prev_feedback_json = json.dumps(prev_feedback)

    return HTML_TEMPLATE.replace("__EVAL_DATA__", eval_data_json) \
        .replace("__BENCHMARK_DATA__", benchmark_json) \
        .replace("__PREV_FEEDBACK__", prev_feedback_json) \
        .replace("__SKILL_NAME__", html.escape(skill_name)) \
        .replace("__WORKSPACE__", html.escape(str(workspace)))


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Skill Review: __SKILL_NAME__</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; line-height: 1.6; }
  .header { background: #161b22; padding: 16px 24px; border-bottom: 1px solid #30363d; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 18px; color: #f0f6fc; }
  .tabs { display: flex; gap: 0; background: #161b22; border-bottom: 1px solid #30363d; padding: 0 24px; }
  .tab { padding: 12px 20px; cursor: pointer; border-bottom: 2px solid transparent; color: #8b949e; font-size: 14px; }
  .tab.active { color: #f0f6fc; border-bottom-color: #58a6ff; }
  .tab:hover { color: #f0f6fc; }
  .content { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .eval-nav { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .eval-nav button { padding: 6px 12px; background: #21262d; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; cursor: pointer; font-size: 13px; }
  .eval-nav button.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .eval-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .prompt { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; margin-bottom: 16px; font-style: italic; color: #8b949e; }
  .config-section { margin-bottom: 16px; }
  .config-header { font-size: 15px; font-weight: 600; color: #f0f6fc; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #30363d; }
  .output-file { margin-bottom: 12px; }
  .output-file-name { font-size: 13px; color: #58a6ff; margin-bottom: 4px; font-family: monospace; }
  .output-content { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 8px; overflow-x: auto; }
  .grading { margin-top: 8px; }
  .grading-item { padding: 6px 0; border-bottom: 1px solid #21262d; font-size: 13px; }
  .grading-pass { color: #3fb950; }
  .grading-fail { color: #f85149; }
  .feedback-box { margin-top: 16px; }
  .feedback-box textarea { width: 100%; min-height: 80px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px; color: #c9d1d9; font-family: inherit; font-size: 14px; }
  .feedback-box label { display: block; font-size: 13px; color: #8b949e; margin-bottom: 4px; }
  .prev-feedback { margin-top: 8px; padding: 8px; background: #21262d; border-radius: 4px; font-size: 13px; color: #8b949e; }
  .submit-bar { position: sticky; bottom: 0; background: #161b22; border-top: 1px solid #30363d; padding: 12px 24px; display: flex; justify-content: flex-end; }
  .submit-btn { padding: 8px 20px; background: #238636; border: 1px solid #238636; border-radius: 6px; color: #fff; cursor: pointer; font-size: 14px; }
  .submit-btn:hover { background: #2ea043; }
  .benchmark-table { width: 100%; border-collapse: collapse; }
  .benchmark-table th, .benchmark-table td { padding: 8px 12px; border: 1px solid #30363d; text-align: left; font-size: 13px; }
  .benchmark-table th { background: #21262d; color: #f0f6fc; }
  .benchmark-table tr:nth-child(even) { background: #161b22; }
  .hidden { display: none; }
  .arrow { cursor: pointer; color: #58a6ff; font-size: 18px; user-select: none; }
  .nav-bar { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
</style>
</head>
<body>
<div class="header">
  <h1>__SKILL_NAME__ — Skill Review</h1>
  <span style="color:#8b949e;font-size:13px;">__WORKSPACE__</span>
</div>
<div class="tabs">
  <div class="tab active" onclick="showTab('outputs')">Outputs</div>
  <div class="tab" onclick="showTab('benchmark')">Benchmark</div>
</div>

<div id="outputs-tab" class="content">
  <div class="nav-bar">
    <span class="arrow" onclick="prevEval()">&#8592; Prev</span>
    <span id="eval-counter" style="color:#8b949e;font-size:14px;"></span>
    <span class="arrow" onclick="nextEval()">Next &#8594;</span>
  </div>
  <div id="eval-display"></div>
</div>

<div id="benchmark-tab" class="content hidden">
  <div id="benchmark-display"></div>
</div>

<div class="submit-bar">
  <button class="submit-btn" onclick="submitReviews()">Submit All Reviews</button>
</div>

<script>
const evalData = __EVAL_DATA__;
const benchmarkData = __BENCHMARK_DATA__;
const prevFeedback = __PREV_FEEDBACK__;
let currentEval = 0;
const feedback = {};

function showTab(tab) {
  document.getElementById('outputs-tab').classList.toggle('hidden', tab !== 'outputs');
  document.getElementById('benchmark-tab').classList.toggle('hidden', tab !== 'benchmark');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  if (tab === 'benchmark') renderBenchmark();
}

function renderEval() {
  const ev = evalData[currentEval];
  if (!ev) { document.getElementById('eval-display').innerHTML = '<p>No evals found.</p>'; return; }
  document.getElementById('eval-counter').textContent = `${currentEval + 1} / ${evalData.length} — ${ev.eval_name}`;

  let html = `<div class="eval-card">`;
  html += `<div class="prompt"><strong>Prompt:</strong><br>${escapeHtml(ev.prompt)}</div>`;

  const configOrder = ['with_skill', 'new_skill', 'without_skill', 'old_skill'];
  for (const cfgName of configOrder) {
    if (!ev.configs[cfgName]) continue;
    const cfg = ev.configs[cfgName];
    html += `<div class="config-section"><div class="config-header">${cfgName}</div>`;

    if (cfg.outputs && cfg.outputs.length > 0) {
      for (const out of cfg.outputs) {
        html += `<div class="output-file"><div class="output-file-name">${escapeHtml(out.name)}</div><div class="output-content">${out.content}</div></div>`;
      }
    } else {
      html += `<p style="color:#8b949e;">No output files found.</p>`;
    }

    if (cfg.expectations && cfg.expectations.length > 0) {
      html += `<div class="grading"><strong>Grades:</strong>`;
      for (const exp of cfg.expectations) {
        const cls = exp.passed ? 'grading-pass' : 'grading-fail';
        const icon = exp.passed ? '&#10003;' : '&#10007;';
        html += `<div class="grading-item"><span class="${cls}">${icon}</span> ${escapeHtml(exp.text)} <span style="color:#8b949e;">— ${escapeHtml(exp.evidence || '')}</span></div>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
  }

  // Feedback
  const runId = `${ev.eval_name}-with_skill`;
  const prev = prevFeedback[runId];
  html += `<div class="feedback-box"><label>Feedback for with_skill output:</label>`;
  html += `<textarea id="feedback-${currentEval}" oninput="saveFeedback(${currentEval}, this.value)" placeholder="Leave feedback..."></textarea>`;
  if (prev) html += `<div class="prev-feedback"><strong>Previous feedback:</strong> ${escapeHtml(prev)}</div>`;
  html += `</div>`;

  html += `</div>`;
  document.getElementById('eval-display').innerHTML = html;
  if (feedback[currentEval]) document.getElementById(`feedback-${currentEval}`).value = feedback[currentEval];
}

function saveFeedback(idx, val) { feedback[idx] = val; }
function prevEval() { if (currentEval > 0) { currentEval--; renderEval(); } }
function nextEval() { if (currentEval < evalData.length - 1) { currentEval++; renderEval(); } }

function renderBenchmark() {
  if (!benchmarkData) { document.getElementById('benchmark-display').innerHTML = '<p>No benchmark data. Run aggregate_benchmark.py first.</p>'; return; }
  let html = '';
  for (const cfg of benchmarkData.configs || []) {
    const agg = cfg.aggregate || {};
    html += `<h2 style="color:#f0f6fc;margin-bottom:8px;">${cfg.config}</h2>`;
    html += `<p style="color:#8b949e;margin-bottom:12px;">Mean pass rate: ${(agg.mean_pass_rate * 100).toFixed(1)}%`;
    if (agg.stddev_pass_rate) html += ` (±${(agg.stddev_pass_rate * 100).toFixed(1)}%)`;
    if (agg.mean_tokens) html += ` | Tokens: ${agg.mean_tokens.toFixed(0)}`;
    if (agg.mean_duration_seconds) html += ` | Duration: ${agg.mean_duration_seconds.toFixed(1)}s`;
    html += `</p>`;
    html += `<table class="benchmark-table"><tr><th>Eval</th><th>Passed</th><th>Total</th><th>Pass Rate</th><th>Tokens</th><th>Duration</th></tr>`;
    for (const e of cfg.evals || []) {
      html += `<tr><td>${e.eval_name}</td><td>${e.assertions_passed}</td><td>${e.assertions_total}</td><td>${(e.pass_rate * 100).toFixed(0)}%</td><td>${e.tokens || '-'}</td><td>${e.duration_seconds ? e.duration_seconds.toFixed(1) + 's' : '-'}</td></tr>`;
    }
    html += `</table><br>`;
  }
  if (benchmarkData.delta) {
    html += `<h2 style="color:#f0f6fc;">Delta</h2><table class="benchmark-table">`;
    for (const [k, v] of Object.entries(benchmarkData.delta)) {
      html += `<tr><td>${k}</td><td>${v}</td></tr>`;
    }
    html += `</table>`;
  }
  document.getElementById('benchmark-display').innerHTML = html;
}

function submitReviews() {
  const reviews = [];
  for (let i = 0; i < evalData.length; i++) {
    reviews.push({
      run_id: `${evalData[i].eval_name}-with_skill`,
      feedback: feedback[i] || '',
      timestamp: new Date().toISOString()
    });
  }
  const data = JSON.stringify({ reviews, status: 'complete' }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'feedback.json'; a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') prevEval();
  if (e.key === 'ArrowRight') nextEval();
});

renderEval();
</script>
</body>
</html>
"""


def main():
    parser = argparse.ArgumentParser(description="Generate skill eval review HTML.")
    parser.add_argument("workspace", help="Path to iteration-N directory")
    parser.add_argument("--skill-name", required=True, help="Name of the skill")
    parser.add_argument("--benchmark", help="Path to benchmark.json", default=None)
    parser.add_argument("--previous-workspace", help="Previous iteration workspace for feedback comparison", default=None)
    parser.add_argument("--static", help="Write standalone HTML to this path instead of stdout info", default=None)
    args = parser.parse_args()

    workspace = Path(args.workspace)
    if not workspace.exists():
        print(f"Error: workspace not found: {workspace}", file=sys.stderr)
        sys.exit(1)

    benchmark = None
    if args.benchmark:
        bpath = Path(args.benchmark)
        if bpath.exists():
            benchmark = json.loads(bpath.read_text())
    else:
        bpath = workspace / "benchmark.json"
        if bpath.exists():
            benchmark = json.loads(bpath.read_text())

    prev_ws = Path(args.previous_workspace) if args.previous_workspace else None

    html_content = generate_html(workspace, args.skill_name, benchmark, prev_ws)

    if args.static:
        out = Path(args.static)
        out.write_text(html_content)
        print(f"Wrote {out}")
        print(f"Open in browser: file://{out.resolve()}")
    else:
        out = workspace / "review.html"
        out.write_text(html_content)
        print(f"Wrote {out}")
        print(f"Open in browser: file://{out.resolve()}")


if __name__ == "__main__":
    main()
