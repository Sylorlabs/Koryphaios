# Threat model — device firmware (board `mcu-rev-c`)

Scope: the firmware trust boundary of the supplied fixture. Board, revision, image
versions and the trust anchors below are taken from `evidence/device-corpus.json`
(fixed, unmodified); every decision quoted here is re-derived through the supplied
simulator `src/device-sim.ts` (unmodified) and recorded in
`.kory-eval/boot-evidence.json`, which this document cites by key.

## Claim labels used

| Label | Meaning in this fixture |
| --- | --- |
| `board-observed` | Recorded in `corpus.observed`: `keyHashFuseRecord`, `productionLockRegister`, `serialBootLog`. |
| `emulator-only` | Produced by calling `src/device-sim.ts` on the corpus: all boot decisions, the recovery-authorization decision, all power-cut transitions, image digests, and the serial text itself. |
| `not determined` | Not established by this fixture — listed so it is never mistaken for a proof. |

Reproduce with `bun scripts/generate-evidence.ts` and `bun test` (39 tests).

## 1. Physical access / attacker model

Assumed for this model: an attacker with temporary or persistent physical
possession, plus remote access to the delivery channel that supplies OTA images
(firmware is the attacked surface, and the fixture's image set is exactly a
delivered-artifact set: signed, unsigned, corrupt, wrong-product, older).

- Physical possession is assumed because everything below (debug, extraction,
  slot tampering, power interruption) requires it. Removing physical access from
  the model would remove most of the residual risks in §10.
- `emulator-only`: the model's controls are demonstrated as boot-chain state
  transitions, not as physical resistance.
- `not determined`: decapping/microprobing resistance, glitching, EM and laser
  fault injection, side-channel key extraction (`corpus.emulator.
  physicalFuseProof=false`).

## 2. Debug and maintenance interfaces

- `board-observed`: a production lock register exists and is readable
  (`corpus.observed.productionLockRegister=true`).
- `not determined`: the debug fuse / SWD lock state. The corpus explicitly
  records `emulator.debugLockProof=false`, and the production lock register is a
  *different* register — so `.kory-eval/boot-config.json` ships
  `debugFuseObserved: false` and no debug-lock claim is made anywhere. An open
  SWD/UART in production would let an attacker with possession read/write slots
  and secrets; this fixture cannot disprove that, so it is carried as an open
  risk, not a control.
- Control posture (asserted as policy, `emulator-only` for the decision logic):
  privileged interfaces must be disabled or authenticated in production, and
  recovery access must be authorized rather than reachable by a signed-but-older
  image.

## 3. Boot chain and trust anchors

Chain, from the root:

1. Immutable Boot ROM trusts the production key-hash fuse record
   (`prod-key-hash-2026`, `board-observed`) and authenticates the mutable
   second-stage bootloader. The mutable bootloader is the control point for
   signature, product and version policy; Boot ROM itself is the trust anchor.
2. Bootloader authenticates the application/recovery image signature
   (`bootloaderVerifiesSignature=true`) and the product binding
   (`bootloaderVerifiesProduct=true`).
3. Protected rollback state rejects a signed older image
   (`rollbackStateProtected=true`, `minimumVersion=7` — see §8).
4. Recovery is separately authorized (`recoveryRequiresAuthorization=true`), so
   an older authorized-recovery image cannot act as a signature-only rollback
   bypass.

`emulator-only` decisions (keys in `.kory-eval/boot-evidence.json` →
`bootDecisions`):

| Image | Key (id@version:digest12) | Decision |
| --- | --- | --- |
| current v7 | `current@v7:675df385f0d9` | `boot` |
| older v5 | `older@v5:320f1578a93a` | `reject-rollback` |
| wrong-product v8 | `wrong-product@v8:9721ec874056` | `reject-product` |
| unsigned v8 | `unsigned@v8:b9af2aa96cbc` | `reject-signature` |
| corrupt v8 | `corrupt@v8:800b567fc022` | `reject-corrupt` |
| recovery v3 (authorized) | `recovery@v3:a5d5c179b206` | `recovery` |

Adjacent-skill decoy, resolved: the `wrong-product` fixture is v8 — *newer* than
`minimumVersion` — so a version-only reading would admit it. It is rejected by
product binding instead, which is the actual control. A test proves it by
disabling only `bootloaderVerifiesProduct`, after which the same image boots:
the rejection came from the product binding, not the version.

## 4. Provenance

- `board-observed`: the production key-hash fuse value is the anchor the Boot ROM
  trusts; the board emits a serial boot log.
- `emulator-only`: image digests are SHA-256 over fixture metadata (fixed key
  order, reproducible), recorded per image in `imageIndex`. They identify
  fixture records; they are **not** hardware measurements of flash contents.
- `not determined`: build/signing-pipeline provenance of the images themselves
  is supply-chain-security's responsibility, not this fixture's; the device-side
  question — "does the device accept the right artifact under the right policy" —
  is what §3 and §8 answer.

## 5. Keys

- `board-observed`: a key-hash fuse record exists and matches the supplied
  production hash (`prod-key-hash-2026`). Only the *hash* is observed; no key
  material is read, stored, or claimed to be extractable/inaccessible.
- `emulator-only`: signature verification outcomes for the six corpus images and
  the derived candidate.
- `not determined`: key generation/import path, storage isolation, rotation,
  revocation, backup/exportability, factory-reset/RMA/decommission behavior, and
  any hardware-backed isolation. Attacker consequence carried: if the debug or
  extraction assumptions of §2 fail, key compromise is fleet-wide, which is why
  §2 is an open risk rather than a closed control.

## 6. Communications

- The fixture models no transport. What it does establish is that the *device
  side* of the update channel is safe to feed adversarial images: an unsigned,
  corrupt, wrong-product, or rolled-back image delivered over any channel
  (BLE/Wi-Fi/USB/NFC/removable media) is rejected before execution
  (`emulator-only`).
- `not determined`: transport authentication, anti-rollback of *metadata*,
  server-side authorization of the recovery path, and fleet revocation. Those
  are cloud/infrastructure concerns; the endpoint contract here is "reject
  unless authenticated, product-correct, fresh-or-authorized-recovery".

## 7. Peripherals

- `not determined`: the fixture's `DeviceConfig` interface sketch (`swd`, `uart`,
  `romUsb`) declares capability lists, but no observed register or log constrains
  them, so no peripheral capability claim is made. Production policy required:
  disable or authenticate SWD/UART/ROM-USB, bound DMA-capable peripherals, and
  gate manufacturing/maintenance commands. See §2 for why debug remains open.

## 8. Update (the power-cut matrix)

Update steps supplied by the corpus: `write-inactive`, `verify-inactive`,
`mark-pending`, `boot-pending`, `commit-version`.

- The corpus deliberately ships **no valid newer image** — every v8 fixture is a
  negative case (unsigned / corrupt / wrong product). To exercise the candidate
  branch, `scripts/evidence-lib.ts` derives the intended OTA image
  (`candidate@v8:e0b585d70197`, device-x, signed, valid). It is labelled
  `source: derived-emulator-fixture`, is not part of the corpus, and is not
  passed off as board data.
- `emulator-only` results, recorded under `powerCutRecovery` keyed by candidate
  image key × cut step (35 pairs):
  - valid candidate: `write-inactive`/`verify-inactive` → authenticated
    `current`; `mark-pending`/`boot-pending`/`commit-version` → authenticated
    `candidate`. The inactive slot is never executed before it is verified.
  - every other candidate (older, wrong-product, unsigned, corrupt, recovery):
    **all five** steps → authenticated `current`.
- Invariant `no-unverified-slot-executed-on-power-cut`: for all 35 pairs, the
  resumed image's own `bootDecision` is `boot` or `recovery` — never a reject.
- `not determined`: real power-fail behavior, flash wear/atomicity, and what a
  cut during `commit-version` does to a protected version counter on hardware.

## 9. Recovery (demonstrated, not assumed)

- `emulator-only`: `bootDecision(recovery v3)` = `recovery` under the shipped
  config — the device enters separately authorized recovery instead of booting
  the older image. On a cut during recovery-image install at any of the five
  steps, the device falls back to authenticated `current` (the recovery image is
  never resumed as an ordinary image).
- Negative control (`negativeControls.recoveryAuthorizationBypass`, explicitly
  `isDevicePolicy: false`): with `recoveryRequiresAuthorization=false`,
  `bootDecision(recovery)` = `boot` and a cut at `commit-version` resumes the
  old image. That is the signature-only rollback bypass the shipped config
  prevents; it is recorded as contrast evidence, not policy.
- `not determined`: who authorizes recovery on real hardware, whether that
  authorization is hardware-bound, and fleet revocation on recovery entry.

## 10. Limits of this evidence (what is *not* proven)

A simulator proves state-machine logic only. Nothing here proves, on hardware:
debug-lock/fuse state; physical or invasive secret extraction; fault-injection
resistance; real power-fail behavior; or hardware-root enforcement beyond the
supplied key-hash fuse record. The corpus says so itself
(`emulator.debugLockProof=false`, `emulator.physicalFuseProof=false`), and the
config's `debugFuseObserved: false` encodes that limit. The remaining risks that
board-observed proof would have to close are listed under §2, §5 and §7.

## 11. Safety consequences

Per consequence class, so they are not conflated:

- **Safety** (physical harm): an unverified slot executing on an actuator-adjacent
  device is the worst case. This is exactly what the boot chain prevents
  (`emulator-only`): unsigned, corrupt, wrong-product and rolled-back images are
  rejected before execution, and no power-cut transition resumes a slot the boot
  policy rejects. A recovery path that is a rollback bypass (negative control
  above) would reintroduce it.
- **Availability / bricking**: a cut during update must leave a bootable,
  authenticated image. Demonstrated for all 35 (candidate, step) pairs:
  fallback to `current` or resumption of the verified `candidate` — never an
  unverified slot.
- **Privacy / credential compromise**: not established; depends on §2/§5.
  Consequence carried as fleet-wide if §2 is wrong.
- **Fleet**: downgrade-to-vulnerable and wrong-product cross-flashing are
  rejected by version floor (`minimumVersion=7` > older v5) and product binding
  respectively (`emulator-only`). Fleet revocation is `not determined`.

## Preserved inputs and contracts

Unmodified and integrity-pinned (SHA-256 in `scripts/…`-independent test
`tests/boot-policy.test.ts`, and re-hashed inside the evidence `generator`
block): `src/device-sim.ts`
(`e8af64b48757dbf674afa78a94795e5312c144687412a382b2fc472419ae851b`) and
`evidence/device-corpus.json`
(`5f05cc1ee398c0bdb059f52a440c3a41976459a30c6578271272272faa4bc9cc`).
`package.json` and `tests/.gitkeep` are also untouched; no script, platform
branching, or simulation rewrite was needed — the artifacts drive the supplied
simulator as-is. Regenerating evidence is deterministic: re-running
`bun scripts/generate-evidence.ts` reproduces `boot-evidence.json` byte for byte
(asserted by `tests/artifacts.test.ts`).
