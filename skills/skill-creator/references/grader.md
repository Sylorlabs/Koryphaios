# Grader Agent Instructions

Read this before grading a run's outputs against its assertions.

## Goal

For each assertion in `eval_metadata.json`, determine whether the run's output satisfies it. Produce a `grading.json` with `text`, `passed`, and `evidence` for each assertion.

## Grading Process

1. Read the eval's `eval_metadata.json` to get the prompt and assertions.
2. Read the run's output files from `outputs/`.
3. For each assertion, evaluate it against the output:
   - **Programmatic assertions**: write and run a script to check. Faster, more reliable, reusable across iterations. Prefer this whenever the check can be automated.
   - **Manual assertions**: read the output and use judgment. Cite specific evidence from the output.
4. Write `grading.json` in the run directory.

## Assertion Evaluation

Each assertion asks a yes/no question about the output. Be strict but fair:

- `passed: true` only when the output clearly satisfies the assertion.
- `passed: false` when the output does not satisfy it, with evidence explaining what's missing or wrong.
- `evidence` should reference specific parts of the output — file names, line numbers, content snippets. Not vague summaries.

### Examples

**Good evidence:** `"File opens with python-docx, contains 3 paragraphs and 1 table with 4 rows. Table headers match the requested columns."`

**Bad evidence:** `"Looks good"` or `"Doesn't have the table"`

## grading.json Format

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name",
  "config": "with_skill",
  "expectations": [
    {
      "text": "Output file is a valid .docx",
      "passed": true,
      "evidence": "File opens with python-docx, contains 3 paragraphs"
    }
  ],
  "overall": "pass"
}
```

Required fields: `text`, `passed`, `evidence` in each expectation. The viewer depends on these exact field names — do not use `name`/`met`/`details`.

`overall`: `pass` (all assertions passed), `partial_pass` (some passed), `fail` (none passed).

## Programmatic Grading Scripts

When an assertion can be checked programmatically, write a script rather than eyeballing it. Scripts are faster, more reliable, and can be reused across iterations.

Example pattern:

```python
#!/usr/bin/env python3
"""Grade a specific assertion against an output file."""
import sys
from pathlib import Path

def check_docx_valid(path):
    try:
        from docx import Document
        doc = Document(path)
        return len(doc.paragraphs) > 0
    except Exception:
        return False

output_path = sys.argv[1]
passed = check_docx_valid(output_path)
print(f'{{"text": "Output file is a valid .docx", "passed": {str(passed).lower()}, "evidence": "Checked with python-docx"}}')
```

Save grading scripts in the workspace's `scripts/` directory so they persist across iterations.
