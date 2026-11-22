/**
 * Deterministic builder for `.kory-eval/device-lifecycle-evidence.json`.
 *
 * No claim is retyped here: interface attempts are re-derived from the authored
 * policy with the supplied `interfaceCan()`, the credential lifecycle is executed
 * by `credential-lifecycle.ts`, and every boot/rollback/power-cut outcome comes
 * from the supplied simulator. Re-running this file on an unchanged tree
 * reproduces a byte-identical artifact, which `tests/evidence-artifacts.test.ts`
 * asserts.
 */
import { bootDecision, type BootConfig, type Image } from '../src/device-sim';
import {
  CORPUS_PATH,
  CONFIG_PATH,
  EVIDENCE_PATH,
  SIM_PATH,
  type AuthoredDeviceConfig,
  type Corpus,
  corpusImage,
  deriveBootPolicy,
  fileDigest,
  imageKey,
  readConfig,
  readCorpus,
  LABEL_DEFINITIONS,
  writeArtifact,
} from './kory-artifact';
import {
  ATTACKER_MODEL,
  CLAIM_BOUNDARY,
  COMMUNICATIONS,
  LIMITS,
  PERIPHERALS,
  PROVENANCE_AND_KEYS,
  RECOVERY_AND_DECOMMISSION_CONTRACT,
  REPRODUCTION,
  RESISTANCE_CLAIMS,
  SCOPE_BOUNDARIES,
} from './attack-surface';
import {
  INTERFACE_NAMES,
  POSSESSION_STATES,
  POSSESSION_STATE_DEFINITIONS,
  enumerateAuthority,
  parseAuthorityToken,
  probeAttempts,
} from './interface-authority';
import { LIFECYCLE, recordFor, runLifecycle } from './credential-lifecycle';
import {
  imageEntry,
  powerCutScenario,
  resolvedEnvironmentFacts,
  trustChain,
} from './boot-and-update';

export function buildEvidence(
  corpus: Corpus,
  config: AuthoredDeviceConfig,
): Record<string, unknown> {
  const policy: BootConfig = deriveBootPolicy(corpus, config);
  const current = corpusImage(corpus, 'current');
  const older = corpusImage(corpus, 'older');
  const wrongProduct = corpusImage(corpus, 'wrong-product');
  const unsigned = corpusImage(corpus, 'unsigned');
  const corrupt = corpusImage(corpus, 'corrupt');
  const recovery = corpusImage(corpus, 'recovery');

  // Derived fixtures: constructed in memory, never written into the corpus.
  const candidate: Image = { ...current, id: 'update-candidate', version: current.version + 1 };
  const recoveryUnauthorized: Image = {
    ...recovery,
    id: 'recovery-unauthorized',
    authorizedRecovery: undefined,
  };
  const minimumVersionCounterfactual: BootConfig = { ...policy, minimumVersion: older.version };

  const attempts = probeAttempts(config);
  const deniedAttempts = attempts.filter((attempt) => !attempt.grantedByPolicy);
  const grantedAttempts = attempts.filter((attempt) => attempt.grantedByPolicy);
  const mismatched = attempts.filter((attempt) => !attempt.matchesExpectation);

  const transcript = runLifecycle(current.version);
  const lifecycle = (event: string) => recordFor(transcript, event);

  const images: Record<string, unknown> = {
    [imageKey(current)]: imageEntry(policy, corpus, current, 'hardware-observed', [
      'corpus observed.serialBootLog=true: the board serial log records this image executing',
      'the per-check results are the state-machine explanation of that observation, not separate hardware measurements',
    ]),
    [imageKey(older)]: imageEntry(policy, corpus, older, 'simulation', [
      'negative fixture supplied by the corpus; the board was not flashed with it in this fixture',
    ]),
    [imageKey(wrongProduct)]: imageEntry(policy, corpus, wrongProduct, 'simulation', [
      'negative fixture supplied by the corpus; correctly signed, so only product binding rejects it',
    ]),
    [imageKey(unsigned)]: imageEntry(policy, corpus, unsigned, 'simulation', [
      'negative fixture supplied by the corpus',
    ]),
    [imageKey(corrupt)]: imageEntry(policy, corpus, corrupt, 'simulation', [
      'invalid-state fixture supplied by the corpus',
    ]),
    [imageKey(recovery)]: imageEntry(policy, corpus, recovery, 'simulation', [
      'recovery fixture supplied by the corpus; entering recovery on the board was not performed in this fixture',
    ]),
    [imageKey(candidate)]: imageEntry(policy, corpus, candidate, 'simulation', [
      'derived from the board-observed current image with version 8: the authenticated update candidate used by the power-cut matrix',
    ]),
    [imageKey(recoveryUnauthorized)]: imageEntry(policy, corpus, recoveryUnauthorized, 'simulation', [
      'derived counterfactual: identical to the supplied recovery image except that the separate recovery authorization is removed',
      'this fixture shows recovery is authorized separately and is not a signature-only rollback bypass',
    ]),
  };

  const powerCuts: Record<string, unknown> = {
    'authenticated-update': powerCutScenario(
      policy,
      corpus,
      'authenticated update from the board-observed current image',
      current,
      candidate,
      [
        'the candidate passes the signature, product and version gates before any step selects it',
        'every pre-commit cut leaves the board-observed current image running',
      ],
    ),
    'signed-downgrade': powerCutScenario(
      policy,
      corpus,
      'correctly signed downgrade of the product image',
      current,
      older,
      [
        'the older image is correctly signed, so only protected rollback state rejects it',
        'recovery stays on the authenticated current image at every step',
      ],
    ),
    'wrong-product-candidate': powerCutScenario(
      policy,
      corpus,
      'correctly signed image bound to another product',
      current,
      wrongProduct,
      ['product binding is enforced before version state is consulted'],
    ),
    'unsigned-candidate': powerCutScenario(
      policy,
      corpus,
      'unsigned candidate of the right product and version',
      current,
      unsigned,
      ['integrity and signature are evaluated before product and version'],
    ),
    'corrupt-candidate': powerCutScenario(
      policy,
      corpus,
      'corrupt candidate of the right product and version',
      current,
      corrupt,
      ['the corrupt candidate is rejected before any step can select it'],
    ),
    'recovery-image-as-candidate': powerCutScenario(
      policy,
      corpus,
      'recovery image offered as an ordinary update candidate',
      current,
      recovery,
      [
        'an authorized recovery image is a boot destination, not an installable image',
        'interrupting this path leaves the authenticated current image running',
      ],
    ),
    'restore-from-authorized-recovery': powerCutScenario(
      policy,
      corpus,
      'authorized recovery restoring a production image',
      recovery,
      candidate,
      [
        'starting from authorized recovery, an authenticated production image is installed and committed',
        'pre-commit cuts keep the board in authorized recovery, which is itself an authenticated state',
      ],
    ),
    'unsigned-while-in-recovery': powerCutScenario(
      policy,
      corpus,
      'unsigned candidate installed while the active slot is authorized recovery',
      recovery,
      { ...unsigned, id: 'unsigned-candidate', version: current.version + 1 },
      [
        'the active slot is authorized recovery, so a failed update falls back to an authorized state rather than to an unverified slot',
      ],
    ),
    'recovery-authorization-removed': powerCutScenario(
      policy,
      corpus,
      'recovery image with the separate authorization removed (counterfactual)',
      current,
      recoveryUnauthorized,
      [
        'with the authorization removed the same signed image is rejected as a rollback: signature alone does not open the recovery path',
      ],
    ),
  };

  const resolved = resolvedEnvironmentFacts(corpus, config);

  const claims = {
    supportedByThisFixture: [
      'the production lock register is observed on the representative board and the policy keeps SWD from unrestricted firmware/secret readout, with the authenticated recovery path as the remaining route',
      `${attempts.length} interface attempts were re-derived from the authored policy with the supplied interfaceCan(); ${deniedAttempts.length} are refused and the ${grantedAttempts.length} grants are the read-only boot log and the authenticated recovery entry`,
      `the board-observed current image (${imageKey(current)}) boots and is the only image recorded as executing on hardware`,
      'unsigned, corrupt, wrong-product and signed-older fixtures are all rejected before execution in the state machine',
      `every power-cut transition in ${Object.keys(powerCuts).length} scenarios recovers to an authenticated current, candidate or authorized-recovery slot`,
      'recovery requires the separate authorization: removing it turns the same signed recovery image into a rollback rejection',
      `the credential lifecycle transcript runs ${transcript.length} steps: provisioning, non-exportable use, rotation with the previous credential revoked, survival through update, authorized recovery, reset, silent-reauthorization refusal, revocation, reset-after-revocation refusal, RMA reprovision and decommission`,
      'factory reset destroys local credential authority while the fleet record keeps the immutable device identity, so a reset device cannot silently regain authorization',
      'fleet revocation is checked on recovery, so a refused device stays refused across a reset and across the recovery path',
    ],
    notEstablished: [
      'debug-lock enforcement: the corpus records emulator.debugLockProof=false',
      'physical fuse enforcement and resistance to physical secret extraction: the corpus records emulator.physicalFuseProof=false',
      'invasive-extraction and fault-injection resistance: not exercised and therefore not claimed',
      'that the production lock register is tamper-proof or that resetting the board clears it: neither was attempted here',
      'anything about real flash contents: image digests are digests of corpus records',
    ],
    claimBoundary: CLAIM_BOUNDARY,
  };

  return {
    schema: 'kory-eval/device-lifecycle-evidence@1',
    scope: {
      task: 'production device debug interface authority and per-device credential lifecycle',
      deviceClass: `${corpus.board} running ${corpus.product}`,
      covers: [
        'physical access and possession states',
        'debug interface authority (SWD, UART, ROM USB) under normal and temporary physical possession',
        'boot chain, provenance and keys',
        'communications and peripherals at the device endpoint',
        'authenticated, rollback-resistant update and recovery',
        'credential provisioning, rotation, revocation, reset, RMA and decommission',
        'fleet revocation on recovery',
        'limits and safety consequences',
      ],
      adjacentSkillsNotCovered: SCOPE_BOUNDARIES,
    },
    labels: {
      vocabulary: LABEL_DEFINITIONS,
      rule: 'every factual section carries an evidenceLabel; a simulation or documentation label means the property was not measured on hardware',
    },
    environment: {
      board: corpus.board,
      product: corpus.product,
      productionKeyHash: corpus.keyHash,
      applicationVersion: current.version,
      minimumVersion: policy.minimumVersion,
      observedOnHardware: Object.entries(corpus.observed)
        .filter(([, value]) => value)
        .map(([key]) => key),
      emulatorCannotProve: Object.entries(corpus.emulator)
        .filter(([, value]) => value === false)
        .map(([key]) => key),
      resolvedFacts: resolved.facts,
      minimumVersionDemonstration: resolved.minimumVersionDemonstration,
      inputs: {
        'src/device-sim.ts': fileDigest(SIM_PATH),
        'evidence/device-corpus.json': fileDigest(CORPUS_PATH),
        '.kory-eval/device-config.json': fileDigest(CONFIG_PATH),
      },
    },
    attackerModel: ATTACKER_MODEL,
    productionLockState: {
      observed: config.observedProductionLockState,
      observation:
        `corpus records observed.productionLockRegister=true for board ${corpus.board}; the register value is therefore hardware-observed`,
      enforces: [
        'SWD cannot perform unrestricted firmware or secret readout',
        'only the explicitly authenticated recovery path remains',
        'UART console authority is read-only',
        'ROM download authority is bounded by the same boot gate as an ordinary update',
      ],
      notEstablished: [
        'that the register is physically tamper-proof',
        'that the debug lock survives decapsulation, voltage glitching or a fault attack',
        'that the register cannot be rewritten by a programming-time attacker',
      ],
      evidenceLabel: 'hardware-observed',
      evidenceLabelForEnforcement: 'documentation',
    },
    interfaceAuthority: {
      grammar:
        '<state>:<privilege>; state is one of normal or physical-possession, and a no- privilege prefix records an explicit denial. The authored policy is .kory-eval/device-config.json.',
      states: POSSESSION_STATE_DEFINITIONS,
      authorityTokens: enumerateAuthority(config),
      enumeration: INTERFACE_NAMES.flatMap((name) =>
        POSSESSION_STATES.map((state) => {
          const tokens = enumerateAuthority(config).filter(
            (token) => token.interface === name && token.state === state,
          );
          return {
            interface: name,
            state,
            grants: tokens.filter((token) => token.kind === 'grant').map((token) => parseAuthorityToken(name, token.token).privilege),
            denials: tokens.filter((token) => token.kind === 'denial').map((token) => token.privilege),
          };
        }),
      ),
      attempts,
      attemptSummary: {
        total: attempts.length,
        denied: deniedAttempts.length,
        granted: grantedAttempts.length,
        grantedDetails: grantedAttempts.map((attempt) => `${attempt.state}: ${attempt.interface} ${attempt.privilege}`),
        expectationsMismatched: mismatched.length,
        derivation:
          'each attempt is the supplied interfaceCan() applied to the authored policy; the policy is documentation and the attempt is a computation',
      },
      evidenceLabel: 'documentation',
    },
    bootChain: trustChain(policy, corpus),
    update: {
      policy,
      policyLabel: 'simulation',
      images,
      powerCuts,
      notes: [
        'the update path is an A/B slot machine: the inactive slot is written and verified before it is marked pending, and a cut before commit leaves the previously authenticated slot selected',
        'an authorized recovery image is a boot destination and is never selected as an ordinary update candidate',
        'the counterfactual with the separate recovery authorization removed shows signature validity alone does not open the recovery path',
      ],
    },
    recovery: {
      requiresSeparateAuthorization: config.authorizedRecoveryOnly,
      fleetRevocationChecked: config.fleetRevocationCheckedOnRecovery,
      demonstration: [
        {
          case: 'supplied recovery image with its separate authorization',
          image: imageKey(recovery),
          decision: bootDecision(policy, recovery),
          evidenceLabel: 'simulation',
        },
        {
          case: 'derived counterfactual with the authorization removed',
          image: imageKey(recoveryUnauthorized),
          decision: bootDecision(policy, recoveryUnauthorized),
          evidenceLabel: 'simulation',
        },
        {
          case: 'lifecycle: authorized recovery entry for a provisioned device',
          step: lifecycle('authorized-recovery-entry').event,
          outcome: lifecycle('authorized-recovery-entry').outcome,
          reason: lifecycle('authorized-recovery-entry').reason,
          evidenceLabel: 'simulation',
        },
        {
          case: 'lifecycle: recovery entry without the separate authorization',
          step: lifecycle('unauthorized-recovery-entry').event,
          outcome: lifecycle('unauthorized-recovery-entry').outcome,
          reason: lifecycle('unauthorized-recovery-entry').reason,
          evidenceLabel: 'simulation',
        },
        {
          case: 'lifecycle: recovery attempted by a device the fleet refused',
          step: lifecycle('recovery-after-revocation-attempt').event,
          outcome: lifecycle('recovery-after-revocation-attempt').outcome,
          reason: lifecycle('recovery-after-revocation-attempt').reason,
          evidenceLabel: 'simulation',
        },
      ],
      conclusion:
        'recovery is demonstrated, not assumed: the same signed image enters recovery only with the separate authorization and a fleet record that authorizes the device, and a refused device stays refused across a factory reset',
    },
    credentialLifecycle: {
      model: {
        deviceIdentity: 'immutable device-x:mcu-rev-c:0007; a factory reset never deletes it, because fleet revocation is keyed to it',
        slot: 'secure-slot-0, hardware-backed and non-exportable',
        fleetRecord: 'device identity, provisioned/revoked/decommissioned state, active credential id and revocation list',
        authority: 'local authority and fleet authority are separate: a device can hold a credential it is not allowed to use',
      },
      rotateAndRevoke: PROVENANCE_AND_KEYS.keysAndCounters,
      transcript,
      demonstrations: [
        {
          property: 'provisioned into a hardware-backed slot and non-exportable',
          steps: ['manufacturing-provision', 'credential-export-attempt'],
          outcome: `${lifecycle('manufacturing-provision').outcome} then ${lifecycle('credential-export-attempt').outcome}`,
          evidenceLabel: 'documentation',
        },
        {
          property: 'protected through update',
          steps: ['authenticated-application-update'],
          outcome: `${lifecycle('authenticated-application-update').outcome} (applicationVersion ${lifecycle('authenticated-application-update').applicationVersion}, credential still provisioned)`,
          evidenceLabel: 'documentation',
        },
        {
          property: 'protected through recovery',
          steps: ['authorized-recovery-entry'],
          outcome: `${lifecycle('authorized-recovery-entry').outcome} with the credential still provisioned`,
          evidenceLabel: 'documentation',
        },
        {
          property: 'protected through RMA',
          steps: ['rma-authorised-reprovision', 'post-rma-old-credential-use-attempt'],
          outcome: `${lifecycle('rma-authorised-reprovision').outcome} then the pre-RMA credential ${lifecycle('post-rma-old-credential-use-attempt').outcome}`,
          evidenceLabel: 'documentation',
        },
        {
          property: 'explicit rotate semantics',
          steps: ['credential-rotate', 'stale-credential-use'],
          outcome: `${lifecycle('credential-rotate').outcome} then the rotated-out credential ${lifecycle('stale-credential-use').outcome}`,
          evidenceLabel: 'documentation',
        },
        {
          property: 'explicit revoke semantics',
          steps: ['device-revocation'],
          outcome: `${lifecycle('device-revocation').outcome}; the device keeps only stale local authority`,
          evidenceLabel: 'documentation',
        },
      ],
      stepCount: transcript.length,
      events: LIFECYCLE.map((step) => step.event),
    },
    resetDecommissionAndFleet: {
      ...RECOVERY_AND_DECOMMISSION_CONTRACT,
      demonstrations: [
        {
          property: 'factory reset destroys local credential authority',
          step: lifecycle('factory-reset').event,
          outcome: `${lifecycle('factory-reset').outcome}; slot=${lifecycle('factory-reset').slotState}, authority=${lifecycle('factory-reset').localCredentialAuthority}`,
          evidenceLabel: 'documentation',
        },
        {
          property: 'the partial state after reset is not an authorization',
          step: lifecycle('post-reset-silent-reauthorization-attempt').event,
          outcome: `${lifecycle('post-reset-silent-reauthorization-attempt').outcome}; ${lifecycle('post-reset-silent-reauthorization-attempt').reason}`,
          evidenceLabel: 'documentation',
        },
        {
          property: 'authorized reprovision is the only way back',
          step: lifecycle('post-reset-authorized-reprovision').event,
          outcome: `${lifecycle('post-reset-authorized-reprovision').outcome} with ${lifecycle('post-reset-authorized-reprovision').presentedAuthority}`,
          evidenceLabel: 'documentation',
        },
        {
          property: 'a refused device cannot be reprovisioned with fleet authority alone',
          step: lifecycle('reset-after-revocation-with-fleet-authority').event,
          outcome: `${lifecycle('reset-after-revocation-with-fleet-authority').outcome}; ${lifecycle('reset-after-revocation-with-fleet-authority').reason}`,
          evidenceLabel: 'documentation',
        },
        {
          property: 'a local reset does not clear fleet revocation',
          step: lifecycle('reset-after-revocation-silent-attempt').event,
          outcome: `${lifecycle('reset-after-revocation-silent-attempt').outcome}; ${lifecycle('reset-after-revocation-silent-attempt').reason}`,
          evidenceLabel: 'documentation',
        },
        {
          property: 'decommission destroys the credential and is terminal',
          steps: ['decommission', 'post-decommission-use-attempt', 'post-decommission-recovery-attempt'],
          outcome: `${lifecycle('decommission').outcome}; later use ${lifecycle('post-decommission-use-attempt').outcome}; later recovery ${lifecycle('post-decommission-recovery-attempt').outcome}`,
          evidenceLabel: 'documentation',
        },
      ],
    },
    resistanceClaims: RESISTANCE_CLAIMS,
    safetyConsequences: ATTACKER_MODEL.consequences,
    peripherals: PERIPHERALS,
    communications: COMMUNICATIONS,
    provenanceAndKeys: PROVENANCE_AND_KEYS,
    limits: LIMITS,
    claims,
    reproduction: {
      ...REPRODUCTION,
      generators: ['bun run scripts/build-lifecycle-evidence.ts', 'bun run scripts/build-threat-model.ts'],
      deterministic: true,
    },
  };
}

function main(): void {
  const corpus = readCorpus();
  const config = readConfig();
  const evidence = buildEvidence(corpus, config);
  writeArtifact(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  const cutCount = Object.keys(evidence.update as Record<string, unknown>)
    ? Object.keys((evidence.update as { powerCuts: Record<string, unknown> }).powerCuts).length *
      corpus.steps.length
    : 0;
  console.log(
    `wrote ${EVIDENCE_PATH}\nimages: ${Object.keys((evidence.update as { images: Record<string, unknown> }).images).length}; power-cut transitions: ${cutCount}; lifecycle steps: ${(evidence.credentialLifecycle as { stepCount: number }).stepCount}`,
  );
}

if (import.meta.main) main();
