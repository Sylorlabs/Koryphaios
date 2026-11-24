import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import {
  hasHardLinks,
  hasPosixPermissionBits,
  hasUnexpectedMode,
  hasUnexpectedOwner,
  isContainedBy,
} from '../backend/src/runtime/platform';
import {
  verifyBlindReviewPublicContractSnapshot,
  type BlindReviewArtifact,
} from '../backend/src/eval/skills/skill-eval-blind-review';
import type { SkillEvaluationRun } from '../backend/src/kory/skill-evaluations';

export const blindImportSha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export const SNAPSHOT_HASH_EXPLANATION =
  'SNAPSHOT HASH DOMAINS: beforeSha256/afterSha256 identify complete workspace entries, using SHA256("file\\0" + original file bytes), or SHA256("symlink\\0" + link target). Scorer artifactSHA and durable artifact hashes use SHA256(raw bytes), without that tag. These different hash domains must not be compared as if identical. Visible beforeText/afterText may be bounded or privacy-scrubbed; they are not the original complete bytes to hash.';
export const MAX_BLIND_IMPORT_BYTES = 2_097_152;
const MAX_MANIFEST_BYTES = 16_777_216;
const MAX_SNAPSHOT_BYTES = 67_108_864;
const MAX_TOTAL_SNAPSHOT_BYTES = 268_435_456;

// Walk literal components, including ancestors above the evidence root. A
// canonical path alone hides a caller-supplied symlink to unrelated private data.
export function assertBlindPath(path: string, leafSymlink = false, allowMissing = false): string {
  if (!isAbsolute(path) || /[\u0000-\u001f]/u.test(path))
    throw new Error('Invalid blind artifact path');
  const absolute = resolve(path);
  let component = parse(absolute).root;
  const parts = relative(component, absolute).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    component = join(component, parts[index]!);
    let metadata;
    try {
      metadata = lstatSync(component);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return absolute;
      throw error;
    }
    const leaf = index === parts.length - 1;
    if (metadata.isSymbolicLink() && !(leaf && leafSymlink))
      throw new Error('Blind artifact parent or root is a symlink');
    if (!leaf && !metadata.isDirectory())
      throw new Error('Blind artifact parent is not a regular directory');
  }
  return absolute;
}

// Never use readFileSync(fd) after checking size: a file can grow after fstat.
// Read at most the bounded size plus one byte, even during concurrent mutation.
export function readBoundedBlindDescriptor(fd: number, maximum: number): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 0)
    throw new Error('Invalid blind artifact byte limit');
  const before = fstatSync(fd);
  if (!before.isFile() || before.size > maximum)
    throw new Error('Blind artifact is not a bounded regular file');
  const bytes = Buffer.alloc(before.size + 1);
  let read = 0;
  while (read < bytes.length) {
    const count = readSync(fd, bytes, read, bytes.length - read, null);
    if (count === 0) break;
    read += count;
  }
  const after = fstatSync(fd);
  if (
    read !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw new Error('Blind artifact changed during bounded read');
  }
  return bytes.subarray(0, read);
}

export function readBoundedBlindFile(path: string, maximum: number, privateFile = false): Buffer {
  const absolute = assertBlindPath(path);
  const parent = lstatSync(dirname(absolute));
  if (privateFile && (hasUnexpectedOwner(parent) || hasUnexpectedMode(parent, 0o700))) {
    throw new Error('Blind private artifact parent is not protected');
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = fstatSync(fd);
    if (
      privateFile &&
      (hasUnexpectedOwner(metadata) ||
        hasHardLinks(metadata) ||
        (hasUnexpectedMode(metadata, 0o600) && hasUnexpectedMode(metadata, 0o400)))
    ) {
      throw new Error('Blind private artifact is not protected');
    }
    const bytes = readBoundedBlindDescriptor(fd, maximum);
    assertBlindPath(absolute);
    const current = lstatSync(absolute);
    if (
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino ||
      current.size !== metadata.size ||
      current.mtimeMs !== metadata.mtimeMs ||
      current.ctimeMs !== metadata.ctimeMs
    ) {
      throw new Error('Blind artifact path changed during bounded read');
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function writeProtectedBlindFile(path: string, bytes: Buffer): string {
  if (!bytes.length || bytes.length > MAX_BLIND_IMPORT_BYTES)
    throw new Error('Invalid blind private artifact size');
  assertBlindPath(dirname(path));
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || hasUnexpectedOwner(parent) || hasUnexpectedMode(parent, 0o700)) {
    throw new Error('Blind private artifact parent is not protected');
  }
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const digest = blindImportSha256(bytes);
  if (blindImportSha256(readBoundedBlindFile(path, MAX_BLIND_IMPORT_BYTES, true)) !== digest) {
    throw new Error('Blind private artifact did not persist exactly');
  }
  // Windows cannot open/fsync a directory through Node's POSIX file API.
  if (hasPosixPermissionBits()) {
    const directoryFd = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
  return digest;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function scrubBlindPrivateText(value: string, skill: string): string {
  return value
    .replace(/\bwithout-skill\b/giu, 'workspace')
    .replace(/\bwith-skill\b/giu, 'workspace')
    .replace(/\bwithout[ -]skill\b/giu, 'workspace')
    .replace(/\bwith[ -]skill\b/giu, 'workspace')
    .replace(new RegExp(escapeRegExp(skill), 'giu'), 'target-guidance')
    .replace(
      /\/(?:Users|home|private\/var|var\/folders|tmp)\/[^\s"'`\)\]}>,;]+|[A-Za-z]:\\(?:Users|home|Temp|Windows)\\[^\s"'`\)\]}>,;]+/gu,
      '<redacted-path>',
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|\S+)/giu,
      '$1<redacted-credential>',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, 'Bearer <redacted-credential>')
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{12,}/gu, 'sk-<redacted-credential>');
}

// Snapshot hashes use the executor's domain tag, not scorer raw-byte hashes.
// Never follow a snapshot symlink, including a symlink in a parent directory.
export function verifiedSnapshotText(
  root: string,
  path: string,
  expected: unknown,
  maxChars: number,
  budget = { remainingBytes: MAX_SNAPSHOT_BYTES },
): string | undefined {
  if (
    !path ||
    isAbsolute(path) ||
    /[\u0000-\u001f]/u.test(path) ||
    path.split(/[\\/]/u).some((part) => part === '..')
  ) {
    throw new Error('Invalid blind snapshot path');
  }
  const destination = resolve(root, path);
  if (destination === resolve(root) || !isContainedBy(resolve(root), destination))
    throw new Error('Invalid blind snapshot containment');
  assertBlindPath(destination, true, true);
  if (existsSync(root) && !lstatSync(root).isDirectory())
    throw new Error('Blind snapshot root is not a regular directory');
  let metadata;
  try {
    metadata = lstatSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (expected === null || expected === undefined) {
    if (metadata) throw new Error('Unexpected blind snapshot with no bound hash');
    return undefined;
  }
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected) || !metadata) {
    throw new Error('Missing or invalid bound blind snapshot');
  }
  const bytes = metadata.isSymbolicLink()
    ? Buffer.from(readlinkSync(destination))
    : metadata.isFile()
      ? readBoundedBlindFile(destination, Math.min(MAX_SNAPSHOT_BYTES, budget.remainingBytes))
      : undefined;
  if (!bytes) throw new Error('Blind snapshot is not a file or symlink');
  budget.remainingBytes -= bytes.length;
  if (budget.remainingBytes < 0) throw new Error('Blind snapshot total byte limit exceeded');
  const tag = metadata.isSymbolicLink() ? 'symlink\0' : 'file\0';
  if (blindImportSha256(Buffer.concat([Buffer.from(tag), bytes])) !== expected)
    throw new Error('Blind snapshot domain-tagged hash mismatch');
  if (metadata.isSymbolicLink() || maxChars <= 0 || bytes.includes(0)) return undefined;
  return bytes.toString('utf8').slice(0, maxChars);
}

export function verifyPreparedArtifactHashes(
  prepared: { artifactASha256: string; artifactBSha256: string },
  artifactA: BlindReviewArtifact,
  artifactB: BlindReviewArtifact,
): void {
  if (
    blindImportSha256(JSON.stringify(artifactA)) !== prepared.artifactASha256 ||
    blindImportSha256(JSON.stringify(artifactB)) !== prepared.artifactBSha256
  ) {
    throw new Error(
      'Prepared blind assignment artifact hash mismatch; current anonymous snapshots differ from the sealed assignment',
    );
  }
}

export function verifyPreparedCurrentBinding(
  prepared: {
    skill: string;
    scenarioId: string;
    pairId: string;
    revisionHash: string;
    withIsA: boolean;
    suiteId?: string;
    evaluationContractHash?: string;
    evaluationContractVersion?: number;
    materializerId?: string;
    deterministicScorerId?: string;
  },
  run: SkillEvaluationRun,
): void {
  if (
    typeof prepared.withIsA !== 'boolean' ||
    prepared.skill !== run.skill ||
    prepared.scenarioId !== (run.scenarioId ?? run.caseId) ||
    prepared.pairId !== run.comparisonId ||
    [
      'revisionHash',
      'suiteId',
      'evaluationContractHash',
      'evaluationContractVersion',
      'materializerId',
      'deterministicScorerId',
    ].some((key) => prepared[key as keyof typeof prepared] !== run[key as keyof SkillEvaluationRun])
  ) {
    throw new Error(
      'Prepared blind assignment does not match the exact current eligible revision/contract pair',
    );
  }
}

// Keep historical guidance prefixes immutable, but bind the task/rubric/evidence
// tail itself to the current anonymous pair, not merely to mutable metadata.
export function verifyPreparedPromptBinding(prompt: string, currentPrompt: string): void {
  const task = currentPrompt.indexOf('\nTASK\n');
  if (task < 0 || !prompt.endsWith(currentPrompt.slice(task))) {
    throw new Error(
      'Sealed blind prompt does not contain the exact current anonymous task/artifact bundle',
    );
  }
}

export function anonymousArtifact(run: SkillEvaluationRun, skill: string): BlindReviewArtifact {
  const manifestArtifact = run.artifacts?.find(
    (artifact) => artifact.kind === 'report' && basename(artifact.location) === 'run-manifest.json',
  );
  const outputArtifact = run.artifacts?.find(
    (artifact) => artifact.kind === 'report' && basename(artifact.location) === 'final-output.txt',
  );
  if (!manifestArtifact || !outputArtifact)
    throw new Error(`Run ${run.id} lacks durable manifest/output artifacts`);
  const manifestBytes = readBoundedBlindFile(manifestArtifact.location, MAX_MANIFEST_BYTES);
  const outputBytes = readBoundedBlindFile(outputArtifact.location, MAX_BLIND_IMPORT_BYTES);
  for (const [artifact, bytes, label] of [
    [manifestArtifact, manifestBytes, 'manifest'],
    [outputArtifact, outputBytes, 'output'],
  ] as const) {
    if (typeof artifact.sha256 !== 'string' || blindImportSha256(bytes) !== artifact.sha256) {
      throw new Error(`Durable ${label} artifact hash mismatch for run ${run.id}`);
    }
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    changes?: Array<{
      path?: unknown;
      change?: unknown;
      beforeSha256?: unknown;
      afterSha256?: unknown;
    }>;
    evidence?: unknown;
    score?: { evidence?: unknown };
    publicContractSnapshot?: import('../backend/src/eval/skills/skill-eval-execution').SkillEvalPublicContractSnapshot;
  };
  let remaining = 80_000;
  const artifactRoot = dirname(manifestArtifact.location);
  const manifestChanges = manifest.changes ?? [];
  if (
    !Array.isArray(manifestChanges) ||
    manifestChanges.length > 10_000 ||
    manifestChanges.some(
      (change) =>
        !change ||
        typeof change.path !== 'string' ||
        !['added', 'modified', 'deleted'].includes(String(change.change)) ||
        (change.change === 'added'
          ? change.beforeSha256 !== null || typeof change.afterSha256 !== 'string'
          : change.change === 'deleted'
            ? change.afterSha256 !== null || typeof change.beforeSha256 !== 'string'
            : typeof change.beforeSha256 !== 'string' || typeof change.afterSha256 !== 'string'),
    ) ||
    new Set(manifestChanges.map((change) => change.path)).size !== manifestChanges.length
  ) {
    throw new Error('Invalid blind snapshot change manifest');
  }
  // Compiler caches and installed dependencies are not candidate work: a webpack pack or a
  // dependency symlink cannot be carried into a reviewer bundle, and reading them must not fail
  // the assignment. They are counted in the evidence so the reviewer knows what was left out.
  const generatedRoots = ['.gocache/', '.next/', 'node_modules/'];
  const reviewChanges = manifestChanges.filter(
    (change) => !generatedRoots.some((root) => String(change.path).startsWith(root)),
  );
  const omittedGeneratedChanges = manifestChanges.length - reviewChanges.length;
  const snapshotBudget = { remainingBytes: MAX_TOTAL_SNAPSHOT_BYTES };
  const changes = reviewChanges.map((change) => {
    const path = change.path as string;
    const beforeText = verifiedSnapshotText(
      join(artifactRoot, 'before-files'),
      path,
      change.beforeSha256,
      Math.min(20_000, remaining),
      snapshotBudget,
    );
    if (beforeText) remaining -= beforeText.length;
    const afterText = verifiedSnapshotText(
      join(artifactRoot, 'files'),
      path,
      change.afterSha256,
      Math.min(20_000, remaining),
      snapshotBudget,
    );
    if (afterText) remaining -= afterText.length;
    return {
      path: scrubBlindPrivateText(path, skill),
      change: change.change as string,
      beforeSha256: typeof change.beforeSha256 === 'string' ? change.beforeSha256 : null,
      afterSha256: typeof change.afterSha256 === 'string' ? change.afterSha256 : null,
      ...(beforeText ? { beforeText: scrubBlindPrivateText(beforeText, skill) } : {}),
      ...(afterText ? { afterText: scrubBlindPrivateText(afterText, skill) } : {}),
    };
  });
  const manifestEvidence = Array.isArray(manifest.evidence)
    ? manifest.evidence.filter((item): item is string => typeof item === 'string')
    : [];
  const scoreEvidence = Array.isArray(manifest.score?.evidence)
    ? manifest.score.evidence.filter((item): item is string => typeof item === 'string')
    : [];
  let evidenceRemaining = 45_000;
  const executionEvidence = [
    ...(omittedGeneratedChanges > 0
      ? [
          `Blind harness omitted ${String(omittedGeneratedChanges)} generated build and dependency change records from the reviewer bundle; the durable run manifest retains them.`,
        ]
      : []),
    ...manifestEvidence,
    ...scoreEvidence,
  ].flatMap((item) => {
    if (evidenceRemaining <= 0) return [];
    const bounded = item.slice(0, evidenceRemaining);
    evidenceRemaining -= bounded.length;
    return [scrubBlindPrivateText(bounded, skill)];
  });
  const publicContractSnapshot = manifest.publicContractSnapshot;
  const publicContract = verifyBlindReviewPublicContractSnapshot({
    snapshot: publicContractSnapshot,
    taskPromptBytes: publicContractSnapshot?.taskPrompt?.available
      ? readBoundedBlindFile(
          join(artifactRoot, 'public-contract', 'task-prompt.txt'),
          MAX_BLIND_IMPORT_BYTES,
        )
      : undefined,
    fixtureFileBytes: {
      'README.md': publicContractSnapshot?.fixtureFiles?.['README.md']?.available
        ? readBoundedBlindFile(
            join(artifactRoot, 'public-contract', 'README.md'),
            MAX_BLIND_IMPORT_BYTES,
          )
        : undefined,
      'contract.json': publicContractSnapshot?.fixtureFiles?.['contract.json']?.available
        ? readBoundedBlindFile(
            join(artifactRoot, 'public-contract', 'contract.json'),
            MAX_BLIND_IMPORT_BYTES,
          )
        : undefined,
    },
  });
  return {
    finalOutput: scrubBlindPrivateText(outputBytes.toString('utf8').slice(0, 30_000), skill),
    executionEvidence,
    publicContract,
    changes,
  };
}
