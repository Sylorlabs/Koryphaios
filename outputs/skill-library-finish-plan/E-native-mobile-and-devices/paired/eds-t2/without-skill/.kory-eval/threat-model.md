# Device firmware threat model — mcu-rev-c / device-x

This is the analysis document for `.kory-eval/device-config.json` and
`.kory-eval/device-lifecycle-evidence.json`. It explains the reasoning; it is not
the evidence. Every table below is regenerated from the same models the evidence
artifact uses, and the reproducible results live in the artifacts and the tests.

- Board: `mcu-rev-c`
- Product: `device-x`
- Production key-hash record: `prod-key-hash-2026`
- Deployed application version: `7` (minimum accepted version `7`)
- Evidence labels: **hardware-observed** (read on the board, recorded in the corpus), **documentation** (fixture README, device policy or the authored config), **simulation** (the supplied state machine or this repository's own lifecycle model).

## What this fixture can and cannot show

This artifact shows the interface authority policy, the credential lifecycle state machine, and the boot/rollback/power-cut state machine. Debug-lock enforcement, physical fuse enforcement, resistance to invasive extraction, fault-injection resistance and real power-fail behaviour are outside what this fixture can show.

The corpus records `physicalFuseProof`, `debugLockProof` as unavailable in the emulator, so no debug-lock, physical-fuse, invasive-extraction or fault-injection resistance is claimed anywhere in these artifacts.

## 1. Attacker access and consequences

| Capability | Available | What it means here |
| --- | --- | --- |
| remote-network-access | yes | the device talks to a fleet service over an authenticated channel; an attacker can reach the endpoint but the device still enforces image authenticity, product binding and version state locally |
| local-protocol-access | yes | the fleet, update and provisioning channels are reachable by anyone who can complete the protocol handshake; capability is what the fleet record grants, not protocol reachability |
| temporary-physical-possession | yes | the board can be held on a bench with SWD, UART and ROM download pads reachable; the fixture contract asks for authority under exactly this state |
| persistent-physical-possession | yes | an attacker can keep the board and factory-reset it, then try to bring it back into the fleet; this is the state the fleet revocation check must defeat |
| removable-storage-access | no | no removable media surface is recorded for this board class; recorded as an explicit absence rather than left unexamined |
| fault-injection-capability | yes | clock, voltage and glitch attacks are a real capability for this attacker class, and none of them were exercised in this fixture |
| supply-chain-programming-access | yes | programming-time access could install a different key-hash anchor or lower version state; the key-hash fuse record is the control and its physical enforcement was not exercised here |

| Consequence | Severity | Trigger | Control |
| --- | --- | --- | --- |
| credential compromise | credential | the per-device credential is readable or exportable through a debug or download interface | non-exportable hardware-backed slot, production lock register observed on the board, fleet rotation and revocation |
| fleet impersonation | fleet | a revoked, reset or decommissioned device regains fleet authorization | fleet revocation keyed to the immutable device identity, checked on recovery and on reprovisioning; a local reset cannot clear it |
| unauthorized firmware execution | safety | an unsigned, corrupt, wrong-product or downgraded image is executed | signature, integrity, product and protected-version checks reject before execution; recovery is a separate authorization |
| unsafe actuation | safety | a device in a safety-relevant role runs firmware that was never authorized for that product | product binding plus the authenticated boot chain; the boot gate is enforced before any actuating code runs |
| privacy loss | privacy | device identity or credential material is extracted and used to link or impersonate a device | no interface returns key material; the credential signs challenges and never leaves the slot |
| availability loss | availability | an interrupted update leaves the device with no bootable slot | the A/B update state machine keeps the previously authenticated slot selected before commit |

## 2. Boot chain, provenance and keys

| Stage | Mutability | Enforces | On failure |
| --- | --- | --- | --- |
| immutable-boot-rom | immutable | mutable first-stage bootloader | reject before executing any mutable stage |
| first-stage-bootloader | mutable, authenticated by the immutable Boot ROM | bootloaderVerifiesSignature=true; bootloaderVerifiesProduct=true | reject-signature / reject-product / reject-corrupt before execution |
| protected-rollback-state | protected from ordinary firmware writes | minimumVersion=7; rollbackStateProtected=true | reject-rollback for any version below the minimum that is not separately authorized |
| authorized-recovery | separately authorized destination, never an ordinary installable image | recoveryRequiresAuthorization=true | an image below the minimum without the separate authorization is rejected as a rollback |
| application | mutable | current@7 | — |

- **trust anchor**: production key-hash record prod-key-hash-2026 recorded on the representative board (hardware-observed). the corpus records the key-hash fuse record as read on the board; what the record physically enforces is not exercised here
- **per-device credential**: generated inside a hardware-backed, non-exportable slot; secure slot, key material never leaves it; exportable=false (documentation).
- **artifact provenance boundary**: build provenance, dependency integrity and the release-signing pipeline belong to supply-chain-security. This artifact records whether the device accepts the right artifact under the right boot and update policy, not how the artifact was built.
- **algorithm boundary**: algorithm and protocol construction belongs to applied-cryptography. The authored policy records algorithmOwnedBy as applied-cryptography; no algorithm is designed or evaluated here.
- **rotation**: explicit rotate semantics: the new credential lands in the slot and the previous credential id is revoked at the fleet in the same operation
- **revocation**: explicit revoke semantics: the active credential id moves to the fleet revocation list and the device holds only stale local authority
- **backup**: no backup of the credential exists: the slot is the only copy and it is not exportable

## 3. Environment facts that change the answer

| Fact | Resolved value | Decision and consequence |
| --- | --- | --- |
| board and product binding | board=mcu-rev-c, product=device-x | product is device-x: the wrong-product corpus image is rejected on product binding, not on signature. a signed image for another product would be accepted if product binding were disabled, because its signature is valid |
| production key-hash record | prod-key-hash-2026 | the trust anchor is the recorded production key-hash record prod-key-hash-2026. a development anchor would accept images signed with a key the fleet never issued for this product |
| minimum version | 7 | minimumVersion=7, the version of the board-observed deployed image (current@7). the correctly signed older image (older@5) is rejected as a rollback; with minimumVersion=5 it would boot, which is the downgrade the policy exists to stop |
| debug lock and physical fuse proof | corpus records emulator.debugLockProof=false and emulator.physicalFuseProof=false | the production lock register value is recorded as board-observed, while debug-lock and physical-fuse enforcement are recorded as unavailable in this fixture. invasive-extraction and fault-injection resistance are left false rather than inferred from the register readout |
| serial boot log | corpus records observed.serialBootLog=true | only current@7 is board-observed as executing; every other image decision is simulation. the negative and recovery paths are state-machine outcomes, not measurements taken on hardware |

The minimum-version ambiguity is the one that changes a decision, so it is
demonstrated rather than asserted:

- resolved policy (`minimumVersion=7`): `reject-rollback` for `older@5`
- counterfactual policy (`minimumVersion=5`): `boot` for `older@5`

the minimum-version resolution is what turns the signed older image from an accepted downgrade into a rollback rejection; the counterfactual policy shows the same image booting

## 4. Debug interface authority

Authority is enumerated in `.kory-eval/device-config.json` as
`<state>:<privilege>` tokens, where a `no-` prefix records an explicit denial.
The two states are:

| State | Meaning |
| --- | --- |
| normal | device operating in the owner's possession: no attacker access to the board |
| physical-possession | attacker has temporary physical possession: board desoldered or case opened, SWD/UART/ROM pads reachable, no credentials, no persistent firmware write authority |

| Interface | State | Granted | Explicitly denied |
| --- | --- | --- | --- |
| swd | normal | — | debug-attach, firmware-readout, secret-readout |
| swd | physical-possession | authenticated-recovery-entry | unrestricted-firmware-readout, secret-export, flash-write, rollback-state-clear |
| uart | normal | read-only-boot-log | image-install, credential-readout |
| uart | physical-possession | read-only-boot-log, authenticated-recovery-entry | image-install, secret-readout, rollback-state-clear |
| romUsb | normal | — | rom-download-mode, image-install |
| romUsb | physical-possession | authenticated-recovery-entry, authenticated-image-install | unrestricted-firmware-readout, unsigned-image-install, downgrade, secret-readout, rollback-state-clear |

60 attempts were re-derived from that policy with the supplied
`interfaceCan()`: 55 refused, 5 granted.
The grants are exactly `swd physical-possession:authenticated-recovery-entry`, `uart normal:read-only-boot-log`, `uart physical-possession:authenticated-recovery-entry`, `uart physical-possession:read-only-boot-log`, `romUsb physical-possession:authenticated-recovery-entry`.
Everything else an attacker tries — unrestricted firmware readout, secret export,
flash erase, rollback-state clear, unauthenticated image install, credential
export — is refused by the enumeration, so there is no privileged path that ends
in key material. The production lock register read on `mcu-rev-c`
(`observedProductionLockState=true`,
`swdReadoutLocked=true`) is what keeps SWD bounded,
and only the explicitly authenticated recovery path remains.

## 5. Update and recovery

| Image | Basis | Decision | Executed |
| --- | --- | --- | --- |
| current@7 (corpus) | board-observed serial boot log | boot | yes |
| older@5 (corpus) | correctly signed downgrade | reject-rollback | no |
| wrong-product@8 (corpus) | correctly signed, other product | reject-product | no |
| unsigned@8 (corpus) | unsigned | reject-signature | no |
| corrupt@8 (corpus) | corrupt slot content | reject-corrupt | no |
| recovery@3 (corpus) | authorized recovery image | recovery | yes |
| update-candidate@8 (derived) | authenticated update candidate | boot | yes |
| recovery-unauthorized@3 (derived) | recovery image with the authorization removed | reject-rollback | no |

| Power-cut step | Slot booted |
| --- | --- |
| write-inactive | current@7 |
| verify-inactive | current@7 |
| mark-pending | update-candidate@8 |
| boot-pending | update-candidate@8 |
| commit-version | update-candidate@8 |

Every one of the 5 supplied cut steps recovers to an
authenticated slot: `current@7`, `update-candidate@8` across the
authenticated-update scenario, and the same holds for the downgrade, wrong-product,
unsigned, corrupt, recovery-as-candidate, restore-from-recovery,
unsigned-while-in-recovery and authorization-removed scenarios recorded in the
evidence artifact. The authorization-removed counterfactual is the recovery
condition that must be demonstrated rather than assumed:

- `recovery@3` with its separate authorization → `recovery`
- `recovery-unauthorized@3` with the authorization removed → `reject-rollback`

A valid signature alone therefore does not open the recovery path.

## 6. Per-device credential lifecycle

The lifecycle is executed, not asserted: `scripts/credential-lifecycle.ts` runs a
21-step transcript and the evidence artifact quotes it in full.

| # | Step | Outcome | Slot | Fleet | Authority |
| --- | --- | --- | --- | --- | --- |
| 1 | manufacturing-provision | state-change | provisioned (cred-v1) | provisioned | active |
| 2 | authenticated-use | allowed | provisioned (cred-v1) | provisioned | active |
| 3 | credential-export-attempt | denied | provisioned (cred-v1) | provisioned | active |
| 4 | credential-rotate | state-change | provisioned (cred-v2) | provisioned | active |
| 5 | stale-credential-use | denied | provisioned (cred-v2) | provisioned | active |
| 6 | authenticated-application-update | state-change | provisioned (cred-v2) | provisioned | active |
| 7 | authorized-recovery-entry | allowed | provisioned (cred-v2) | provisioned | active |
| 8 | unauthorized-recovery-entry | denied | provisioned (cred-v2) | provisioned | active |
| 9 | swd-readout-attempt | denied | provisioned (cred-v2) | provisioned | active |
| 10 | factory-reset | state-change | destroyed | reset-pending-reprovision | none |
| 11 | post-reset-silent-reauthorization-attempt | denied | destroyed | reset-pending-reprovision | none |
| 12 | post-reset-authorized-reprovision | state-change | provisioned (cred-v3) | provisioned | active |
| 13 | device-revocation | state-change | provisioned (cred-v3) | revoked | stale |
| 14 | reset-after-revocation-with-fleet-authority | denied | destroyed | revoked | none |
| 15 | reset-after-revocation-silent-attempt | denied | destroyed | revoked | none |
| 16 | recovery-after-revocation-attempt | denied | destroyed | revoked | none |
| 17 | rma-authorised-reprovision | state-change | provisioned (cred-v4) | provisioned | active |
| 18 | post-rma-old-credential-use-attempt | denied | provisioned (cred-v4) | provisioned | active |
| 19 | decommission | state-change | destroyed | decommissioned | none |
| 20 | post-decommission-use-attempt | denied | destroyed | decommissioned | none |
| 21 | post-decommission-recovery-attempt | denied | destroyed | decommissioned | none |

The properties the contract asks for, and the step that shows each one:

- **hardware-backed and non-exportable**: `denied` — the slot answers challenges and never returns key material.
- **explicit rotate semantics**: `state-change`, after which the rotated-out credential `denied`.
- **explicit revoke semantics**: `state-change`, leaving only stale local authority.
- **protected through update**: `state-change` with the credential still provisioned.
- **protected through recovery**: `allowed` with the separate authorization, and without it `denied`.
- **factory reset destroys local authority**: slot becomes `destroyed`, authority `none`, while the immutable device identity survives so revocation still applies.
- **the partial state is not an authorization**: `denied` — an empty slot plus a fleet record that still lists the device is not authority.
- **fleet revocation survives a reset**: `denied` even with fleet authority presented, because only RMA authority can reprovision a refused device.
- **decommission is terminal**: `state-change`, after which later use `denied` and later recovery `denied`.

## 7. Peripherals and communications at the device endpoint

| Peripheral | Capability | Production policy |
| --- | --- | --- |
| crypto accelerator / secure slot | holds the per-device credential and signs challenges | key material never readable over any bus: the slot answers challenges, it does not export; use requires the fleet record to agree |
| flash controller | writes both application slots | writes are reachable only through the authenticated update path; a write in progress is never selected for boot before verification |
| version/rollback counter storage | stores the minimum accepted version | not writable by ordinary firmware; an image below the minimum is rejected unless it carries a separate recovery authorization |
| debug mailbox (SWD) | halt, single-step and memory access over the debug bus | locked in production; only the authenticated recovery path remains reachable |
| serial console (UART) | boot log output and console input | read-only in production; it cannot install an image or bypass verification |
| ROM USB download mode | raw image download before the bootloader runs | entered only under physical possession, accepts only images that pass the same signature, product and version gate |
| watchdog | resets the device on a hung firmware stage | a watchdog reset re-runs the boot gate; it never resumes an unverified slot |

| Channel | Purpose | Device-side enforcement |
| --- | --- | --- |
| fleet update channel | delivers signed application images | the device still verifies signature, integrity, product binding and version locally; a compromised transport cannot skip the boot gate |
| fleet service channel | credential use, rotation and revocation checks | the device presents its credential and the fleet record decides; a stale local credential id grants nothing |
| provisioning channel | first and replacement credential provisioning | provisioning requires an authenticated authorization; a device the fleet refused needs RMA authority |
| local debug buses | SWD, UART console and ROM USB download | bounded by the production authority enumeration in .kory-eval/device-config.json and re-derived in this artifact |

The fleet backend itself belongs to infrastructure-security / cloud-security; this
artifact owns the device endpoint and its trust boundary.

## 8. Resistance claims that are deliberately false

- invasive extraction: claimed `false`
- fault injection: claimed `false`

Neither resistance was exercised. The production lock register value is board-observed, but the corpus records emulator.physicalFuseProof=false and emulator.debugLockProof=false, so no physical or invasive resistance is claimed. What would establish them: decapsulation and probing attempts against a representative board, plus glitched-signature trials with the device in a controlled harness.

## 9. Safety consequences, limits and reproduction

Safety consequences are listed separately from the privacy, availability, fleet and
credential consequences rather than folded into them: **unauthorized firmware execution** (an unsigned, corrupt, wrong-product or downgraded image is executed); **unsafe actuation** (a device in a safety-relevant role runs firmware that was never authorized for that product). Both are controlled before actuating code runs — by product binding
and the authenticated boot chain, not by anything downstream of the boot gate.

- The credential lifecycle is this repository's own model, not silicon: it shows which transitions are reachable and which moves are refused, not how a real slot behaves under a probing attack.
- The production lock register value is board-observed (corpus observed.productionLockRegister=true); what it physically enforces is not, because the corpus records debugLockProof=false and physicalFuseProof=false.
- Interface authority is the authored production policy in .kory-eval/device-config.json. It is documentation, and each attempt in this artifact is re-derived from that policy rather than measured.
- The boot, rollback and power-cut outcomes are simulator behaviour. Real power-fail behaviour, flash wear and partial erase are not modelled.
- Image digests are content digests of the corpus image records, not measurements of flash contents on hardware.
- Only the current image is recorded as executing on the board; the negative and recovery paths were not flashed in this fixture.
- No fleet backend was available in this environment, so revocation, rotation and reprovisioning are demonstrated against the model, not against a live service.
- No fault-injection, invasive or side-channel work was performed, and none of those resistances are claimed.

Scope boundaries: 
  - applied-cryptography owns algorithm and protocol construction; the authored policy records algorithmOwnedBy as applied-cryptography and no algorithm is evaluated here.
  - embedded-firmware owns RTOS tasks, drivers and peripheral implementation; this artifact records the security invariants those mechanisms must enforce.
  - supply-chain-security owns build provenance, dependency and release-signing trust; this artifact records whether the device accepts the right artifact.
  - infrastructure-security / cloud-security own the fleet backend; this artifact owns the device endpoint and its trust boundary.
  - threat-modeling-practice may establish the broader threat model; this artifact converts device-specific threats into enforceable controls.

Reproduction (deterministic, no clock, no network, no randomness):

```text
bun run build:evidence
bun run build:analysis
bun test
```

Inputs pinned by content digest:

```text
src/device-sim.ts                        sha256:e8af64b48757dbf674afa78a94795e5312c144687412a382b2fc472419ae851b
evidence/device-corpus.json              sha256:5f05cc1ee398c0bdb059f52a440c3a41976459a30c6578271272272faa4bc9cc
.kory-eval/device-config.json            sha256:c0df587ba743a81616521773b2b56480437146ab0adc7e94148f37537b0f468c
.kory-eval/device-lifecycle-evidence.json sha256:9bfdf66ac0514aa3acc30578abbcd658390e58807c7365d9b6696da88adbd5c0
```
