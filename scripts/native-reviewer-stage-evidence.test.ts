import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalizePath, isContainedBy } from '../backend/src/runtime/platform';
import {
  archiveNativeStageBytes,
  createNativeArchiveDirectory,
  nativeArchiveDirectory,
  readBoundedNativeDescriptor,
  readNativeStageReference,
} from './native-reviewer-archive';
import {
  archiveNativeStageEvidence,
  verifyNativeStageArchives,
  verifyNativeStageEvidence,
} from './native-reviewer-stage-evidence';
import { NATIVE_REVIEW_SYSTEM_PROMPT } from './kory-native-stateless-reviewer.ts';
import { nativeMacStageProfile } from './native-reviewer-sandbox';
import { verifyNativeBlindReviewImport } from './blind-review-native-import';

const roots: string[] = [];
const projectRoot = canonicalizePath(resolve(import.meta.dir, '..'));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const model = 'native-fixture-model';
const prompt = 'Anonymous sealed fixture.\n$Exact source TeX$.\n';
const sessionId = 'fixture-session-1';
const score = {
  passed: true,
  quality: 0.8,
  verification: 0.7,
  integrityFailure: false,
  evidence: ['Anonymous source.'],
};
const output =
  JSON.stringify({
    artifactA: score,
    artifactB: score,
    preference: 'tie',
    rationale: ['No supported difference.'],
  }) + '\n';
const opaque = 'OPAQUE_NOT_BASE64_DO_NOT_DECODE';
const stream = Buffer.from(
  [
    {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model,
      tools: [],
      mcp_servers: [],
      skills: [],
    },
    {
      type: 'assistant',
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'redacted_thinking', data: opaque }] },
    },
    {
      type: 'assistant',
      session_id: sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: output }],
        stop_reason: 'end_turn',
      },
    },
    { type: 'result', session_id: sessionId, subtype: 'success', is_error: false, result: output },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n') + '\n\n',
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-native-archive-test-')));
  roots.push(root);
  return root;
}
function fixture() {
  const root = directory();
  const archive = createNativeArchiveDirectory(root);
  const privateRoot = join(root, 'deleted-model-home');
  const denies = ['/Users', '/Volumes', '/private/var/folders', '/private/tmp', root, projectRoot];
  const profile = Buffer.from(nativeMacStageProfile(privateRoot, [...new Set(denies)]));
  const rawEventArchive = archiveNativeStageBytes(
    archive,
    'native-cli-events.jsonl',
    stream,
    1_048_576,
  );
  const profileArchive = archiveNativeStageBytes(
    archive,
    'native-kernel-profile.sb',
    profile,
    64_000,
  );
  const request = JSON.stringify({ system: NATIVE_REVIEW_SYSTEM_PROMPT, prompt, model });
  const reviewerId = `native-cli:${sessionId}`;
  const response = {
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
      runtimeVersion: '2.1.309',
      identitySource: 'host-observed-native-cli-session-id',
      boundary: 'native-no-tools-bare-restricted-explicit-stdin',
      requestedModel: model,
      observedModel: model,
      tools: [],
      mcpServers: [],
      skills: [],
      promptSha256: hash(prompt),
      systemPromptSha256: hash(NATIVE_REVIEW_SYSTEM_PROMPT),
      requestSerialization: 'host-declared-system-prompt-model-not-upstream-wire',
      requestBytes: Buffer.byteLength(request),
      requestSha256: hash(request),
      responseSha256: hash(stream),
      responseBytes: stream.length,
      rawEventArchive,
      outputSha256: hash(output),
      osIsolationVerified: false,
      signed: false,
      upstreamIdentityVerified: false,
      upstreamCancellationAcknowledged: false,
      kernelStage: {
        mode: 'macos-private-roots',
        enforcement: 'sandbox-exec',
        privateRoot,
        readDenyRoots: [...new Set(denies)],
        protectedRoots: [projectRoot, archive],
        profileArchive,
        profileSha256: hash(profile),
        writableRoots: [privateRoot],
        writableDevice: '/dev/null',
        universalReadAllowlist: false,
        readPolicy: 'broad-runtime-reads-with-explicit-canonical-private-root-denies',
      },
    },
  };
  return { root, archive, response, profile, privateRoot };
}

test('creates distinct canonical private per-attempt directories and exact protected files', () => {
  const root = directory();
  const first = createNativeArchiveDirectory(root);
  const second = createNativeArchiveDirectory(root);
  expect(first).not.toBe(second);
  for (const path of [first, second]) {
    expect(isContainedBy(root, path)).toBe(true);
    expect(dirname(path)).toBe(root);
    expect(lstatSync(path).mode & 0o777).toBe(0o700);
    expect(nativeArchiveDirectory(path, join(root, 'model-home'), projectRoot)).toBe(path);
  }
  const ref = archiveNativeStageBytes(first, 'native-cli-events.jsonl', stream, 1_048_576);
  expect(ref).toEqual({
    path: join(first, 'native-cli-events.jsonl'),
    sha256: hash(stream),
    bytes: stream.length,
  });
  expect(lstatSync(ref.path).mode & 0o777).toBe(0o600);
  expect(readNativeStageReference(ref, first, 1_048_576).data.equals(stream)).toBe(true);
  expect(() =>
    archiveNativeStageBytes(first, 'native-cli-events.jsonl', stream, 1_048_576),
  ).toThrow();
});

test('native descriptor reads exact bounded bytes and rejects invalid limits or non-files', () => {
  const root = directory();
  const path = join(root, 'bounded');
  writeFileSync(path, 'fixture', { mode: 0o600 });
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const directoryFd = openSync(root, constants.O_RDONLY);
  try {
    expect(readBoundedNativeDescriptor(fd, 7).toString()).toBe('fixture');
    for (const maximum of [6, -1, NaN, Infinity, 1.5])
      expect(() => readBoundedNativeDescriptor(fd, maximum)).toThrow();
    expect(() => readBoundedNativeDescriptor(directoryFd, 100)).toThrow();
  } finally {
    closeSync(fd);
    closeSync(directoryFd);
  }
});

for (const mutation of ['grow', 'truncate'] as const)
  test(`native descriptor rejects concurrent ${mutation} with at most size plus one bytes read`, () => {
    const root = directory();
    const path = join(root, 'bounded');
    writeFileSync(path, 'fixture', { mode: 0o600 });
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const original = fs.readSync;
    const lengths: number[] = [];
    let changed = false;
    const read = spyOn(fs, 'readSync').mockImplementation(
      (
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offsetOrOptions?: number | fs.ReadOptions,
        length?: number,
        position?: fs.ReadPosition | null,
      ) => {
        if (typeof offsetOrOptions === 'number') lengths.push(length!);
        if (!changed) {
          changed = true;
          if (mutation === 'grow') appendFileSync(path, Buffer.alloc(100_000, 32));
          else truncateSync(path, 3);
        }
        return typeof offsetOrOptions === 'number'
          ? original(fd, buffer, offsetOrOptions, length!, position ?? null)
          : original(fd, buffer, offsetOrOptions);
      },
    );
    try {
      expect(() => readBoundedNativeDescriptor(fd, 7)).toThrow();
      expect(changed).toBe(true);
      expect(lengths[0]).toBe(8);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(8);
    } finally {
      read.mockRestore();
      closeSync(fd);
    }
  });

test('native archive opens are no-follow and nonblocking before descriptor verification', () => {
  const root = directory();
  const archive = createNativeArchiveDirectory(root);
  const ref = archiveNativeStageBytes(archive, 'native-cli-events.jsonl', stream, 1_048_576);
  const original = fs.openSync;
  const flags: number[] = [];
  const open = spyOn(fs, 'openSync').mockImplementation(
    (...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === ref.path) flags.push(args[1] as number);
      return original(...args);
    },
  );
  try {
    expect(readNativeStageReference(ref, archive, 1_048_576).data.equals(stream)).toBe(true);
    expect(flags).toHaveLength(1);
    expect(flags[0] & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(flags[0] & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  } finally {
    open.mockRestore();
  }
});

test('archive directories reject symlink components, overlap and broad permissions', () => {
  const root = directory();
  const archive = createNativeArchiveDirectory(root);
  const link = join(root, 'alias');
  symlinkSync(archive, link);
  expect(() => nativeArchiveDirectory(link, join(root, 'home'), projectRoot)).toThrow();
  expect(() => createNativeArchiveDirectory(link)).toThrow();
  expect(() => nativeArchiveDirectory(archive, root, projectRoot)).toThrow();
  expect(() => nativeArchiveDirectory(archive, join(archive, 'home'), projectRoot)).toThrow();
  expect(() => nativeArchiveDirectory(archive, join(root, 'home'), archive)).toThrow();
  chmodSync(archive, 0o755);
  expect(() =>
    archiveNativeStageBytes(archive, 'native-cli-events.jsonl', stream, 1_048_576),
  ).toThrow();
  chmodSync(root, 0o755);
  expect(() => createNativeArchiveDirectory(root)).toThrow();
});

test('archive files reject symlinks, hardlinks, foreign/nested refs, mutation and byte/hash mismatch', () => {
  const root = directory();
  const archive = createNativeArchiveDirectory(root);
  const ref = archiveNativeStageBytes(archive, 'native-cli-events.jsonl', stream, 1_048_576);
  for (const changed of [
    { ...ref, bytes: ref.bytes + 1 },
    { ...ref, sha256: '0'.repeat(64) },
    { ...ref, extra: true },
    { ...ref, path: join(root, 'foreign') },
    { ...ref, bytes: 1_048_577 },
  ]) {
    expect(() => readNativeStageReference(changed, archive, 1_048_576)).toThrow();
  }
  const nested = join(archive, 'nested');
  mkdirSync(nested, { mode: 0o700 });
  writeFileSync(join(nested, 'file'), stream, { mode: 0o600 });
  expect(() =>
    readNativeStageReference({ ...ref, path: join(nested, 'file') }, archive, 1_048_576),
  ).toThrow();
  const alias = join(archive, 'alias');
  symlinkSync(ref.path, alias);
  expect(() => readNativeStageReference({ ...ref, path: alias }, archive, 1_048_576)).toThrow();
  chmodSync(ref.path, 0o644);
  expect(() => readNativeStageReference(ref, archive, 1_048_576)).toThrow();
  chmodSync(ref.path, 0o600);
  linkSync(ref.path, join(archive, 'hardlink'));
  expect(() => readNativeStageReference(ref, archive, 1_048_576)).toThrow();
  rmSync(join(archive, 'hardlink'));
  writeFileSync(ref.path, Buffer.alloc(stream.length, 32));
  expect(() => readNativeStageReference(ref, archive, 1_048_576)).toThrow();
  expect(() =>
    archiveNativeStageBytes(archive, 'native-kernel-profile.sb', Buffer.alloc(0), 64_000),
  ).toThrow();
});

test('archives exact successful stream/profile and seals full completion without exposing opaque thinking', () => {
  const f = fixture();
  const stage = archiveNativeStageEvidence(f.response, f.archive, prompt, model, projectRoot);
  expect(Object.keys(stage).sort()).toEqual([
    'hostReceipt',
    'kernelProfile',
    'rawEvents',
    'schemaVersion',
    'sealedPrompt',
    'stageOnly',
  ]);
  expect(readFileSync(stage.rawEvents.path).equals(stream)).toBe(true);
  expect(readFileSync(stage.kernelProfile.path).equals(f.profile)).toBe(true);
  expect(readFileSync(stage.sealedPrompt.path, 'utf8')).toBe(prompt);
  const completion = JSON.parse(readFileSync(stage.hostReceipt.path, 'utf8'));
  expect(completion.output).toBe(output);
  expect(completion.hostReceipt.rawEventArchive).toEqual(stage.rawEvents);
  expect(completion.hostReceipt.kernelStage.profileArchive).toEqual(stage.kernelProfile);
  expect(JSON.stringify(completion)).not.toContain(opaque);
  expect(JSON.stringify(stage)).not.toContain(opaque);
  for (const ref of [stage.rawEvents, stage.hostReceipt, stage.sealedPrompt, stage.kernelProfile])
    expect(lstatSync(ref.path).mode & 0o777).toBe(0o600);
  verifyNativeStageEvidence(
    stage,
    f.archive,
    prompt,
    model,
    projectRoot,
    output,
    f.response.reviewerId,
  );
  expect(() =>
    verifyNativeStageEvidence(
      stage,
      f.archive,
      prompt,
      model,
      projectRoot,
      output + '\n',
      f.response.reviewerId,
    ),
  ).toThrow();
  expect(() =>
    verifyNativeStageEvidence(
      stage,
      f.archive,
      prompt,
      model,
      projectRoot,
      output,
      'native-cli:foreign',
    ),
  ).toThrow();
  writeFileSync(stage.sealedPrompt.path, prompt + 'changed');
  expect(() =>
    verifyNativeStageEvidence(
      stage,
      f.archive,
      prompt,
      model,
      projectRoot,
      output,
      f.response.reviewerId,
    ),
  ).toThrow();
});

test('approved archive envelope passes the independent importer with exact stream output', () => {
  const f = fixture();
  const stage = archiveNativeStageEvidence(f.response, f.archive, prompt, model, projectRoot);
  const input = {
    stage,
    reviewer: { agentId: f.response.reviewerId, model },
    output,
    promptSha256: hash(prompt),
    requiredProtectedRoots: [projectRoot, f.archive],
  };
  const verified = verifyNativeBlindReviewImport(input);
  expect(verified.provenance.sessionId).toBe(sessionId);
  expect(verified.provenance.upstreamIdentityVerified).toBe(false);
  expect(
    verified.files.find((file) => file.name === 'native-cli-events.jsonl')!.bytes.equals(stream),
  ).toBe(true);
  expect(
    verified.files
      .find((file) => file.name === 'native-kernel-profile.sb')!
      .bytes.equals(f.profile),
  ).toBe(true);
  expect(() => verifyNativeBlindReviewImport({ ...input, output: output + '\n' })).toThrow();
});

const mutations: Array<[string, (response: ReturnType<typeof fixture>['response']) => void]> = [
  [
    'session',
    (r) => {
      r.reviewerId = 'native-cli:foreign';
    },
  ],
  [
    'output newline',
    (r) => {
      r.output += '\n';
    },
  ],
  [
    'completion event',
    (r) => {
      r.events[1].outputSha256 = '0'.repeat(64);
    },
  ],
  [
    'runtime',
    (r) => {
      r.hostReceipt.runtimeVersion = '2.1.308';
    },
  ],
  [
    'model',
    (r) => {
      r.hostReceipt.observedModel = 'other';
    },
  ],
  [
    'prompt',
    (r) => {
      r.hostReceipt.promptSha256 = '0'.repeat(64);
    },
  ],
  [
    'system prompt',
    (r) => {
      r.hostReceipt.systemPromptSha256 = '0'.repeat(64);
    },
  ],
  [
    'request hash',
    (r) => {
      r.hostReceipt.requestSha256 = '0'.repeat(64);
    },
  ],
  [
    'request size',
    (r) => {
      r.hostReceipt.requestBytes++;
    },
  ],
  [
    'response hash',
    (r) => {
      r.hostReceipt.responseSha256 = '0'.repeat(64);
    },
  ],
  [
    'tools',
    (r) => {
      r.hostReceipt.tools.push('Read' as never);
    },
  ],
  [
    'stage posture',
    (r) => {
      r.hostReceipt.stageOnly = false;
    },
  ],
  [
    'identity overclaim',
    (r) => {
      r.hostReceipt.upstreamIdentityVerified = true;
    },
  ],
  [
    'no kernel',
    (r) => {
      r.hostReceipt.kernelStage.mode = 'none';
    },
  ],
  [
    'profile hash',
    (r) => {
      r.hostReceipt.kernelStage.profileSha256 = '0'.repeat(64);
    },
  ],
  [
    'writable root',
    (r) => {
      r.hostReceipt.kernelStage.writableRoots = ['/'];
    },
  ],
  [
    'protected roots',
    (r) => {
      r.hostReceipt.kernelStage.protectedRoots = [];
    },
  ],
  [
    'standard denies',
    (r) => {
      r.hostReceipt.kernelStage.readDenyRoots.shift();
    },
  ],
];
for (const [name, mutate] of mutations)
  test(`rejects altered native stage ${name} before sealing`, () => {
    const f = fixture();
    mutate(f.response);
    expect(() =>
      archiveNativeStageEvidence(f.response, f.archive, prompt, model, projectRoot),
    ).toThrow();
  });

test('reparses stream and profile bytes even when a forged receipt recalculates their digests', () => {
  const f = fixture();
  const forged = Buffer.from(stream.toString('utf8').replace('"tools":[]', '"tools":["Read"]'));
  const path = f.response.hostReceipt.rawEventArchive.path;
  writeFileSync(path, forged);
  f.response.hostReceipt.rawEventArchive = { path, sha256: hash(forged), bytes: forged.length };
  f.response.hostReceipt.responseSha256 = hash(forged);
  f.response.hostReceipt.responseBytes = forged.length;
  expect(() =>
    verifyNativeStageArchives(f.response, f.archive, prompt, model, projectRoot),
  ).toThrow();
  const profileFixture = fixture();
  const profile = Buffer.from('(version 1)\n(allow default)');
  const profilePath = profileFixture.response.hostReceipt.kernelStage.profileArchive.path;
  writeFileSync(profilePath, profile);
  profileFixture.response.hostReceipt.kernelStage.profileArchive = {
    path: profilePath,
    sha256: hash(profile),
    bytes: profile.length,
  };
  profileFixture.response.hostReceipt.kernelStage.profileSha256 = hash(profile);
  expect(() =>
    verifyNativeStageArchives(
      profileFixture.response,
      profileFixture.archive,
      prompt,
      model,
      projectRoot,
    ),
  ).toThrow();
});
