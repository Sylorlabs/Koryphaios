---
name: skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy. Even for simple requests like "make me a skill for X" or "improve this skill" — this skill has the full eval loop, benchmarking, and description optimization machinery.
metadata:
  koryphaios:
    version: 1.0.0
    baseVersion: 1.0.0
    baseHash: __BASE_HASH__
    parent:
    depth: 0
    requires: []
    conflicts: []
    activation: ["create a skill", "make a skill", "improve a skill", "skill eval", "benchmark skill", "optimize skill description"]
    excludes: []
    domains: ["skills"]
    targetMedia: ["any"]
    shouldTrigger: ["create a skill for generating SQL", "improve this skill", "run evals on my skill"]
    shouldNotTrigger: ["fix a CSS bug", "deploy to AWS"]
    evidence: ["Skill structure validation", "Eval results and benchmark"]
    contextBudget: 8000
    sourceScope: local-only
---

# Skill Creator

A skill for creating new skills and iteratively improving them. The core loop:

1. Understand what the skill should do and when it should trigger
2. Write a draft of the skill
3. Create test prompts and run them (with-skill AND baseline) in parallel
4. Evaluate results — both qualitatively (human review) and quantitatively (benchmarks)
5. Improve the skill based on feedback
6. Repeat until the skill is genuinely good
7. Optimize the description for triggering accuracy

Jump in wherever the user is in this process. If they already have a draft, go straight to evals. If they say "just vibe with me", do that instead. Be flexible.

## Communicating with the User

Skill creators are used by people across a wide range of coding familiarity. Pay attention to context cues. For terms like "JSON" and "assertion", look for serious cues before using them without explanation. It's fine to briefly explain terms if in doubt. For "evaluation" and "benchmark", those are borderline but OK.

## About Skills

Skills are modular, self-contained folders that extend Codex's capabilities by providing specialized knowledge, workflows, and tools. They transform Codex from a general-purpose agent into a specialized agent equipped with procedural knowledge that no model can fully possess.

### What Skills Provide

1. Specialized workflows — Multi-step procedures for specific domains
2. Tool integrations — Instructions for working with specific file formats or APIs
3. Domain expertise — Company-specific knowledge, schemas, business logic
4. Bundled resources — Scripts, references, and assets for complex and repetitive tasks

## Core Principles

### Concise is Key

The context window is a public good. Skills share it with everything else: system prompt, conversation history, other skills' metadata, and the actual user request.

**Default assumption: Codex is already very smart.** Only add context Codex doesn't already have. Challenge each piece: "Does Codex really need this?" and "Does this paragraph justify its token cost?" Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

Match specificity to the task's fragility and variability:

| Freedom level | When to use | Example |
|--------------|-------------|---------|
| High (text instructions) | Multiple valid approaches, context-dependent decisions | Writing style guidance |
| Medium (pseudocode/parameterized scripts) | Preferred pattern exists, some variation OK | API call with configurable params |
| Low (specific scripts, few params) | Fragile operations, consistency critical, exact sequence required | PDF rotation, secret handling |

Think of Codex exploring a path: a narrow bridge with cliffs needs guardrails (low freedom), while an open field allows many routes (high freedom).

### Explain the Why, Not Just the What

Today's LLMs are smart and have good theory of mind. When given a good harness they go beyond rote instructions. Explain the reasoning behind instructions rather than using rigid MUSTs. If you find yourself writing ALWAYS or NEVER in all caps, reframe to explain why. This is more humane, powerful, and effective.

### Generalize, Don't Overfit

Skills are used many times across many different prompts. When iterating on a few test examples, the big risk is overfitting — making the skill work only for those examples. Rather than adding fiddly overfit changes or oppressively constrictive rules, try branching out with different metaphors or patterns. It's cheap to try and might land on something great.

### Protect Validation Integrity

When using subagents to validate, treat that as an evaluation surface. The goal is to learn whether the skill generalizes, not whether another agent can reconstruct the answer from leaked context.

Prefer raw artifacts (example prompts, outputs, diffs, logs). Give the minimum task-local context needed. Avoid passing the intended answer, suspected bug, or prior conclusions unless validation explicitly requires them.

## Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
├── agents/ (recommended)
│   └── openai.yaml - UI metadata for skill lists and chips
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons, fonts)
```

### SKILL.md (required)

- **Frontmatter** (YAML): `name` and `description` fields. These are the only fields Codex reads to determine when the skill gets used — be clear and comprehensive about what the skill is and when to use it.
- **Body** (Markdown): Instructions and guidance. Only loaded AFTER the skill triggers.

### Agents metadata (recommended)

- UI-facing metadata for skill lists and chips
- Read `references/openai_yaml.md` before generating values
- Generate deterministically by passing values as `--interface key=value` to `scripts/generate_openai_yaml.py` or `scripts/init_skill.py`
- On updates: validate `agents/openai.yaml` still matches SKILL.md; regenerate if stale

### Bundled Resources

**Scripts** (`scripts/`): Executable code for tasks that require deterministic reliability or are repeatedly rewritten. Token efficient, deterministic, may be executed without loading into context. Scripts may still need to be read by Codex for patching.

**References** (`references/`): Documentation loaded as needed into context. Keeps SKILL.md lean. For large files (>10k words), include grep search patterns in SKILL.md. Information should live in either SKILL.md or references, not both.

**Assets** (`assets/`): Files not loaded into context but used in output Codex produces. Templates, images, icons, boilerplate code, fonts.

### What NOT to Include

Do not create extraneous documentation: README.md, INSTALLATION_GUIDE.md, QUICK_REFERENCE.md, CHANGELOG.md, etc. The skill should only contain information needed for an AI agent to do the job. Creating additional documentation files adds clutter and confusion.

## Progressive Disclosure

Skills use a three-level loading system:

1. **Metadata** (name + description) — Always in context (~100 words)
2. **SKILL.md body** — When skill triggers (<500 lines ideal)
3. **Bundled resources** — As needed (unlimited, scripts can execute without loading)

Keep SKILL.md under 500 lines. When approaching this limit, split content into reference files with clear pointers about when to read them.

**Key patterns:**

- **High-level guide with references**: Core workflow in SKILL.md, details in linked reference files
- **Domain organization**: `references/finance.md`, `references/sales.md` — Codex reads only the relevant one
- **Variant organization**: `references/aws.md`, `references/gcp.md` — Codex reads only the chosen variant
- **Conditional details**: Basic content inline, advanced features linked

Keep references one level deep from SKILL.md. For files longer than 100 lines, include a table of contents at the top.

## Skill Creation Process

1. Understand the skill with concrete examples
2. Plan reusable skill contents (scripts, references, assets)
3. Initialize the skill (run `init_skill.py`)
4. Edit the skill (implement resources and write SKILL.md)
5. Validate the skill (run `quick_validate.py`)
6. Test and evaluate (run test cases, benchmark, review)
7. Iterate based on feedback and benchmarks
8. Optimize the description for triggering

Follow these steps in order, skipping only when there's a clear reason.

### Skill Naming

- Lowercase letters, digits, hyphens only; normalize user-provided titles to hyphen-case
- Under 64 characters; prefer short, verb-led phrases
- Namespace by tool when it improves clarity or triggering (e.g., `gh-address-comments`)
- Name the skill folder exactly after the skill name

### Step 1: Understand the Skill with Concrete Examples

Gather concrete examples of how the skill will be used. Ask:
- "What functionality should the skill support?"
- "Can you give examples of how this skill would be used?"
- "What would a user say that should trigger this skill?"
- "Where should I create this skill?" (default: `$CODEX_HOME/skills` or `~/.codex/skills`)

Avoid overwhelming users with too many questions at once. Start with the most important and follow up as needed. Conclude when there's a clear sense of the functionality.

### Step 2: Plan Reusable Skill Contents

Analyze each concrete example:
1. Consider how to execute it from scratch
2. Identify what scripts, references, and assets would help when doing this repeatedly

| Example query | Analysis | Reusable resource |
|--------------|----------|-------------------|
| "Rotate this PDF" | Same rotation code rewritten each time | `scripts/rotate_pdf.py` |
| "Build me a todo app" | Same HTML/React boilerplate each time | `assets/hello-world/` template |
| "How many users logged in today?" | Table schemas rediscovered each time | `references/schema.md` |

### Step 3: Initialize the Skill

Run `init_skill.py` to create the skill directory with template SKILL.md, agents/openai.yaml, and optional resource directories.

```bash
scripts/init_skill.py <skill-name> --path <output-directory> [--resources scripts,references,assets] [--examples] [--interface key=value]
```

Default path: `${CODEX_HOME:-$HOME/.codex}/skills`. Skip this step if the skill already exists.

### Step 4: Edit the Skill

Write for another instance of Codex. Include information that is beneficial and non-obvious. Consider what procedural knowledge, domain-specific details, or reusable assets would help another Codex instance execute these tasks more effectively.

Start with reusable resources (`scripts/`, `references/`, `assets/`). Test added scripts by actually running them. Then write SKILL.md.

**Writing guidelines:** Use imperative/infinitive form. Always include both what the skill does AND specific triggers/contexts in the `description` field — all "when to use" info goes there, not in the body. The body is only loaded after triggering.

### Step 5: Validate the Skill

```bash
scripts/quick_validate.py <path/to/skill-folder>
```

Checks YAML frontmatter format, required fields, and naming rules. Fix reported issues and re-run.

## Testing and Evaluation

After the skill draft is written, test it. This is the heart of creating a skill that actually works — not one that just looks good on paper.

### Step 6: Create Test Cases

Come up with 2-3 realistic test prompts — the kind of thing a real user would actually say. Share them with the user: "Here are a few test cases I'd like to try. Do these look right, or do you want to add more?" Then run them.

Save test cases to `evals/evals.json` in the skill directory. Don't write assertions yet — just the prompts. You'll draft assertions while the runs are in progress.

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 0,
      "prompt": "User's task prompt with realistic specifics",
      "expected_output": "Description of expected result",
      "files": []
    }
  ]
}
```

For the full schema (including assertions, grading, benchmark, timing, feedback, and trigger-eval formats), see `references/evals-and-schemas.md`.

### Step 7: Run Test Cases

For each test case, spawn two subagents in the same turn — one with the skill, one without. Launch everything at once so it all finishes around the same time.

**With-skill run:**
```
Execute this task:
- Skill path: <path-to-skill>
- Task: <eval prompt>
- Input files: <eval files or "none">
- Save outputs to: <workspace>/iteration-1/eval-<name>/with_skill/outputs/
- Outputs to save: <what the user cares about>
```

**Baseline run** (same prompt, no skill):
- Creating a new skill: no skill at all. Save to `without_skill/outputs/`.
- Improving an existing skill: snapshot the old skill first (`cp -r <skill-path> <workspace>/skill-snapshot/`), point baseline at the snapshot. Save to `old_skill/outputs/`.

Put results in `<skill-name>-workspace/` as a sibling to the skill directory. Organize by iteration (`iteration-1/`, `iteration-2/`) and within that, each test case gets a directory named after its eval (`eval-<descriptive-name>/`).

Write `eval_metadata.json` for each eval (assertions can be empty for now). Give each eval a descriptive name — not just "eval-0".

### Step 8: Draft Assertions While Runs Are In Progress

Don't just wait — draft quantitative assertions for each test case. Good assertions are objectively verifiable with descriptive names. Subjective skills (writing style, design) are better evaluated qualitatively — don't force assertions onto things that need human judgment.

Update `eval_metadata.json` and `evals/evals.json` with the assertions. See `references/evals-and-schemas.md` for the exact format.

### Step 9: Capture Timing Data

When each subagent task completes, save `total_tokens` and `duration_ms` from the notification to `timing.json` in the run directory immediately. This data isn't persisted elsewhere — process each notification as it arrives.

### Step 10: Grade, Aggregate, and Review

Once all runs are done:

1. **Grade each run** — spawn a grader subagent (read `references/grader.md` for instructions) or grade inline. Evaluate each assertion against outputs. Save to `grading.json` using fields `text`, `passed`, `evidence`. For programmatic checks, write and run a script rather than eyeballing.

2. **Aggregate into benchmark** — run the aggregation script:
   ```bash
   python scripts/aggregate_benchmark.py <workspace>/iteration-N --skill-name <name>
   ```
   Produces `benchmark.json` and `benchmark.md` with pass_rate, time, and tokens per config, with mean ± stddev and the delta.

3. **Analyst pass** — read the benchmark and surface patterns: non-discriminating assertions (pass in both configs), high-variance evals (flaky), always-failing assertions, time/token tradeoffs. See `references/analyzer.md`.

4. **Generate the review viewer**:
   ```bash
   python scripts/generate_review.py <workspace>/iteration-N --skill-name "my-skill" --benchmark <workspace>/iteration-N/benchmark.json
   ```
   For iteration 2+, also pass `--previous-workspace <workspace>/iteration-(N-1)`.
   In headless/no-display environments, use `--static <output.html>` to write a standalone HTML file.

5. **Tell the user**: "I've generated the review. There are two tabs — 'Outputs' lets you click through each test case and leave feedback, 'Benchmark' shows the quantitative comparison. When you're done, submit your reviews and let me know."

### Step 11: Read Feedback and Improve

When the user is done, read `feedback.json`. Empty feedback means fine. Focus improvements on test cases with specific complaints.

When improving the skill:
- **Generalize from feedback** — don't overfit to the test examples
- **Keep the prompt lean** — remove things not pulling their weight
- **Explain the why** — help the model understand why things matter
- **Look for repeated work** — if all test cases independently wrote similar helper scripts, bundle that script into the skill

### The Iteration Loop

After improving:
1. Apply improvements to the skill
2. Rerun all test cases into `iteration-<N+1>/`, including baselines
3. Generate the reviewer with `--previous-workspace` pointing at the previous iteration
4. Wait for user review
5. Read feedback, improve, repeat

Keep going until: the user is happy, feedback is all empty, or you're not making meaningful progress.

## Description Optimization

The `description` field in SKILL.md frontmatter is the primary mechanism that determines whether Codex invokes a skill. After creating or improving a skill, offer to optimize the description for better triggering accuracy.

### Generate Trigger Eval Queries

Create 20 eval queries — a mix of should-trigger (8-10) and should-not-trigger (8-10). Save as JSON. See `references/evals-and-schemas.md` for the `trigger-eval.json` format.

Queries must be realistic — concrete and specific with detail like file paths, personal context, column names, company names. Some in lowercase, with typos or casual speech. Focus on edge cases, not clear-cut ones.

For should-trigger: different phrasings of the same intent, cases where the user doesn't explicitly name the skill, uncommon use cases.

For should-not-trigger: near-misses that share keywords but need something different. Not obviously irrelevant — genuinely tricky.

### Run the Optimization Loop

```bash
python scripts/run_loop.py \
  --eval-set <path-to-trigger-eval.json> \
  --skill-path <path-to-skill> \
  --model <model-id> \
  --max-iterations 5 \
  --verbose
```

This splits the eval set 60% train / 40% held-out test, evaluates the current description (3 runs per query for reliability), proposes improvements based on failures, and re-evaluates. The best description is selected by test score to avoid overfitting.

Take `best_description` from the output and update the skill's frontmatter. Show the user before/after and report the scores.

## Forward-Testing

To forward-test, launch subagents to stress-test the skill with minimal context. Subagents should not know they are testing the skill — treat them as agents asked to perform a task by the user.

Prompt like: `Use $skill-x at /path/to/skill-x to solve problem y`
Not: `Review the skill at /path/to/skill-x; pretend a user asks you to...`

Decision rule: err on the side of forward-testing. Ask for approval if there's risk it would take a long time, require additional approvals, or modify live production systems.

Considerations:
- Use fresh threads for independent passes
- Pass raw artifacts, not your conclusions
- Avoid showing expected answers or intended fixes
- Rebuild context from source artifacts after each iteration
- Clean up subagents' artifacts between iterations to avoid contamination

If forward-testing only succeeds when subagents see leaked context, tighten the skill or the forward-testing setup before trusting the result.

## Reference Map

Read only what you need:

- `references/openai_yaml.md` — `agents/openai.yaml` field definitions and examples
- `references/evals-and-schemas.md` — JSON structures for evals.json, grading.json, benchmark.json, timing.json, feedback.json, trigger-eval.json
- `references/grader.md` — Instructions for grading assertions against outputs
- `references/analyzer.md` — Instructions for analyzing benchmark results

## Scripts

- `scripts/init_skill.py` — Create a new skill directory with template SKILL.md and openai.yaml
- `scripts/generate_openai_yaml.py` — Generate or update agents/openai.yaml
- `scripts/quick_validate.py` — Validate skill structure (frontmatter, naming, required fields)
- `scripts/aggregate_benchmark.py` — Aggregate grading results into benchmark.json and benchmark.md
- `scripts/generate_review.py` — Generate HTML review viewer for eval results
- `scripts/run_loop.py` — Run description optimization loop for triggering accuracy
