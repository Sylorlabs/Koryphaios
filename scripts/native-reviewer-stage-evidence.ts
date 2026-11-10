import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonicalizePath, isContainedBy } from '../backend/src/runtime/platform';
import {
  archiveNativeStageBytes, nativeArchiveDirectory, readNativeStageReference, type NativeStageFileReference,
} from './native-reviewer-archive';
import {
  MAX_NATIVE_REVIEW_REQUEST_BYTES, MAX_NATIVE_REVIEW_RESPONSE_BYTES, NATIVE_REVIEW_SYSTEM_PROMPT,
  NATIVE_REVIEW_VERSION, parseNativeReviewEvents,
} from './kory-native-stateless-reviewer.ts';
import { nativeMacStageProfile, NATIVE_MAC_STAGE_MODE } from './native-reviewer-sandbox';
import { exactRecord, strictJson } from './reviewer-json';

export interface NativeStageEvidence {
  schemaVersion: 1;
  stageOnly: true;
  rawEvents: NativeStageFileReference;
  hostReceipt: NativeStageFileReference;
  sealedPrompt: NativeStageFileReference;
  kernelProfile: NativeStageFileReference;
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const MAX_HOST_RECEIPT_BYTES = 2_097_152;
const MAX_PROFILE_BYTES = 64_000;
function invalid(): never { throw new Error('Native reviewer stage evidence invalid (details redacted).'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

// A completed wrapper deletes its private HOME. Verify canonical path identity
// via the nearest surviving ancestor without permitting literal symlink aliases.
function canonicalStagePath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\u0000-\u001f]/u.test(value)) invalid();
  let component = parse(value).root;
  for (const part of relative(component, value).split(sep).filter(Boolean)) {
    component = join(component, part);
    if (!existsSync(component)) {
      try { lstatSync(component); invalid(); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const ancestor = dirname(component);
      if (join(canonicalizePath(ancestor), relative(ancestor, value)) !== value) invalid();
      return value;
    }
    if (lstatSync(component).isSymbolicLink()) invalid();
  }
  if (canonicalizePath(value) !== value) invalid();
  return value;
}

export function verifyNativeStageArchives(response: unknown, archiveDirectory: string, prompt: string,
  model: string, projectRoot: string): { rawEvents: NativeStageFileReference; kernelProfile: NativeStageFileReference } {
  const envelope = object(response);
  const receipt = object(envelope.hostReceipt);
  const kernel = object(receipt.kernelStage);
  const privateRoot = canonicalStagePath(kernel.privateRoot);
  nativeArchiveDirectory(archiveDirectory, privateRoot, projectRoot);
  const raw = readNativeStageReference(receipt.rawEventArchive, archiveDirectory, MAX_NATIVE_REVIEW_RESPONSE_BYTES);
  const parsed = parseNativeReviewEvents(raw.data, model);
  const reviewerId = `native-cli:${parsed.sessionId}`;
  const request = JSON.stringify({ system: NATIVE_REVIEW_SYSTEM_PROMPT, prompt, model });
  if (!prompt.trim() || Buffer.byteLength(prompt) > MAX_NATIVE_REVIEW_REQUEST_BYTES ||
    Buffer.byteLength(request) > MAX_NATIVE_REVIEW_REQUEST_BYTES || envelope.schemaVersion !== 1 || envelope.completed !== true ||
    envelope.reviewerId !== reviewerId || envelope.output !== parsed.output ||
    !Array.isArray(envelope.events) || envelope.events.length !== 2) invalid();
  const [start, completion] = envelope.events.map(object);
  if (start.type !== 'review.started' || completion.type !== 'review.completed' ||
    start.reviewerId !== reviewerId || completion.reviewerId !== reviewerId || completion.outputSha256 !== hash(parsed.output) ||
    receipt.schemaVersion !== 1 || receipt.stageOnly !== true || receipt.runtimeVersion !== NATIVE_REVIEW_VERSION ||
    receipt.identitySource !== 'host-observed-native-cli-session-id' ||
    receipt.boundary !== 'native-no-tools-bare-restricted-explicit-stdin' ||
    ['tools', 'mcpServers', 'skills'].some(key => !Array.isArray(receipt[key]) || (receipt[key] as unknown[]).length !== 0) ||
    receipt.requestedModel !== model || receipt.observedModel !== model ||
    receipt.promptSha256 !== hash(prompt) || receipt.systemPromptSha256 !== hash(NATIVE_REVIEW_SYSTEM_PROMPT) ||
    receipt.requestSerialization !== 'host-declared-system-prompt-model-not-upstream-wire' ||
    receipt.requestBytes !== Buffer.byteLength(request) || receipt.requestSha256 !== hash(request) ||
    receipt.responseSha256 !== raw.reference.sha256 || receipt.responseBytes !== raw.reference.bytes ||
    receipt.outputSha256 !== hash(parsed.output) || receipt.osIsolationVerified !== false || receipt.signed !== false ||
    receipt.upstreamIdentityVerified !== false || receipt.upstreamCancellationAcknowledged !== false) invalid();
  if (kernel.mode !== NATIVE_MAC_STAGE_MODE || kernel.enforcement !== 'sandbox-exec' ||
    kernel.readPolicy !== 'broad-runtime-reads-with-explicit-canonical-private-root-denies' ||
    kernel.universalReadAllowlist !== false || kernel.writableDevice !== '/dev/null' ||
    !Array.isArray(kernel.writableRoots) || kernel.writableRoots.length !== 1 || kernel.writableRoots[0] !== privateRoot ||
    !Array.isArray(kernel.readDenyRoots) || !Array.isArray(kernel.protectedRoots)) invalid();
  const denies = kernel.readDenyRoots.map(canonicalStagePath);
  const protectedRoots = kernel.protectedRoots.map(canonicalStagePath);
  if (!protectedRoots.length || new Set(protectedRoots).size !== protectedRoots.length ||
    !['/Users', '/Volumes', '/private/var/folders', '/private/tmp'].every(root => denies.includes(root))) invalid();
  const required = [canonicalStagePath(projectRoot), canonicalStagePath(archiveDirectory)];
  for (const root of [...protectedRoots, ...required]) {
    if (isContainedBy(root, privateRoot) || isContainedBy(privateRoot, root) ||
      !denies.some(denied => isContainedBy(denied, root))) invalid();
  }
  if (required.some(root => !protectedRoots.some(protectedRoot => isContainedBy(protectedRoot, root)))) invalid();
  const profile = readNativeStageReference(kernel.profileArchive, archiveDirectory, MAX_PROFILE_BYTES);
  if (raw.reference.path === profile.reference.path ||
    !profile.data.equals(Buffer.from(nativeMacStageProfile(privateRoot, denies))) || kernel.profileSha256 !== profile.reference.sha256) invalid();
  return { rawEvents: raw.reference, kernelProfile: profile.reference };
}

export function archiveNativeStageEvidence(response: unknown, archiveDirectory: string, prompt: string,
  model: string, projectRoot: string): NativeStageEvidence {
  const verified = verifyNativeStageArchives(response, archiveDirectory, prompt, model, projectRoot);
  const sealedPrompt = archiveNativeStageBytes(archiveDirectory, 'review-task.prompt.txt', Buffer.from(prompt), MAX_NATIVE_REVIEW_REQUEST_BYTES);
  // The importer intentionally binds the full completion envelope, not just an
  // unsigned receipt detached from the observed session/output/event pair.
  const hostReceipt = archiveNativeStageBytes(archiveDirectory, 'reviewer-events.json',
    Buffer.from(`${JSON.stringify(response)}\n`), MAX_HOST_RECEIPT_BYTES);
  const stage: NativeStageEvidence = { schemaVersion: 1, stageOnly: true, ...verified, hostReceipt, sealedPrompt };
  verifyNativeStageEvidence(stage, archiveDirectory, prompt, model, projectRoot, object(response).output, object(response).reviewerId);
  return stage;
}

export function verifyNativeStageEvidence(value: unknown, archiveDirectory: string, prompt: string,
  model: string, projectRoot: string, output: unknown, reviewerId: unknown): void {
  const stage = exactRecord(value, ['schemaVersion', 'stageOnly', 'rawEvents', 'hostReceipt', 'sealedPrompt', 'kernelProfile']);
  if (stage.schemaVersion !== 1 || stage.stageOnly !== true) invalid();
  const host = readNativeStageReference(stage.hostReceipt, archiveDirectory, MAX_HOST_RECEIPT_BYTES);
  const seal = readNativeStageReference(stage.sealedPrompt, archiveDirectory, MAX_NATIVE_REVIEW_REQUEST_BYTES);
  const sealed = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(seal.data);
  if (sealed !== prompt) invalid();
  const completion = object(strictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(host.data)));
  const verified = verifyNativeStageArchives(completion, archiveDirectory, sealed, model, projectRoot);
  if (completion.output !== output || completion.reviewerId !== reviewerId) invalid();
  for (const key of ['rawEvents', 'kernelProfile'] as const) {
    const reference = exactRecord(stage[key], ['path', 'sha256', 'bytes']);
    if (reference.path !== verified[key].path || reference.sha256 !== verified[key].sha256 || reference.bytes !== verified[key].bytes) invalid();
  }
  if (new Set([host.reference.path, seal.reference.path, verified.rawEvents.path, verified.kernelProfile.path]).size !== 4) invalid();
}
