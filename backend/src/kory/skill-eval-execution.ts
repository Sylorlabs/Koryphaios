import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalizePath, isContainedBy } from '../runtime/platform';
import {
  createPairedSkillExperimentsV3,
  validatePairedSkillExperimentsV3,
  type SkillEvalBudget,
  type SkillEvalExperimentV3,
  type SkillEvalScenarioV3,
  type SkillEvalSubject,
} from './skill-eval-harness';
import {
  listOpenSkillRegressionSources,
  recordSkillEvaluationRun,
  type SkillInfrastructureFailure,
  type SkillRuntimeArtifact,
} from './skill-evaluations';
import type { V5CompiledSkillPackage } from './skill-packages';
import type { ProviderConfig } from '@koryphaios/shared';

export interface SkillEvalFixtureMaterializer {
  id: string;
  /** A runnable component exercise is not necessarily a complete full-task environment. */
  readinessBlockers?: readonly string[];
  /**
   * The fixture drives a real external runtime (bounded child processes, real browser sessions)
   * rather than an in-process simulation. Such fixtures own dedicated red/green end-to-end tests,
   * and the generic "every ready fixture starts red" sweep skips them so that a single-process
   * sweep does not accumulate process/browser spawn churn.
   */
  realRuntime?: boolean;
  matches: (scenario: SkillEvalScenarioV3) => boolean;
  materialize: (destination: string, scenario: SkillEvalScenarioV3) => void | Promise<void>;
  /** Trusted fixture-owned execution on the original source, before either arm is cloned/dispatched. */
  captureBeforeCandidateDispatch?: (destination: string, scenario: SkillEvalScenarioV3) =>
    { relativePath: string; text: string } | Promise<{ relativePath: string; text: string }>;
  /**
   * Ordered images the fixture hands to the candidate as model input, for scenarios whose
   * evidence is visual (a real desktop session, a rendered page). Paths are resolved against
   * the materialized fixture so both arms receive byte-identical images. An executor that
   * cannot transport images must refuse the scenario rather than silently drop them.
   */
  imageAttachments?: (
    destination: string,
    scenario: SkillEvalScenarioV3,
  ) => readonly SkillEvalImageAttachment[];
}

/** One image handed to the candidate, recorded so a run can prove what it was shown. */
export interface SkillEvalImageAttachment {
  /** Path inside the materialized fixture directory. */
  readonly relativePath: string;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** What the image depicts, in the fixture's own words. */
  readonly label: string;
}

/** Sealed separately from the editable candidate-visible receipt. */
export interface SkillEvalPreDispatchCapture {
  readonly relativePath: string;
  readonly sha256: string;
  readonly text: string;
}

export interface SkillEvalExecutionObservation {
  output: string;
  evidence: string[];
  artifacts: SkillRuntimeArtifact[];
  durationMs: number;
  infrastructureFailure?: SkillInfrastructureFailure;
  /** The model failed its execution contract, without a proven host failure. */
  taskFailure?: string;
  /** Validated raw transport bytes, non-enumerable to keep opaque data out of logs. */
  nativeTextEventStream?: Buffer;
}

export const SKILL_EVAL_PUBLIC_FIXTURE_PATHS = ['README.md', 'contract.json'] as const;
export type SkillEvalPublicFixturePath = (typeof SKILL_EVAL_PUBLIC_FIXTURE_PATHS)[number];

export interface SkillEvalPublicContractFileSnapshot {
  available: boolean;
  sha256: string | null;
  byteLength: number;
  text: string | null;
  reason?: string;
}

export type SkillEvalPublicContractTextSnapshot = SkillEvalPublicContractFileSnapshot;

/** Candidate-visible input captured from the materialized workspace before either arm runs. */
export interface SkillEvalPublicContractSnapshot {
  schemaVersion: 1;
  capturedBeforeExecution: true;
  taskPrompt: SkillEvalPublicContractTextSnapshot;
  fixtureFiles: Record<SkillEvalPublicFixturePath, SkillEvalPublicContractFileSnapshot>;
}

function freezePublicContractSnapshot(
  snapshot: SkillEvalPublicContractSnapshot,
): SkillEvalPublicContractSnapshot {
  for (const file of Object.values(snapshot.fixtureFiles)) Object.freeze(file);
  Object.freeze(snapshot.taskPrompt);
  Object.freeze(snapshot.fixtureFiles);
  return Object.freeze(snapshot);
}

// Use the changed-workspace snapshot ceiling of 64 MiB for capture. Blind
// import's public-contract/request/envelope gates remain narrower: availability
// is not import eligibility. Oversized or unstable input is unavailable, never truncated.
const MAX_PUBLIC_CONTRACT_FILE_BYTES = 67_108_864;

function snapshotTextFile(path: string): SkillEvalPublicContractFileSnapshot {
  const unavailable: SkillEvalPublicContractFileSnapshot = {
    available: false, sha256: null, byteLength: 0, text: null, reason: 'not-present',
  };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 ||
      stat.size > MAX_PUBLIC_CONTRACT_FILE_BYTES) return unavailable;
    const parentPath = dirname(path);
    const parent = lstatSync(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink()) return unavailable;
    // Preserve legitimate platform aliases such as macOS /var via the one
    // canonicalisation helper, while pinning the actual materialized parent.
    const canonicalParent = canonicalizePath(parentPath);
    const fd = openSync(join(canonicalParent, basename(path)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino ||
        before.size !== stat.size || before.mtimeMs !== stat.mtimeMs || before.ctimeMs !== stat.ctimeMs) return unavailable;
      // Never pathname-read or consume to EOF without a fixed bound: the file
      // can grow after fstat. The extra byte detects growth without admitting it.
      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      const after = fstatSync(fd);
      const current = lstatSync(path);
      const parentAfter = lstatSync(parentPath);
      if (offset !== before.size || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        !current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino ||
        current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs ||
        !parentAfter.isDirectory() || parentAfter.isSymbolicLink() || parentAfter.dev !== parent.dev || parentAfter.ino !== parent.ino ||
        canonicalizePath(parentPath) !== canonicalParent) return unavailable;
      const bytes = buffer.subarray(0, offset);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes)) return unavailable;
      return {
        available: true,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
        text,
      };
    } finally { closeSync(fd); }
  } catch {
    return unavailable;
  }
}

/** Capture only candidate-visible public input before either paired arm executes. */
export function captureSkillEvalPublicContractSnapshot(
  root: string,
  taskPrompt: string,
): SkillEvalPublicContractSnapshot {
  const promptBytes = Buffer.from(taskPrompt, 'utf8');
  return freezePublicContractSnapshot({
    schemaVersion: 1,
    capturedBeforeExecution: true,
    taskPrompt: {
      available: true,
      sha256: createHash('sha256').update(promptBytes).digest('hex'),
      byteLength: promptBytes.byteLength,
      text: taskPrompt,
    },
    fixtureFiles: {
      'README.md': snapshotTextFile(join(root, 'README.md')),
      'contract.json': snapshotTextFile(join(root, 'contract.json')),
    },
  });
}

export interface SkillEvalExecutor {
  id: string;
  subject: SkillEvalSubject;
  provider: string;
  providerConfig?: ProviderConfig;
  model: string;
  runtimeIdentity: string;
  tools: string[];
  /** A scenario may grant a narrower or broader tool surface to both arms. */
  toolsForScenario?: (scenario: SkillEvalScenarioV3) => string[];
  budget: SkillEvalBudget;
  execute: (input: {
    experiment: SkillEvalExperimentV3;
    scenario: SkillEvalScenarioV3;
    workingDirectory: string;
    taskPrompt: string;
    /** Portable target skill text. Null means the no-skill baseline. */
    skillContext: string | null;
    /** Fixture-provided images. Empty when the scenario hands the candidate no visual evidence. */
    attachments?: readonly SkillEvalImageAttachment[];
  }) => Promise<SkillEvalExecutionObservation>;
}

export interface SkillEvalDeterministicScore {
  passed: boolean;
  quality: number;
  verification: number;
  integrityFailure: boolean;
  evidence: string[];
}

export interface SkillEvalDeterministicScorer {
  id: string;
  scenarioIds: string[];
  score: (input: {
    scenario: SkillEvalScenarioV3;
    experiment: SkillEvalExperimentV3;
    workingDirectory: string;
    observation: SkillEvalExecutionObservation;
    /** Exists only when the evaluator really captured it before candidate dispatch. */
    preDispatchCapture?: SkillEvalPreDispatchCapture;
  }) => SkillEvalDeterministicScore | Promise<SkillEvalDeterministicScore>;
}

export interface SkillEvalExecutionReadiness {
  skill: string;
  scenarioId: string;
  startingState: string;
  materializerId: string | null;
  deterministicScorerId: string | null;
  ready: boolean;
  reasons: string[];
}

export interface SkillEvalPairRunResult {
  pairId: string;
  scenarioId: string;
  initialFingerprint: string;
  publicContractSnapshot: SkillEvalPublicContractSnapshot;
  preDispatchCapture?: SkillEvalPreDispatchCapture;
  executionOrder: Array<'with-skill' | 'without-skill'>;
  withSkill: {
    experiment: SkillEvalExperimentV3;
    workspace: string;
    observation: SkillEvalExecutionObservation;
    score: SkillEvalDeterministicScore | null;
  };
  withoutSkill: {
    experiment: SkillEvalExperimentV3;
    workspace: string;
    observation: SkillEvalExecutionObservation;
    score: SkillEvalDeterministicScore | null;
  };
  cleanup: () => void;
}

function boundedUnit(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Skill evaluation score must be in [0, 1], received ${value}`);
  }
  return value;
}

function matchingMaterializer(
  scenario: SkillEvalScenarioV3,
  materializers: readonly SkillEvalFixtureMaterializer[],
): SkillEvalFixtureMaterializer | undefined {
  return materializers.find((materializer) => materializer.matches(scenario));
}

function matchingScorer(
  scenario: SkillEvalScenarioV3,
  scorers: readonly SkillEvalDeterministicScorer[],
): SkillEvalDeterministicScorer | undefined {
  return scorers.find((scorer) => scorer.scenarioIds.includes(scenario.id));
}

export function auditSkillEvalExecutionReadiness(
  skillPackages: readonly V5CompiledSkillPackage[],
  materializers: readonly SkillEvalFixtureMaterializer[],
  scorers: readonly SkillEvalDeterministicScorer[],
): SkillEvalExecutionReadiness[] {
  return skillPackages.flatMap((skillPackage) =>
    skillPackage.evaluation.tasks.map((task) => {
      const scenario: SkillEvalScenarioV3 = {
        id: task.id,
        skill: skillPackage.sidecar.name,
        category: 'full-task',
        prompt: task.prompt,
        expectedSelection: true,
        expectedSkills: [],
        forbiddenSkills: [],
        heldOut: true,
        adjacentSkills: [],
        tags: ['held-out', 'full-task'],
        environment: task.environment,
        falsifiableChecks: task.falsifiableChecks,
        scorers: task.scorers,
        requiredEvidence: task.requiredEvidence,
        requiredArtifacts: task.requiredArtifacts,
      };
      const materializer = matchingMaterializer(scenario, materializers);
      const scorer = matchingScorer(scenario, scorers);
      const reasons: string[] = [];
      reasons.push(...(materializer?.readinessBlockers ?? []));
      if (!materializer) reasons.push(`no materializer for ${scenario.environment.startingState}`);
      if (!scorer) reasons.push('no registered deterministic scorer');
      if (!scenario.falsifiableChecks.length) reasons.push('no falsifiable checks');
      if (!scenario.scorers.some((item) => item.kind === 'deterministic')) {
        reasons.push('fixture declares no deterministic scorer');
      }
      return {
        skill: skillPackage.sidecar.name,
        scenarioId: scenario.id,
        startingState: scenario.environment.startingState,
        materializerId: materializer?.id ?? null,
        deterministicScorerId: scorer?.id ?? null,
        ready: reasons.length === 0,
        reasons,
      };
    }),
  );
}

function workspaceEntries(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const stat = lstatSync(current);
  if (stat.isSymbolicLink() || stat.isFile()) return [current];
  if (!stat.isDirectory()) return [];
  return readdirSync(current)
    // Installed dependencies and framework build output are derived state, not candidate
    // source, and snapshotting them made blind review impossible: the artifact reader
    // requires a bounded regular file and a Next fixture produced 368 MB of them.
    .filter((name) =>
      name !== '.git' &&
      name !== 'node_modules' &&
      name !== '.next' &&
      name !== '.turbo' &&
      !(name === 'target' && existsSync(join(current, 'Cargo.toml')))
    )
    .sort()
    .flatMap((name) => workspaceEntries(root, join(current, name)));
}

function workspaceHashes(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const path of workspaceEntries(root)) {
    const relativePath = relative(root, path).replaceAll('\\', '/');
    const stat = lstatSync(path);
    const hash = createHash('sha256');
    if (stat.isSymbolicLink()) {
      hash.update('symlink\0');
      hash.update(readlinkSync(path));
    } else if (stat.isFile()) {
      hash.update('file\0');
      hash.update(readFileSync(path));
    }
    hashes.set(relativePath, hash.digest('hex'));
  }
  return hashes;
}

export const SKILL_EVAL_WORKSPACE_FINGERPRINT_FORMAT = 'path-entry-sha256-json-v1';

export function fingerprintSkillEvalWorkspace(root: string): string {
  // Hash each entry before framing the tree: binary content can contain separators.
  return createHash('sha256')
    .update(SKILL_EVAL_WORKSPACE_FINGERPRINT_FORMAT)
    .update('\0')
    .update(JSON.stringify([...workspaceHashes(root)]))
    .digest('hex');
}

function safeArtifactSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
}

function persistArmEvidence(input: {
  projectRoot: string;
  pairId: string;
  variant: 'with-skill' | 'without-skill';
  scenario: SkillEvalScenarioV3;
  materializerId: string;
  deterministicScorerId: string;
  harnessVersion: string;
  evaluationContractHash?: string;
  evaluationContractVersion?: number;
  baseRoot: string;
  initialFingerprint: string;
  assertBaseUnchanged: () => void;
  workingDirectory: string;
  publicContractSnapshot: SkillEvalPublicContractSnapshot;
  preDispatchCapture?: SkillEvalPreDispatchCapture;
  observation: SkillEvalExecutionObservation;
  score: SkillEvalDeterministicScore | null;
}): SkillRuntimeArtifact[] {
  const artifactRoot = join(
    input.projectRoot,
    '.koryphaios',
    'skills',
    'eval-artifacts',
    safeArtifactSegment(input.pairId),
    input.variant,
  );
  mkdirSync(artifactRoot, { recursive: true });
  const nativeStream = input.observation.nativeTextEventStream;
  const nativeWorkspaceRoot = nativeStream === undefined
    ? undefined
    : canonicalizePath(dirname(input.baseRoot));
  if (nativeWorkspaceRoot !== undefined) {
    if (!Buffer.isBuffer(nativeStream)) throw new Error('Native text event stream must be raw bytes');
    if (isContainedBy(nativeWorkspaceRoot, canonicalizePath(artifactRoot))) {
      throw new Error('Native text event archive must be outside the evaluation workspace');
    }
  }
  const before = workspaceHashes(input.baseRoot);
  const after = workspaceHashes(input.workingDirectory);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = paths.flatMap((path) => {
    const left = before.get(path);
    const right = after.get(path);
    if (left === right) return [];
    const change = left === undefined ? 'added' : right === undefined ? 'deleted' : 'modified';
    if (left !== undefined) {
      const source = join(input.baseRoot, path);
      const destination = join(artifactRoot, 'before-files', path);
      mkdirSync(
        destination.slice(0, Math.max(destination.lastIndexOf('/'), destination.lastIndexOf('\\'))),
        {
          recursive: true,
        },
      );
      cpSync(source, destination, { recursive: true, dereference: false });
    }
    if (right !== undefined) {
      const source = join(input.workingDirectory, path);
      const destination = join(artifactRoot, 'files', path);
      mkdirSync(
        destination.slice(0, Math.max(destination.lastIndexOf('/'), destination.lastIndexOf('\\'))),
        {
          recursive: true,
        },
      );
      cpSync(source, destination, { recursive: true, dereference: false });
    }
    return [{ path, change, beforeSha256: left ?? null, afterSha256: right ?? null }];
  });
  const outputPath = join(artifactRoot, 'final-output.txt');
  writeFileSync(outputPath, input.observation.output);
  const manifestPath = join(artifactRoot, 'run-manifest.json');
  const nativeTextArtifacts: SkillRuntimeArtifact[] = [];
  let nativeTextEventArchive: {
    location: string; sha256: string; bytes: number; workspaceRoot: string;
  } | undefined;
  if (nativeStream !== undefined) {
    const location = join(artifactRoot, 'native-text-events.jsonl');
    writeFileSync(location, nativeStream, { mode: 0o600, flag: 'wx' });
    const archived = readFileSync(location);
    if (!archived.equals(nativeStream)) throw new Error('Native text event archive changed during persistence');
    const sha256 = createHash('sha256').update(archived).digest('hex');
    nativeTextEventArchive = {
      location: canonicalizePath(location), sha256, bytes: archived.byteLength,
      workspaceRoot: nativeWorkspaceRoot!,
    };
    nativeTextArtifacts.push({ kind: 'report', location, sha256 });
  }
  const publicContractRoot = join(artifactRoot, 'public-contract');
  mkdirSync(publicContractRoot, { recursive: true });
  const publicContractFiles: Array<
    [keyof SkillEvalPublicContractSnapshot['fixtureFiles'], string]
  > = [
    ['README.md', join(publicContractRoot, 'README.md')],
    ['contract.json', join(publicContractRoot, 'contract.json')],
  ];
  for (const [name, destination] of publicContractFiles) {
    const snapshot = input.publicContractSnapshot.fixtureFiles[name];
    if (!snapshot.available) continue;
    writeFileSync(destination, snapshot.text!);
    const archived = readFileSync(destination);
    if (
      createHash('sha256').update(archived).digest('hex') !== snapshot.sha256 ||
      archived.byteLength !== snapshot.byteLength ||
      archived.toString('utf8') !== snapshot.text
    ) {
      throw new Error(`Public fixture snapshot could not be archived for ${name}`);
    }
  }
  const taskPromptSnapshot = input.publicContractSnapshot.taskPrompt;
  if (
    !taskPromptSnapshot.available ||
    typeof taskPromptSnapshot.sha256 !== 'string' ||
    typeof taskPromptSnapshot.text !== 'string'
  ) {
    throw new Error('Public task-prompt snapshot is unavailable');
  }
  const promptPath = join(publicContractRoot, 'task-prompt.txt');
  writeFileSync(promptPath, taskPromptSnapshot.text);
  const archivedPrompt = readFileSync(promptPath);
  if (
    createHash('sha256').update(archivedPrompt).digest('hex') !== taskPromptSnapshot.sha256 ||
    archivedPrompt.byteLength !== taskPromptSnapshot.byteLength ||
    archivedPrompt.toString('utf8') !== taskPromptSnapshot.text
  ) {
    throw new Error('Public task-prompt snapshot could not be archived');
  }
  let archivedPreDispatch: { location: string; sha256: string; relativePath: string } | undefined;
  if (input.preDispatchCapture) {
    const sealed = input.preDispatchCapture;
    const location = join(artifactRoot, 'pre-dispatch-original.json');
    writeFileSync(location, sealed.text, { flag: 'wx' });
    if (createHash('sha256').update(readFileSync(location)).digest('hex') !== sealed.sha256) {
      throw new Error('Sealed pre-dispatch original-source observation could not be archived');
    }
    archivedPreDispatch = { location, sha256: sealed.sha256, relativePath: sealed.relativePath };
  }
  const finalFingerprint = fingerprintSkillEvalWorkspace(input.workingDirectory);
  input.assertBaseUnchanged();
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        artifactSchemaVersion: 3,
        pairId: input.pairId,
        variant: input.variant,
        scenario: input.scenario,
        materializerId: input.materializerId,
        deterministicScorerId: input.deterministicScorerId,
        harnessVersion: input.harnessVersion,
        evaluationContractHash: input.evaluationContractHash ?? null,
        evaluationContractVersion: input.evaluationContractVersion ?? null,
        workspaceFingerprintFormat: SKILL_EVAL_WORKSPACE_FINGERPRINT_FORMAT,
        initialFingerprint: input.initialFingerprint,
        finalFingerprint,
        publicContractSnapshot: input.publicContractSnapshot,
        preDispatchCaptureArchive: archivedPreDispatch ?? null,
        ...(nativeTextEventArchive ? { nativeTextEventArchive } : {}),
        durationMs: input.observation.durationMs,
        changes,
        score: input.score,
        evidence: input.observation.evidence,
        infrastructureFailure: input.observation.infrastructureFailure ?? null,
      },
      null,
      2,
    )}\n`,
  );
  return [
    ...nativeTextArtifacts,
    ...(archivedPreDispatch ? [{
      kind: 'report' as const, location: archivedPreDispatch.location,
      sha256: archivedPreDispatch.sha256,
    }] : []),
    {
      kind: 'report',
      location: manifestPath,
      sha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
    },
    {
      kind: 'report',
      location: outputPath,
      sha256: createHash('sha256').update(readFileSync(outputPath)).digest('hex'),
    },
  ];
}

function scenarioFromPackage(
  skillPackage: V5CompiledSkillPackage,
  scenarioId: string,
): SkillEvalScenarioV3 {
  const task = skillPackage.evaluation.tasks.find((item) => item.id === scenarioId);
  if (!task)
    throw new Error(`Full-task scenario ${scenarioId} not found for ${skillPackage.sidecar.name}`);
  return {
    id: task.id,
    skill: skillPackage.sidecar.name,
    category: 'full-task',
    prompt: task.prompt,
    expectedSelection: true,
    expectedSkills: [],
    forbiddenSkills: [],
    heldOut: true,
    adjacentSkills: [],
    tags: ['held-out', 'full-task'],
    environment: task.environment,
    falsifiableChecks: task.falsifiableChecks,
    scorers: task.scorers,
    requiredEvidence: task.requiredEvidence,
    requiredArtifacts: task.requiredArtifacts,
  };
}

function infrastructureObservation(
  kind: SkillInfrastructureFailure['kind'],
  detail: string,
  evidence: string[],
): SkillEvalExecutionObservation {
  return {
    output: '',
    evidence,
    artifacts: [],
    durationMs: 0,
    infrastructureFailure: { kind, retryable: false, evidence, detail },
  };
}

export async function runPairedSkillEvaluationV3(input: {
  projectRoot: string;
  skillPackage: V5CompiledSkillPackage;
  scenarioId: string;
  skillRevisionHash: string;
  harnessVersion: string;
  evaluationContractHash?: string;
  evaluationContractVersion?: number;
  executor: SkillEvalExecutor;
  materializers: readonly SkillEvalFixtureMaterializer[];
  scorers: readonly SkillEvalDeterministicScorer[];
  pairId?: string;
  /** Immutable failure to retest under the exact current task and scorer. */
  regressionId?: string;
  persist?: boolean;
  executionOrder?: 'with-skill-first' | 'without-skill-first';
}): Promise<SkillEvalPairRunResult> {
  const scenario = scenarioFromPackage(input.skillPackage, input.scenarioId);
  const materializer = matchingMaterializer(scenario, input.materializers);
  const scorer = matchingScorer(scenario, input.scorers);
  if (!materializer) {
    throw new Error(
      `Cannot execute ${scenario.id}: no materializer for ${scenario.environment.startingState}`,
    );
  }
  if (!scorer) throw new Error(`Cannot execute ${scenario.id}: no registered deterministic scorer`);
  if (materializer.readinessBlockers?.length) {
    throw new Error(`Cannot execute ${scenario.id}: ${materializer.readinessBlockers.join('; ')}`);
  }
  if (input.regressionId) {
    const source = listOpenSkillRegressionSources(
      input.projectRoot, input.skillPackage.sidecar.name, input.skillRevisionHash,
    ).find((run) => run.id === input.regressionId);
    if (!source || (source.scenarioId ?? source.caseId) !== scenario.id) {
      throw new Error(`Cannot retest ${scenario.id}: regression source is not open for this task`);
    }
  }

  const pairId = input.pairId ?? `${scenario.id}:${randomUUID()}`;
  const suiteId = `${input.skillPackage.sidecar.name}:v${input.skillPackage.sidecar.version}:held-out`;
  const experiments = createPairedSkillExperimentsV3({
    pairId,
    suiteId,
    skill: input.skillPackage.sidecar.name,
    skillRevisionHash: input.skillRevisionHash,
    subject: input.executor.subject,
    provider: input.executor.provider,
    model: input.executor.model,
    harnessVersion: input.harnessVersion,
    role: 'worker',
    runtimeIdentity: input.executor.runtimeIdentity,
    tools: input.executor.toolsForScenario?.(scenario) ?? input.executor.tools,
    budget: input.executor.budget,
  });
  const pairValidation = validatePairedSkillExperimentsV3(
    experiments.withSkill,
    experiments.withoutSkill,
  );
  if (!pairValidation.valid) {
    throw new Error(`Invalid skill evaluation pair: ${pairValidation.reasons.join('; ')}`);
  }

  const pairRoot = mkdtempSync(join(tmpdir(), 'kory-skill-eval-pair-'));
  const baseRoot = join(pairRoot, 'base');
  const withSkillRoot = join(pairRoot, 'with-skill');
  const withoutSkillRoot = join(pairRoot, 'without-skill');
  mkdirSync(baseRoot, { recursive: true });
  let cleanupCalled = false;
  const cleanup = () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    rmSync(pairRoot, { recursive: true, force: true });
  };

  try {
    await materializer.materialize(baseRoot, scenario);
    let preDispatchCapture: SkillEvalPreDispatchCapture | undefined;
    if (materializer.captureBeforeCandidateDispatch) {
      const capture = await materializer.captureBeforeCandidateDispatch(baseRoot, scenario);
      if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(capture.relativePath) ||
        capture.relativePath.split('/').includes('..')) {
        throw new Error('Unsafe pre-dispatch observation path');
      }
      const snapshot = snapshotTextFile(join(baseRoot, capture.relativePath));
      if (!snapshot.available || snapshot.text !== capture.text || !snapshot.sha256) {
        throw new Error('Original-source observation was not captured intact before dispatch');
      }
      preDispatchCapture = Object.freeze({
        relativePath: capture.relativePath,
        sha256: snapshot.sha256,
        text: snapshot.text,
      });
    }
    const baseIdentity = lstatSync(baseRoot);
    if (!baseIdentity.isDirectory() || baseIdentity.isSymbolicLink()) {
      throw new Error('Evaluation base workspace must be a real directory');
    }
    const canonicalBaseRoot = canonicalizePath(baseRoot);
    const initialFingerprint = fingerprintSkillEvalWorkspace(baseRoot);
    const assertBaseUnchanged = () => {
      try {
        const current = lstatSync(baseRoot);
        if (current.isDirectory() && !current.isSymbolicLink() &&
          current.dev === baseIdentity.dev && current.ino === baseIdentity.ino &&
          canonicalizePath(baseRoot) === canonicalBaseRoot &&
          fingerprintSkillEvalWorkspace(baseRoot) === initialFingerprint) return;
      } catch {
        // A missing or substituted baseline cannot become starting-state evidence.
      }
      throw new Error('Evaluation base workspace changed after materialization');
    };
    const publicContractSnapshot = captureSkillEvalPublicContractSnapshot(
      baseRoot,
      scenario.prompt,
    );
    assertBaseUnchanged();
    cpSync(baseRoot, withSkillRoot, { recursive: true });
    cpSync(baseRoot, withoutSkillRoot, { recursive: true });
    if (
      fingerprintSkillEvalWorkspace(withSkillRoot) !== initialFingerprint ||
      fingerprintSkillEvalWorkspace(withoutSkillRoot) !== initialFingerprint
    ) {
      throw new Error('Paired evaluation workspaces diverged before execution');
    }

    const runOne = async (
      experiment: SkillEvalExperimentV3,
      workingDirectory: string,
      skillContext: string | null,
    ) => {
      assertBaseUnchanged();
      let observation: SkillEvalExecutionObservation;
      try {
        observation = await input.executor.execute({
          experiment,
          scenario,
          workingDirectory,
          taskPrompt: scenario.prompt,
          skillContext,
          attachments: materializer.imageAttachments?.(baseRoot, scenario) ?? [],
        });
      } catch (error: unknown) {
        observation = infrastructureObservation(
          'provider',
          error instanceof Error ? error.message : String(error),
          ['executor threw before producing a complete observation'],
        );
      }
      assertBaseUnchanged();
      const score: SkillEvalDeterministicScore | null = observation.infrastructureFailure
        ? null
        : observation.taskFailure
          ? {
              passed: false,
              quality: 0,
              verification: 0,
              integrityFailure: false,
              evidence: [observation.taskFailure],
            }
          : await scorer.score({ scenario, experiment, workingDirectory, observation, preDispatchCapture });
      if (score) {
        boundedUnit(score.quality);
        boundedUnit(score.verification);
      }
      assertBaseUnchanged();
      if (input.persist) {
        const durableArtifacts = persistArmEvidence({
          projectRoot: input.projectRoot,
          pairId,
          variant: experiment.variant,
          scenario,
          materializerId: materializer.id,
          deterministicScorerId: scorer.id,
          harnessVersion: experiment.harnessVersion,
          evaluationContractHash: input.evaluationContractHash,
          evaluationContractVersion: input.evaluationContractVersion,
          baseRoot,
          initialFingerprint,
          assertBaseUnchanged,
          workingDirectory,
          publicContractSnapshot,
          preDispatchCapture,
          observation,
          score,
        });
        // An arm with no score did not produce candidate evidence. Persisting it as a zero-quality
        // run made a provider outage or a host socket failure indistinguishable from a model that
        // solved nothing, and it stayed in the pass rate forever. The artifacts above are still
        // archived for diagnosis; only the evidence row is withheld.
        if (score)
        recordSkillEvaluationRun(input.projectRoot, {
          id: experiment.id,
          skill: input.skillPackage.sidecar.name,
          revisionHash: input.skillRevisionHash,
          caseId: scenario.id,
          provider: experiment.provider,
          model: experiment.model,
          harnessVersion: experiment.harnessVersion,
          role: experiment.role,
          evaluator: 'deterministic',
          passed: score?.passed ?? false,
          quality: score?.quality ?? 0,
          verification: score?.verification ?? 0,
          integrityFailure: score?.integrityFailure ?? false,
          evidence: [...observation.evidence, ...(score?.evidence ?? [])],
          recordedAt: new Date().toISOString(),
          protocolVersion: 3,
          variant: experiment.variant,
          caseCategory: 'full-task',
          ...(experiment.variant === 'with-skill' && input.regressionId
            ? { regressionId: input.regressionId }
            : {}),
          comparisonId: pairId,
          routing: {
            expectedSelection: true,
            selected: experiment.variant === 'with-skill',
            selectedSkills:
              experiment.variant === 'with-skill' ? [input.skillPackage.sidecar.name] : [],
            expectedSkills: [],
            forbiddenSkills: [],
          },
          suiteId,
          scenarioId: scenario.id,
          experimentId: experiment.id,
          evaluationContractHash: input.evaluationContractHash,
          evaluationContractVersion: input.evaluationContractVersion,
          materializerId: materializer.id,
          deterministicScorerId: scorer.id,
          infrastructureFailure: observation.infrastructureFailure,
          artifacts: [...observation.artifacts, ...durableArtifacts],
        });
      }
      return { experiment, workspace: workingDirectory, observation, score };
    };

    const runWithSkill = () =>
      runOne(experiments.withSkill, withSkillRoot, input.skillPackage.sourceContent);
    const runWithoutSkill = () => runOne(experiments.withoutSkill, withoutSkillRoot, null);
    const executionOrder: Array<'with-skill' | 'without-skill'> =
      input.executionOrder === 'without-skill-first'
        ? ['without-skill', 'with-skill']
        : ['with-skill', 'without-skill'];
    let withSkill: Awaited<ReturnType<typeof runWithSkill>>;
    let withoutSkill: Awaited<ReturnType<typeof runWithoutSkill>>;
    if (executionOrder[0] === 'with-skill') {
      withSkill = await runWithSkill();
      withoutSkill = await runWithoutSkill();
    } else {
      withoutSkill = await runWithoutSkill();
      withSkill = await runWithSkill();
    }
    return {
      pairId,
      scenarioId: scenario.id,
      initialFingerprint,
      publicContractSnapshot,
      preDispatchCapture,
      executionOrder,
      withSkill,
      withoutSkill,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
