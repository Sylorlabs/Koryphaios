---
name: local-service-backend
description: Engineer desktop daemons, local IPC services, sidecars, and single-host processes without importing cloud assumptions. Use when the request specifically requires local service, desktop daemon, ipc service, sidecar process.
---

# Local Service Backend

## Responsibility

Establish why a separate local process is beneficial: isolation, privilege separation, lifecycle, language boundary, sharing, or fault containment. Define startup readiness, discovery, IPC transport, authentication or peer identity, permissions, version negotiation, request cancellation, streaming, backpressure, crash recovery, single-instance behavior, upgrades, logs, and shutdown ownership.

Prefer the operating system's appropriate local primitives and existing project conventions. Do not add HTTP, containers, cloud discovery, Kubernetes, or a network database merely because the component is called a service. Verify stale clients, server restart, partial messages, permission denial, path and user isolation, concurrent clients, upgrades, and supervisor behavior on the real host.

## Hierarchy and routing

- Broader skills: backend-engineering.
- No narrower bundled child is declared.

## Professional practice

### Operating contract

Build machine-local service boundaries with explicit process, IPC, and lifecycle behavior.

### Execution sequence

1. Identify clients, service ownership, startup, discovery, IPC, trust, and shutdown.
2. Define protocol, versioning, identity, permissions, timeout, cancellation, and reconnect behavior.
3. Implement supervision, single-instance or multi-instance rules, and observable state.
4. Handle upgrades, stale sockets, crashes, partial initialization, and cleanup.
5. Verify across real process boundaries and user/session conditions.

### Decisions that must be explicit

- IPC mechanism and security boundary.
- Who launches, supervises, upgrades, and stops the service.
- State location and multi-client concurrency.
- Offline, restart, and compatibility policy.

### Failure and recovery discipline

- Stale endpoints connect to the wrong instance.
- A local boundary is assumed trusted.
- Client and daemon versions deadlock or corrupt state.
- Shutdown leaks processes, files, locks, or sockets.

### Evidence required before completion

- Process and protocol identity.
- Permission and denied-path tests.
- Restart, reconnect, upgrade, and cleanup results.
- Observable supervision evidence.

### Anti-misinterpretation boundaries

- Do not imply network-service guarantees.
- Do not use world-accessible local endpoints.
- Do not hide lifecycle behind client retries.
- Do not claim a live backend proves its UI consumer.

## Completion evidence

- Process and IPC contract
- Restart and failure verification

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
