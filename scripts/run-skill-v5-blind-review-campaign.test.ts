import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { canonicalizePath, isContainedBy } from '../backend/src/runtime/platform';
import { NATIVE_REVIEW_SYSTEM_PROMPT } from './kory-native-stateless-reviewer.ts';

const runnerPath = resolve(import.meta.dir, 'run-skill-v5-blind-review-campaign.ts');
const testRoots: string[] = [];

// Every external command is replaced with an isolated fake. Tests cannot run
// a live review, write an evaluation ledger, or touch the browser launcher.
const fakeProgram = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.V5_TEST_CALL_LOG, JSON.stringify({ name, args, cwd: process.cwd(),
  archiveDirectory: process.env.KORY_NATIVE_REVIEW_ARCHIVE_DIR,
  nativeModel: process.env.KORY_NATIVE_REVIEW_MODEL,
  nativeSandbox: process.env.KORY_NATIVE_REVIEW_STAGE_SANDBOX,
}) + '\n');

if (name === 'bun') {
  if (args.includes('--prepare-only') || args.includes('--dry-run')) {
    const preparedAssignments = [];
    const eligible = [];
    for (let id = 1; id <= Number(process.env.V5_TEST_ASSIGNMENTS || '1'); id++) {
      const assignmentId = 'assignment-' + id;
      const promptPath = id === 1 ? process.env.V5_TEST_PROMPT :
        path.join(path.dirname(process.env.V5_TEST_PROMPT), 'prompt-' + id + '.txt');
      if (id !== 1 && !args.includes('--dry-run')) {
        fs.writeFileSync(promptPath, 'second anonymous reviewer fixture');
      }
      eligible.push({ skill: 'test-skill', scenarioId: 'scenario-' + id, pairId: 'pair-' + id });
      if (args.includes('--dry-run')) continue;
      const promptSha256 = process.env.V5_TEST_BAD_PROMPT_SHA === '1' ? '0'.repeat(64) :
        crypto.createHash('sha256').update(fs.readFileSync(promptPath)).digest('hex');
      const item = {
        assignmentId, skill: 'test-skill', scenarioId: 'scenario-' + id,
        pairId: 'pair-' + id, promptPath, promptSha256,
      };
      fs.writeFileSync(path.join(path.dirname(promptPath), assignmentId + '.private.json'), JSON.stringify({
        schemaVersion: 3, ...item,
        artifactASha256: 'a'.repeat(64), artifactBSha256: 'b'.repeat(64),
      }));
      preparedAssignments.push(item);
    }
    console.log(JSON.stringify({
      preparedAssignments, eligible, skippedExistingReviews: 0, queuedPairs: eligible.length,
    }));
  } else if (args.some((arg) => arg.startsWith('--validate-only='))) {
    const file = args.find((arg) => arg.startsWith('--validate-only=')).slice('--validate-only='.length);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (process.env.V5_TEST_MUTATE_ARCHIVE && envelope.nativeStageEvidence) {
      fs.appendFileSync(envelope.nativeStageEvidence[process.env.V5_TEST_MUTATE_ARCHIVE].path, 'changed');
    }
    if (process.env.V5_TEST_VALIDATE === 'reject' || envelope.reviews.length !== 1) {
      console.error('mock importer rejected contradictory source evidence');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({
        mode: process.env.V5_TEST_VALIDATE === 'wrong-summary' ? 'ingest' : 'validate',
        validatedReviews: 1,
        persistedReviews: 0,
      }));
    }
  } else if (args.some((arg) => arg.startsWith('--ingest='))) {
    const file = args.find((arg) => arg.startsWith('--ingest=')).slice('--ingest='.length);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(process.env.V5_TEST_INGEST_LOG, JSON.stringify(envelope));
    console.log(JSON.stringify({ persistedReviews: 1 }));
  } else {
    console.error('unexpected bun invocation', args);
    process.exitCode = 2;
  }
} else if (name === 'reviewer-control') {
  if (args.join(' ') === 'route status') {
    if (process.env.V5_TEST_ROUTE === 'unavailable') {
      console.error('route unavailable');
      process.exitCode = 1;
    } else if (process.env.V5_TEST_ROUTE === 'invalid-json') {
      console.log('unparseable');
    } else {
      console.log(JSON.stringify({
        installed: true,
        active: process.env.V5_TEST_ROUTE !== 'inactive',
        routeUrl: process.env.V5_TEST_ROUTE === 'mismatch' ?
          'http://127.0.0.1:19999/v1' : 'http://127.0.0.1:17841/v1',
        errors: [],
      }));
    }
  } else if (args.join(' ') !== 'browser check') {
    console.error('unexpected control invocation', args);
    process.exitCode = 2;
  } else if (process.env.V5_TEST_BROWSER === 'busy') {
    console.error('ChatGPT browser is running Codex turn a1b2c3');
    process.exitCode = 1;
  } else if (process.env.V5_TEST_BROWSER === 'unavailable') {
    console.error('ChatGPT browser unavailable');
    process.exitCode = 1;
  } else {
    console.log('ChatGPT browser ready');
  }
} else if (name === 'kory-native-stateless-reviewer') {
  const history = fs.readFileSync(process.env.V5_TEST_CALL_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  if (process.env.V5_TEST_NATIVE === 'exit-error' ||
    (process.env.V5_TEST_NATIVE === 'retry' && history.filter(call => call.name === name).length === 1)) {
    console.log('OPAQUE_NOT_OUTPUT_PROVIDER_SECRET');
    console.error('PRIVATE_NATIVE_DIAGNOSTIC');
    process.exit(1);
  }
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    const prompt = Buffer.concat(chunks).toString('utf8');
    const model = process.env.KORY_NATIVE_REVIEW_MODEL;
    const archive = process.env.KORY_NATIVE_REVIEW_ARCHIVE_DIR;
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const output = JSON.stringify({
      artifactA: { passed: true, quality: 0.9, verification: 0.8, integrityFailure: false, evidence: ['A'] },
      artifactB: { passed: false, quality: 0.2, verification: 0.2, integrityFailure: false, evidence: ['B'] },
      preference: 'A', rationale: ['A is better'],
    }) + '\n';
    const session = 'native-fixture-session';
    const reviewerId = 'native-cli:' + session;
    const events = [
      { type: 'system', subtype: 'init', session_id: session, model, tools: [], mcp_servers: [], skills: [] },
      { type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'OPAQUE_NOT_OUTPUT_PROVIDER_SECRET' }] } },
      { type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'text', text: output }], stop_reason: 'end_turn' } },
      { type: 'result', session_id: session, subtype: 'success', is_error: false, result: output },
    ];
    if (process.env.V5_TEST_NATIVE === 'tools') events[0].tools.push('Read');
    if (process.env.V5_TEST_NATIVE === 'wrong-model') events[0].model = 'other-model';
    const raw = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
    const privateRoot = path.join(fs.realpathSync(process.env.TMPDIR), 'deleted-native-model-home');
    const projectRoot = fs.realpathSync(process.env.V5_TEST_PROJECT_ROOT);
    const denyRoots = [...new Set(['/Users', '/Volumes', '/private/var/folders', '/private/tmp', process.cwd(), projectRoot])];
    const profile = Buffer.from([
      '(version 1)', '(deny default)', '(allow process*)', '(allow mach*)', '(allow iokit*)',
      '(allow signal)', '(allow sysctl-read)', '(allow file-read*)', '(allow file-ioctl)',
      '(allow ipc-posix-sem*)', '(allow ipc-posix-shm*)', '(allow network*)',
      '(allow file-write-data (literal "/dev/null"))',
      '(allow file-write* (subpath ' + JSON.stringify(privateRoot) + '))',
      ...denyRoots.map(root => '(deny file-read* (require-all (subpath ' + JSON.stringify(root) + ') (require-not (subpath ' + JSON.stringify(privateRoot) + '))))'),
    ].join('\n'));
    const save = (name, bytes) => {
      const file = path.join(archive, name);
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      return { path: file, bytes: bytes.length, sha256: hash(bytes) };
    };
    const rawEventArchive = save('native-cli-events.jsonl', raw);
    const profileArchive = save('native-kernel-profile.sb', profile);
    const system = process.env.V5_TEST_NATIVE_SYSTEM;
    const request = JSON.stringify({ system, prompt, model });
    const response = {
      schemaVersion: 1, reviewerId, completed: true, output,
      events: [{ type: 'review.started', reviewerId }, { type: 'review.completed', reviewerId, outputSha256: hash(output) }],
      hostReceipt: {
        schemaVersion: 1, stageOnly: true, runtimeVersion: '2.1.309', identitySource: 'host-observed-native-cli-session-id',
        boundary: 'native-no-tools-bare-restricted-explicit-stdin', requestedModel: model, observedModel: model,
        tools: [], mcpServers: [], skills: [], promptSha256: hash(prompt), systemPromptSha256: hash(system),
        requestSerialization: 'host-declared-system-prompt-model-not-upstream-wire', requestBytes: Buffer.byteLength(request), requestSha256: hash(request),
        responseSha256: hash(raw), responseBytes: raw.length, rawEventArchive, outputSha256: hash(output),
        osIsolationVerified: false, signed: false, upstreamIdentityVerified: false, upstreamCancellationAcknowledged: false,
        kernelStage: {
          mode: 'macos-private-roots', enforcement: 'sandbox-exec', privateRoot, readDenyRoots: denyRoots,
          protectedRoots: [projectRoot, process.cwd(), archive], profileArchive, profileSha256: hash(profile),
          writableRoots: [privateRoot], writableDevice: '/dev/null', universalReadAllowlist: false,
          readPolicy: 'broad-runtime-reads-with-explicit-canonical-private-root-denies',
        },
      },
    };
    if (process.env.V5_TEST_NATIVE === 'missing-raw') delete response.hostReceipt.rawEventArchive;
    if (process.env.V5_TEST_NATIVE === 'wrong-request') response.hostReceipt.requestSha256 = '0'.repeat(64);
    if (process.env.V5_TEST_NATIVE === 'normalize-output') response.output = output.trimEnd();
    if (process.env.V5_TEST_NATIVE === 'wrong-profile') {
      const bytes = Buffer.from('(version 1)\n(allow default)');
      fs.writeFileSync(profileArchive.path, bytes);
      response.hostReceipt.kernelStage.profileArchive = { path: profileArchive.path, sha256: hash(bytes), bytes: bytes.length };
      response.hostReceipt.kernelStage.profileSha256 = hash(bytes);
    }
    console.log(JSON.stringify(response));
  });
} else if (name === 'generic-reviewer') {
  const output = JSON.stringify({
    artifactA: { passed: true, quality: 0.9, verification: 0.8, integrityFailure: false, evidence: ['A'] },
    artifactB: { passed: false, quality: 0.2, verification: 0.2, integrityFailure: false, evidence: ['B'] },
    preference: 'A', rationale: ['A is better'],
  });
  const response = {
    schemaVersion: 1,
    reviewerId: 'external-reviewer-1',
    completed: true,
    output,
    events: [
      { type: 'review.started', reviewerId: 'external-reviewer-1' },
      {
        type: 'review.completed',
        reviewerId: 'external-reviewer-1',
        outputSha256: crypto.createHash('sha256').update(output).digest('hex'),
      },
    ],
  };
  if (process.env.V5_TEST_GENERIC === 'invalid-events') {
    response.events[1].outputSha256 = '0'.repeat(64);
  }
  console.log(JSON.stringify(response));
} else if (name === 'codex') {
  if (process.env.V5_TEST_CODEX === 'network-error' || process.env.V5_TEST_CODEX === 'safety-refusal') {
    console.error(process.env.V5_TEST_CODEX === 'network-error' ?
      'ChatGPT web turn is missing network access in trusted Codex environment context' :
      "This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.");
    console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'network access missing' } }));
    process.exitCode = 1;
  } else {
    const index = args.indexOf('-o');
    if (index < 0 || !args[index + 1]) {
      console.error('missing result artifact path');
      process.exitCode = 2;
    } else {
      const decision = JSON.stringify({
        artifactA: { passed: true, quality: 0.9, verification: 0.8, integrityFailure: false, evidence: ['A'] },
        artifactB: { passed: false, quality: 0.2, verification: 0.2, integrityFailure: false, evidence: ['B'] },
        preference: 'A', rationale: ['A is better'],
      });
      const output = process.env.V5_TEST_CODEX === 'incomplete' ? '{"status":"pending"}' :
        process.env.V5_TEST_CODEX === 'invalid-schema' ?
        decision.replace('"quality":0.9', '"quality":9') : decision;
      fs.writeFileSync(args[index + 1], process.env.V5_TEST_CODEX === 'mismatch' ? 'forged' : output);
      if (process.env.V5_TEST_CODEX === 'mutate-prompt') {
        fs.writeFileSync(process.env.V5_TEST_PROMPT, 'altered during review');
      }
      if (process.env.V5_TEST_CODEX === 'mutate-private') {
        fs.appendFileSync(path.join(path.dirname(process.env.V5_TEST_PROMPT), 'assignment-1.private.json'), ' ');
      }
      console.log(JSON.stringify({
        type: 'thread.started',
        thread_id: process.env.V5_TEST_CODEX === 'invalid-thread' ? 'invented-id' :
          '0199a833-1b2c-73de-8ff1-123456789abc',
      }));
      if (process.env.V5_TEST_CODEX === 'invalid-jsonl') console.log('not JSONL');
      console.log(JSON.stringify({ type: 'turn.started' }));
      if (process.env.V5_TEST_CODEX === 'unconfirmed') {
        console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'turn failed' } }));
      } else {
        if (process.env.V5_TEST_CODEX !== 'no-message') {
          console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: output } }));
        }
        console.log(JSON.stringify({ type: 'turn.completed' }));
        if (process.env.V5_TEST_CODEX === 'duplicate-completion') {
          console.log(JSON.stringify({ type: 'turn.completed' }));
        }
        if (process.env.V5_TEST_CODEX === 'post-completion-message') {
          console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: output } }));
        }
      }
    }
  }
} else {
  console.error('unexpected fake command', name);
  process.exitCode = 2;
}
`;

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'kory-v5-campaign-test-'));
  testRoots.push(root);
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  const tempDir = join(root, 'tmp');
  mkdirSync(tempDir);
  for (const name of [
    'bun',
    'codex',
    'generic-reviewer',
    'reviewer-control',
    'kory-native-stateless-reviewer',
  ]) {
    const path = join(binDir, name);
    writeFileSync(path, fakeProgram);
    chmodSync(path, 0o755);
  }
  const promptPath = join(root, 'prompt.txt');
  writeFileSync(promptPath, 'anonymous reviewer fixture');
  const callLog = join(root, 'calls.jsonl');
  const ingestLog = join(root, 'ingest.json');

  function run(
    options: {
      args?: string[];
      env?: Record<string, string>;
    } = {},
  ) {
    return spawnSync(
      process.execPath,
      [
        runnerPath,
        ...(options.args?.some((arg) => arg.startsWith('--max-assignments='))
          ? []
          : ['--max-assignments=1']),
        ...(options.args?.some((arg) => arg.startsWith('--max-reviewer-attempts='))
          ? []
          : ['--max-reviewer-attempts=1']),
        ...(options.args ?? []),
      ],
      {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
          TMPDIR: tempDir,
          KORY_SKILL_CHATGPT_WEB_CLI: join(binDir, 'reviewer-control'),
          KORY_SKILL_CHATGPT_WEB_BASE_URL: '',
          KORY_SKILL_BLIND_REVIEWER_MODEL: '',
          KORY_SKILL_BLIND_REVIEW_CONCURRENCY: '1',
          CODEX_CHATGPT_WEB_HOME: join(root, 'unconfigured-home'),
          V5_TEST_PROMPT: promptPath,
          V5_TEST_CALL_LOG: callLog,
          V5_TEST_INGEST_LOG: ingestLog,
          V5_TEST_NATIVE_SYSTEM: NATIVE_REVIEW_SYSTEM_PROMPT,
          V5_TEST_PROJECT_ROOT: resolve(import.meta.dir, '..'),
          KORY_NATIVE_REVIEW_ARCHIVE_DIR: '',
          KORY_NATIVE_REVIEW_STAGE_SANDBOX: '',
          ...options.env,
        },
      },
    );
  }

  function calls(): Array<{
    name: string;
    args: string[];
    cwd: string;
    archiveDirectory?: string;
    nativeModel?: string;
    nativeSandbox?: string;
  }> {
    return existsSync(callLog)
      ? readFileSync(callLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  }

  function summary(stdout: string): Record<string, any> {
    const start = stdout.lastIndexOf('\n{\n  "schemaVersion": 1,');
    if (start < 0) throw new Error(`Missing campaign summary: ${stdout}`);
    return JSON.parse(stdout.slice(start + 1));
  }

  return { run, calls, summary, ingestLog, binDir };
}

afterEach(() => {
  for (const path of testRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const nativeArgs = [
  '--reviewer-adapter=kory-native-stateless-reviewer',
  '--reviewer-model=native-fixture-model',
];
test('native campaign stages exact output and four private archives with validate-only opt-in', () => {
  const harness = makeHarness();
  const result = harness.run({ args: nativeArgs });
  expect(result.status).toBe(0);
  const summary = harness.summary(result.stdout);
  expect(summary.reviewed).toBe(1);
  expect(summary.persisted).toBe(0);
  const native = harness.calls().find((call) => call.name === 'kory-native-stateless-reviewer')!;
  expect(native.nativeModel).toBe('native-fixture-model');
  expect(native.nativeSandbox).toBe('macos-private-roots');
  expect(native.cwd).toBe(canonicalizePath(native.cwd));
  expect(dirname(native.archiveDirectory!)).toBe(native.cwd);
  expect(lstatSync(native.archiveDirectory!).mode & 0o777).toBe(0o700);
  expect(
    harness.calls().some((call) => call.name === 'codex' || call.name === 'reviewer-control'),
  ).toBe(false);
  const validator = harness
    .calls()
    .find((call) => call.args.some((arg) => arg.startsWith('--validate-only=')))!;
  expect(validator.args).toContain('--allow-native-stage');
  expect(validator.archiveDirectory).toBe('');
  const envelope = JSON.parse(readFileSync(summary.stagedReviews[0].envelopePath, 'utf8'));
  const stage = envelope.nativeStageEvidence;
  expect(stage.schemaVersion).toBe(1);
  expect(stage.stageOnly).toBe(true);
  const completion = JSON.parse(readFileSync(stage.hostReceipt.path, 'utf8'));
  const raw = readFileSync(stage.rawEvents.path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(envelope.reviews[0].output).toBe(raw.at(-1).result);
  expect(envelope.reviews[0].output).toBe(completion.output);
  expect(envelope.reviews[0].output.endsWith('\n')).toBe(true);
  expect(readFileSync(join(native.cwd, 'result-1.txt'), 'utf8')).toBe(completion.output);
  expect(completion.hostReceipt.rawEventArchive).toEqual(stage.rawEvents);
  expect(completion.hostReceipt.kernelStage.profileArchive).toEqual(stage.kernelProfile);
  for (const ref of [stage.rawEvents, stage.hostReceipt, stage.sealedPrompt, stage.kernelProfile]) {
    expect(isContainedBy(native.archiveDirectory!, ref.path)).toBe(true);
    expect(lstatSync(ref.path).mode & 0o777).toBe(0o600);
    expect(lstatSync(ref.path).isSymbolicLink()).toBe(false);
  }
  expect(result.stdout + result.stderr).not.toContain('OPAQUE_NOT_OUTPUT_PROVIDER_SECRET');
  expect(readFileSync(stage.rawEvents.path, 'utf8')).toContain('OPAQUE_NOT_OUTPUT_PROVIDER_SECRET');
  expect(readFileSync(stage.hostReceipt.path, 'utf8')).not.toContain(
    'OPAQUE_NOT_OUTPUT_PROVIDER_SECRET',
  );
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test.each([
  'missing-raw',
  'wrong-request',
  'tools',
  'wrong-model',
  'wrong-profile',
  'normalize-output',
  'exit-error',
])('native campaign rejects %s without validation, exposure or ingestion', (mode) => {
  const harness = makeHarness();
  const result = harness.run({ args: nativeArgs, env: { V5_TEST_NATIVE: mode } });
  expect(result.status).toBe(1);
  const summary = harness.summary(result.stdout);
  expect(summary.reviewed).toBe(0);
  expect(summary.persisted).toBe(0);
  expect(
    harness.calls().some((call) => call.args.some((arg) => arg.startsWith('--validate-only='))),
  ).toBe(false);
  expect(result.stdout + result.stderr).not.toContain('OPAQUE_NOT_OUTPUT_PROVIDER_SECRET');
  expect(result.stdout + result.stderr).not.toContain('PRIVATE_NATIVE_DIAGNOSTIC');
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test.each(['rawEvents', 'hostReceipt', 'sealedPrompt', 'kernelProfile'])(
  'native campaign rechecks %s after read-only import validation',
  (file) => {
    const harness = makeHarness();
    const result = harness.run({ args: nativeArgs, env: { V5_TEST_MUTATE_ARCHIVE: file } });
    expect(result.status).toBe(1);
    expect(harness.summary(result.stdout).reviewed).toBe(0);
    expect(harness.summary(result.stdout).persisted).toBe(0);
    expect(existsSync(harness.ingestLog)).toBe(false);
  },
);

test('native campaign isolates retries into distinct per-attempt archives', () => {
  const harness = makeHarness();
  const result = harness.run({
    args: [...nativeArgs, '--max-reviewer-attempts=2'],
    env: { V5_TEST_NATIVE: 'retry' },
  });
  expect(result.status).toBe(0);
  expect(harness.summary(result.stdout).reviewed).toBe(1);
  const attempts = harness.calls().filter((call) => call.name === 'kory-native-stateless-reviewer');
  expect(attempts).toHaveLength(2);
  expect(attempts[0].archiveDirectory).not.toBe(attempts[1].archiveDirectory);
  expect(dirname(attempts[0].archiveDirectory!)).toBe(dirname(attempts[1].archiveDirectory!));
  expect(existsSync(join(attempts[0].archiveDirectory!, 'native-cli-events.jsonl'))).toBe(false);
  expect(existsSync(join(attempts[1].archiveDirectory!, 'native-cli-events.jsonl'))).toBe(true);
  expect(result.stdout + result.stderr).not.toContain('OPAQUE_NOT_OUTPUT_PROVIDER_SECRET');
});

test('stages a reviewer from an active matching local route without granting network trust', () => {
  const harness = makeHarness();
  const result = harness.run();

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const summary = harness.summary(result.stdout);
  expect(summary.reviewerBaseUrl).toBe('http://127.0.0.1:17841/v1');
  expect(summary.persisted).toBe(0);
  expect(summary.reviewed).toBe(1);
  expect(summary.infrastructureFailures).toBe(0);
  const codex = harness.calls().find((call) => call.name === 'codex');
  expect(codex).toBeDefined();
  const sandboxIndex = codex!.args.indexOf('--sandbox');
  expect(codex!.args[sandboxIndex + 1]).toBe('workspace-write');
  expect(codex!.args).not.toContain('sandbox_workspace_write.network_access=true');
  expect(codex!.args).not.toContain('--ignore-rules');
  expect(codex!.args).toContain('openai_base_url="http://127.0.0.1:17841/v1"');
  expect(codex!.args).toContain('--ephemeral');
  expect(codex!.args).toContain('--strict-config');
  expect(codex!.args).toContain('--ignore-user-config');
  expect(codex!.cwd).toContain('kory-v5-blind-review-');
  expect(codex!.cwd).not.toBe(resolve(import.meta.dir, '..'));
  const envelope = JSON.parse(readFileSync(summary.stagedReviews[0].envelopePath, 'utf8'));
  expect(envelope.reviewer).toEqual({
    agentId: '0199a833-1b2c-73de-8ff1-123456789abc',
    provider: 'chatgpt-web',
    model: 'chatgpt-web/high',
  });
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test('stages a provider-neutral adapter only when it supplies bound identity and completion evidence', () => {
  const harness = makeHarness();
  const result = harness.run({ args: ['--reviewer-adapter=generic-reviewer'] });

  expect(result.status).toBe(0);
  const summary = harness.summary(result.stdout);
  expect(summary.reviewed).toBe(1);
  expect(summary.persisted).toBe(0);
  expect(harness.calls().filter((call) => call.name === 'codex')).toHaveLength(0);
  expect(harness.calls().filter((call) => call.name === 'generic-reviewer')).toHaveLength(1);
  const status = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{"type":"reviewer-status"'))
    .map((line) => JSON.parse(line))[0];
  expect(status).toMatchObject({
    ready: false,
    canAttempt: false,
    routeVerified: false,
    executableAvailable: true,
    isolationVerified: false,
    stageOnlyAttemptAllowed: true,
  });
  const { attestationPath, envelopePath } = summary.stagedReviews[0];
  try {
    const attestation = JSON.parse(readFileSync(attestationPath, 'utf8'));
    const envelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
    expect(envelope.reviewer).toEqual({
      agentId: 'external-reviewer-1',
      provider: 'independent-agent',
      model: 'reviewer-model-v1',
    });
    expect(attestation.reviewerIdentitySource).toBe('external-reviewer-adapter-output');
    expect(attestation.reviewerAdapter).toBe('generic-reviewer');
    expect(attestation.reviewerModelSource).toBe('configured-provider-model-metadata');
    expect(attestation.reviewerEventsPath).toMatch(/reviewer-events\.json$/u);
    expect(existsSync(attestation.reviewerEventsPath)).toBe(true);
  } finally {
    rmSync(resolve(attestationPath, '..'), { recursive: true, force: true });
  }
});

test('resolves a relative reviewer adapter from the project before entering private review cwd', () => {
  const harness = makeHarness();
  const adapter = relative(
    resolve(import.meta.dir, '..'),
    join(harness.binDir, 'generic-reviewer'),
  );
  const result = harness.run({ args: [`--reviewer-adapter=${adapter}`] });

  expect(result.status).toBe(0);
  expect(harness.summary(result.stdout)).toMatchObject({
    reviewed: 1,
    persisted: 0,
    infrastructureFailures: 0,
  });
  const calls = harness.calls().filter((call) => call.name === 'generic-reviewer');
  expect(calls).toHaveLength(1);
  expect(calls[0].cwd).toContain('kory-v5-blind-review-');
});

test('rejects provider-neutral adapter output whose completion event is not bound to the result', () => {
  const harness = makeHarness();
  const result = harness.run({
    args: ['--reviewer-adapter=generic-reviewer'],
    env: { V5_TEST_GENERIC: 'invalid-events' },
  });

  expect(result.status).toBe(1);
  const summary = harness.summary(result.stdout);
  expect(summary.reviewed).toBe(0);
  expect(summary.persisted).toBe(0);
  expect(summary.failures[0].detail).toContain('ordered start/completion event pair');
  expect(harness.calls().filter((call) => call.name === 'codex')).toHaveLength(0);
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test('review-only stages hash-bound independent turn evidence without ingesting', () => {
  const harness = makeHarness();
  const result = harness.run({ args: ['--review-only'] });

  expect(result.status).toBe(0);
  const summary = harness.summary(result.stdout);
  expect(summary.reviewOnly).toBe(true);
  expect(summary.reviewed).toBe(1);
  expect(summary.persisted).toBe(0);
  expect(summary.infrastructureFailures).toBe(0);
  expect(summary.stagedReviews).toHaveLength(1);
  expect(harness.calls().filter((call) => call.name === 'bun')).toHaveLength(2);
  expect(
    harness.calls().filter((call) => call.args.some((arg) => arg.startsWith('--validate-only='))),
  ).toHaveLength(1);
  expect(harness.calls().some((call) => call.args.some((arg) => arg.startsWith('--ingest=')))).toBe(
    false,
  );
  expect(existsSync(harness.ingestLog)).toBe(false);
  const { attestationPath, envelopePath, reviewerThread } = summary.stagedReviews[0];
  try {
    const attestation = JSON.parse(readFileSync(attestationPath, 'utf8'));
    const envelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
    expect(attestation.status).toBe('unimported');
    expect(attestation.assignmentId).toBe('assignment-1');
    expect(attestation.reviewerThread).toBe(reviewerThread);
    expect(attestation.promptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(attestation.reviewerEventsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(attestation.importValidation).toEqual({
      mode: 'validate',
      validatedReviews: 1,
      persistedReviews: 0,
    });
    expect(envelope.reviewer.agentId).toBe(reviewerThread);
    expect(attestation.reviewerIdentitySource).toBe('codex-jsonl-thread.started');
    expect(attestation.reviewerModelSource).toBe(
      'codex-cli-model-selection-and-matching-local-route',
    );
    expect(existsSync(attestation.promptSnapshotPath)).toBe(true);
    expect(existsSync(attestation.reviewerEventsPath)).toBe(true);
  } finally {
    rmSync(resolve(attestationPath, '..'), { recursive: true, force: true });
  }
});

test('review-only rejects invalid adjudication and never ingests', () => {
  const harness = makeHarness();
  const result = harness.run({ args: ['--review-only'], env: { V5_TEST_CODEX: 'invalid-schema' } });
  expect(result.status).toBe(1);
  expect(harness.summary(result.stdout).reviewed).toBe(0);
  expect(harness.summary(result.stdout).failures[0].detail).toContain(
    'invalid adjudication schema',
  );
  expect(harness.calls().filter((call) => call.name === 'bun')).toHaveLength(1);
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test.each([
  ['reject', 'Blind review validation failed'],
  ['wrong-summary', 'did not confirm one unpersisted valid review'],
])('review-only rejects importer validation %s without staging or ingesting', (mode, detail) => {
  const harness = makeHarness();
  const result = harness.run({ args: ['--review-only'], env: { V5_TEST_VALIDATE: mode } });
  expect(result.status).toBe(1);
  const summary = harness.summary(result.stdout);
  expect(summary.reviewed).toBe(0);
  expect(summary.persisted).toBe(0);
  expect(summary.stagedReviews).toEqual([]);
  expect(summary.failures[0].detail).toContain(detail);
  expect(harness.calls().filter((call) => call.name === 'codex')).toHaveLength(1);
  expect(
    harness.calls().filter((call) => call.args.some((arg) => arg.startsWith('--validate-only='))),
  ).toHaveLength(1);
  expect(harness.calls().some((call) => call.args.some((arg) => arg.startsWith('--ingest=')))).toBe(
    false,
  );
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test('rejects malformed Markdown base URLs before preparing assignments', () => {
  const harness = makeHarness();
  const result = harness.run({
    env: {
      KORY_SKILL_CHATGPT_WEB_BASE_URL: '[[http://127.0.0.1:17841/v1](http://127.0.0.1:17841/v1)]',
    },
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Invalid ChatGPT Web reviewer base URL');
  expect(harness.calls()).toEqual([]);
});

test('refuses a remote URL that could impersonate the ChatGPT Web reviewer', () => {
  const harness = makeHarness();
  const result = harness.run({
    env: { KORY_SKILL_CHATGPT_WEB_BASE_URL: 'https://example.com/v1' },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('expected a loopback /v1 endpoint');
  expect(harness.calls()).toEqual([]);
});

test('read-only diagnostics check the installed route and browser without preparing a prompt', () => {
  const harness = makeHarness();
  const result = harness.run({ args: ['--diagnose-reviewer'] });
  expect(result.status).toBe(0);
  const detail = JSON.parse(result.stdout);
  expect(detail).toMatchObject({
    mode: 'diagnostic',
    ready: true,
    canAttempt: true,
    routeVerified: true,
    independentReviewerCompleted: false,
  });
  expect(detail.trustedNetworkContext).toContain('unverified');
  expect(harness.calls().map((call) => call.args)).toEqual([
    ['route', 'status'],
    ['browser', 'check'],
  ]);
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test('generic diagnostics distinguish executable presence from qualified reviewer readiness', () => {
  const harness = makeHarness();
  const result = harness.run({
    args: ['--diagnose-reviewer', '--reviewer-adapter=generic-reviewer'],
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    mode: 'diagnostic',
    ready: false,
    canAttempt: false,
    routeVerified: false,
    executableAvailable: true,
    isolationVerified: false,
    stageOnlyAttemptAllowed: false,
    independentReviewerCompleted: false,
  });
  expect(harness.calls()).toEqual([]);
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test.each(['missing', 'non-executable'])(
  'generic diagnostics reject a %s adapter without preparing or submitting an assignment',
  (availability) => {
    const harness = makeHarness();
    const adapter = join(harness.binDir, 'unavailable-reviewer');
    if (availability === 'non-executable') {
      writeFileSync(adapter, fakeProgram);
      chmodSync(adapter, 0o600);
    }
    const result = harness.run({
      args: ['--diagnose-reviewer', `--reviewer-adapter=${adapter}`],
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ready: false,
      canAttempt: false,
      routeVerified: false,
      executableAvailable: false,
      isolationVerified: false,
      stageOnlyAttemptAllowed: false,
      independentReviewerCompleted: false,
    });
    expect(harness.calls()).toEqual([]);
    expect(existsSync(harness.ingestLog)).toBe(false);
  },
);

test('diagnostics report a busy reviewer without an independent completed turn', () => {
  const harness = makeHarness();
  const result = harness.run({
    args: ['--diagnose-reviewer'],
    env: { V5_TEST_BROWSER: 'busy' },
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    routeVerified: true,
    ready: false,
    canAttempt: false,
    browserBusy: true,
    independentReviewerCompleted: false,
  });
  expect(harness.calls().every((call) => call.name === 'reviewer-control')).toBe(true);
});

test.each([
  ['unavailable', 'route unavailable'],
  ['invalid-json', 'not valid JSON'],
  ['inactive', 'inactive or does not match'],
  ['mismatch', 'inactive or does not match'],
])('route check %s fails closed before launching the reviewer', (mode, detail) => {
  const harness = makeHarness();
  const result = harness.run({ env: { V5_TEST_ROUTE: mode } });
  expect(result.status).toBe(1);
  expect(harness.summary(result.stdout).failures[0].detail).toContain(detail);
  expect(harness.calls().some((call) => call.name === 'codex')).toBe(false);
  expect(
    harness.calls().some((call) => call.name === 'bun' && call.args.includes('--ingest')),
  ).toBe(false);
});

test('a different loopback endpoint is rejected even when syntactically valid', () => {
  const harness = makeHarness();
  const result = harness.run({
    env: { KORY_SKILL_CHATGPT_WEB_BASE_URL: 'http://127.0.0.1:22222/v1' },
  });
  expect(result.status).toBe(1);
  expect(harness.summary(result.stdout).failures[0].detail).toContain('does not match');
  expect(harness.calls().some((call) => call.name === 'codex')).toBe(false);
});

test('automatic ingestion is unsupported even when explicitly requested', () => {
  const harness = makeHarness();
  const result = harness.run({ args: ['--ingest'] });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('cannot ingest evaluations');
  expect(harness.calls()).toEqual([]);
});

test('live reviews require serial execution to avoid parallel repeated trust failures', () => {
  const harness = makeHarness();
  const result = harness.run({ args: ['--concurrency=2'] });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('must run serially');
  expect(harness.calls()).toEqual([]);
});

test('dry-run prepares candidate metadata without starting or ingesting reviews', () => {
  const harness = makeHarness();
  const result = harness.run({ args: ['--dry-run', '--retry-failed'] });
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.dryRun).toBe(true);
  expect(parsed.retryFailed).toBe(true);
  expect(parsed.selectedAssignments).toHaveLength(1);
  const calls = harness.calls();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.args).toContain('--retry-failed');
  expect(calls[0]?.args).toContain('--dry-run');
  expect(calls[0]?.args).not.toContain('--prepare-only');
  expect(parsed.selectedAssignments[0].assignmentId).toMatch(/^blind-v5-[a-f0-9]{20}$/u);
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test('rejects modified prepared prompts before invoking a reviewer', () => {
  const harness = makeHarness();
  const result = harness.run({ env: { V5_TEST_BAD_PROMPT_SHA: '1' } });
  expect(result.status).toBe(1);
  expect(harness.summary(result.stdout).failures[0].detail).toContain('prompt hash mismatch');
  expect(harness.calls().filter((call) => call.name === 'codex')).toHaveLength(0);
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test.each(['mutate-prompt', 'mutate-private'])(
  'rejects a %s mutation after the reviewer finishes and before ingestion',
  (mutation) => {
    const harness = makeHarness();
    const result = harness.run({ env: { V5_TEST_CODEX: mutation } });
    expect(result.status).toBe(1);
    expect(harness.summary(result.stdout).failures[0].detail).toContain('changed during review');
    expect(existsSync(harness.ingestLog)).toBe(false);
  },
);

test('preserves a real network failure and never ingests an uncompleted review', () => {
  const harness = makeHarness();
  const result = harness.run({ env: { V5_TEST_CODEX: 'network-error' } });

  expect(result.status).toBe(1);
  const summary = harness.summary(result.stdout);
  expect(summary.persisted).toBe(0);
  expect(summary.infrastructureFailures).toBe(1);
  expect(summary.failures[0].detail).toContain(
    'missing network access in trusted Codex environment context',
  );
  expect(harness.calls().filter((call) => call.name === 'codex')).toHaveLength(1);
  expect(
    harness.calls().filter((call) => call.args.some((arg) => arg.startsWith('--ingest='))),
  ).toHaveLength(0);
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test('trusted network denial stops the campaign after one rejected turn across assignments', () => {
  const harness = makeHarness();
  const result = harness.run({
    args: ['--max-assignments=3', '--max-reviewer-attempts=5'],
    env: { V5_TEST_ASSIGNMENTS: '3', V5_TEST_CODEX: 'network-error' },
  });
  expect(result.status).toBe(1);
  const summary = harness.summary(result.stdout);
  expect(summary.completed).toBe(1);
  expect(summary.notAttempted).toBe(2);
  expect(summary.reviewed).toBe(0);
  expect(summary.persisted).toBe(0);
  expect(summary.infrastructureFailures).toBe(1);
  expect(summary.terminalBlocker).toContain('missing network access in trusted');
  expect(harness.calls().filter((call) => call.name === 'codex')).toHaveLength(1);
  expect(harness.calls().some((call) => call.args.some((arg) => arg.startsWith('--ingest')))).toBe(
    false,
  );
});

test('an explicit safety refusal is never retried across attempts or assignments', () => {
  const harness = makeHarness();
  const result = harness.run({
    args: ['--max-assignments=3', '--max-reviewer-attempts=5'],
    env: { V5_TEST_ASSIGNMENTS: '3', V5_TEST_CODEX: 'safety-refusal' },
  });
  expect(result.status).toBe(1);
  expect(harness.summary(result.stdout)).toMatchObject({
    completed: 1,
    notAttempted: 2,
    reviewed: 0,
    persisted: 0,
  });
  expect(harness.summary(result.stdout).terminalBlocker).toContain('blocked by OpenAI');
  expect(harness.calls().filter((call) => call.name === 'codex')).toHaveLength(1);
});

test('unverified browser readiness stops a queued campaign before any reviewer runs', () => {
  const harness = makeHarness();
  const result = harness.run({
    args: ['--max-assignments=3'],
    env: { V5_TEST_ASSIGNMENTS: '3', V5_TEST_BROWSER: 'busy' },
  });
  expect(result.status).toBe(1);
  expect(harness.summary(result.stdout)).toMatchObject({
    queued: 3,
    completed: 1,
    notAttempted: 2,
    reviewed: 0,
    persisted: 0,
  });
  expect(harness.calls().filter((call) => call.name === 'codex')).toHaveLength(0);
});

test('does not submit a reviewer when another browser turn is active', () => {
  const harness = makeHarness();
  const result = harness.run({ env: { V5_TEST_BROWSER: 'busy' } });

  expect(result.status).toBe(1);
  const status = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{"type":"reviewer-status"'))
    .map((line) => JSON.parse(line))[0];
  expect(status.ready).toBe(false);
  expect(status.canAttempt).toBe(false);
  expect(status.browserBusy).toBe(true);
  expect(status.detail).toContain('reviewer readiness is unverified');
  const calls = harness.calls();
  expect(calls.filter((call) => call.name === 'reviewer-control').map((call) => call.args)).toEqual(
    [
      ['route', 'status'],
      ['browser', 'check'],
    ],
  );
  expect(calls.some((call) => call.name === 'codex')).toBe(false);
});

test('fails closed when browser preflight is unavailable', () => {
  const harness = makeHarness();
  const result = harness.run({ env: { V5_TEST_BROWSER: 'unavailable' } });

  expect(result.status).toBe(1);
  expect(harness.summary(result.stdout).failures[0].detail).toContain(
    'ChatGPT browser unavailable',
  );
  expect(harness.calls().some((call) => call.name === 'codex')).toBe(false);
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test('requires confirmed turn completion even if a result file and task ID exist', () => {
  const harness = makeHarness();
  const result = harness.run({ env: { V5_TEST_CODEX: 'unconfirmed' } });

  expect(result.status).toBe(1);
  expect(harness.summary(result.stdout).failures[0].detail).toContain(
    'did not confirm a completed single Codex turn',
  );
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test.each([
  ['invalid-thread', 'valid independent Codex task id'],
  ['no-message', 'differs from its completed Codex agent message'],
  ['mismatch', 'differs from its completed Codex agent message'],
  ['incomplete', 'incomplete semantic adjudication'],
  ['invalid-jsonl', 'contains invalid JSON'],
  ['post-completion-message', 'differs from its completed Codex agent message'],
  ['duplicate-completion', 'did not confirm a completed single Codex turn'],
])('rejects %s evidence without recording a pass', (scenario, failure) => {
  const harness = makeHarness();
  const result = harness.run({ env: { V5_TEST_CODEX: scenario } });
  expect(result.status).toBe(1);
  expect(harness.summary(result.stdout).failures[0].detail).toContain(failure);
  expect(existsSync(harness.ingestLog)).toBe(false);
});

test('rejects reuse of a single Codex reviewer task across distinct assignments', () => {
  const harness = makeHarness();
  const result = harness.run({
    args: ['--max-assignments=2'],
    env: { V5_TEST_ASSIGNMENTS: '2' },
  });
  expect(result.status).toBe(1);
  const summary = harness.summary(result.stdout);
  expect(summary.persisted).toBe(0);
  expect(summary.reviewed).toBe(1);
  expect(summary.infrastructureFailures).toBe(1);
  expect(summary.failures[0].detail).toContain('reused across blind assignments');
  expect(harness.calls().filter((call) => call.name === 'codex')).toHaveLength(2);
});
