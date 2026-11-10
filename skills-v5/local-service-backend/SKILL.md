---
name: local-service-backend
description: Engineer desktop daemons, local IPC services, sidecars, and single-host processes without importing cloud assumptions. Use when the request specifically requires local service, desktop daemon, ipc service, sidecar process.
---

# Local Service Backend

## Responsibility

Establish why a separate local process is beneficial: isolation, privilege separation, lifecycle, language boundary, sharing, or fault containment. Define startup readiness, discovery, IPC transport, authentication or peer identity, permissions, version negotiation, request cancellation, streaming, backpressure, crash recovery, single instance behavior, upgrades, logs, and shutdown ownership.

Prefer the operating system's appropriate local primitives and existing project conventions. Do not add HTTP, containers, cloud discovery, Kubernetes, or a network database merely because the component is called a service. Verify stale clients, server restart, partial messages, permission denial, path and user isolation, concurrent clients, upgrades, and supervisor behavior on the real host.

## Hierarchy and routing

- Broader skills: backend-engineering.
- No narrower bundled child is declared.

## Professional practice

### Operating contract

Build machine local service boundaries with explicit process, IPC, and lifecycle behavior.

### Execution sequence

1. Identify clients, service ownership, startup, discovery, IPC, trust, and shutdown.
2. Define protocol, versioning, identity, permissions, timeout, cancellation, and reconnect behavior.
3. Implement supervision, rules for single or multiple instances, and observable state.
4. Handle upgrades, stale sockets, crashes, partial initialization, and cleanup.
5. Verify across real process boundaries and user/session conditions.

### Prove the actual machine local service boundary

- A token manager, in process class, or written topology plan alone is not an implemented local service. If the task asks for a service, provide the listener/IPC endpoint, launcher or supervisor integration, client discovery and version handshake, request admission, cancellation, bounded concurrent work and draining, shutdown, and restart generation checks appropriate to the existing application. Make the actual process owner and readiness signal observable. If the environment lacks a launcher or native transport, identify that gap explicitly and do not claim a process level integration was exercised.
- Treat the discovered endpoint and its generation/instance identity as part of the authority contract. A stale socket, port, file, or endpoint record must fail closed rather than accidentally attach a newly started unrelated service. On restart, invalidate old bootstrap credentials and require a new authorized handshake; use protected atomic on disk token replacement where persistent bootstrap data is part of the contract, with a rollback path on a failed write.
- A loopback address proves locality only. Authenticate the requesting client and bound token lifetime/rotation by client identity; use a strict allowlist for desktop origins **including any existing application scheme** explicitly documented by the preserved client contract. Desktop webviews may use an application origin such as `app://desktop`; blocking it through a check that allows HTTP(S) only is a compatibility defect even when network origin CSRF defenses are otherwise sound. Deny foreign hosts, untrusted origins, missing or mismatched credentials, expired tokens, and stale generation IDs.
- Exercise a real local server and two independent client processes where the declared runtime supports them. Record startup readiness, negotiated protocol and instance identity, authorized request, untrusted local caller, wrong origin, token expiry/rotation, stale endpoint after restart, concurrent requests, interrupted/partial request, cancellation, bounded queue, and graceful/drained shutdown. Keep process level evidence separate from in memory API tests.
- Prioritize a reproducible end to end smoke and the strongest focused failure tests early in the work. Report observed command exit statuses and output; authored tests or an invocation that timed out cannot be counted as a verified integration. Run the project's existing test suite, not only tests you author, before reporting completion: a green authored suite beside a red pre-existing suite means the existing module contract was broken by the change, so restore the original exported behavior or update the change until both suites pass. Preserve source client contracts while adding local authority checks, rather than silently restricting a previously valid app origin or transport.

### Decisions that must be explicit

- IPC mechanism and security boundary.
- Who launches, supervises, upgrades, and stops the service.
- State location and concurrency with multiple clients.
- Offline, restart, and compatibility policy.

### Failure and recovery discipline

- Stale endpoints connect to the wrong instance.
- A local boundary is assumed trusted.
- Client and daemon versions deadlock or corrupt state.
- Shutdown leaks processes, files, locks, or sockets.

### Evidence required before completion

- Process and protocol identity.
- Permission and denied path tests.
- Restart, reconnect, upgrade, and cleanup results.
- Observable supervision evidence.

### Guarding against misinterpretation

- Do not imply network service guarantees.
- Do not use local endpoints accessible to the world.
- Do not hide lifecycle behind client retries.
- Do not claim a live backend proves its UI consumer.

## Completion evidence

- Process and IPC contract
- Restart and failure verification

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
