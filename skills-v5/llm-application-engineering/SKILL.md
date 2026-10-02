---
name: llm-application-engineering
description: Engineer LLM application behavior with validated outputs, bounded tool use, state, fallback, and cost controls. Use when model inference determines application behavior; use agentic-systems for autonomous orchestration, prompt-context-engineering for context optimization, and llm-evaluation for evaluation methodology.
---

# LLM Application Engineering

Treat the model as a probabilistic component behind a deterministic product contract. The application owns what the user is allowed to request, what context is authoritative, which actions exist, how outputs are validated, how state changes are authorized, and what happens when the model is wrong, unavailable, slow, over budget, or refuses.

## Application workflow

1. **Define the product contract before the prompt.** State the user task, allowed and disallowed outcomes, provider/model or model class, input sources, required output shape, latency/cost budget, and which decisions remain deterministic application logic. Do not turn business rules or authorization into prose that only the model enforces.
2. **Pin provider/model behavior that matters.** Record the provider, API surface, model identifier/snapshot where available, tool/structured-output mode, temperature/reasoning controls when relevant, context limits, and any provider-specific semantics the integration depends on. Re-run the regression suite when the model or API behavior changes.
3. **Use machine-checkable output contracts.** Prefer supported structured-output or schema-constrained modes for data consumed by code. Validate again at the application boundary, handle refusals/truncation/provider errors explicitly, and never deserialize arbitrary model text directly into privileged operations.
4. **Treat tool calls as proposals, not authority.** Give each tool a narrow schema and purpose. The application validates arguments, authorization, current state, idempotency/replay rules, rate/budget limits, and any required user confirmation before executing mutations. Return bounded tool errors/results to the model without granting a wider retry loop than the product permits.
5. **Control context and state deliberately.** Distinguish user input, trusted system/product rules, retrieved data, conversation state, and tool results. Preserve provenance and freshness for material facts. Provider prompt caching can reduce cost/latency for stable prefixes but is an optimization, not persistent application memory or correctness evidence.
6. **Design failure and uncertainty behavior.** Specify what happens on malformed output, refusal, missing context, low confidence/ambiguity, tool timeout, rate limit, provider outage, context overflow, and budget exhaustion. Prefer explicit abstention, human handoff, deterministic fallback, or bounded retry over fabricating completion.
7. **Instrument the inference boundary.** Record request/correlation ID, provider/model, prompt/template version, tool/schema version, latency, token/usage/cost data when available, validation failures, tool outcomes, fallback/refusal path, and final user-visible result without logging sensitive content unnecessarily.
8. **Gate changes on persisted task evidence.** Run representative success, ambiguity, malformed-output, stale/missing context, tool failure, authorization denial, latency/cost and model-version cases. `llm-evaluation` owns deeper benchmark/judge design; this skill requires that the application actually has and passes a meaningful release regression set.

## Boundaries

Normalize primary and fallback outputs into the same application envelope, then apply the same validation to both. A fallback cannot return a provider specific shape directly to a consumer. For mutations, check subject and resource ownership before eligibility, bind confirmation to current state, and reconcile a stored operation receipt before executing again. Test malformed primary output, stale confirmation and duplicate delivery as separate transitions with observable effects.

- `agentic-systems` owns autonomous multi-step planning, delegation, dynamic tool sequencing, budgets, memory and completion criteria. A bounded application with a deterministic orchestration graph and model calls remains here.
- `prompt-context-engineering` owns prompt decomposition, context-window strategy and prompt optimization. This skill owns the surrounding application contract and failure behavior.
- `rag-retrieval-systems` owns corpus ingestion, chunking, access-controlled retrieval, ranking and grounding. This skill owns how retrieved context is consumed and validated in the application.
- `llm-evaluation` owns held-out benchmark construction, graders/judges, calibration and comparative model/prompt evaluation. This skill owns shipping behavior gated by those results.
- `ai-safety-evaluation` owns dedicated safety/red-team assessment; application-level refusals/authorization remain product requirements here.
- `fine-tuning-training` owns training/fine-tuning workflows; selecting or integrating a trained model belongs here.

Use [the maintained source map](references/sources.md) for current provider contracts. Provider-specific semantics change quickly; re-fetch the relevant official page whenever a task depends on a current API default or feature.
