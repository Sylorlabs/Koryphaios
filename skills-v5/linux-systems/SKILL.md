---
name: linux-systems
description: Diagnose and operate Linux processes, services, filesystems, permissions, namespaces, and resource limits. Use when Linux host or kernel-visible state determines behavior; use networking-systems for network paths and protocols, and container-engineering for container image and lifecycle work.
---

# Linux Systems

Diagnose the running system before editing it. Linux symptoms are often produced by a different layer than the application reports: a stale unit drop-in, mount namespace, open deleted file, cgroup limit, capability, ownership/ACL, or distribution-specific service/package convention can make an otherwise-correct application fail.

## Workflow

1. **Identify the actual host/runtime.** Record distribution/release, kernel, architecture, init/service manager, container/VM context, cgroup version, relevant namespaces and package/config ownership. Do not assume commands, unit paths or defaults are portable across distributions.
2. **Reproduce with read-only evidence first.** Capture exact command/service failure, exit status, timestamps and relevant logs before restarting, killing or editing. Preserve enough state to distinguish the original fault from changes caused during diagnosis.
3. **Trace the process, not just its name.** Verify PID/start time, parent/child ancestry, executable, cwd/root, credentials, capabilities, namespaces, cgroup, limits and relevant `/proc/<pid>` file descriptors/maps/status. Account for PID reuse and multiple similarly named processes.
4. **Inspect the effective service definition.** For systemd, use the loaded unit plus all drop-ins and environment/config sources, not only one unit file. Check `Type=`, `ExecStart`, user/group, working directory, environment, dependencies/order, restart policy, resource limits, sandbox/security directives and enablement.
5. **Separate reload, restart and reboot persistence.** Editing a unit/config file does not prove the service manager loaded it. Verify daemon reload where required, restart behavior, enablement and a clean reboot/start path when persistence is part of the claim.
6. **Diagnose filesystem and mount state explicitly.** Check the process's mount namespace, source filesystem, mount options, free blocks/inodes, read-only state, symlinks/bind mounts and path traversal. `df`, `du` and the process's view may disagree when deleted-open files or namespaces are involved.
7. **Resolve permissions precisely.** Check owner/group/mode, parent-directory execute permission, ACLs, capabilities, SELinux/AppArmor context when present, umask and service user identity. Prefer the least-scoped fix; do not use broad `chmod 777`, disable MAC globally or run as root to hide the cause.
8. **Inspect resource limits at the right layer.** Distinguish shell/process rlimits, systemd limits and cgroup v2 CPU/memory/IO/PID controls. Use cgroup events/pressure/OOM evidence and process state before attributing termination to the kernel or application.
9. **Handle signals and shutdown semantics deliberately.** Verify which process is PID 1 for the namespace, which process systemd supervises, signal propagation, timeout/kill mode and child cleanup. Avoid indiscriminate `kill -9`; it prevents graceful cleanup and erases useful failure behavior.
10. **Treat kernel tunables as scoped configuration.** Confirm the active sysctl/kernel interface, namespace scope and current value before modifying. Verify both runtime effect and intended persistent source; do not write global tunables to fix an application-local issue without evidence.
11. **Protect package/config ownership.** Determine whether a file is distribution/package-managed, generated, local override or runtime state. Prefer supported drop-ins/override directories and record any package upgrade implications.
12. **Verify the recovery from a clean state.** Re-run the original failure path, confirm service state/process identity, logs, permissions/resources and expected restart/reboot behavior. Remove or account for temporary diagnostic processes/files so success is not caused by leftover manual state.

## Boundaries

- `networking-systems` owns routing, DNS, transport/network path, packet flow and network architecture. `linux-systems` owns host sockets/processes, network namespaces and host kernel state needed to diagnose that path.
- `container-engineering` owns container image/runtime packaging and orchestration behavior. `linux-systems` owns the underlying namespace/cgroup/process/mount mechanics when host-level diagnosis is required.
- `infrastructure-security` owns security hardening/policy design. This skill diagnoses Linux permissions, capabilities and MAC enforcement needed to restore correct operation without broad weakening.
- `observability-sre` owns service-level reliability/telemetry programs. This skill uses host journals/kernel/process/resource evidence to diagnose a Linux fault.
- `shell-cli-engineering` owns shell script/CLI implementation. This skill owns what Linux state the commands must observe or change.

Use [the maintained source map](references/sources.md) before relying on version-sensitive kernel, systemd, namespace or cgroup behavior.
