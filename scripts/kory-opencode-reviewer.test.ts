import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const reviewer = resolve(import.meta.dir, 'kory-opencode-reviewer');
const node = Bun.which('node');
if (!node) throw new Error('These wrapper tests require Node.js');
const roots: string[] = [];
const prompt = 'Sealed anonymous artifacts A and B.\nPreserve this prompt exactly.\n';
const sessionID = 'ses_stub_123';
const adjudication = {
  artifactA: {
    passed: true,
    quality: 0.9,
    verification: 0.8,
    integrityFailure: false,
    evidence: ['A'],
  },
  artifactB: {
    passed: false,
    quality: 0.2,
    verification: 0.3,
    integrityFailure: false,
    evidence: ['B'],
  },
  preference: 'A',
  rationale: ['A has stronger evidence'],
};
const output = JSON.stringify(adjudication);
const textEvent = {
  type: 'text',
  sessionID,
  part: { id: 'part-review', type: 'text', text: output },
};
const secrets = ['sk-provider-secret-123', 'bearer-secret-456', 'opaque-private-value-789'];
const errorEvent = {
  type: 'error',
  sessionID,
  error: {
    name: 'APIError',
    data: {
      message: `Provider rejected api_key=${secrets[0]}`,
      responseHeaders: { authorization: `Bearer ${secrets[1]}` },
      responseBody: JSON.stringify({ private: secrets[2] }),
    },
  },
};

// This executable only replays fixtures. Its private PATH contains no real
// opencode, and its environment contains no inherited provider credentials.
const stub = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'debug' && process.argv[3] === 'agents') {
  process.stdout.write(process.env.REVIEW_TEST_AGENTS);
  process.exit(0);
}
fs.writeFileSync(process.env.REVIEW_TEST_CALL, JSON.stringify({
  binary: process.argv[1], args: process.argv.slice(2), cwd: process.cwd(),
  stagedAgent: fs.readFileSync(require('path').join(process.cwd(), '.opencode', 'agents', 'kory-blind-reviewer.md'), 'utf8'),
}));
if (process.env.REVIEW_TEST_OVERSIZED === '1') {
  process.stdout.write('z'.repeat(9 * 1024 * 1024), () => process.exit(0));
} else {
  process.stdout.write(process.env.REVIEW_TEST_STREAM);
  process.stderr.write(process.env.REVIEW_TEST_STDERR || '');
  process.exitCode = Number(process.env.REVIEW_TEST_EXIT || '0');
}
`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(
  options: {
    events?: unknown[];
    rawStream?: string;
    oversizedStream?: boolean;
    exitCode?: number;
    stderr?: string;
    binary?: 'path' | 'blank' | 'missing';
    model?: string;
    agents?: unknown[];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'kory reviewer test-'));
  roots.push(root);
  symlinkSync(node!, join(root, 'node'));
  const pathBinary = join(root, 'opencode');
  const overrideBinary = join(root, 'review binary');
  writeFileSync(pathBinary, stub, { mode: 0o755 });
  writeFileSync(overrideBinary, stub, { mode: 0o755 });
  const callPath = join(root, 'call.json');
  const env: Record<string, string> = {
    HOME: root,
    PATH: root,
    REVIEW_TEST_CALL: callPath,
    REVIEW_TEST_STREAM:
      options.rawStream ??
      (options.events ?? [textEvent]).map((ev) => JSON.stringify(ev)).join('\n') + '\n',
    REVIEW_TEST_STDERR: options.stderr ?? '',
    REVIEW_TEST_EXIT: String(options.exitCode ?? 0),
    REVIEW_TEST_OVERSIZED: options.oversizedStream ? '1' : '0',
    REVIEW_TEST_AGENTS: JSON.stringify(
      options.agents ?? [
        {
          id: 'kory-blind-reviewer',
          mode: 'primary',
          permissions: [
            { action: '*', resource: '*', effect: 'allow' },
            { action: '*', resource: '*', effect: 'deny' },
          ],
        },
      ],
    ),
  };
  if (options.binary !== 'path') {
    env.KORY_OPENCODE_REVIEW_BINARY =
      options.binary === 'blank'
        ? '  '
        : options.binary === 'missing'
          ? join(root, 'missing')
          : overrideBinary;
  }
  if (options.model !== undefined) env.KORY_OPENCODE_REVIEW_MODEL = options.model;
  const result = spawnSync(node!, [reviewer, '-p', 'IGNORED_ARGV_INSTRUCTION'], {
    cwd: root,
    env,
    input: prompt,
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const call = existsSync(callPath) ? JSON.parse(readFileSync(callPath, 'utf8')) : null;
  return { ...result, call, pathBinary, overrideBinary };
}

function expectFailure(result: ReturnType<typeof run>) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('kory-opencode-reviewer:');
  for (const secret of secrets) expect(result.stdout + result.stderr).not.toContain(secret);
}

test('explicit executable override preserves prompt, defaults, output hash and session provenance', () => {
  const result = run();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.call.binary).toBe(result.overrideBinary);
  expect(result.call.cwd).not.toBe(process.cwd());
  expect(result.call.stagedAgent).toContain('effect: deny');
  expect(result.call.args).toHaveLength(9);
  expect(result.call.args.slice(0, 8)).toEqual([
    'run',
    '--standalone',
    '--format',
    'json',
    '--agent',
    'kory-blind-reviewer',
    '-m',
    'opencode/beam-free',
  ]);
  expect(result.call.args[8]).toBe(
    prompt +
      `

ADJUDICATION OUTPUT CONTRACT — MANDATORY:
Reply with EXACTLY ONE JSON object and nothing else. No prose, no markdown code fences, no commentary before or after. The object must match this schema exactly:
{"artifactA": {"passed": <bool>, "quality": <0-1>, "verification": <0-1>, "integrityFailure": <bool>, "evidence": [<strings>]}, "artifactB": {"passed": <bool>, "quality": <0-1>, "verification": <0-1>, "integrityFailure": <bool>, "evidence": [<strings>]}, "preference": "A"|"B"|"tie", "rationale": [<strings>]}
Score honestly against the artifacts described above. Do not invent evidence; cite only what the prompt supports.`,
  );
  const reviewerId = 'opencode:ses-stub-123';
  expect(JSON.parse(result.stdout)).toEqual({
    schemaVersion: 1,
    reviewerId,
    completed: true,
    output,
    events: [
      { type: 'review.started', reviewerId },
      {
        type: 'review.completed',
        reviewerId,
        outputSha256: createHash('sha256').update(output).digest('hex'),
      },
    ],
  });
});

for (const binary of ['path', 'blank'] as const) {
  test(`${binary} executable selection resolves opencode only through PATH`, () => {
    const result = run({ binary, model: ' test-provider/test-model ' });
    expect(result.status).toBe(0);
    expect(result.call.binary).toBe(result.pathBinary);
    expect(result.call.args[7]).toBe('test-provider/test-model');
  });
}

test('a missing explicit executable fails rather than falling back to PATH', () => {
  const result = run({ binary: 'missing' });
  expectFailure(result);
  expect(result.stderr).toContain('unable to verify effective OpenCode agent permissions');
});

for (const position of ['before', 'after'] as const) {
  test(`exit zero with a provider error ${position} valid review text fails closed and redacts secrets`, () => {
    const result = run({
      events: position === 'before' ? [errorEvent, textEvent] : [textEvent, errorEvent],
      stderr: `Provider diagnostic: ${secrets.join(' ')}`,
    });
    expectFailure(result);
    expect(result.stderr).toContain('error event');
  });
}

test('a payload-free error event also invalidates a complete review', () => {
  const result = run({ events: [textEvent, { type: 'error' }] });
  expectFailure(result);
  expect(result.stderr).toContain('error event');
});

test('a successful CLI exit with malformed JSON events cannot be staged as a completed review', () => {
  const result = run({
    rawStream: `${JSON.stringify(textEvent)}\n{invalid JSON}\n`,
  });
  expectFailure(result);
  expect(result.stderr).toContain('malformed JSON events');
});

test('a successful CLI exit with a non-object JSON event cannot be staged as a completed review', () => {
  const result = run({
    rawStream: `${JSON.stringify(textEvent)}\n[]\n`,
  });
  expectFailure(result);
  expect(result.stderr).toContain('malformed JSON events');
});

test('a successful CLI cannot make an oversized event stream into review evidence', () => {
  const result = run({ oversizedStream: true });
  expectFailure(result);
  expect(result.stderr).toContain('bounded output limit');
});

test('nonzero provider exit redacts raw stdout and stderr even without a structured error', () => {
  const result = run({
    events: [textEvent, { diagnostic: secrets[0] }],
    exitCode: 7,
    stderr: secrets.slice(1).join(' '),
  });
  expectFailure(result);
  expect(result.stderr).toContain('exited with code 7');
});

test('Beam Free exhausted quota emits a safe, nonretryable diagnostic', () => {
  const result = run({
    events: [
      {
        type: 'error',
        sessionID,
        error: {
          message: `Free usage limit reached; api_key=${secrets[0]}`,
        },
      },
    ],
    exitCode: 1,
  });
  expectFailure(result);
  expect(result.stderr).toContain('free usage limit reached for opencode/beam-free');
});

test('alternate free reviewer quota diagnostics identify the selected model', () => {
  const model = 'opencode/deepseek-v4.1-flash-free';
  const result = run({
    model,
    events: [
      {
        type: 'error',
        sessionID,
        error: {
          message: `Free usage limit reached; api_key=${secrets[0]}`,
        },
      },
    ],
    exitCode: 1,
  });
  expectFailure(result);
  expect(result.stderr).toContain(`free usage limit reached for ${model}`);
  expect(result.call.args[7]).toBe(model);
});

test('valid text without a genuine session ID cannot emit an envelope', () => {
  const result = run({ events: [{ type: 'text', part: textEvent.part }] });
  expectFailure(result);
  expect(result.stderr).toContain('no sessionID');
});

test('session IDs on parts and replacement text events retain their existing contracts', () => {
  const result = run({
    events: [
      { type: 'text', part: { ...textEvent.part, sessionID, text: 'partial' } },
      { type: 'text', part: { ...textEvent.part, text: output } },
    ],
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ reviewerId: 'opencode:ses-stub-123', output });
});

test('rejects a missing or unrestricted reviewer agent before spawning model', () => {
  for (const agents of [
    [],
    [
      {
        id: 'kory-blind-reviewer',
        mode: 'primary',
        permissions: [{ action: '*', resource: '*', effect: 'allow' }],
      },
    ],
  ]) {
    const result = run({ agents });
    expectFailure(result);
    expect(result.stderr).toContain('lacks an effective deny-all rule');
  }
});

test('rejects a response with Markdown fences rather than laundering it into evidence', () => {
  const result = run({
    events: [{ ...textEvent, part: { ...textEvent.part, text: `\`\`\`json\n${output}\n\`\`\`` } }],
  });
  expectFailure(result);
  expect(result.stderr).toContain('not one strict JSON object');
});

test('preserves raw duplicate keys for campaign strict validation', () => {
  const duplicate = output.replace('"preference":"A"', '"preference":"B","preference":"A"');
  const result = run({ events: [{ ...textEvent, part: { ...textEvent.part, text: duplicate } }] });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).output).toBe(duplicate);
});

test('rejects conflicting session identities', () => {
  const result = run({ events: [textEvent, { ...textEvent, sessionID: 'ses_other' }] });
  expectFailure(result);
  expect(result.stderr).toContain('different sessions');
});

// Match the candidate parser's tool family, including separators, camel case,
// and lifecycle variants, without importing or executing the candidate adapter.
const toolEventTypes = [
  'tool',
  'tool_call',
  'tool-call',
  'tool.call',
  'toolCall',
  'tool_use',
  'tool-use',
  'tool.use',
  'toolUse',
  'tool_result',
  'tool-result',
  'tool.result',
  'toolResult',
  'tool_use_start',
  'tool-call.delta',
  'TOOL_RESULT',
];

for (const type of toolEventTypes) {
  for (const location of ['top-level', 'part'] as const) {
    for (const position of ['before', 'after', 'only'] as const) {
      const context =
        position === 'only' ? 'only (no review text)' : `${position} valid review text`;
      test(`exit zero rejects ${location} ${type} ${context}`, () => {
        const payload = {
          type,
          tool: 'grep',
          args: { pattern: secrets[0], path: secrets[1] },
          output: secrets[2],
          state: { status: 'completed', input: { pattern: secrets[0] }, output: secrets[2] },
        };
        const toolEvent =
          location === 'top-level'
            ? { sessionID, ...payload }
            : { type: 'part.updated', sessionID, part: payload };
        const events =
          position === 'before'
            ? [toolEvent, textEvent]
            : position === 'after'
              ? [textEvent, toolEvent]
              : [toolEvent];
        const result = run({ events });
        expectFailure(result);
        // An exact fixed diagnostic also excludes tool names, arguments, and
        // output that do not resemble any known credential format.
        expect(result.stderr).toBe(
          'kory-opencode-reviewer: opencode run emitted a tool event; text-only review required; tool details redacted\n',
        );
      });
    }
  }
}
