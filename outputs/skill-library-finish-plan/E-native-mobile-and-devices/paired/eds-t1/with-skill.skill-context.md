# Embedded Device Security

Start from the device's actual trust anchors and attacker access. A signed application image is not a secure device if an earlier boot stage is mutable, debug remains privileged in production, downgrade is possible, update failure bricks the device, or secrets can be read through another interface.

## Device-security workflow

1. **Define attacker access and consequences.** State whether the attacker has remote network access, local protocol access, temporary or persistent physical possession, removable storage access, fault-injection capability, or supply-chain/programming access. Identify safety, privacy, availability, fleet, and credential-compromise consequences separately.
2. **Trace the boot chain from an immutable or protected root.** Identify Boot ROM/first-stage trust, key or key-hash storage, bootloader verification, configuration/security fuses, application verification, measured state where applicable, and every mutable stage that executes before policy is enforced. Record what happens on verification failure.
3. **Design authenticated, rollback-resistant updates.** Bind update authorization to the intended product/device class and image metadata, verify before execution, protect version/rollback state from ordinary firmware writes, handle A/B or recovery images deliberately, and test interruption at each state transition. Authenticity without freshness/rollback policy is incomplete.
4. **Inventory privileged interfaces.** Include JTAG/SWD, UART/serial consoles, ROM download modes, test pads, USB, BLE/Wi-Fi provisioning, NFC, removable media, maintenance ports, DMA-capable peripherals, manufacturing commands, and hidden service protocols. Production policy must define disablement, authentication, capability limits, and recovery access rather than relying on obscurity.
5. **Protect device identity and secrets.** Trace provisioning, generation/import, storage, use, rotation/revocation, backup/exportability, factory reset, RMA, and decommissioning. Prefer hardware-backed isolation when the threat model requires it, but verify the actual access path and lifecycle rather than inferring protection from a chip feature name.
6. **Constrain firmware authority.** Use MPU/MMU/TrustZone or process/task isolation where available, least-privilege peripheral access, memory-safe boundaries where feasible, bounded parsers/protocols, watchdog/fail-safe behavior, and explicit transitions between secure, recovery, manufacturing, and normal modes.
7. **Verify on representative hardware when the claim depends on hardware.** Exercise malformed/unsigned/downgraded images, interrupted updates, corrupted slots, debug/maintenance access, factory reset, recovery, and credential revocation. A simulator can prove state-machine logic but cannot prove fuse state, debug lock, physical secret extraction resistance, power-fail behavior, or hardware-root enforcement unless the simulator specifically models those properties.
8. **Preserve supplied evidence machinery.** When a repository task provides a simulator, fixed device corpus, package lifecycle commands, or an artifact schema, treat those inputs as user owned unless the task explicitly authorizes changing them. Express the device policy and bounded observations in the requested artifacts and tests. Do not rewrite the simulator, fixed corpus, or harness to make a security claim easier to pass.

## Evidence and claims

Produce a physical/logical attack-surface map, boot/update trust-chain record, production interface policy, device-secret lifecycle, recovery/decommissioning contract, and observed results from representative hardware or clearly bounded simulation. Record board/revision, bootloader/application version, relevant fuse/configuration state, image digest/version, and exact failure/recovery outcome when those facts determine the claim.

## Boundaries

- `embedded-firmware` owns ordinary RTOS tasks, drivers, peripherals, timing, and firmware implementation; this skill owns the security invariants those mechanisms must enforce.
- `applied-cryptography` owns algorithm/protocol construction details; this skill owns how device trust anchors, signed images, counters, and credentials are provisioned and enforced across the device lifecycle.
- `supply-chain-security` owns build provenance, dependency/release integrity, and artifact-signing pipeline trust; this skill owns whether the device accepts the right artifact under the right boot/update policy.
- `infrastructure-security`/`cloud-security` own fleet backends and cloud control planes; this skill owns the device endpoint and its trust boundary.
- `threat-modeling-practice` may establish the broader threat model; this skill converts device-specific threats into enforceable hardware/firmware controls and verification.

Use [the maintained source map](references/sources.md) for NIST's current IoT manufacturer baseline and platform-firmware resiliency guidance.