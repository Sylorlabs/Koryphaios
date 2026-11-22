/**
 * Threat-model content that is authored rather than computed: attacker access
 * and consequences, peripherals, communications, provenance/keys, safety
 * consequences, limits and claim boundaries.
 *
 * Everything here is documentation-grade. Nothing in this module asserts a
 * hardware measurement; the labels say so per section, and the computable parts
 * of the artifact are produced by `interface-authority.ts`,
 * `credential-lifecycle.ts` and `boot-and-update.ts`.
 */

export type EvidenceLabel = 'hardware-observed' | 'documentation' | 'simulation';

export interface AttackerCapability {
  capability: string;
  available: boolean;
  description: string;
  evidenceLabel: EvidenceLabel;
}

export interface Consequence {
  consequence: string;
  trigger: string;
  control: string;
  severity: 'safety' | 'privacy' | 'availability' | 'fleet' | 'credential';
  evidenceLabel: EvidenceLabel;
}

export const ATTACKER_MODEL: {
  capabilities: AttackerCapability[];
  consequences: Consequence[];
} = {
  capabilities: [
    {
      capability: 'remote-network-access',
      available: true,
      description:
        'the device talks to a fleet service over an authenticated channel; an attacker can reach the endpoint but the device still enforces image authenticity, product binding and version state locally',
      evidenceLabel: 'documentation',
    },
    {
      capability: 'local-protocol-access',
      available: true,
      description:
        'the fleet, update and provisioning channels are reachable by anyone who can complete the protocol handshake; capability is what the fleet record grants, not protocol reachability',
      evidenceLabel: 'documentation',
    },
    {
      capability: 'temporary-physical-possession',
      available: true,
      description:
        'the board can be held on a bench with SWD, UART and ROM download pads reachable; the fixture contract asks for authority under exactly this state',
      evidenceLabel: 'documentation',
    },
    {
      capability: 'persistent-physical-possession',
      available: true,
      description:
        'an attacker can keep the board and factory-reset it, then try to bring it back into the fleet; this is the state the fleet revocation check must defeat',
      evidenceLabel: 'documentation',
    },
    {
      capability: 'removable-storage-access',
      available: false,
      description:
        'no removable media surface is recorded for this board class; recorded as an explicit absence rather than left unexamined',
      evidenceLabel: 'documentation',
    },
    {
      capability: 'fault-injection-capability',
      available: true,
      description:
        'clock, voltage and glitch attacks are a real capability for this attacker class, and none of them were exercised in this fixture',
      evidenceLabel: 'documentation',
    },
    {
      capability: 'supply-chain-programming-access',
      available: true,
      description:
        'programming-time access could install a different key-hash anchor or lower version state; the key-hash fuse record is the control and its physical enforcement was not exercised here',
      evidenceLabel: 'documentation',
    },
  ],
  consequences: [
    {
      consequence: 'credential compromise',
      trigger: 'the per-device credential is readable or exportable through a debug or download interface',
      control:
        'non-exportable hardware-backed slot, production lock register observed on the board, fleet rotation and revocation',
      severity: 'credential',
      evidenceLabel: 'documentation',
    },
    {
      consequence: 'fleet impersonation',
      trigger: 'a revoked, reset or decommissioned device regains fleet authorization',
      control:
        'fleet revocation keyed to the immutable device identity, checked on recovery and on reprovisioning; a local reset cannot clear it',
      severity: 'fleet',
      evidenceLabel: 'documentation',
    },
    {
      consequence: 'unauthorized firmware execution',
      trigger: 'an unsigned, corrupt, wrong-product or downgraded image is executed',
      control:
        'signature, integrity, product and protected-version checks reject before execution; recovery is a separate authorization',
      severity: 'safety',
      evidenceLabel: 'documentation',
    },
    {
      consequence: 'unsafe actuation',
      trigger: 'a device in a safety-relevant role runs firmware that was never authorized for that product',
      control: 'product binding plus the authenticated boot chain; the boot gate is enforced before any actuating code runs',
      severity: 'safety',
      evidenceLabel: 'documentation',
    },
    {
      consequence: 'privacy loss',
      trigger: 'device identity or credential material is extracted and used to link or impersonate a device',
      control: 'no interface returns key material; the credential signs challenges and never leaves the slot',
      severity: 'privacy',
      evidenceLabel: 'documentation',
    },
    {
      consequence: 'availability loss',
      trigger: 'an interrupted update leaves the device with no bootable slot',
      control: 'the A/B update state machine keeps the previously authenticated slot selected before commit',
      severity: 'availability',
      evidenceLabel: 'documentation',
    },
  ],
};

export interface Peripheral {
  peripheral: string;
  capability: string;
  productionPolicy: string;
  evidenceLabel: EvidenceLabel;
}

export const PERIPHERALS: Peripheral[] = [
  {
    peripheral: 'crypto accelerator / secure slot',
    capability: 'holds the per-device credential and signs challenges',
    productionPolicy:
      'key material never readable over any bus: the slot answers challenges, it does not export; use requires the fleet record to agree',
    evidenceLabel: 'documentation',
  },
  {
    peripheral: 'flash controller',
    capability: 'writes both application slots',
    productionPolicy:
      'writes are reachable only through the authenticated update path; a write in progress is never selected for boot before verification',
    evidenceLabel: 'documentation',
  },
  {
    peripheral: 'version/rollback counter storage',
    capability: 'stores the minimum accepted version',
    productionPolicy:
      'not writable by ordinary firmware; an image below the minimum is rejected unless it carries a separate recovery authorization',
    evidenceLabel: 'documentation',
  },
  {
    peripheral: 'debug mailbox (SWD)',
    capability: 'halt, single-step and memory access over the debug bus',
    productionPolicy: 'locked in production; only the authenticated recovery path remains reachable',
    evidenceLabel: 'documentation',
  },
  {
    peripheral: 'serial console (UART)',
    capability: 'boot log output and console input',
    productionPolicy: 'read-only in production; it cannot install an image or bypass verification',
    evidenceLabel: 'documentation',
  },
  {
    peripheral: 'ROM USB download mode',
    capability: 'raw image download before the bootloader runs',
    productionPolicy:
      'entered only under physical possession, accepts only images that pass the same signature, product and version gate',
    evidenceLabel: 'documentation',
  },
  {
    peripheral: 'watchdog',
    capability: 'resets the device on a hung firmware stage',
    productionPolicy:
      'a watchdog reset re-runs the boot gate; it never resumes an unverified slot',
    evidenceLabel: 'documentation',
  },
];

export interface Channel {
  channel: string;
  purpose: string;
  deviceSideEnforcement: string;
  owner: string;
  evidenceLabel: EvidenceLabel;
}

export const COMMUNICATIONS: Channel[] = [
  {
    channel: 'fleet update channel',
    purpose: 'delivers signed application images',
    deviceSideEnforcement:
      'the device still verifies signature, integrity, product binding and version locally; a compromised transport cannot skip the boot gate',
    owner: 'device endpoint enforced here; the backend belongs to infrastructure-security / cloud-security',
    evidenceLabel: 'documentation',
  },
  {
    channel: 'fleet service channel',
    purpose: 'credential use, rotation and revocation checks',
    deviceSideEnforcement:
      'the device presents its credential and the fleet record decides; a stale local credential id grants nothing',
    owner: 'device endpoint enforced here; the fleet service belongs to infrastructure-security / cloud-security',
    evidenceLabel: 'documentation',
  },
  {
    channel: 'provisioning channel',
    purpose: 'first and replacement credential provisioning',
    deviceSideEnforcement:
      'provisioning requires an authenticated authorization; a device the fleet refused needs RMA authority',
    owner: 'device endpoint enforced here',
    evidenceLabel: 'documentation',
  },
  {
    channel: 'local debug buses',
    purpose: 'SWD, UART console and ROM USB download',
    deviceSideEnforcement:
      'bounded by the production authority enumeration in .kory-eval/device-config.json and re-derived in this artifact',
    owner: 'this skill',
    evidenceLabel: 'documentation',
  },
];

export const PROVENANCE_AND_KEYS = {
  trustAnchor: {
    property: 'production key-hash record prod-key-hash-2026 recorded on the representative board',
    evidenceLabel: 'hardware-observed' as EvidenceLabel,
    note: 'the corpus records the key-hash fuse record as read on the board; what the record physically enforces is not exercised here',
  },
  perDeviceCredential: {
    property: 'generated inside a hardware-backed, non-exportable slot',
    storage: 'secure slot, key material never leaves it',
    exportable: false,
    evidenceLabel: 'documentation' as EvidenceLabel,
  },
  artifactProvenanceBoundary:
    'build provenance, dependency integrity and the release-signing pipeline belong to supply-chain-security. This artifact records whether the device accepts the right artifact under the right boot and update policy, not how the artifact was built.',
  algorithmBoundary:
    'algorithm and protocol construction belongs to applied-cryptography. The authored policy records algorithmOwnedBy as applied-cryptography; no algorithm is designed or evaluated here.',
  keysAndCounters: {
    rotation: 'explicit rotate semantics: the new credential lands in the slot and the previous credential id is revoked at the fleet in the same operation',
    revocation: 'explicit revoke semantics: the active credential id moves to the fleet revocation list and the device holds only stale local authority',
    backup: 'no backup of the credential exists: the slot is the only copy and it is not exportable',
  },
};

export const RECOVERY_AND_DECOMMISSION_CONTRACT = {
  factoryReset: {
    destroysLocalCredentialAuthority: true,
    retainsImmutableDeviceIdentity: true,
    fleetRecordAfterReset: 'reset-pending-reprovision, unless the fleet had already refused the device, in which case it stays refused',
    silentRegainOfAuthorization: false,
    evidenceLabel: 'documentation' as EvidenceLabel,
  },
  recovery: {
    separatelyAuthorized: true,
    authorizationCarrier: 'a separate recovery authorization carried by the image and required by policy',
    signatureAloneOpensRecovery: false,
    fleetRevocationChecked: true,
    evidenceLabel: 'simulation' as EvidenceLabel,
  },
  rma: {
    preRmaCredentialRevoked: true,
    replacementProvisioned: true,
    evidenceLabel: 'documentation' as EvidenceLabel,
  },
  decommission: {
    destroysCredential: true,
    fleetRecord: 'decommissioned',
    laterRecoveryRefused: true,
    evidenceLabel: 'documentation' as EvidenceLabel,
  },
};

export const RESISTANCE_CLAIMS = {
  invasiveExtractionClaimed: false,
  faultInjectionClaimed: false,
  reason:
    'Neither resistance was exercised. The production lock register value is board-observed, but the corpus records emulator.physicalFuseProof=false and emulator.debugLockProof=false, so no physical or invasive resistance is claimed.',
  whatWouldEstablishThem:
    'decapsulation and probing attempts against a representative board, plus glitched-signature trials with the device in a controlled harness',
};

export const LIMITS: string[] = [
  'The credential lifecycle is this repository\'s own model, not silicon: it shows which transitions are reachable and which moves are refused, not how a real slot behaves under a probing attack.',
  'The production lock register value is board-observed (corpus observed.productionLockRegister=true); what it physically enforces is not, because the corpus records debugLockProof=false and physicalFuseProof=false.',
  'Interface authority is the authored production policy in .kory-eval/device-config.json. It is documentation, and each attempt in this artifact is re-derived from that policy rather than measured.',
  'The boot, rollback and power-cut outcomes are simulator behaviour. Real power-fail behaviour, flash wear and partial erase are not modelled.',
  'Image digests are content digests of the corpus image records, not measurements of flash contents on hardware.',
  'Only the current image is recorded as executing on the board; the negative and recovery paths were not flashed in this fixture.',
  'No fleet backend was available in this environment, so revocation, rotation and reprovisioning are demonstrated against the model, not against a live service.',
  'No fault-injection, invasive or side-channel work was performed, and none of those resistances are claimed.',
];

export const CLAIM_BOUNDARY =
  'This artifact shows the interface authority policy, the credential lifecycle state machine, and the boot/rollback/power-cut state machine. Debug-lock enforcement, physical fuse enforcement, resistance to invasive extraction, fault-injection resistance and real power-fail behaviour are outside what this fixture can show.';

export const SCOPE_BOUNDARIES = [
  'applied-cryptography owns algorithm and protocol construction; the authored policy records algorithmOwnedBy as applied-cryptography and no algorithm is evaluated here.',
  'embedded-firmware owns RTOS tasks, drivers and peripheral implementation; this artifact records the security invariants those mechanisms must enforce.',
  'supply-chain-security owns build provenance, dependency and release-signing trust; this artifact records whether the device accepts the right artifact.',
  'infrastructure-security / cloud-security own the fleet backend; this artifact owns the device endpoint and its trust boundary.',
  'threat-modeling-practice may establish the broader threat model; this artifact converts device-specific threats into enforceable controls.',
];

export const REPRODUCTION = {
  commands: ['bun run build:evidence', 'bun run build:analysis', 'bun test'],
  deterministic: true,
  scripts: [
    'scripts/interface-authority.ts',
    'scripts/credential-lifecycle.ts',
    'scripts/boot-and-update.ts',
    'scripts/build-lifecycle-evidence.ts',
    'scripts/build-threat-model.ts',
  ],
  tests: [
    'tests/device-config.test.ts',
    'tests/interface-authority.test.ts',
    'tests/credential-lifecycle.test.ts',
    'tests/boot-and-update.test.ts',
    'tests/evidence-artifacts.test.ts',
  ],
};
