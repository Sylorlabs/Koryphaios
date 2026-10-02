# Source map

`serverless-platforms` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Serverless semantics are provider-, product-, trigger-, compute-mode-, and version-specific. Refresh the exact product documentation before encoding concurrency, duration, retries, state reuse, event-source, background-work, or deployment assumptions.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader network-service-backend.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **AWS Lambda developer guide**: [https://docs.aws.amazon.com/lambda/latest/dg/welcome.html](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html)
  - Scope: rolling AWS Lambda documentation as available 2026-09-19.
  - Use: current Lambda runtime/product families and the important 2026 boundary that standard functions, Durable Functions, and Managed Instances do not share one duration/concurrency/state model.
  - Verified: 2026-09-19; refresh after 14 days.
- **AWS Lambda retry behavior**: [https://docs.aws.amazon.com/lambda/latest/dg/invocation-retries.html](https://docs.aws.amazon.com/lambda/latest/dg/invocation-retries.html)
  - Scope: rolling retry documentation as available 2026-09-19.
  - Use: direct versus asynchronous versus indirect invocation retry ownership. A retry can follow partial execution, so external effects must tolerate duplicate invocation.
  - Verified: 2026-09-19; refresh after 14 days.
- **AWS Lambda execution-environment lifecycle**: [https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)
  - Scope: rolling lifecycle documentation as available 2026-09-19.
  - Use: init/invoke/freeze/reuse, cold starts, transient `/tmp`, and the risk of unfinished background callbacks resuming on a reused environment. Warm state is an optimization, not durable correctness state.
  - Verified: 2026-09-19; refresh after 14 days.
- **AWS Lambda concurrency**: [https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html)
  - Scope: current standard Lambda scaling/concurrency documentation as available 2026-09-19.
  - Use: in-flight concurrency, reserved/provisioned controls and scaling. Verify compute mode because Lambda Managed Instances use multi-concurrent invocation semantics.
  - Verified: 2026-09-19; refresh after 14 days.
- **AWS Lambda with Amazon SQS**: [https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
  - Scope: rolling SQS event-source mapping documentation as available 2026-09-19.
  - Use: polling/batching, visibility, duplicate processing, scaling and idempotency requirements; batch failure behavior differs from ordinary asynchronous invocation.
  - Verified: 2026-09-19; refresh after 14 days.
- **AWS Lambda SQS partial batch/error handling**: [https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)
  - Scope: current SQS error/partial batch behavior as available 2026-09-19.
  - Use: `ReportBatchItemFailures`, retry/backoff interaction and avoiding unnecessary replay of successful records.
  - Verified: 2026-09-19; refresh after 14 days.
- **AWS Lambda durable idempotency**: [https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html)
  - Scope: current Durable Functions documentation as available 2026-09-19.
  - Use: execution-name idempotency and the separate requirement that durable steps can still have at-least-once execution semantics; event-source mappings require explicit idempotency design.
  - Verified: 2026-09-19; refresh after 14 days.
- **Google Cloud Run event-driven function retries**: [https://docs.cloud.google.com/run/docs/tips/function-retries](https://docs.cloud.google.com/run/docs/tips/function-retries)
  - Scope: documentation as available 2026-09-19.
  - Use: retry behavior configured on Eventarc/Pub/Sub delivery rather than the function alone, reinforcing trigger-specific delivery semantics and idempotent handlers.
  - Verified: 2026-09-19; refresh after 14 days.
- **Cloudflare Workers limits**: [https://developers.cloudflare.com/workers/platform/limits/](https://developers.cloudflare.com/workers/platform/limits/)
  - Scope: documentation inspected 2026-09-17; page updated 2026-09-05.
  - Use: current CPU/memory/subrequest/connection/duration limits and the critical concurrency boundary that one isolate can process many concurrent requests.
  - Verified: 2026-09-17; refresh after 7 days.
- **Cloudflare Workers Context / waitUntil**: [https://developers.cloudflare.com/workers/runtime-apis/context/](https://developers.cloudflare.com/workers/runtime-apis/context/)
  - Scope: current runtime Context documentation as available 2026-09-19.
  - Use: `ctx.waitUntil()` semantics and current bounded post-response lifetime; floating promises can be canceled and must not carry required business effects.
  - Verified: 2026-09-19; refresh after 14 days.

## Interpretation rules

- Resolve provider, product/compute mode, runtime/compatibility version and invocation source before applying any serverless rule. “Lambda,” “functions,” and “edge functions” are not one execution model.
- Retry semantics belong to the full invocation path. Direct API calls, asynchronous queues, event-source pollers, Eventarc/Pub/Sub, schedules and durable workflows can retry/acknowledge differently.
- Build duplicate-safe effects even when retries look bounded. A function may commit externally and then time out or lose acknowledgement.
- For queue/stream sources, coordinate batch size/window, function timeout, visibility/lease, concurrency, partial failure and DLQ/discard behavior. Backlog age is a first-class health signal.
- Do not universalize per-environment concurrency. Standard Lambda normally handles one invocation per environment, Lambda Managed Instances can handle multiple concurrent invocations, and Cloudflare isolates can process many concurrent requests. Shared mutable state must match the actual model.
- Warm globals, `/tmp`, cached connections and reused isolates are optimization surfaces only unless the selected product explicitly provides a durable primitive designed for workflow state.
- Await response-critical effects. Use provider-supported post-response facilities only for non-critical work that fits their documented lifetime; detached/floating work is not durable.
- Treat cold-start mitigation as a measured latency/cost decision and verify traffic actually targets the pre-provisioned/min-instance version or revision.
- Publish immutable artifacts/versions/revisions before traffic shift, pin trigger and configuration identity, observe per-version behavior and preserve a known-good rollback.
