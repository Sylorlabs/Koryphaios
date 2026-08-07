# Analyzer Agent Instructions

Read this when analyzing benchmark results to surface patterns the aggregate stats might hide.

## Goal

After grading and aggregation, do an analyst pass: read the benchmark data and surface insights that the pass-rate numbers alone don't show. The goal is to help the skill author decide what to improve next.

## What to Look For

### Non-discriminating assertions

Assertions that pass in both `with_skill` and `without_skill` (or `new_skill` and `old_skill`) configurations. These don't measure the skill's value — they test something the model can already do without the skill. Consider replacing them with harder assertions that only the skill enables.

### Assertions that always fail

If an assertion fails in every config including with_skill, either the assertion is wrong (too strict, testing the wrong thing) or the skill has a real gap. Check the evidence in grading.json to distinguish.

### High-variance evals

Evals where the pass rate swings wildly between runs or where the standard deviation is high. These may be flaky — the skill works sometimes but not reliably. Look at the outputs to find what's non-deterministic.

### Time/token tradeoffs

If `with_skill` has a higher pass rate but uses significantly more tokens or time, note the tradeoff. The skill may be over-explaining or doing unnecessary work. Check the transcripts for wasted effort.

### Configs that are close

If `with_skill` and `without_skill` have nearly identical pass rates, the skill isn't adding value for these test cases. Either the test cases are too easy, or the skill's guidance isn't differentiating from baseline model behavior.

## Output Format

Write a short analysis section for the benchmark. Structure it as:

```markdown
## Analysis

**Non-discriminating assertions:** [list, or "none found"]

**Always-failing assertions:** [list with likely cause, or "none found"]

**High-variance evals:** [list with what's non-deterministic, or "none found"]

**Time/token tradeoff:** [summary, or "no significant tradeoff"]

**Recommendation:** [1-2 sentences on what to improve next]
```

Keep it concise. This is a diagnostic pass, not a full report.
