# Device firmware threat model — `device-x` on board `mcu-rev-c`

Analysis companion to the required artifacts. It explains the policy in
`.kory-eval/boot-config.json` and the observations in
`.kory-eval/boot-evidence.json`; it is not itself verification. The
verification evidence is the artifact plus `bun test`.

- Board / revision: `mcu-rev-c`
- Product: `device-x`
- Production key-hash fuse record (board-observed): `prod-key-hash-2026`
- Deployed application image (board-observed, serial boot log): `current@7`, digest `sha256:05b6bd2a401bfbcacb5d9c45e9b32247b3e92340d5fc99198b30d79b43343dbf`
- Fixture inputs: `src/device-sim.ts` `sha256:e8af64b48757dbf674afa78a94795e5312c144687412a382b2fc472419ae851b`, `evidence/device-corpus.json` `sha256:5f05cc1ee398c0bdb059f52a440c3a41976459a30c6578271272272faa4bc9cc`

## Evidence classes used throughout

| Label | Meaning |
| --- | --- |
| board-observed | read from the fixture's board observation set (`observed.serialBootLog`, `observed.keyHashFuseRecord`, `observed.productionLockRegister`) |
| emulator-only | derived from `src/device-sim.ts`; proves state-machine logic, not silicon behaviour |
| derived fixture | an image record this analysis derived from a corpus image to probe a boundary; never written into the corpus |

What this fixture does **not** establish, on any surface: debug lock, physical
fuse enforcement, resistance to invasive measurement or fault injection, and
resistance to physical secret extraction. The corpus records
`emulator.physicalFuseProof=false` and `emulator.debugLockProof=false`, and
`boot-config.json` therefore carries `debugFuseObserved=false`. Only the
key-hash fuse record is board-observed.

## 1. Attacker access and consequences

| Access the attacker is assumed to hold | Available in this fixture? | Security consequence that must be assumed |
| --- | --- | --- |
| Remote network access to the device | no observation | firmware corruption attempts, downgrade push, denial of service |
| Local protocol access (update channel, provisioning) | no observation | installation of an older or wrong-product image, rollback |
| Temporary physical possession | assumed | attempts to reach SWD/UART/download mode and read flash |
| Persistent physical possession | assumed | offline analysis, flash readout, key extraction attempt |
| Removable storage access | no observation | image substitution if any slot is writable off-device |
| Fault injection (voltage/clock/optical) | assumed possible, not measured here | bypass of a verification branch; requires hardware countermeasures |
| Supply-chain / programming access | no observation | substitution of bootloader or keys at manufacture or RMA |

Consequences are tracked separately, because they are not interchangeable:

- **Safety** — a device that boots an unverified image can drive actuators with
  unauthenticated code. The power-cut matrix exists to keep this from happening
  during an interrupted update.
- **Privacy** — secrets readable through another interface would defeat
  authenticated boot entirely; the fixture has no credential observations, so
  this stays an open hardware question.
- **Availability** — an updatable device that rejects every image after a
  failed update is bricked; recovery is the answer and is exercised here.
- **Fleet** — one accepted rollback image is accepted on the whole fleet, so
  version state is protected on the device, not only in the cloud.
- **Credential compromise** — out of scope of this fixture's observations.

## 2. Boot chain from the immutable root

| Stage | Mutability | What it enforces | Failure behaviour | Evidence class |
| --- | --- | --- | --- | --- |
| Immutable Boot ROM | immutable | trusts the production key-hash fuse record `prod-key-hash-2026` and authenticates the mutable bootloader | reject before executing any mutable stage | key-hash record board-observed; ROM behaviour is the fixture's stated contract, emulator-only |
| First-stage bootloader | mutable, authenticated by Boot ROM | `bootloaderVerifiesSignature=true`, `bootloaderVerifiesProduct=true`; integrity checked first | `reject-signature` / `reject-product` / `reject-corrupt` before execution | emulator-only |
| Protected rollback state | protected from ordinary firmware writes | `minimumVersion=7` (`rollbackStateProtected=true`) | `reject-rollback` for a version below the minimum without separate authorization | emulator-only |
| Authorized recovery | separately authorized destination | `recoveryRequiresAuthorization=true` | an unauthorized below-minimum image is a rollback, not a recovery | emulator-only |
| Application | mutable | verified on every boot | falls back to the previously authenticated slot | current image boots, board-observed |

There is no mutable stage that executes before the Boot ROM's policy is
enforced: the first mutable stage is the bootloader and it is itself
authenticated by the immutable root.

## 3. Authenticated, rollback-resistant updates

Update authorization is bound to product (`device-x`), to the deployed
anti-rollback floor (version 7, the version the board actually runs), and to a
separate recovery authorization. The candidate is verified before execution,
never during execution.

Every supplied transition is exercised for the authenticated candidate
`new@8` and for each negative candidate:

| Candidate | Gate result | `write-inactive` / `verify-inactive` | `mark-pending` / `boot-pending` / `commit-version` |
| --- | --- | --- | --- |
| `new@8` (authenticated update) | `boot` | `current@7` | `new@8` |
| `older@5` (signed downgrade) | `reject-rollback` | `current@7` | `current@7` |
| `wrong-product@8` | `reject-product` | `current@7` | `current@7` |
| `unsigned@8` | `reject-signature` | `current@7` | `current@7` |
| `corrupt@8` | `reject-corrupt` | `current@7` | `current@7` |
| `recovery@3` offered as an update | `recovery` | `current@7` | `current@7` |
| `new-unsigned@8` installed from authorized recovery | `reject-signature` | `recovery@3` | `recovery@3` |
| `new@8` installed from authorized recovery | `boot` | `recovery@3` | `new@8` |
| `recovery-unauthorized@3` (derived counterfactual) | `reject-rollback` | `current@7` | `current@7` |

No transition selects a slot whose decision is not an accept, so no unverified
slot executes at any cut point. Two deliberate consequences of this policy are
worth stating: an authorized recovery image is a boot destination, never an
installable update candidate; and a failed restore leaves the device in an
authorized state (authorized recovery) rather than on an unverified slot.

## 4. Privileged interface inventory

Production policy for each surface. The fixture supplies **no** board
observation for any of these, so nothing below is a measurement — these are the
policies that must be enforced and then verified on hardware.

| Surface | Required production policy | Observation here |
| --- | --- | --- |
| JTAG/SWD | disabled or authenticated; capability limit; authorized recovery path | none |
| UART console | not privileged; cannot install images or bypass verification | none |
| ROM USB download mode | accepts authenticated images only; cannot lower version state | none |
| Test pads / manufacturing commands | authenticated; cannot install an unverified image or clear rollback state | none |
| USB device stack / DFU | bounded parsers; no unauthenticated flash write path | none |
| BLE/Wi-Fi provisioning | mutually authenticated provisioning; no open pairing that writes slots | none |
| NFC | no image write path | none |
| Removable media | not a boot source, or verified like any other image | none |
| DMA-capable peripherals | least-privilege access; no DMA into security-critical memory | none |
| Hidden/service protocols | enumerated and either authenticated or disabled; no obscurity-only protection | none |

Relying on "nobody knows the port exists" is not a policy for any row above.

## 5. Device identity and secrets lifecycle

Trace each item to an access path and a lifecycle, then verify the path — do not
infer protection from a feature name.

| Lifecycle step | Required handling | Observation here |
| --- | --- | --- |
| Provisioning | identity and key material written under an authenticated manufacturing mode | none |
| Generation / import | keys generated on device, or imported only into a hardware-backed store | none |
| Storage | hardware-backed isolation where the threat model needs it; export path closed | none |
| Use | security-relevant use confined to the isolated domain | none |
| Rotation / revocation | credential rotation and fleet revocation reachable from an authenticated channel | none |
| Backup / exportability | no exportable copy of the private material | none |
| Factory reset | destroys or invalidates device credentials, not just user data | none |
| RMA | re-provisioning path is authenticated; previous credentials are invalidated | none |
| Decommissioning | credential destruction is final and evidenced | none |

Because the fixture records no credential or key material observations, this
table is a requirements checklist for a hardware review, not a set of results.

## 6. Firmware authority constraints

- Isolate security-relevant code with the MPU/TrustZone-class mechanism that the
  part actually provides, and confirm the isolation is enabled, not merely
  present.
- Give peripherals least privilege; no peripheral should be able to write
  security-critical memory or rollback state.
- Bound parsers and protocol handlers so a malformed image or frame cannot
  exhaust the boot path.
- Watchdog and fail-safe behaviour: a watchdog event must land in an
  authenticated slot, never in an unverified one.
- Make mode transitions explicit: normal, recovery, manufacturing and secure
  states must be distinguishable and each must be authorized.

## 7. Verification performed here, and what remains for hardware

Run from the working directory:

- `bun run scripts/build-boot-evidence.ts` — regenerates
  `.kory-eval/boot-evidence.json` deterministically (byte-identical on an
  unchanged tree).
- `bun test` — 26 tests, 388 assertions, 0 failures. They re-derive every
  decision, digest and power-cut transition from `src/device-sim.ts` and
  `evidence/device-corpus.json` rather than restating them, check the artifact
  labels, and check that the artifact makes no claim the emulator cannot
  support.

Still requires representative hardware before it can be claimed:

| Claim that needs hardware | Why the fixture cannot show it |
| --- | --- |
| Debug lock is effective in production | the corpus records `emulator.debugLockProof=false` |
| Physical fuse enforcement holds | the corpus records `emulator.physicalFuseProof=false` |
| Secret extraction is resisted | no invasive or fault-injection model exists here |
| Power-cut behaviour on real flash | the simulator models decisions, not flash wear, bit-rot or partial erasure |
| Interface policy is actually enforced | no interface observation exists in this fixture |

## 8. Scope boundary

`embedded-device-security` owns the device trust anchors, signed images,
rollback state, privileged interfaces, credentials and recovery contracts
described above. Adjacent disciplines are not absorbed here:

- `embedded-firmware` — RTOS tasks, drivers, peripherals and timing.
- `applied-cryptography` — algorithm and protocol construction.
- `supply-chain-security` — build provenance and the artifact-signing pipeline.
- `infrastructure-security` / `cloud-security` — the fleet backend and control
  plane.
- `threat-modeling-practice` — the broader enterprise threat model.
- Application security of the host/mobile/web tier — a separate
  responsibility that this task did not request, so no application-layer
  control is claimed or graded here.
