# Device firmware threat model — `device-x` on board `mcu-rev-c`

Analysis companion to the required artifacts. It explains the policy in
`.kory-eval/device-config.json` and the observations in
`.kory-eval/device-lifecycle-evidence.json`; it is not itself verification. The
verification evidence is the artifact plus `bun test` (32 tests, 599 assertions,
0 failures) run from this directory.

- Board / revision: `mcu-rev-c`
- Product: `device-x`
- Production key-hash fuse record (hardware-observed): `prod-key-hash-2026`
- Deployed application image (hardware-observed, serial boot log): `current@7`,
  digest `sha256:05b6bd2a401bfbcacb5d9c45e9b32247b3e92340d5fc99198b30d79b43343dbf`
- Production lock register: hardware-observed (`corpus.observed.productionLockRegister=true`)
- Fixture inputs, unmodified:
  `src/device-sim.ts` `sha256:e8af64b48757dbf674afa78a94795e5312c144687412a382b2fc472419ae851b`,
  `evidence/device-corpus.json` `sha256:5f05cc1ee398c0bdb059f52a440c3a41976459a30c6578271272272faa4bc9cc`

## Evidence classes used throughout

| Label | Meaning in this fixture |
| --- | --- |
| `hardware-observed` | recorded in `corpus.observed`: `serialBootLog`, `keyHashFuseRecord`, `productionLockRegister` |
| `documentation/simulation` | stated by the fixture contract, derived from `src/device-sim.ts`, or produced by the authored credential model in `scripts/device-lifecycle-model.ts` |

What this fixture does **not** establish, on any surface: effective debug lock,
physical fuse enforcement, resistance to invasive secret extraction, resistance
to fault injection, and any credential hardware behaviour. The corpus records
`emulator.physicalFuseProof=false` and `emulator.debugLockProof=false`, so
`device-config.json` ships `debugFuseObserved: false`,
`invasiveResistanceClaimed: false` and `faultInjectionResistanceClaimed: false`.

## 1. Attacker access and consequences

| Access the attacker is assumed to hold | Available in this fixture? | Consequence that must be assumed |
| --- | --- | --- |
| Remote network access to the device | no observation | image-substitution and downgrade pushes through the delivery channel |
| Local protocol access (update, provisioning) | no observation | installation of an older or wrong-product image |
| Temporary physical possession | assumed | bench access to SWD header, test pads, UART console, ROM boot strap |
| Persistent physical possession | assumed | offline analysis, flash readout, credential-extraction attempts |
| Removable storage access | no observation | image substitution if any slot is writable off-device |
| Fault injection (voltage/clock/optical) | assumed possible, not exercised | bypass of a verification branch; needs hardware countermeasures |
| Supply-chain / programming access | no observation | substitution of bootloader or keys at manufacture or RMA |

Consequences are tracked separately, because they are not interchangeable:

- **Safety** — a device that runs an unverified image can drive actuators with
  unauthenticated code. Interface authority is therefore bounded by the same
  gate the bootloader applies, and no power-cut step from authorized recovery
  selects an unverified slot.
- **Privacy** — secrets readable through another interface would defeat
  authenticated boot entirely. SWD holds no readout authority in either
  possession state per the fixture contract, but that bound is
  documentation/simulation, not a hardware measurement.
- **Availability** — an updatable device that rejects every image after a failed
  update is bricked; recovery is the answer, and it is exercised here.
- **Fleet** — one accepted rollback image is accepted on the whole fleet, so
  version state is protected on the device, not only in the cloud.
- **Credential compromise** — one exported credential compromises the device
  class. The credential is non-exportable by policy
  (`credentialExportable=false`), which is a contract claim here, not a
  measurement.

## 2. Boot chain and provenance

| Stage | Mutability | What it enforces | Failure behaviour | Evidence class |
| --- | --- | --- | --- | --- |
| Immutable Boot ROM | immutable | trusts the production key-hash fuse record `prod-key-hash-2026` and authenticates the mutable bootloader | reject before executing any mutable stage | key-hash record hardware-observed; ROM behaviour is the fixture's stated contract (documentation/simulation) |
| First-stage bootloader | mutable, authenticated by Boot ROM | `bootloaderVerifiesSignature=true`, `bootloaderVerifiesProduct=true`; integrity checked first | `reject-signature` / `reject-product` / `reject-corrupt` before execution | documentation/simulation |
| Protected rollback state | protected from ordinary firmware writes | `minimumVersion=7` | `reject-rollback` for a version below the minimum without separate authorization | documentation/simulation |
| Authorized recovery | separately authorized destination | `recoveryRequiresAuthorization=true` | an unauthorized below-minimum image is a rollback, not a recovery | documentation/simulation |
| Application | mutable | verified on every boot | falls back to the previously authenticated slot | `current@7` executes, hardware-observed |

Provenance recorded for every image the gate is applied to:

| Image | Version | Digest | Gate decision | Executed |
| --- | --- | --- | --- | --- |
| `current` | 7 | `sha256:05b6bd2a…43dbf` | `boot` | yes (board-observed on the serial boot log) |
| `older` | 5 | `sha256:89fb215a…b1afe` | `reject-rollback` | no |
| `wrong-product` | 8 | `sha256:22de78a3…9126` | `reject-product` | no |
| `unsigned` | 8 | `sha256:0fae0ed4…3e43` | `reject-signature` | no |
| `corrupt` | 8 | `sha256:75fe7053…832f` | `reject-corrupt` | no |
| `recovery` | 3 | `sha256:d25e9635…5b6e` | `recovery` | yes, only through the authorized recovery path |
| `recovery-unauthorized` (derived counterfactual) | 3 | `sha256:72b74001…c825` | `reject-rollback` | no |

The counterfactual is the load-bearing row: the same signed, non-corrupt,
correctly bound image is accepted only when it carries the separate recovery
authorization. A valid signature alone does not open the recovery path, so
recovery is an authorization rather than a rollback bypass.

## 3. Update and rollback bounds on every write path

The boot/update gate is derived from the fixed corpus (product `device-x`,
key-hash `prod-key-hash-2026`, `minimumVersion` = the board-observed deployed
version 7), and it bounds **every** write path: OTA, ROM USB download and the
authenticated recovery path. "Download permitted" can therefore only ever mean
"download permitted for an image this gate accepts". Power-cut behaviour from
authorized recovery:

| Candidate | Gate result | `write-inactive` / `verify-inactive` | `mark-pending` / `boot-pending` / `commit-version` |
| --- | --- | --- | --- |
| `new@8` (authenticated update) | `boot` | `recovery@3` | `new@8` |
| `new-unsigned@8` | `reject-signature` | `recovery@3` | `recovery@3` |

No transition selects a slot whose decision is not an accept, so no unverified
slot executes at any cut point, and a failed restore leaves the device in an
authorized state rather than on an unverified slot.

## 4. Privileged interface inventory

Production authority per surface and possession state, evaluated through the
supplied `interfaceCan` (38 attempts: 6 authorized, 32 denied, 0 of 12 readout
attempts authorized):

| Surface | Normal service | Temporary physical possession | Authenticated recovery |
| --- | --- | --- | --- |
| SWD | no unrestricted firmware/secret readout; no general debug session | identical bound — possession does not escalate | recovery session only; still no readout |
| UART console | console log output only | identical bound | authenticated recovery console only |
| ROM USB download | no download authority (mode not reachable, no write path open) | authenticated images only, bounded by the boot/update gate; no rollback lowering; not a readout path | authorized recovery image only |

The two possession states are enumerated separately on purpose: the security
property is that possession does not change authority. A bench attacker with the
case open gets exactly the authority a remote attacker gets, plus the physical
ability to *attempt* the same interfaces.

The fixture supplies no board observation for the wider surface inventory, so
the following are requirements for a hardware review, not results:

| Surface | Required production policy | Observation here |
| --- | --- | --- |
| Test pads / manufacturing commands | authenticated; cannot install an unverified image or clear rollback state | none |
| USB device stack / DFU | bounded parsers; no unauthenticated flash write path | none |
| BLE/Wi-Fi provisioning | mutually authenticated provisioning; no open pairing that writes slots | none |
| NFC | no image write path | none |
| Removable media | not a boot source, or verified like any other image | none |
| DMA-capable peripherals | least-privilege access; no DMA into security-critical memory | none |
| Hidden / service protocols | enumerated and either authenticated or disabled; no obscurity-only protection | none |
| Maintenance UART variants / secondary consoles | same bound as the primary console | none |

Relying on "nobody knows the port exists" is not a policy for any row above.

## 5. Device identity and secrets lifecycle

The credential lifecycle contract and the modelled behaviour of each step. Every
row is `documentation/simulation`: the corpus records no credential, key-slot or
fleet observation, so no row here is hardware-observed.

| Lifecycle step | Requirement | Config flag | Demonstrated by |
| --- | --- | --- | --- |
| Provisioning | authenticated path into a hardware-backed slot | `credentialHardwareBacked=true` | `provision-and-use` |
| Generation / import | generated on device or imported only into the slot; algorithm design belongs to `applied-cryptography` | `algorithmOwnedBy=applied-cryptography` | `provision-and-use` (slot placement only) |
| Storage | hardware-backed isolation, no export path | `credentialExportable=false` | `export-attempt-blocked` |
| Use | live slot + current handle + authorized fleet record | `fleetRevocationCheckedOnRecovery=true` | `provision-and-use`, `fleet-revocation-denies-use` |
| Rotation | previous handle retired and rejected | explicit rotate semantics | `rotate-invalidates-previous-handle` |
| Revocation | fleet-side, no device contact required | `fleetRevocationCheckedOnRecovery=true` | `fleet-revocation-denies-use` |
| Backup / exportability | no exportable copy exists | `credentialExportable=false` | `export-attempt-blocked` |
| Update | protected through update | protected through update | `update-and-authorized-recovery-preserve-credential` |
| Recovery | protected through recovery, and recovery is separately authorized | `authorizedRecoveryOnly=true` | `update-and-authorized-recovery-preserve-credential` + the recovery counterfactual |
| Factory reset | destroys/invalidates local credential authority | `resetDestroysOrInvalidatesCredential=true` | `factory-reset-invalidates-credential` |
| RMA | previous credential invalidated; re-provision only authenticated | protected through RMA | `rma-invalidates-previous-credential` |
| Decommission | credential destroyed, final | `decommissionDestroysCredential=true` | `decommission-destroys-credential` |
| Fleet record | revocation prevents silent re-authorization after reset/recovery | `fleetRevocationCheckedOnRecovery=true` | `reset-device-cannot-silently-regain-authorization` |

Nine lifecycle scenarios run: 9/9 match the outcome this analysis requires. The
partial state that distinguishes real expertise from a happy path is the
reset/recovered device: after a factory reset the device holds no usable
credential, a silent re-authorization attempt is refused, and an authenticated
re-provisioning request is still refused while the fleet entry is revoked. Only
when the request is authenticated *and* the fleet record still authorizes the
device does it regain a credential.

## 6. Firmware authority constraints

Requirements, with no observation in this fixture: isolate security-relevant
code with the MPU/TrustZone-class mechanism the part actually provides and
confirm the isolation is enabled rather than merely present; give peripherals
least privilege so no peripheral can write security-critical memory or rollback
state; bound parsers so a malformed image or frame cannot exhaust the boot path;
make watchdog events land in an authenticated slot; and make mode transitions
between normal, recovery, manufacturing and secure states explicit and each
separately authorized.

## 7. Communications

The delivery and provisioning channels must authenticate the artifact and the
requester, and the device must still enforce product binding, signature and
version state locally — a channel that is trusted to send only good images is
not a control, because one accepted rollback is accepted on the whole fleet. The
fleet backend and control plane that own the revocation record belong to
`infrastructure-security`/`cloud-security`; this analysis owns the device
endpoint and its trust boundary, which is why fleet revocation is modelled as a
gate the *device* consults rather than as a backend property.

## 8. Recovery and decommission contract

- Recovery is a separately authorized destination, never an ordinary installable
  image and never a signature-only rollback bypass (demonstrated, §2).
- A failed restore from authorized recovery leaves the device in an authorized
  state (§3).
- Factory reset removes local credential authority; the fleet entry alone never
  re-authorizes the device (§5).
- RMA invalidates the previous credential and re-provisions only through an
  authenticated path (§5).
- Decommission destroys the credential and revokes the fleet entry, and is final
  (§5).

## 9. Verification performed here, and what remains for hardware

Run from this directory:

- `bun run scripts/build-lifecycle-evidence.ts` — regenerates
  `.kory-eval/device-lifecycle-evidence.json` deterministically (byte-identical
  on an unchanged tree; the test asserts it).
- `bun test` — 32 tests, 599 assertions, 0 failures. They re-derive every
  interface authority through `interfaceCan`, every gate decision through
  `bootDecision`, every power-cut transition through `powerCutRecovery`, and
  every credential lifecycle case through the authored model, rather than
  restating them; they check the artifact labels, the environment bindings and
  that the artifact makes no claim the emulator cannot support.

Still requires representative hardware before it can be claimed:

| Claim that needs hardware | Why the fixture cannot show it |
| --- | --- |
| Debug lock is effective in production | the corpus records `emulator.debugLockProof=false` |
| Physical fuse enforcement holds | the corpus records `emulator.physicalFuseProof=false` |
| Secret extraction is resisted | no invasive or fault-injection model exists here |
| The credential really is non-exportable from its slot | no credential or key-slot observation exists |
| Interface policy is enforced on silicon | no interface attempt is board-observed here |
| Communications and peripheral behaviour | no observation exists for any of those surfaces |

## 10. Limits

- The supplied simulator models boot, update and recovery decisions only. The
  credential lifecycle is therefore an authored model
  (`scripts/device-lifecycle-model.ts`), and every one of its results is
  `documentation/simulation`.
- Image digests are content digests of the corpus image records, not
  measurements of flash contents on hardware.
- The recovery counterfactual, the update candidate and the unsigned candidate
  are derived fixtures: they are labelled as such and are not present in
  `evidence/device-corpus.json`.
- Interface authority is evaluated as policy membership. The fixture supplies no
  board observation of an interface attempt, so no attempt result is
  hardware-observed.
- No fleet, credential or communication behaviour is hardware-observed; the
  `infrastructure-security`/`cloud-security` backend that owns the fleet record
  is out of scope here.

## 11. Scope boundary

`embedded-device-security` owns the device trust anchors, the boot/update gate,
privileged interface authority, the credential lifecycle and the recovery
contract described above. Adjacent disciplines are not absorbed here:

- `embedded-firmware` — RTOS tasks, drivers, peripheral implementation, timing.
- `applied-cryptography` — algorithm and protocol construction
  (`algorithmOwnedBy=applied-cryptography`; no algorithm is designed or graded
  here).
- `supply-chain-security` — build provenance and the artifact-signing pipeline.
- `infrastructure-security` / `cloud-security` — the fleet backend and control
  plane.
- `threat-modeling-practice` — the broader threat model this analysis converts
  into device controls.
- Application security of a host, mobile or web tier — a separate
  responsibility that this task did not request, so no application-layer
  control is claimed or graded here.
