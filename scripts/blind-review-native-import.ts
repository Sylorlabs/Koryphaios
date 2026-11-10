import { createHash } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import {
  canonicalizePath, hasHardLinks, hasPosixPermissionBits, hasUnexpectedMode,
  hasUnexpectedOwner, isContainedBy,
} from '../backend/src/runtime/platform';
import { parseNativeTextEvents } from './native-text-events';
import { exactRecord, strictJson, validateAdjudication } from './reviewer-json';
import { nativeMacStageProfile, NATIVE_MAC_STAGE_MODE } from './native-reviewer-sandbox';
import {
  MAX_NATIVE_REVIEW_REQUEST_BYTES, MAX_NATIVE_REVIEW_RESPONSE_BYTES,
  NATIVE_REVIEW_SYSTEM_PROMPT, NATIVE_REVIEW_VERSION,
} from './kory-native-stateless-reviewer.ts';
import type { NativeStageFileReference } from './native-reviewer-archive';
import { assertBlindPath, MAX_BLIND_IMPORT_BYTES, readBoundedBlindDescriptor } from './blind-review-import-validation';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const MAX_RECEIPT_BYTES = 2_097_152;
const MAX_PROFILE_BYTES = 64_000;
const MAX_ENVELOPE_BYTES = 2_097_152;
function refuse(): never { throw new Error('Unqualified native blind-review stage evidence (details redacted)'); }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  return value as Record<string, any>;
}

export function requireNativeStageOptIn(envelope: { nativeStageEvidence?: unknown; reviewer: { agentId: string; provider?: string }; reviews: unknown[] }, allowed: boolean): boolean {
  const native = envelope.nativeStageEvidence !== undefined || envelope.reviewer.agentId.startsWith('native-cli:') ||
    envelope.reviewer.provider === 'native-cli';
  if (native && (!allowed || !envelope.nativeStageEvidence || envelope.reviews.length !== 1)) {
    throw new Error('Native blind-review stages require --allow-native-stage and fresh archived nativeStageEvidence; old unarchived stages remain unqualified');
  }
  return native;
}

export interface NativeStageEvidence {
  schemaVersion: 1;
  stageOnly: true;
  rawEvents: NativeStageFileReference;
  hostReceipt: NativeStageFileReference;
  sealedPrompt: NativeStageFileReference;
  kernelProfile: NativeStageFileReference;
}

// Reject literal symlink components before canonical resolution. The deleted CLI
// private home can be checked by canonicalizing its nearest extant ancestor.
function canonicalLiteral(path: string, allowMissing = false): string {
  if (!isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f]/u.test(path)) refuse();
  let component = parse(path).root;
  for (const part of relative(component, path).split(sep).filter(Boolean)) {
    component = join(component, part);
    if (!existsSync(component)) {
      try { lstatSync(component); refuse(); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!allowMissing) refuse();
      const ancestor = dirname(component);
      const canonical = join(canonicalizePath(ancestor), relative(ancestor, path));
      if (canonical !== path) refuse();
      return canonical;
    }
    if (lstatSync(component).isSymbolicLink()) refuse();
  }
  const canonical = canonicalizePath(path);
  if (canonical !== path) refuse();
  return canonical;
}

export function readProtectedNativeReference(value: unknown, limit: number, prompt = false): { ref: NativeStageFileReference; bytes: Buffer } {
  const input = exactRecord(value, ['path', 'sha256', 'bytes']);
  if (typeof input.path !== 'string' || typeof input.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input.sha256) || typeof input.bytes !== 'number' || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > limit ||
    !hasPosixPermissionBits()) refuse();
  const path = canonicalLiteral(input.path);
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || hasUnexpectedOwner(parent) || hasUnexpectedMode(parent, 0o700)) refuse();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || hasUnexpectedOwner(before) || hasHardLinks(before) ||
      (!prompt && hasUnexpectedMode(before, 0o600)) ||
      (prompt && hasUnexpectedMode(before, 0o400) && hasUnexpectedMode(before, 0o600)) || before.size !== input.bytes) refuse();
    const bytes = readBoundedBlindDescriptor(fd, input.bytes);
    const after = fstatSync(fd);
    canonicalLiteral(path);
    const current = lstatSync(path);
    const parentAfter = lstatSync(dirname(path));
    if (!parentAfter.isDirectory() || hasUnexpectedOwner(parentAfter) || hasUnexpectedMode(parentAfter, 0o700) ||
      bytes.length !== input.bytes || sha(bytes) !== input.sha256 || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || hasHardLinks(after) ||
      current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) refuse();
    return { ref: { path, sha256: input.sha256, bytes: input.bytes }, bytes };
  } finally { closeSync(fd); }
}

export interface VerifiedNativeImport {
  files: Array<{ name: string; bytes: Buffer; sha256: string }>;
  provenance: {
    schemaVersion: 1;
    qualification: 'host-observed-native-empty-tool-stream-and-macos-private-root-profile';
    sessionId: string;
    runtimeVersion: string;
    model: string;
    promptSha256: string;
    systemPromptSha256: string;
    requestSha256: string;
    outputSha256: string;
    upstreamIdentityVerified: false;
    signed: false;
    universalReadAllowlist: false;
  };
}

// Caller must opt in; neither provider label nor an unsigned receipt alone is
// qualification. This verifies a specific host-observed boundary, not upstream
// identity, cancellation, or a universal OS read allowlist.
export function verifyNativeBlindReviewImport(input: {
  stage: unknown;
  reviewer: { agentId: string; model: string };
  output: string;
  promptSha256: string;
  requiredProtectedRoots: string[];
}): VerifiedNativeImport {
  const stage = exactRecord(input.stage, ['schemaVersion', 'stageOnly', 'rawEvents', 'hostReceipt', 'sealedPrompt', 'kernelProfile']);
  if (stage.schemaVersion !== 1 || stage.stageOnly !== true) refuse();
  validateAdjudication(input.output);
  const raw = readProtectedNativeReference(stage.rawEvents, MAX_NATIVE_REVIEW_RESPONSE_BYTES);
  const host = readProtectedNativeReference(stage.hostReceipt, MAX_RECEIPT_BYTES);
  const seal = readProtectedNativeReference(stage.sealedPrompt, MAX_NATIVE_REVIEW_REQUEST_BYTES, true);
  const profile = readProtectedNativeReference(stage.kernelProfile, MAX_PROFILE_BYTES);
  if (new Set([raw.ref.path, host.ref.path, seal.ref.path, profile.ref.path]).size !== 4 ||
    dirname(raw.ref.path) !== dirname(profile.ref.path) || dirname(host.ref.path) !== dirname(seal.ref.path)) refuse();
  const completion = object(strictJson(host.bytes.toString('utf8')));
  const receipt = object(completion.hostReceipt);
  const parsed = parseNativeTextEvents(raw.bytes, input.reviewer.model);
  if (completion.schemaVersion !== 1 || completion.completed !== true ||
    completion.reviewerId !== `native-cli:${parsed.sessionId}` || completion.reviewerId !== input.reviewer.agentId ||
    completion.output !== parsed.output || input.output !== parsed.output ||
    !Array.isArray(completion.events) || completion.events.length !== 2 ||
    completion.events[0]?.type !== 'review.started' || completion.events[1]?.type !== 'review.completed' ||
    completion.events.some((event: any) => event.reviewerId !== input.reviewer.agentId) ||
    completion.events[1]?.outputSha256 !== sha(parsed.output)) refuse();
  const sameRef = (actual: unknown, expected: NativeStageFileReference) => {
    const ref = object(actual);
    return ref.path === expected.path && ref.sha256 === expected.sha256 && ref.bytes === expected.bytes;
  };
  const prompt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(seal.bytes);
  const request = JSON.stringify({ system: NATIVE_REVIEW_SYSTEM_PROMPT, prompt, model: input.reviewer.model });
  if (!prompt.trim() || seal.ref.sha256 !== input.promptSha256 ||
    receipt.schemaVersion !== 1 || receipt.stageOnly !== true || receipt.runtimeVersion !== NATIVE_REVIEW_VERSION ||
    receipt.identitySource !== 'host-observed-native-cli-session-id' ||
    receipt.boundary !== 'native-no-tools-bare-restricted-explicit-stdin' ||
    receipt.requestedModel !== input.reviewer.model || receipt.observedModel !== input.reviewer.model ||
    ['tools', 'mcpServers', 'skills'].some(key => !Array.isArray(receipt[key]) || receipt[key].length) ||
    receipt.promptSha256 !== input.promptSha256 || receipt.systemPromptSha256 !== sha(NATIVE_REVIEW_SYSTEM_PROMPT) ||
    receipt.requestSerialization !== 'host-declared-system-prompt-model-not-upstream-wire' ||
    receipt.requestBytes !== Buffer.byteLength(request) || receipt.requestBytes > MAX_NATIVE_REVIEW_REQUEST_BYTES || receipt.requestSha256 !== sha(request) ||
    receipt.responseSha256 !== raw.ref.sha256 || receipt.responseBytes !== raw.ref.bytes || receipt.outputSha256 !== sha(parsed.output) ||
    !sameRef(receipt.rawEventArchive, raw.ref) ||
    receipt.osIsolationVerified !== false || receipt.upstreamIdentityVerified !== false ||
    receipt.upstreamCancellationAcknowledged !== false || receipt.signed !== false) refuse();
  const kernel = object(receipt.kernelStage);
  if (kernel.mode !== NATIVE_MAC_STAGE_MODE || kernel.enforcement !== 'sandbox-exec' ||
    kernel.readPolicy !== 'broad-runtime-reads-with-explicit-canonical-private-root-denies' ||
    kernel.universalReadAllowlist !== false || kernel.writableDevice !== '/dev/null' ||
    typeof kernel.privateRoot !== 'string' || !Array.isArray(kernel.readDenyRoots) || !Array.isArray(kernel.protectedRoots) ||
    !Array.isArray(kernel.writableRoots) || kernel.writableRoots.length !== 1 || kernel.writableRoots[0] !== kernel.privateRoot ||
    !sameRef(kernel.profileArchive, profile.ref) || kernel.profileSha256 !== profile.ref.sha256) refuse();
  const privateRoot = canonicalLiteral(kernel.privateRoot, true);
  const denyRoots = kernel.readDenyRoots.map((root: unknown) => typeof root === 'string' ? canonicalLiteral(root, true) : refuse());
  const protectedRoots = kernel.protectedRoots.map((root: unknown) => typeof root === 'string' ? canonicalLiteral(root, true) : refuse());
  if (!protectedRoots.length || new Set(protectedRoots).size !== protectedRoots.length ||
    !['/Users', '/Volumes', '/private/var/folders', '/private/tmp'].every(root => denyRoots.includes(root))) refuse();
  const required = [...input.requiredProtectedRoots, dirname(host.ref.path), dirname(raw.ref.path)]
    .map(root => canonicalLiteral(root));
  for (const root of [...required, ...protectedRoots]) {
    if (isContainedBy(root, privateRoot) || isContainedBy(privateRoot, root) ||
      !denyRoots.some((denied: string) => isContainedBy(denied, root))) refuse();
  }
  // Coverage by a canonical protected ancestor is sufficient; labels are not.
  if (required.some(root => !protectedRoots.some((protectedRoot: string) => isContainedBy(protectedRoot, root)))) refuse();
  if (!profile.bytes.equals(Buffer.from(nativeMacStageProfile(privateRoot, denyRoots)))) refuse();
  return {
    files: [
      { name: 'native-cli-events.jsonl', bytes: raw.bytes, sha256: raw.ref.sha256 },
      { name: 'reviewer-events.json', bytes: host.bytes, sha256: host.ref.sha256 },
      { name: 'review-task.prompt.txt', bytes: seal.bytes, sha256: seal.ref.sha256 },
      { name: 'native-kernel-profile.sb', bytes: profile.bytes, sha256: profile.ref.sha256 },
    ],
    provenance: {
      schemaVersion: 1, qualification: 'host-observed-native-empty-tool-stream-and-macos-private-root-profile',
      sessionId: parsed.sessionId, runtimeVersion: NATIVE_REVIEW_VERSION, model: input.reviewer.model,
      promptSha256: input.promptSha256, systemPromptSha256: receipt.systemPromptSha256,
      requestSha256: receipt.requestSha256, outputSha256: sha(parsed.output),
      upstreamIdentityVerified: false, signed: false, universalReadAllowlist: false,
    },
  };
}

export function retainNativeBlindReviewEvidence(root: string, verified: VerifiedNativeImport,
  envelopeBytes: Buffer, preparedBytes: Buffer): Array<{ kind: 'report'; location: string; sha256: string }> {
  if (!envelopeBytes.length || envelopeBytes.length > MAX_ENVELOPE_BYTES ||
    !preparedBytes.length || preparedBytes.length > MAX_BLIND_IMPORT_BYTES) refuse();
  const expectedNames = ['native-cli-events.jsonl', 'reviewer-events.json', 'review-task.prompt.txt', 'native-kernel-profile.sb'];
  if (verified.files.length !== expectedNames.length || verified.files.some((file, index) =>
    file.name !== expectedNames[index] || !file.bytes.length || sha(file.bytes) !== file.sha256)) refuse();
  const protectedRoot = canonicalLiteral(assertBlindPath(root));
  const metadata = lstatSync(protectedRoot);
  if (!metadata.isDirectory() || hasUnexpectedOwner(metadata) || hasUnexpectedMode(metadata, 0o700)) refuse();
  const directory = canonicalLiteral(mkdtempSync(join(protectedRoot, 'native-evidence-')));
  const artifacts: Array<{ kind: 'report'; location: string; sha256: string }> = [];
  try {
    for (const file of [...verified.files,
      { name: 'import.json', bytes: envelopeBytes },
      { name: 'prepared-assignment.json', bytes: preparedBytes },
      { name: 'verification.json', bytes: Buffer.from(`${JSON.stringify(verified.provenance, null, 2)}\n`) },
    ]) {
      const location = join(directory, file.name);
      const fd = openSync(location, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, file.bytes); fsyncSync(fd); } finally { closeSync(fd); }
      const expected = sha(file.bytes);
      readProtectedNativeReference({ path: location, sha256: expected, bytes: file.bytes.length }, Math.max(file.bytes.length, 1));
      artifacts.push({ kind: 'report', location, sha256: expected });
    }
    for (const path of [directory, protectedRoot]) {
      const directoryFd = openSync(path, constants.O_RDONLY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
    return artifacts;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
