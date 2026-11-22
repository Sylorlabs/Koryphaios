/**
 * Boot chain, provenance and update evidence derived from the supplied
 * simulator (`src/device-sim.ts`) and the fixed corpus
 * (`evidence/device-corpus.json`).
 *
 * Nothing here re-states a boot decision: every decision, serial line and
 * power-cut transition is recomputed from the simulator. The corpus is only
 * read; derived fixtures are constructed in memory and always labelled.
 */
import { bootDecision, powerCutRecovery, type BootConfig, type Image, type UpdateStep } from '../src/device-sim';
import {
  type AuthoredDeviceConfig,
  type Corpus,
  corpusImage,
  deriveBootPolicy,
  imageDigest,
  imageKey,
} from './kory-artifact';

export interface CheckOutcome {
  check: string;
  result: 'pass' | 'fail' | 'below-minimum-authorized' | 'present' | 'absent';
  note: string;
}

/** The boot chain in evaluation order, mirroring `bootDecision`. */
export function checkOutcomes(policy: BootConfig, image: Image): CheckOutcome[] {
  return [
    {
      check: 'integrity',
      result: image.corrupt ? 'fail' : 'pass',
      note: image.corrupt ? 'slot content is corrupt' : 'slot content intact',
    },
    {
      check: 'signature',
      result: !image.signed || !image.signatureValid ? 'fail' : 'pass',
      note: `bootloaderVerifiesSignature=${String(policy.bootloaderVerifiesSignature)} (signed=${String(image.signed)}, signatureValid=${String(image.signatureValid)})`,
    },
    {
      check: 'product-binding',
      result: image.product !== policy.product ? 'fail' : 'pass',
      note: `bootloaderVerifiesProduct=${String(policy.bootloaderVerifiesProduct)} (image product=${image.product}, policy product=${policy.product})`,
    },
    {
      check: 'rollback-version',
      result:
        image.version < policy.minimumVersion
          ? image.authorizedRecovery
            ? 'below-minimum-authorized'
            : 'fail'
          : 'pass',
      note: `minimumVersion=${policy.minimumVersion}, image version=${image.version}, rollbackStateProtected=${String(policy.rollbackStateProtected)}`,
    },
    {
      check: 'recovery-authorization',
      result: image.authorizedRecovery ? 'present' : 'absent',
      note: image.authorizedRecovery
        ? 'separate recovery authorization carried by the image and required by policy'
        : 'image carries no separate recovery authorization',
    },
  ];
}

/** One line per evaluated check, in evaluation order, mirroring the short-circuit. */
export function serialDecision(policy: BootConfig, corpus: Corpus, image: Image): string[] {
  const decision = bootDecision(policy, image);
  const stop = image.corrupt
    ? 1
    : !image.signed || !image.signatureValid
      ? 2
      : image.product !== policy.product
        ? 3
        : 5;
  const lines = [
    `[bootrom] key-hash fuse record bound to ${policy.productionKeyHash} (corpus keyHash=${corpus.keyHash})`,
    `[bootloader] image ${imageKey(image)} product=${image.product}`,
  ];
  for (const [index, check] of checkOutcomes(policy, image).entries()) {
    if (index >= stop) break;
    lines.push(`[check] ${check.check}: ${check.result} (${check.note})`);
  }
  lines.push(
    decision === 'boot' || decision === 'recovery'
      ? `[boot] decision=${decision}; executing ${imageKey(image)}`
      : `[boot] decision=${decision}; no slot executed`,
  );
  return lines;
}

const authenticityOf = (policy: BootConfig, image: Image): string => {
  const decision = bootDecision(policy, image);
  if (decision === 'boot') return 'authenticated-application';
  if (decision === 'recovery') return 'authorized-recovery';
  return `not-authenticated(${decision})`;
};

export interface ImageEntry {
  key: string;
  id: string;
  version: number;
  product: string;
  digest: string;
  source: 'corpus' | 'derived';
  decision: string;
  executed: boolean;
  executedBeforeReject: boolean;
  checks: CheckOutcome[];
  serialDecision: string[];
  evidenceLabel: string;
  notes: string[];
}

export function imageEntry(
  policy: BootConfig,
  corpus: Corpus,
  image: Image,
  evidenceLabel: string,
  notes: string[],
): ImageEntry {
  const decision = bootDecision(policy, image);
  const fromCorpus = corpus.images.some(
    (entry) => entry.id === image.id && entry.version === image.version,
  );
  return {
    key: imageKey(image),
    id: image.id,
    version: image.version,
    product: image.product,
    digest: imageDigest(image),
    source: fromCorpus ? 'corpus' : 'derived',
    decision,
    executed: decision === 'boot' || decision === 'recovery',
    executedBeforeReject: false,
    checks: checkOutcomes(policy, image),
    serialDecision: serialDecision(policy, corpus, image),
    evidenceLabel,
    notes,
  };
}

export interface PowerCutStepRecord {
  step: UpdateStep;
  activeSlot: string;
  candidateSlot: string;
  candidateDecision: string;
  bootedImage: string;
  bootedImageKey: string;
  bootedSlotAuthenticity: string;
  unverifiedSlotExecuted: boolean;
  serialDecision: string[];
  evidenceLabel: 'simulation';
  note: string;
}

export interface PowerCutScenario {
  title: string;
  activeSlot: string;
  activeSlotAuthenticity: string;
  candidateSlot: string;
  candidateDigest: string;
  candidateDecision: string;
  candidateSource: 'corpus' | 'derived';
  steps: PowerCutStepRecord[];
  recoveredImages: string[];
  recoversToAuthenticatedSlotOnly: boolean;
  unverifiedSlotExecutedAtAnyStep: boolean;
  evidenceLabel: 'simulation';
  notes: string[];
}

export function powerCutStep(
  policy: BootConfig,
  active: Image,
  candidate: Image,
  step: UpdateStep,
): PowerCutStepRecord {
  const candidateDecision = bootDecision(policy, candidate);
  const bootedId = powerCutRecovery(policy, active, candidate, step);
  const booted = bootedId === candidate.id ? candidate : active;
  const authenticity = authenticityOf(policy, booted);
  return {
    step,
    activeSlot: imageKey(active),
    candidateSlot: imageKey(candidate),
    candidateDecision,
    bootedImage: booted.id,
    bootedImageKey: imageKey(booted),
    bootedSlotAuthenticity: authenticity,
    unverifiedSlotExecuted: authenticity.startsWith('not-authenticated'),
    serialDecision: [
      `[boot] power-cut at ${step}: candidate ${imageKey(candidate)} decision=${candidateDecision}`,
      `[boot] selecting ${imageKey(booted)} (${authenticity}); unverified slot executed=${String(authenticity.startsWith('not-authenticated'))}`,
    ],
    evidenceLabel: 'simulation',
    note:
      step === 'write-inactive' || step === 'verify-inactive'
        ? 'pre-commit step: the inactive slot is never selected, so a partial write is never run'
        : candidateDecision === 'boot'
          ? 'post-commit step: the candidate is selected only after it passed the signature, product and version gate'
          : 'candidate failed the gate, so the previously authenticated slot keeps running',
  };
}

export function powerCutScenario(
  policy: BootConfig,
  corpus: Corpus,
  title: string,
  active: Image,
  candidate: Image,
  notes: string[],
): PowerCutScenario {
  const steps = corpus.steps.map((step) => powerCutStep(policy, active, candidate, step));
  const booted = steps.map((entry) => entry.bootedImageKey);
  const unverified = steps.some((entry) => entry.unverifiedSlotExecuted);
  const fromCorpus = corpus.images.some(
    (entry) => entry.id === candidate.id && entry.version === candidate.version,
  );
  return {
    title,
    activeSlot: imageKey(active),
    activeSlotAuthenticity: authenticityOf(policy, active),
    candidateSlot: imageKey(candidate),
    candidateDigest: imageDigest(candidate),
    candidateDecision: bootDecision(policy, candidate),
    candidateSource: fromCorpus ? 'corpus' : 'derived',
    steps,
    recoveredImages: [...new Set(booted)],
    recoversToAuthenticatedSlotOnly: !unverified,
    unverifiedSlotExecutedAtAnyStep: unverified,
    evidenceLabel: 'simulation',
    notes,
  };
}

/**
 * Environment facts that change the boot/update answer, with the alternative
 * that was rejected and the consequence of the choice. The minimum-version
 * ambiguity is the one that actually changes decisions, so it is demonstrated
 * with a counterfactual policy rather than asserted.
 */
export function resolvedEnvironmentFacts(
  corpus: Corpus,
  config: AuthoredDeviceConfig,
): {
  facts: Array<{ fact: string; value: string; alternatives: string[]; decision: string; consequence: string; evidenceLabel: string }>;
  minimumVersionDemonstration: {
    resolvedPolicyDecision: string;
    counterfactualPolicyDecision: string;
    conclusion: string;
  };
} {
  const policy = deriveBootPolicy(corpus, config);
  const older = corpusImage(corpus, 'older');
  const current = corpusImage(corpus, 'current');
  const counterfactual: BootConfig = { ...policy, minimumVersion: older.version };
  return {
    facts: [
      {
        fact: 'board and product binding',
        value: `board=${corpus.board}, product=${corpus.product}`,
        alternatives: [`product=${corpus.product}`, 'a product bound to another device class'],
        decision: `product is ${corpus.product}: the wrong-product corpus image is rejected on product binding, not on signature`,
        consequence:
          'a signed image for another product would be accepted if product binding were disabled, because its signature is valid',
        evidenceLabel: 'hardware-observed',
      },
      {
        fact: 'production key-hash record',
        value: corpus.keyHash,
        alternatives: ['a development or test key-hash record'],
        decision: `the trust anchor is the recorded production key-hash record ${corpus.keyHash}`,
        consequence:
          'a development anchor would accept images signed with a key the fleet never issued for this product',
        evidenceLabel: 'hardware-observed',
      },
      {
        fact: 'minimum version',
        value: String(policy.minimumVersion),
        alternatives: [
          String(older.version),
          String(corpusImage(corpus, 'recovery').version),
        ],
        decision: `minimumVersion=${policy.minimumVersion}, the version of the board-observed deployed image (${imageKey(current)})`,
        consequence: `the correctly signed older image (${imageKey(older)}) is rejected as a rollback; with minimumVersion=${older.version} it would boot, which is the downgrade the policy exists to stop`,
        evidenceLabel: 'simulation',
      },
      {
        fact: 'debug lock and physical fuse proof',
        value: 'corpus records emulator.debugLockProof=false and emulator.physicalFuseProof=false',
        alternatives: ['claiming the lock register proves physical enforcement'],
        decision:
          'the production lock register value is recorded as board-observed, while debug-lock and physical-fuse enforcement are recorded as unavailable in this fixture',
        consequence:
          'invasive-extraction and fault-injection resistance are left false rather than inferred from the register readout',
        evidenceLabel: 'hardware-observed',
      },
      {
        fact: 'serial boot log',
        value: 'corpus records observed.serialBootLog=true',
        alternatives: ['treating every image decision as board-observed'],
        decision: `only ${imageKey(current)} is board-observed as executing; every other image decision is simulation`,
        consequence:
          'the negative and recovery paths are state-machine outcomes, not measurements taken on hardware',
        evidenceLabel: 'hardware-observed',
      },
    ],
    minimumVersionDemonstration: {
      resolvedPolicyDecision: bootDecision(policy, older),
      counterfactualPolicyDecision: bootDecision(counterfactual, older),
      conclusion:
        'the minimum-version resolution is what turns the signed older image from an accepted downgrade into a rollback rejection; the counterfactual policy shows the same image booting',
    },
  };
}

/** Boot-chain stages, each with what it enforces and what happens on failure. */
export function trustChain(policy: BootConfig, corpus: Corpus): Array<Record<string, unknown>> {
  const current = corpusImage(corpus, 'current');
  return [
    {
      stage: 'immutable-boot-rom',
      mutability: 'immutable',
      trustAnchor: `production key-hash fuse record ${policy.productionKeyHash} (corpus keyHash=${corpus.keyHash})`,
      anchorEvidenceLabel: 'hardware-observed',
      authenticates: 'mutable first-stage bootloader',
      failureBehavior: 'reject before executing any mutable stage',
      notes: [
        'the corpus records the key-hash fuse record as read on the board; the simulator models the bootloader image decision, not the ROM-to-bootloader handoff',
      ],
    },
    {
      stage: 'first-stage-bootloader',
      mutability: 'mutable, authenticated by the immutable Boot ROM',
      enforces: [
        `bootloaderVerifiesSignature=${String(policy.bootloaderVerifiesSignature)}`,
        `bootloaderVerifiesProduct=${String(policy.bootloaderVerifiesProduct)}`,
      ],
      failureBehavior: 'reject-signature / reject-product / reject-corrupt before execution',
      notes: ['integrity is evaluated before signature, and signature before product, in the state machine'],
    },
    {
      stage: 'protected-rollback-state',
      mutability: 'protected from ordinary firmware writes',
      enforces: [`minimumVersion=${policy.minimumVersion}`, `rollbackStateProtected=${String(policy.rollbackStateProtected)}`],
      failureBehavior: 'reject-rollback for any version below the minimum that is not separately authorized',
    },
    {
      stage: 'authorized-recovery',
      mutability: 'separately authorized destination, never an ordinary installable image',
      enforces: [`recoveryRequiresAuthorization=${String(policy.recoveryRequiresAuthorization)}`],
      failureBehavior: 'an image below the minimum without the separate authorization is rejected as a rollback',
    },
    {
      stage: 'application',
      mutability: 'mutable',
      currentImage: imageKey(current),
      note: 'the board-observed current image is the only image this fixture records as executing on hardware',
    },
  ];
}
