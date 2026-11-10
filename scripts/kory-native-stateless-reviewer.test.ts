import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalizePath, isContainedBy, isMac } from '../backend/src/runtime/platform';
import { MAX_NATIVE_REVIEW_REQUEST_BYTES, nativeReviewerEnvironment, parseNativeReviewEvents, parseNativeTextEvents } from './kory-native-stateless-reviewer.ts';

const roots: string[] = [];
const model = 'gpt-6.1-sol';
const sessionId = 'b7f5ec78-1234-1234-1234-2345a7be1089';
const score = { passed: true, quality: 0.8, verification: 0.7, integrityFailure: false, evidence: ['Anonymous artifact supports this result.'] };
const output = JSON.stringify({ artifactA: score, artifactB: score, preference: 'tie', rationale: ['No supported difference.'] });
const events = () => [
  { type: 'system', subtype: 'ui_invalidate' },
  { type: 'system', subtype: 'init', session_id: sessionId, model, tools: [], mcp_servers: [], skills: [] },
  { type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: output }], stop_reason: 'end_turn' } },
  { type: 'result', session_id: sessionId, subtype: 'success', is_error: false, result: output },
];
const bytes = (value: unknown[]) => Buffer.from(value.map((event) => JSON.stringify(event)).join('\n') + '\n');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('host archive controls never enter the model child environment', () => {
  const variables = {
    KORY_NATIVE_REVIEW_ARCHIVE_DIR: '/private/archive-canary',
    KORY_NATIVE_REVIEW_PENDING_ROOT: '/private/pending-canary',
    KORY_NATIVE_REVIEW_STAGE_SANDBOX: 'macos-private-roots',
    KORY_NATIVE_REVIEW_MODEL: model,
    ANTHROPIC_API_KEY: 'fixture-only-key',
    ANTHROPIC_BASE_URL: 'https://fixture.invalid',
    ANTHROPIC_AUTH_TOKEN: 'must-not-forward',
    NODE_OPTIONS: 'must-not-forward',
  };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, variables);
    const env = nativeReviewerEnvironment('/private/model-home');
    expect(env.ANTHROPIC_API_KEY).toBe(variables.ANTHROPIC_API_KEY);
    expect(env.ANTHROPIC_BASE_URL).toBe(variables.ANTHROPIC_BASE_URL);
    for (const key of ['KORY_NATIVE_REVIEW_ARCHIVE_DIR', 'KORY_NATIVE_REVIEW_PENDING_ROOT', 'KORY_NATIVE_REVIEW_STAGE_SANDBOX', 'KORY_NATIVE_REVIEW_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'NODE_OPTIONS']) expect(env[key]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('archive-canary');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('binds one empty-tool init and true successful result to exact assistant adjudication', () => {
  expect(parseNativeReviewEvents(bytes(events()), model)).toEqual({ sessionId, output });
});

test('accepts measured native redacted-thinking prefix without retaining opaque thinking data', () => {
  const stream = events();
  Object.assign(stream[0], { session_id: sessionId });
  const thinking = {
    type: 'assistant', session_id: sessionId,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'redacted_thinking', data: 'OPAQUE_NOT_OUTPUT' }] },
  };
  Object.assign(thinking, { parent_tool_use_id: null });
  Object.assign(stream[2], { parent_tool_use_id: null });
  const parsed = parseNativeReviewEvents(bytes([...stream.slice(0, 2), thinking, ...stream.slice(2)]), model);
  expect(parsed).toEqual({ sessionId, output });
  expect(JSON.stringify(parsed)).not.toContain('OPAQUE_NOT_OUTPUT');
});

for (const [name, content] of [
  ['non-string opaque data', [{ type: 'redacted_thinking', data: 42 }]],
  ['missing opaque data', [{ type: 'redacted_thinking' }]],
  ['extra opaque fields', [{ type: 'redacted_thinking', data: 'opaque', tool: 'Read' }]],
  ['mixed text and thinking', [{ type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: output }]],
  ['mixed tool and thinking', [{ type: 'redacted_thinking', data: 'opaque' }, { type: 'tool_use', name: 'Read' }]],
  ['unknown thinking type', [{ type: 'thinking', thinking: 'private' }]],
  ['empty thinking envelope', []],
] as const) {
  test(`rejects ${name} in thinking prefix`, () => {
    const stream = events();
    const thinking = { type: 'assistant', session_id: sessionId, message: { role: 'assistant', stop_reason: 'end_turn', content } };
    expect(() => parseNativeReviewEvents(bytes([...stream.slice(0, 2), thinking, ...stream.slice(2)]), model)).toThrow();
  });
}

test('rejects thinking after final text and truncated or foreign-session thinking prefixes', () => {
  const stream = events();
  const thinking = { type: 'assistant', session_id: sessionId, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'redacted_thinking', data: 'opaque' }] } };
  expect(() => parseNativeReviewEvents(bytes([...stream.slice(0, 3), thinking, stream[3]]), model)).toThrow();
  for (const stop_reason of ['max_tokens', 'tool_use']) {
    expect(() => parseNativeReviewEvents(bytes([...stream.slice(0, 2), { ...thinking, message: { ...thinking.message, stop_reason } }, ...stream.slice(2)]), model)).toThrow();
  }
  expect(() => parseNativeReviewEvents(bytes([...stream.slice(0, 2), { ...thinking, session_id: 'foreign' }, ...stream.slice(2)]), model)).toThrow();
  expect(() => parseNativeReviewEvents(bytes([...stream.slice(0, 2), { ...thinking, parent_tool_use_id: 'forged-tool-origin' }, ...stream.slice(2)]), model)).toThrow();
});

test('generic native text parser retains all stream guards without reviewer adjudication semantics', () => {
  const stream = events();
  stream[2].message!.content[0].text = 'Opaque candidate text patch.';
  stream[3].result = 'Opaque candidate text patch.';
  expect(parseNativeTextEvents(bytes(stream), model)).toEqual({ sessionId, output: 'Opaque candidate text patch.' });
  expect(() => parseNativeReviewEvents(bytes(stream), model)).toThrow();
});

const invalidStreams: Array<[string, (stream: ReturnType<typeof events>) => unknown[]]> = [
  ['foreign invalidate session', (s) => { Object.assign(s[0], { session_id: 'foreign' }); return s; }],
  ['invalid invalidate session', (s) => { Object.assign(s[0], { session_id: '../invalid' }); return s; }],
  ['contradictory invalidate sessions', (s) => [{ ...s[0], session_id: sessionId }, { ...s[0], session_id: 'foreign' }, ...s.slice(1)]],
  ['forged parent tool id', (s) => { Object.assign(s[2], { parent_tool_use_id: 'tool-123' }); return s; }],
  ['non-string parent tool id', (s) => { Object.assign(s[2], { parent_tool_use_id: 42 }); return s; }],
  ['missing init', (s) => s.filter((_, i) => i !== 1)],
  ['duplicate init', (s) => [s[0], s[1], s[1], ...s.slice(2)]],
  ['wrong model', (s) => { s[1].model = 'other-model'; return s; }],
  ['built-in tool enabled', (s) => { s[1].tools = ['Read'] as never[]; return s; }],
  ['MCP enabled', (s) => { s[1].mcp_servers = [{}] as never[]; return s; }],
  ['skill enabled', (s) => { s[1].skills = ['memory'] as never[]; return s; }],
  ['missing tools declaration', (s) => { delete (s[1] as Record<string, unknown>).tools; return s; }],
  ['invalid session id', (s) => { s[1].session_id = '../assignment'; return s; }],
  ['assistant session mismatch', (s) => { s[2].session_id = 'other'; return s; }],
  ['result session mismatch', (s) => { s[3].session_id = 'other'; return s; }],
  ['tool_use content', (s) => { s[2].message!.content[0].type = 'tool_use'; return s; }],
  ['tool_result content', (s) => { s[2].message!.content[0].type = 'tool_result'; return s; }],
  ['tool lifecycle event', (s) => [s[0], s[1], { type: 'tool_use', session_id: sessionId }, ...s.slice(2)]],
  ['assistant error', (s) => { Object.assign(s[2], { error: 'provider secret' }); return s; }],
  ['truncated message', (s) => { s[2].message!.stop_reason = 'max_tokens'; return s; }],
  ['missing assistant', (s) => s.filter((_, i) => i !== 2)],
  ['duplicate assistant', (s) => [...s.slice(0, 3), s[2], s[3]]],
  ['not logged in success subtype', (s) => { s[3].is_error = true; s[3].result = 'Not logged in'; return s; }],
  ['result error subtype', (s) => { s[3].subtype = 'error_max_turns'; return s; }],
  ['result errors array', (s) => { Object.assign(s[3], { errors: ['provider secret'] }); return s; }],
  ['result differs from assistant', (s) => { s[3].result = output + ' '; return s; }],
  ['duplicate result', (s) => [...s, s[3]]],
  ['event after result', (s) => [...s, { type: 'system', subtype: 'ui_invalidate' }]],
  ['missing result', (s) => s.slice(0, 3)],
  ['unsupported lifecycle', (s) => [s[0], s[1], { type: 'system', subtype: 'compact_boundary', session_id: sessionId }, ...s.slice(2)]],
];
for (const [name, mutate] of invalidStreams) {
  test(`rejects ${name} without exposing stream contents`, () => {
    expect(() => parseNativeReviewEvents(bytes(mutate(events())), model)).toThrow(/redacted|Invalid reviewer JSON/u);
  });
}

test('rejects duplicate JSON keys, malformed JSON and invalid UTF-8', () => {
  for (const input of [
    Buffer.from('{"type":"error","type":"system","subtype":"ui_invalidate"}\n'),
    Buffer.from('provider diagnostic\n'), Buffer.from([0xff]),
  ]) expect(() => parseNativeReviewEvents(input, model)).toThrow();
});

test('rejects non-strict or contradictory semantic adjudication', () => {
  for (const invalidOutput of [
    '```json\n' + output + '\n```',
    output + '\nextra prose',
    output.replace('"quality":0.8', '"quality":0.8,"quality":1'),
    output.replace('"quality":0.8', '"quality":2'),
    output.replace('"quality":0.8', '"quality":1e999'),
    output.replace('"preference":"tie"', '"preference":"A","unexpected":true'),
  ]) {
    const stream = events();
    stream[2].message!.content[0].text = invalidOutput;
    stream[3].result = invalidOutput;
    expect(() => parseNativeReviewEvents(bytes(stream), model)).toThrow();
  }
});

function fixture(mode = 'ok') {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-native-review-test-')));
  roots.push(root);
  const binary = join(root, 'native-fixture');
  const log = join(root, 'calls.jsonl');
  const source = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const log = ${JSON.stringify(log)};
const record = { args, cwd: process.cwd(), env: process.env, pid: process.pid };
fs.appendFileSync(log, JSON.stringify(record) + '\\n');
if (args[0] === '--version') {
  if (mode === 'wrong-version') console.log('2.1.308 (Claude Code)');
  else if (mode === 'version-error') { console.error('DO_NOT_EXPOSE_PROVIDER_SECRET'); process.exitCode = 1; }
  else if (mode === 'version-hang') setInterval(() => {}, 1000);
  else console.log('2.1.309 (Claude Code)');
} else {
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    fs.appendFileSync(log, JSON.stringify({ stdin: Buffer.concat(chunks).toString('utf8') }) + '\\n');
    const events = ${JSON.stringify(events())};
    if (mode === 'hang') { setInterval(() => {}, 1000); return; }
    if (mode === 'descendant') {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      fs.appendFileSync(log, JSON.stringify({ descendantPid: child.pid, cwd: process.cwd() }) + '\\n');
      child.unref();
      process.exit(0);
    }
    if (mode === 'exit-error') { console.error('DO_NOT_EXPOSE_PROVIDER_SECRET'); console.log('PRIVATE_PROMPT_PAYLOAD'); process.exitCode = 1; return; }
    if (mode === 'stdout-overflow') { process.stdout.write('X'.repeat(1100000)); return; }
    if (mode === 'stderr-overflow') { process.stderr.write('S'.repeat(70000)); return; }
    if (mode === 'not-logged-in') { events[3].is_error = true; events[3].result = 'Not logged in'; }
    if (mode === 'tools') events[1].tools = ['Read'];
    if (mode === 'warn') console.error('unrecognized_model warning; DO_NOT_EXPOSE_PROVIDER_SECRET');
    for (const event of events) console.log(JSON.stringify(event));
  });
}
`;
  writeFileSync(binary, source, { mode: 0o700 });
  chmodSync(binary, 0o700);
  return { root, binary, log };
}

async function invoke(f: ReturnType<typeof fixture>, input = 'Anonymous sealed artifact fixture.', extra: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'kory-native-stateless-reviewer.ts'), '-p', 'IGNORED_ARGV_CONTEXT'], {
    cwd: resolve(import.meta.dir, '..'),
    env: {
      PATH: process.env.PATH,
      HOME: f.root,
      ANTHROPIC_API_KEY: 'fixture-api-key-not-real',
      ANTHROPIC_BASE_URL: 'https://fixture.invalid',
      ANTHROPIC_AUTH_TOKEN: 'DO_NOT_INHERIT_TOKEN',
      CLAUDE_CONFIG_DIR: 'DO_NOT_INHERIT_CONFIG',
      CLAUDE_CODE_TMPDIR: 'DO_NOT_INHERIT_TEMP',
      CLAUDE_CODE_API_KEY_HELPER: 'DO_NOT_RUN_HELPER',
      NODE_OPTIONS: '--no-warnings',
      PRIVATE_SENTINEL: 'DO_NOT_INHERIT_PRIVATE',
      KORY_NATIVE_REVIEW_BINARY: f.binary,
      KORY_NATIVE_REVIEW_MODEL: model,
      KORY_NATIVE_REVIEW_TIMEOUT_MS: '3000',
      ...extra,
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  child.stdin.write(input);
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

function calls(f: ReturnType<typeof fixture>): Array<Record<string, any>> {
  return existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}

test('passes only exact stdin and explicit no-tools flags through a private allowlisted HOME', async () => {
  const f = fixture();
  const prompt = 'Anonymous artifact A and B.\n$Source TeX$ remains exact.\n';
  const result = await invoke(f, prompt);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  const history = calls(f);
  expect(history).toHaveLength(3);
  expect(history[0].args).toEqual(['--version']);
  const execution = history[1];
  for (const flag of ['--bare', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--print']) expect(execution.args).toContain(flag);
  expect(execution.args[execution.args.indexOf('--tools') + 1]).toBe('');
  expect(execution.args[execution.args.indexOf('--model') + 1]).toBe(model);
  expect(execution.args[execution.args.indexOf('--max-turns') + 1]).toBe('1');
  expect(execution.args.join(' ')).not.toContain(prompt);
  expect(execution.args.join(' ')).not.toContain('IGNORED_ARGV_CONTEXT');
  expect(history[2].stdin).toBe(prompt);
  expect(execution.env.ANTHROPIC_API_KEY).toBe('fixture-api-key-not-real');
  expect(execution.env.ANTHROPIC_BASE_URL).toBe('https://fixture.invalid');
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'PRIVATE_SENTINEL', 'NODE_OPTIONS', 'CLAUDE_CODE_API_KEY_HELPER', 'KORY_NATIVE_REVIEW_BINARY', 'KORY_NATIVE_REVIEW_ARCHIVE_DIR', 'KORY_NATIVE_REVIEW_PENDING_ROOT', 'KORY_NATIVE_REVIEW_STAGE_SANDBOX', 'KORY_NATIVE_REVIEW_MODEL']) expect(execution.env[name]).toBeUndefined();
  expect(execution.env.HOME).toBe(execution.cwd);
  expect(execution.env.CLAUDE_CONFIG_DIR).toBe(execution.cwd);
  expect(execution.env.CLAUDE_CODE_TMPDIR).toBe(join(execution.cwd, 'temp'));
  expect(execution.env.TMPDIR).toBe(execution.cwd);
  expect(isContainedBy(resolve(import.meta.dir, '..'), execution.cwd)).toBe(false);
  expect(existsSync(execution.cwd)).toBe(false);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.reviewerId).toBe(`native-cli:${sessionId}`);
  expect(envelope.completed).toBe(true);
  expect(envelope.output).toBe(output);
  expect(envelope.events).toEqual([
    { type: 'review.started', reviewerId: envelope.reviewerId },
    { type: 'review.completed', reviewerId: envelope.reviewerId, outputSha256: createHash('sha256').update(output).digest('hex') },
  ]);
  expect(envelope.hostReceipt).toMatchObject({ stageOnly: true, signed: false, osIsolationVerified: false, upstreamIdentityVerified: false, upstreamCancellationAcknowledged: false, runtimeVersion: '2.1.309', tools: [], mcpServers: [], skills: [] });
  expect(envelope.hostReceipt.kernelStage).toEqual({ mode: 'none', enforcement: 'none' });
  expect(envelope.hostReceipt.promptSha256).toBe(createHash('sha256').update(prompt).digest('hex'));
  expect(envelope.hostReceipt.requestBytes).toBeLessThanOrEqual(MAX_NATIVE_REVIEW_REQUEST_BYTES);
  expect(result.stdout).not.toContain('fixture-api-key');
});

test('accepts actual sealed-packet scale under separate native reviewer bounds without truncation', async () => {
  expect(MAX_NATIVE_REVIEW_REQUEST_BYTES).toBe(128000);
  const f = fixture();
  const prompt = 'A'.repeat(62809);
  const result = await invoke(f, prompt);
  expect(result.code).toBe(0);
  expect(calls(f)[2].stdin).toBe(prompt);
  expect(JSON.parse(result.stdout).hostReceipt.requestBytes).toBeLessThanOrEqual(128000);
});

for (const mode of ['wrong-version', 'version-error', 'not-logged-in', 'tools', 'exit-error', 'stdout-overflow', 'stderr-overflow']) {
  test(`native fixture ${mode} emits no completed review or private diagnostics`, async () => {
    const f = fixture(mode);
    const result = await invoke(f);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('kory-native-stateless-reviewer: failed; diagnostics redacted. No completed review emitted.\n');
    expect(result.stderr).not.toContain('DO_NOT_EXPOSE');
    for (const call of calls(f)) if (call.cwd) expect(existsSync(call.cwd)).toBe(false);
    if (mode === 'wrong-version' || mode === 'version-error') expect(calls(f)).toHaveLength(1);
  });
}

test('redacted model warning does not override actual true successful completion', async () => {
  const result = await invoke(fixture('warn'));
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout).completed).toBe(true);
});

for (const [name, input, extra] of [
  ['empty stdin', '', {}],
  ['request too large', 'X'.repeat(MAX_NATIVE_REVIEW_REQUEST_BYTES + 1), {}],
  ['serialized request too large', '\\'.repeat(65000), {}],
  ['missing explicit model', 'fixture', { KORY_NATIVE_REVIEW_MODEL: '' }],
  ['missing API key', 'fixture', { ANTHROPIC_API_KEY: '' }],
  ['unsafe model', 'fixture', { KORY_NATIVE_REVIEW_MODEL: '../other' }],
  ['invalid budget', 'fixture', { KORY_NATIVE_REVIEW_TIMEOUT_MS: '0' }],
  ['invalid kernel stage', 'fixture', { KORY_NATIVE_REVIEW_STAGE_SANDBOX: 'pretend-sandbox' }],
  ['kernel stage missing protected HOME', 'fixture', { KORY_NATIVE_REVIEW_STAGE_SANDBOX: 'macos-private-roots', HOME: '' }],
  ['archive without kernel stage', 'fixture', { KORY_NATIVE_REVIEW_ARCHIVE_DIR: '/archive-must-not-be-used-unsandboxed' }],
  ['relative archive with kernel stage', 'fixture', { KORY_NATIVE_REVIEW_STAGE_SANDBOX: 'macos-private-roots', KORY_NATIVE_REVIEW_ARCHIVE_DIR: 'relative-archive', CLAUDE_CONFIG_DIR: '' }],
] as const) {
  test(`${name} refuses before any executable dispatch`, async () => {
    const f = fixture();
    const result = await invoke(f, input, extra);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(calls(f)).toHaveLength(0);
  });
}

const kernelModeTest = isMac() && existsSync('/usr/bin/sandbox-exec') ? test : test.skip;
kernelModeTest('opt-in kernel stage refuses unreadable protected fixture runtime without fallback', async () => {
  const f = fixture();
  const result = await invoke(f, 'fixture', {
    KORY_NATIVE_REVIEW_STAGE_SANDBOX: 'macos-private-roots',
    CLAUDE_CONFIG_DIR: f.root,
  });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(calls(f)).toHaveLength(0);
});

for (const mode of ['version-hang', 'hang', 'descendant']) {
  test(`shared caller deadline kills ${mode} and cleans private HOME`, async () => {
    const f = fixture(mode);
    const started = performance.now();
    const result = await invoke(f, 'fixture', { KORY_NATIVE_REVIEW_TIMEOUT_MS: '500' });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(performance.now() - started).toBeLessThan(2500);
    for (const call of calls(f)) {
      const pid = call.pid ?? call.descendantPid;
      if (!pid) continue;
      expect(existsSync(call.cwd)).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });
}
