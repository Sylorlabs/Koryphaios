---
name: serverless-platforms
description: Engineer serverless function invocation, retries, concurrency, execution lifetime, and deployment. Use when Lambda, Cloud Run functions, Workers, or equivalent runtime guarantees determine behavior; use event-driven-architecture for broker topology and network-service-backend for application protocols.
---

# Serverless Platforms

Identify the exact serverless product, compute mode, runtime, trigger, and delivery semantics before designing the handler. “Serverless” is not one execution model: request concurrency, duration, environment reuse, retry ownership, post-response work, and event-source behavior differ materially across providers and products.

## Workflow

1. **Pin the runtime contract.** Record provider/product, region, runtime/version or compatibility date, architecture, compute mode, function/version/alias/deployment revision, memory/CPU/ephemeral storage, timeout/CPU limits, networking mode, and the exact invocation source. Re-check current docs instead of inheriting limits from a different serverless product.
2. **Classify invocation semantics.** Distinguish direct synchronous calls, provider-managed asynchronous queues, poll-based event-source mappings, HTTP/edge requests, cron/schedules, workflow/durable execution, and service-to-service calls. Retry, acknowledgement, timeout, and dead-letter behavior belong to that invocation path, not just the function code.
3. **Assume duplicate execution unless the platform proves otherwise.** Design externally visible effects around idempotency keys, conditional writes/transactions, deduplication windows, or durable workflow identity. A timeout or lost acknowledgement can occur after side effects committed, so retry safety must not depend on knowing whether the previous attempt “really ran.”
4. **Make batch failure semantics explicit.** For queue/stream sources, define batch size/window, acknowledgement/delete/checkpoint behavior, poison-record handling, partial batch response, retry/discard/dead-letter policy, ordering guarantees, and visibility/lease timeout. One bad record must not cause avoidable successful-record replay without a deliberate policy.
5. **Bound concurrency against downstream capacity.** Model arrival rate, duration, batch size, function/platform concurrency, per-source concurrency, connection pools, database/API quotas, and burst scaling. Reserved/max concurrency can be a backpressure tool, not only a latency knob; throttling upstream may change retry/backlog behavior.
6. **Do not assume one universal per-environment concurrency model.** Some runtimes process one invocation per execution environment, while others multiplex requests in one isolate/container/managed instance. Verify thread safety, mutable globals, request context isolation, connection reuse, and memory sharing for the actual mode.
7. **Treat warm state as an optimization only.** Reused globals, connections, compiled templates, and ephemeral files may reduce latency, but correctness must survive a fresh environment. Do not persist user/tenant-sensitive state in warm memory or `/tmp` where another invocation could observe it.
8. **Measure cold and warm behavior separately.** Capture initialization duration, handler duration, end-to-end latency, and scaling/cold-start conditions. Use provisioned/min instances only when the measured latency objective justifies cost/capacity; verify traffic actually targets the version/alias/revision with prewarmed capacity.
9. **Finish required work before the invocation can end.** Await response-critical writes. Use provider-sanctioned post-response mechanisms only for work allowed by their lifetime and reliability contract. Floating promises, detached threads, or background callbacks may be frozen or terminated and cannot be treated as durable jobs.
   When changing an existing handler, preserve the established order and meaning of response-critical writes and optional telemetry. Do not add, reorder, or broaden observable side effects merely because `waitUntil` is available; classify each effect and verify its timing and failure policy separately.
10. **Externalize durable state.** Persist workflow/business state in a durable store, queue, or platform durable-workflow primitive. Treat local files and globals as ephemeral caches unless the selected product explicitly provides stronger semantics and the workflow is built for them.
11. **Package and deploy immutably.** Pin code artifact/image digest, dependencies/layers, runtime, architecture, environment/config and secret references. Publish an immutable version/revision before shifting traffic; do not mutate the exact artifact that passed qualification.
12. **Separate configuration from secrets and rollout identity.** Record environment/config revision and secret source/version without logging secret values. Verify that a configuration/secret update reaches the intended function version/revision and does not silently mix old warm environments with incompatible assumptions.
13. **Verify networking as part of the function path.** Account for DNS, connection reuse, NAT/VPC connectors, egress and downstream timeouts. Bound connection pools under concurrency and test cold connection establishment; route-level diagnosis remains `networking-systems` when the fault is generic packet/path behavior.
14. **Observe backlog and delivery, not just invocation errors.** Monitor concurrency/throttles, age/backlog, retry/delivery attempts, dead-letter/discard counts, cold/init duration, timeout/memory/CPU limit outcomes, downstream saturation, and per-version/revision error/latency.
15. **Deploy reversibly.** Shadow/canary/weighted-shift where supported, keep the prior immutable version/revision, test cold/warm, duplicate/retry, timeout, concurrency and event-source failure paths, then roll back traffic/configuration without rebuilding the old artifact.

## Boundaries

- `event-driven-architecture` owns event topology, broker choice, schemas, consumer groups and system-level delivery design. This skill owns how a serverless trigger/binding polls, batches, retries, scales and invokes the function.
- `network-service-backend` owns HTTP/gRPC/custom service behavior inside the handler. This skill owns managed runtime lifecycle, concurrency, timeout, deployment and invocation semantics.
- `aws-cloud`, `gcp-cloud`, `azure-cloud` and other provider skills own broader IAM/network/account infrastructure. This skill owns the provider-specific function runtime contract and verification when serverless behavior is central.
- `cicd-engineering` owns generic build/test/release automation. This skill adds function runtime/version/alias/revision, event-source and cold/warm rollout evidence.
- `edge-cdn` owns shared edge caching and CDN origin behavior. Edge functions/Workers belong here when execution/runtime semantics are changing; cache-key/TTL/purge behavior remains `edge-cdn`.
- `reliability-verification` owns generic fault/soak verification methodology. This skill defines serverless-specific duplicate, timeout, concurrency, cold-start and event-source failure conditions.

Use [the maintained source map](references/sources.md) before encoding provider-specific retries, duration, concurrency, event-source, background-work, limits, or deployment behavior.
