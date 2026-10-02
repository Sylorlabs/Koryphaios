---
name: network-service-backend
description: Engineer network-facing APIs and services from contracts, trust boundaries, load, failure, compatibility, and operations. Use when the request specifically requires network service, http api, rpc service, public api.
---

# Network Service Backend

## Responsibility

Identify clients, trust zones, protocol constraints, request and response semantics, latency and throughput targets, payload limits, compatibility period, authentication and authorization, abuse cases, deployment topology, and operational ownership. Choose HTTP, RPC, messaging, streaming, or another protocol from those needs; REST is not a default.

Specify schemas, validation, idempotency, pagination or flow control, timeouts, cancellation, retries, rate and resource limits, error taxonomy, observability, rollout, rollback, and versioning. Keep secrets and internal failures out of responses. Test contracts over the real transport, malformed and oversized input, auth boundaries, disconnects, duplicate requests, overload, dependency failure, compatibility, and deployment health.

## Hierarchy and routing

- Broader skills: backend-engineering.
- Narrower children: edge-cdn, networking-systems, realtime-systems, serverless-platforms.

## Professional practice

### Operating contract

Build a network-reachable service with explicit protocol, identity, policy, and failure semantics.

### Execution sequence

1. Define clients, protocol, trust zones, deployment, discovery, and compatibility.
2. Specify request identity, validation, authorization, limits, timeouts, idempotency, and errors.
3. Implement observable handlers with bounded resources and dependency policies.
4. Exercise concurrency, retries, partial dependencies, rolling versions, and abuse paths.
5. Verify consumer-visible behavior, deployment configuration, and recovery.

### Decisions that must be explicit

- Protocol and version negotiation.
- Authentication and authorization enforcement.
- Backpressure, quotas, timeouts, and retry ownership.
- Consistency and availability behavior during dependency failure.

### Failure and recovery discipline

- Client input controls identity or resource scope.
- Unbounded requests exhaust service resources.
- Retries duplicate non-idempotent work.
- A healthy listener returns incorrect or stale product behavior.

### Evidence required before completion

- Wire and compatibility contract.
- Policy and boundary tests.
- Load, fault, timeout, and recovery results.
- Deployment and observability identity.

### Anti-misinterpretation boundaries

- Do not assume HTTP or public internet.
- Do not trust internal networks by default.
- Do not expose secrets in protocol diagnostics.
- Do not generalize one deployment to all topologies.

## Completion evidence

- Protocol and trust contract
- Transport and failure tests

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
