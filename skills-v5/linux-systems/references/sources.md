# Source map

`linux-systems` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Linux behavior depends on distribution, kernel, systemd/man-pages version, security modules and namespace/cgroup layout. Resolve the actual host first and refresh version-sensitive directives before changing persistent configuration.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader backend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Linux kernel documentation**: https://docs.kernel.org/
  - Scope: current kernel documentation as available 2026-09-05.
  - Use: authoritative subsystem, process, filesystem, resource and kernel-interface behavior.
  - Verified: 2026-09-05; refresh after 60 days.
- **Linux cgroup v2 admin guide**: https://docs.kernel.org/admin-guide/cgroup-v2.html
  - Scope: current cgroup v2 documentation as available 2026-09-05.
  - Use: hierarchy/controller/resource/delegation/event semantics; distinguish v2 from legacy/mixed layouts before applying values.
  - Verified: 2026-09-05; refresh after 60 days.
- **Linux `/proc` filesystem**: https://docs.kernel.org/filesystems/proc.html
  - Scope: current kernel `/proc` documentation as available 2026-09-05.
  - Use: kernel-visible process descriptors/status/maps and system interfaces used for read-first diagnosis.
  - Verified: 2026-09-05; refresh after 60 days.
- **systemd.service**: https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
  - Scope: current upstream manual as available 2026-09-05.
  - Use: service types, lifecycle, restart/supervision semantics. Verify installed systemd version because current directives can be newer than the host.
  - Verified: 2026-09-05; refresh after 30 days.
- **systemd.exec**: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html
  - Scope: current upstream manual as available 2026-09-05.
  - Use: execution identity, environment, working directories, permissions, sandboxing and resource directives.
  - Verified: 2026-09-05; refresh after 30 days.
- **Linux namespaces(7)**: https://man7.org/linux/man-pages/man7/namespaces.7.html
  - Scope: Linux man-pages 6.18, dated 2026-02-08.
  - Use: namespace types and `/proc`/API boundaries; man-pages is a user-space interface reference, not proof of host kernel configuration.
  - Verified: 2026-09-05; refresh after 120 days.

## Interpretation rules

- Record distribution/release, kernel, architecture, init/systemd, container/VM context, cgroup mode and relevant namespace before applying distro/version-specific instructions.
- Capture failure state before mutation. Restarting/killing can erase the process, descriptors, cgroup events or journal timing needed to identify the cause.
- Inspect the effective systemd unit plus drop-ins/environment and the actual supervised process. A manually started daemon is not evidence that boot-time service configuration works.
- Use `/proc` and namespace-aware mount/process evidence carefully; process names and PIDs alone are not stable identity.
- Permission failures can involve directory traversal, ACLs, capabilities, MAC policy, mount options and service sandboxing. Prefer the least-scoped fix; never default to broad world-writable permissions or disabling security globally.
- Distinguish rlimits, systemd resource controls and cgroup v2 limits/events before changing capacity. OOM/resource evidence must map to the actual process cgroup.
- Treat reload/restart/reboot as separate verification states. Persistent claims require testing the intended clean start path, not only the edited running system.
- Preserve package/generated/local override ownership and provide rollback for unit/config/sysctl changes.
