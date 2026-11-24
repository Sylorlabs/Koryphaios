#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { exactRecord, strictJson, validateAdjudication } from './reviewer-json';
import {
  canonicalizePath,
  findExecutableOnPath,
  isContainedBy,
  looksLikePath,
  providerProcessGroupOptions,
  terminateProviderProcessGroup,
} from '../backend/src/runtime/platform';

// Stage-only engineering adapter. The source-inspected 2.0.32 operation builds
// an empty system, one user message and tools:[] without session/context dispatch.
// This API boundary is not OS isolation, upstream identity or promotion credit.
const VERSION = '2.0.32';
// A sealed assignment carries both candidate artifacts, so a packet is routinely
// larger than 100 KB. The 24 000 byte bound refused those requests outright, which
// made every full task un-reviewable on this adapter and looked like a reviewer
// failure. Keep a bound (one request, still bounded) but size it to the packets the
// harness actually seals rather than to the text-patch executor's own cap.
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 64_000;
const DRAIN_MS = 500;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function invalid(): never {
  throw new Error('Invalid stateless reviewer response (details redacted).');
}

async function readPrompt(deadline: number): Promise<string> {
  return new Promise((resolvePrompt, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(
      () => {
        process.stdin.destroy();
        reject(new Error('Stateless reviewer stdin exceeded the wall-clock budget.'));
      },
      Math.max(1, deadline - performance.now()),
    );
    process.stdin.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        clearTimeout(timer);
        process.stdin.destroy();
        reject(new Error('Stateless reviewer request exceeds the byte limit; no dispatch.'));
      } else chunks.push(chunk);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Stateless reviewer stdin failed (details redacted).'));
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try {
        const prompt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.concat(chunks),
        );
        if (!prompt.trim())
          throw new Error('Stateless reviewer requires a nonempty sealed prompt.');
        resolvePrompt(prompt);
      } catch {
        reject(new Error('Stateless reviewer requires valid nonempty UTF-8 stdin.'));
      }
    });
  });
}

function run(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  limit: number,
): Promise<Buffer> {
  if (timeoutMs <= 0)
    throw new Error('Stateless reviewer exceeded the wall-clock budget before dispatch.');
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...providerProcessGroupOptions(),
      shell: false,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    let problem: string | undefined;
    let settled = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      terminateProviderProcessGroup(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (problem || code !== 0)
        reject(new Error(problem ?? 'Stateless reviewer process failed (details redacted).'));
      else resolveRun(Buffer.concat(chunks));
    };
    const stop = (message: string) => {
      problem ??= message;
      if (drain) return;
      drain = setTimeout(() => finish(null), DRAIN_MS);
      terminateProviderProcessGroup(child.pid);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () =>
        stop(
          'Stateless reviewer exceeded the wall-clock budget; local cleanup does not certify upstream cancellation.',
        ),
      timeoutMs,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit)
        stop('Stateless reviewer response exceeds the byte limit (details redacted).');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Drain without retaining credential-bearing provider diagnostics.
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES)
        stop('Stateless reviewer diagnostics exceed the byte limit (details redacted).');
    });
    child.on('error', () => stop('Stateless reviewer process failed (details redacted).'));
    child.on('close', finish);
  });
}

async function main(): Promise<void> {
  const budget = Number(process.env.KORY_OPENCODE_REVIEW_TIMEOUT_MS ?? 300_000);
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 550_000)
    throw new Error('Invalid stateless reviewer wall-clock budget.');
  const deadline = performance.now() + budget;
  const prompt = await readPrompt(deadline);
  // argv is ignored. Only the exact stdin string reaches the model; no suffix,
  // workspace snapshot, assignment path, inherited conversation or session id.
  const model = process.env.KORY_OPENCODE_REVIEW_MODEL?.trim();
  if (
    !model ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(model) ||
    model.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Stateless reviewer requires an explicit provider/model identifier.');
  }
  const slash = model.indexOf('/');
  const request = JSON.stringify({
    prompt,
    model: { providerID: model.slice(0, slash), id: model.slice(slash + 1) },
  });
  if (Buffer.byteLength(request) > MAX_REQUEST_BYTES)
    throw new Error('Stateless reviewer request exceeds the byte limit; no dispatch.');
  const configured = process.env.KORY_OPENCODE_REVIEW_BINARY?.trim() || 'opencode';
  const candidate = looksLikePath(configured)
    ? resolve(configured)
    : findExecutableOnPath(configured);
  if (!candidate || !statSync(candidate).isFile())
    throw new Error('Stateless reviewer executable unavailable (details redacted).');
  accessSync(candidate, constants.X_OK);
  const binary = canonicalizePath(candidate);
  const parent = canonicalizePath(tmpdir());
  for (const root of [process.cwd(), resolve(import.meta.dir, '..')]) {
    if (isContainedBy(canonicalizePath(root), parent))
      throw new Error(
        'Stateless reviewer disposable cwd would inherit assignment/repository context.',
      );
  }
  const cwd = mkdtempSync(join(parent, 'kory-stateless-reviewer-'));
  try {
    const version = new TextDecoder('utf-8', { fatal: true })
      .decode(
        await run(binary, ['--version'], cwd, Math.min(5_000, deadline - performance.now()), 8_192),
      )
      .trim();
    if (![VERSION, `v${VERSION}`, `opencode v${VERSION}`].includes(version))
      throw new Error(`Stateless reviewer requires source-inspected CLI v${VERSION}.`);
    const response = await run(
      binary,
      ['api', 'experimental.generate.text', '--data', request],
      cwd,
      deadline - performance.now(),
      MAX_RESPONSE_BYTES,
    );
    const responseObject = exactRecord(
      strictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(response)),
      ['data'],
    );
    const data = exactRecord(responseObject.data, ['text']);
    if (typeof data.text !== 'string' || !data.text.trim()) invalid();
    const output = data.text;
    validateAdjudication(output);
    // Host invocation identity, not an invented OpenCode/upstream session id.
    const reviewerId = `opencode-stateless-host:${randomUUID()}`;
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        reviewerId,
        completed: true,
        output,
        events: [
          { type: 'review.started', reviewerId },
          { type: 'review.completed', reviewerId, outputSha256: hash(output) },
        ],
        hostReceipt: {
          schemaVersion: 1,
          stageOnly: true,
          identitySource: 'host-invocation-uuid',
          upstreamSessionObserved: false,
          requestedModel: model,
          runtimeVersion: VERSION,
          operation: 'experimental.generate.text',
          boundary: 'source-inspected-no-local-model-tool-dispatch',
          promptSha256: hash(prompt),
          requestSha256: hash(request),
          requestBytes: Buffer.byteLength(request),
          responseSha256: hash(response),
          responseBytes: response.length,
          outputSha256: hash(output),
          osIsolationVerified: false,
          upstreamIdentityVerified: false,
          upstreamCancellationAcknowledged: false,
          signed: false,
        },
      })}\n`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch(() => {
  // Input, filesystem errors and model payloads may all contain private data.
  process.stderr.write(
    'kory-opencode-stateless-reviewer: failed; diagnostics redacted. No completed review emitted.\n',
  );
  process.exitCode = 1;
});
