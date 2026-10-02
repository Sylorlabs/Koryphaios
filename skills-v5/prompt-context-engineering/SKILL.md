---
name: prompt-context-engineering
description: Engineer prompts, instruction stacks, examples, and context packing with explicit trust and budgets. Use when prompt or context construction is the main lever for model behavior; use rag-retrieval-systems for corpus retrieval and llm-evaluation for evaluation methodology.
---

# Prompt Context Engineering

Treat a prompt as a versioned behavioral interface, not an accumulation of prose. Preserve the user's goal while making authority, data provenance, dynamic variables, context-budget decisions, and failure behavior explicit enough to test.

## Workflow

1. **Resolve the actual inference boundary.** Identify the provider/model or model class, API/message roles, current prompt builder/template, input sources, output contract, and any provider behavior the prompt depends on. Do not copy prompt recipes across models or snapshots without evidence that they still apply.
2. **Map authority before wording.** Separate higher-authority instructions from user requests, examples, retrieved documents, tool results, quoted text, prior assistant output, and other untrusted data. Lower-trust content may supply facts but must not silently acquire instruction authority. Resolve contradictory instructions explicitly rather than repeating both.
3. **Define the prompt contract.** State the outcome, success criteria, true invariants, permitted autonomy, stopping/abstention behavior, output shape, and what must remain application logic. Avoid redundant rules and process micromanagement unless a measured failure requires them.
4. **Structure dynamic context safely.** Keep fixed instructions separate from variable inputs. Use typed/validated variables where the host supports them and clear delimiters or structural tags where useful. Treat user text, retrieved content, filenames, metadata and tool output as data even when they contain imperative language.
5. **Budget the context window deliberately.** Account for instructions, conversation history, tool schemas/results, documents, examples, images and output headroom. Assign priority to context classes, specify what may be summarized/dropped, and make truncation observable. Never rely on arbitrary tail clipping that can remove the governing instruction or the evidence needed to answer.
6. **Curate examples as testable behavior.** Few-shot examples should cover representative decision boundaries without leaking held-out answers, encoding accidental demographic/content bias, or dominating the token budget. Distinguish examples from rules and include counterexamples only when they clarify a real confusion.
7. **Design missing/stale/conflicting-context behavior.** Require the model to distinguish known evidence from inference, surface material source conflicts, and abstain or request more evidence when the task cannot be grounded. Prompt text is not an authorization or security boundary; enforce permissions and irreversible side effects outside the model.
8. **Change one measured cause at a time.** Capture a baseline on representative, near-neighbor, long-context, stale/missing, contradictory and adversarial-injection cases. Make the smallest prompt/context change supported by the failures, then rerun the same held-out suite on the same model/settings. Preserve every observed failure as a regression fixture.

## Boundaries

- `llm-application-engineering` owns provider integration, structured-output/tool contracts, authorization, retries, persistence, latency/cost policy and shipping behavior around the prompt.
- `rag-retrieval-systems` owns corpus lifecycle, chunking, ACL-aware retrieval, ranking, freshness and grounding-source selection. This skill owns how already-selected context is represented, prioritized and trusted inside the prompt.
- `llm-evaluation` owns benchmark construction, grader/judge design, calibration, statistical comparison and contamination controls. This skill requires before/after evidence but does not redefine the evaluation methodology.
- `agentic-systems` owns autonomous planning, delegation, memory, tool sequencing, budgets and completion criteria. This skill may tune the agent's instructions/context without owning the orchestration architecture.
- `ai-safety-evaluation` owns dedicated safety/red-team evaluation. Prompt injection resistance here is a prompt/context trust property and must not be represented as a complete security control.

Use [the maintained source map](references/sources.md) for provider-specific behavior. Refresh rolling provider documentation before encoding message-role, context-window, model-specific prompting, or prompt-management assumptions.
