import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalizePath, isContainedBy, isUnix } from '../backend/src/runtime/platform';

const adapter = resolve(import.meta.dir, 'kory-opencode-stateless-reviewer');
const roots: string[] = [];
const model = 'test-provider/named/model:free';
const prompt = 'Sealed anonymous artifacts A/B. Literal $(touch escaped) "quote"\n新\n';
const score = {
  passed: true,
  quality: 0.9,
  verification: 0.8,
  integrityFailure: false,
  evidence: ['sealed evidence only'],
};
const output = `\n${JSON.stringify({ artifactA: score, artifactB: { ...score, passed: false }, preference: 'A', rationale: ['A is stronger'] }, null, 2)}\n`;
const response = JSON.stringify({ data: { text: output } });
const secret = 'private-provider-api-key-and-diagnostic';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

interface Options {
  version?: string;
  versionCode?: number;
  versionDelay?: number;
  stdout?: string;
  stderr?: string;
  code?: number;
  mode?: string;
  prompt?: string | Buffer;
  model?: string | null;
  timeout?: number;
  binary?: 'missing' | 'non-executable';
}

function run(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kory-stateless-review-test-'));
  roots.push(root);
  const binary = join(root, 'opencode');
  const callsPath = join(root, 'calls.jsonl');
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const settings = ${JSON.stringify(options)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({args, cwd: process.cwd(), files: fs.readdirSync('.'), home: process.env.HOME}) + '\\n');
if (args[0] === '--version') {
  setTimeout(() => { process.stdout.write(settings.version ?? 'opencode v2.0.32\\n'); process.exit(settings.versionCode ?? 0); }, settings.versionDelay ?? 0);
} else {
  if (args.length !== 4 || args[0] !== 'api' || args[1] !== 'experimental.generate.text' || args[2] !== '--data') process.exit(98);
  if (settings.mode === 'timeout') setInterval(() => {}, 1000);
  else {
    if (settings.mode === 'invalid-utf8') process.stdout.write(Buffer.from([0xff]));
    else process.stdout.write(settings.mode === 'stdout-overflow' ? 'x'.repeat(1_100_000) : (settings.stdout ?? ${JSON.stringify(response)}));
    process.stderr.write(settings.mode === 'stderr-overflow' ? 'x'.repeat(70_000) : (settings.stderr ?? ''));
    process.exit(settings.code ?? 0);
  }
}
`,
    { mode: options.binary === 'non-executable' ? 0o600 : 0o700 },
  );
  // Credential-free stub-only PATH. No real OpenCode inference occurs here.
  const env: Record<string, string> = {
    PATH: root,
    HOME: root,
    KORY_OPENCODE_REVIEW_BINARY: options.binary === 'missing' ? join(root, 'absent') : binary,
    KORY_OPENCODE_REVIEW_TIMEOUT_MS: String(options.timeout ?? 2000),
  };
  if (options.model !== null) env.KORY_OPENCODE_REVIEW_MODEL = options.model ?? model;
  const result = spawnSync(process.execPath, [adapter, '-p', 'IGNORED_ARGV_INSTRUCTION'], {
    cwd: root,
    env,
    input: options.prompt ?? prompt,
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const calls = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8')
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as { args: string[]; cwd: string; files: string[]; home: string },
        )
    : [];
  return { ...result, root, calls };
}

function failed(result: ReturnType<typeof run>, dispatches?: number) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('diagnostics redacted');
  expect(result.stderr).not.toContain(secret);
  if (dispatches !== undefined)
    expect(result.calls.filter((call) => call.args[0] === 'api')).toHaveLength(dispatches);
  for (const call of result.calls) expect(existsSync(call.cwd)).toBe(false);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!isUnix())('stateless stage-only reviewer adapter (fake CLI only)', () => {
  test('sends exact sealed stdin only, preserves output bytes, and labels unsigned host identity', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]!.args).toEqual(['--version']);
    const call = result.calls[1]!;
    expect(call.args.slice(0, 3)).toEqual(['api', 'experimental.generate.text', '--data']);
    const request = JSON.parse(call.args[3]!);
    expect(request).toEqual({
      prompt,
      model: { providerID: 'test-provider', id: 'named/model:free' },
    });
    expect(call.args[3]).not.toContain('IGNORED_ARGV_INSTRUCTION');
    expect(call.args[3]).not.toContain(result.root);
    for (const invocation of result.calls) {
      expect(invocation.files).toEqual([]);
      expect(invocation.home).toBe(result.root);
      expect(isContainedBy(canonicalizePath(result.root), invocation.cwd)).toBe(false);
      expect(isContainedBy(canonicalizePath(process.cwd()), invocation.cwd)).toBe(false);
      expect(existsSync(invocation.cwd)).toBe(false);
    }
    const envelope = JSON.parse(result.stdout);
    expect(envelope.reviewerId).toMatch(/^opencode-stateless-host:[0-9a-f-]{36}$/u);
    expect(envelope.completed).toBe(true);
    expect(envelope.output).toBe(output);
    expect(envelope.events).toEqual([
      { type: 'review.started', reviewerId: envelope.reviewerId },
      { type: 'review.completed', reviewerId: envelope.reviewerId, outputSha256: sha256(output) },
    ]);
    expect(envelope.hostReceipt).toEqual({
      schemaVersion: 1,
      stageOnly: true,
      identitySource: 'host-invocation-uuid',
      upstreamSessionObserved: false,
      requestedModel: model,
      runtimeVersion: '2.0.32',
      operation: 'experimental.generate.text',
      boundary: 'source-inspected-no-local-model-tool-dispatch',
      promptSha256: sha256(prompt),
      requestSha256: sha256(call.args[3]!),
      requestBytes: Buffer.byteLength(call.args[3]!),
      responseSha256: sha256(response),
      responseBytes: Buffer.byteLength(response),
      outputSha256: sha256(output),
      osIsolationVerified: false,
      upstreamIdentityVerified: false,
      upstreamCancellationAcknowledged: false,
      signed: false,
    });
  });

  test('each completion uses a distinct host invocation id, never a fabricated upstream session', () => {
    const first = JSON.parse(run().stdout);
    const second = JSON.parse(run().stdout);
    expect(first.reviewerId).not.toBe(second.reviewerId);
    expect(first.reviewerId).not.toContain('ses-');
  });

  for (const options of [
    { prompt: '' },
    { prompt: Buffer.from([0xff]) },
    { prompt: 'x'.repeat(24_001) },
    { prompt: '\\'.repeat(13_000) },
    { model: null },
    { model: 'provider/../model' },
    { model: 'provider//model' },
    { timeout: 0 },
    { timeout: 550_001 },
    { binary: 'missing' as const },
    { binary: 'non-executable' as const },
  ]) {
    test(`fails before generation dispatch on invalid input/config ${JSON.stringify(options).slice(0, 80)}`, () =>
      failed(run(options), 0));
  }

  for (const options of [
    { version: '2.0.33' },
    { version: '2.0.32\nextra' },
    { versionCode: 1 },
    { versionDelay: 1000, timeout: 100 },
  ]) {
    test(`version preflight fails closed ${JSON.stringify(options)}`, () =>
      failed(run(options), 0));
  }

  for (const stdout of [
    '{"data":{"text":"x"},"error":"hidden"}',
    '{"data":{"text":"x"},"data":{"text":"overwritten"}}',
    '{"data":{"text":"x","tool":"hidden"}}',
    '{"data":{"text":"x","text":"overwritten"}}',
    '[]',
    `${response}\n${response}`,
    JSON.stringify({ data: { text: `\`\`\`json\n${output}\n\`\`\`` } }),
    JSON.stringify({
      data: {
        text: JSON.stringify({
          artifactA: { ...score, quality: 1.1 },
          artifactB: score,
          preference: 'A',
          rationale: [],
        }),
      },
    }),
    JSON.stringify({
      data: {
        text: JSON.stringify({
          artifactA: score,
          artifactB: score,
          preference: 'A',
          rationale: [],
          tool: {},
        }),
      },
    }),
    JSON.stringify({
      data: { text: output.replace('"passed": true', '"passed": false,"passed": true') },
    }),
    JSON.stringify({
      data: {
        text: output
          .replace('"artifactA"', '"\\u0061rtifactA"')
          .replace('"artifactB"', `"artifactA":{},"artifactB"`),
      },
    }),
    JSON.stringify({ data: { text: output.replace('0.9', '1e999') } }),
    JSON.stringify({ data: { text: ' '.repeat(100) } }),
  ]) {
    test(`rejects non-exact or contradictory response ${sha256(stdout).slice(0, 8)}`, () =>
      failed(run({ stdout }), 1));
  }

  for (const options of [
    { code: 1, stdout: secret, stderr: secret },
    { mode: 'invalid-utf8' },
    { mode: 'stdout-overflow' },
    { mode: 'stderr-overflow' },
    { mode: 'timeout', timeout: 100 },
  ]) {
    test(`process failures emit no completion and clean disposable cwd ${JSON.stringify(options)}`, () =>
      failed(run(options), 1));
  }
});
