/**
 * Stage-only blind reviewer transport that runs inside Koryphaios' own CLI.
 *
 * The gateway reviewer needs an API key in the environment and the source
 * inspected CLI reviewers need vendor logins, so both refuse a sealed assignment
 * when the operator's credentials live only in the running backend. The kory CLI
 * already reaches that backend, which resolves the provider credential itself, so
 * this adapter sends the sealed packet through the product instead of around it.
 *
 * Statelessness is the point: the turn runs in a disposable directory with a
 * single user message, no repository context, no attachments, and the answer is
 * the only thing read back. The envelope records the host invocation identity, not
 * an upstream session id, and claims no OS isolation or upstream identity.
 *
 *   bun scripts/kory-cli-stateless-reviewer.ts < review-task.prompt.txt
 *
 * Environment:
 *   KORYPHAIOS_PORT                 backend port (default 3001)
 *   KORY_KORY_CLI_REVIEW_MODEL      provider/model for the review
 *   KORY_KORY_CLI_REVIEW_TIMEOUT_S  per attempt wall clock (default 900)
 *   KORY_KORY_CLI_REVIEW_ATTEMPTS   attempts for a malformed answer (default 3)
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeDuplicateKeys, strictJson, validateAdjudication } from './reviewer-json';

const DEFAULT_MODEL = 'logfare/deepseek-v4.1-flash-1017';
const REVIEWER_NAME = 'kory-cli-stateless';
const MAX_PROMPT_BYTES = 512_000;
const MAX_RESPONSE_BYTES = 4_194_304;

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const processStart = Date.now();
let stage = 'startup';

const trace = (message: string): void => {
  if (process.env.KORY_KORY_CLI_REVIEW_DEBUG === '1') {
    process.stderr.write(`stage=${stage} ${message}\n`);
  }
};

function fail(message: string): never {
  throw new Error(message);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_PROMPT_BYTES) fail('Reviewer prompt exceeds the byte limit.');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) fail('Reviewer prompt is empty.');
  return text;
}

type CliRun = {
  ok?: boolean;
  status?: string;
  text?: string;
  error?: string;
  sessionId?: string;
  seconds?: number;
};

function runKoryCli(
  cwd: string,
  promptPath: string,
  model: string,
  timeoutSeconds: number,
): Promise<{ result: CliRun; raw: string }> {
  const cli = resolve(import.meta.dir, 'kory-cli.ts');
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [
        'run',
        cli,
        'run',
        '--cwd',
        cwd,
        '--prompt-file',
        promptPath,
        '--model',
        model,
        '--reasoning',
        'high',
        '--timeout',
        String(timeoutSeconds),
        '--quiet',
        '--json',
      ],
      {
        cwd,
        env: { ...process.env, KORYPHAIOS_PORT: process.env.KORYPHAIOS_PORT ?? '3001' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const out: Buffer[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    let stopped = false;
    const stop = (message: string) => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGKILL');
      rejectRun(new Error(message));
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) stop('Reviewer response exceeds the byte limit.');
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64_000) stop('Reviewer diagnostics exceed the byte limit.');
    });
    child.on('error', () => stop('Reviewer process failed to start.'));
    child.on('close', () => {
      if (stopped) return;
      const raw = Buffer.concat(out).toString('utf8');
      const start = raw.indexOf('{');
      if (start < 0) {
        rejectRun(new Error('Reviewer CLI emitted no result document.'));
        return;
      }
      let parsed: CliRun;
      try {
        parsed = JSON.parse(raw.slice(start)) as CliRun;
      } catch {
        rejectRun(new Error('Reviewer CLI result document is not valid JSON.'));
        return;
      }
      resolveRun({ result: parsed, raw });
    });
  });
}

function stripWrappingFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const withoutOpen = trimmed.replace(/^```[A-Za-z0-9_-]*\s*\n?/u, '');
  return withoutOpen.replace(/\n?```\s*$/u, '').trim();
}

async function main(): Promise<void> {
  stage = 'read-prompt';
  const prompt = await readStdin();
  const model = process.env.KORY_KORY_CLI_REVIEW_MODEL?.trim() || DEFAULT_MODEL;
  const timeoutSeconds = Number(process.env.KORY_KORY_CLI_REVIEW_TIMEOUT_S ?? '') || 900;
  const attempts = Number(process.env.KORY_KORY_CLI_REVIEW_ATTEMPTS ?? '') || 3;
  const reviewerId = `${REVIEWER_NAME}-${randomUUID()}`;

  const workspace = mkdtempSync(join(tmpdir(), 'kory-review-turn-'));
  const promptPath = join(workspace, 'review-task.txt');
  writeFileSync(promptPath, prompt, { mode: 0o600 });

  let output = '';
  let raw = '';
  let sessionId: string | undefined;
  let lastError: Error | null = null;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      stage = 'review-turn';
      let run: { result: CliRun; raw: string };
      try {
        run = await runKoryCli(workspace, promptPath, model, timeoutSeconds);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Reviewer turn failed.');
        trace(`attempt=${String(attempt)} ${lastError.message}`);
        continue;
      }
      raw = run.raw;
      sessionId = run.result.sessionId;
      const text = (run.result.text ?? '').trim();
      if (!run.result.ok || !text) {
        // A provider refusal is a reviewer failure, never an empty adjudication.
        lastError = new Error('Reviewer turn produced no answer.');
        trace(`attempt=${String(attempt)} ${run.result.error ?? run.result.status ?? 'empty'}`);
        continue;
      }
      stage = 'parse-adjudication';
      const candidate = stripWrappingFence(text);
      try {
        const normalized = normalizeDuplicateKeys(candidate);
        strictJson(normalized);
        validateAdjudication(normalized);
        output = normalized;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Invalid reviewer JSON.');
        trace(`attempt=${String(attempt)} outputChars=${candidate.length} ${lastError.message}`);
      }
    }
    if (!output) throw lastError ?? new Error('Reviewer produced no adjudication.');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
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
          upstreamSessionObserved: Boolean(sessionId),
          requestedModel: model,
          responseModel: null,
          promptSha256: hash(prompt),
          requestBytes: Buffer.byteLength(prompt, 'utf8'),
          responseSha256: hash(raw),
          outputSha256: hash(output),
          elapsedMs: Date.now() - processStart,
          osIsolationVerified: false,
          upstreamIdentityVerified: false,
          signed: false,
        },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  if (process.env.KORY_KORY_CLI_REVIEW_DEBUG === '1') {
    process.stderr.write(
      `stage=${stage} failure=${error instanceof Error ? error.message : 'unknown'}\n`,
    );
  }
  process.stderr.write(
    `${REVIEWER_NAME}: failed; diagnostics redacted. No completed review emitted.\n`,
  );
  process.exitCode = 1;
});
