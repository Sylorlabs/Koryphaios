import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  closeSync,
  constants,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillEvaluationRun } from '../backend/src/kory/skill-evaluations';
import { canonicalizePath } from '../backend/src/runtime/platform';
import {
  anonymousArtifact,
  blindImportSha256 as sha,
  MAX_BLIND_IMPORT_BYTES,
  readBoundedBlindDescriptor,
  readBoundedBlindFile,
  SNAPSHOT_HASH_EXPLANATION,
  verifiedSnapshotText,
  verifyPreparedArtifactHashes,
  verifyPreparedCurrentBinding,
  verifyPreparedPromptBinding,
  writeProtectedBlindFile,
} from './blind-review-import-validation';

const roots: string[] = [];
function root() {
  const path = canonicalizePath(mkdtempSync(join(tmpdir(), 'blind-import-snapshot-test-')));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fileHash(text: string) {
  return sha(`file\0${text}`);
}
function arm() {
  const path = root();
  mkdirSync(join(path, 'before-files'));
  mkdirSync(join(path, 'files'));
  const before = 'initial bytes';
  const after = 'new bytes';
  writeFileSync(join(path, 'before-files', 'file.txt'), before);
  writeFileSync(join(path, 'files', 'file.txt'), after);
  const manifest = {
    changes: [
      {
        path: 'file.txt',
        change: 'modified',
        beforeSha256: fileHash(before),
        afterSha256: fileHash(after),
      },
    ],
    evidence: ['Host observation'],
    score: { evidence: ['artifactSHA uses raw bytes'] },
  };
  const manifestPath = join(path, 'run-manifest.json');
  const outputPath = join(path, 'final-output.txt');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(outputPath, 'Candidate output');
  const run = {
    id: 'fixture-arm',
    skill: 'fixture-skill',
    artifacts: [
      { kind: 'report', location: manifestPath, sha256: sha(readFileSync(manifestPath)) },
      { kind: 'report', location: outputPath, sha256: sha(readFileSync(outputPath)) },
    ],
  } as SkillEvaluationRun;
  return { path, before, after, manifest, manifestPath, outputPath, run };
}

test('anonymousArtifact preserves original JSON binding for legitimate before/after snapshots', () => {
  const fixture = arm();
  const artifact = anonymousArtifact(fixture.run, 'fixture-skill');
  expect(artifact).toMatchObject({
    finalOutput: 'Candidate output',
    executionEvidence: ['Host observation', 'artifactSHA uses raw bytes'],
    changes: [
      {
        path: 'file.txt',
        change: 'modified',
        beforeSha256: fileHash(fixture.before),
        afterSha256: fileHash(fixture.after),
        beforeText: fixture.before,
        afterText: fixture.after,
      },
    ],
  });
  verifyPreparedArtifactHashes(
    {
      artifactASha256: sha(JSON.stringify(artifact)),
      artifactBSha256: sha(JSON.stringify(artifact)),
    },
    artifact,
    artifact,
  );
});

test.each(['before-files', 'files'])(
  'rejects changed %s snapshot bytes despite an unchanged manifest/output',
  (directory) => {
    const fixture = arm();
    writeFileSync(join(fixture.path, directory, 'file.txt'), 'forged snapshot bytes');
    expect(() => anonymousArtifact(fixture.run, 'fixture-skill')).toThrow(
      'domain-tagged hash mismatch',
    );
  },
);

test.each(['before-files', 'files'])(
  'rejects missing %s snapshots even when reviewer text budget is zero',
  (directory) => {
    const fixture = arm();
    rmSync(join(fixture.path, directory, 'file.txt'));
    expect(() =>
      verifiedSnapshotText(
        join(fixture.path, directory),
        'file.txt',
        fileHash(directory === 'files' ? fixture.after : fixture.before),
        0,
      ),
    ).toThrow('Missing or invalid');
  },
);

test('raw scorer digest cannot masquerade as a domain-tagged snapshot digest', () => {
  const path = root();
  writeFileSync(join(path, 'file.txt'), 'bytes');
  expect(() => verifiedSnapshotText(path, 'file.txt', sha('bytes'), 100)).toThrow('domain-tagged');
  expect(verifiedSnapshotText(path, 'file.txt', fileHash('bytes'), 100)).toBe('bytes');
});

test('snapshots beyond the visible truncation budget still verify their full bytes', () => {
  const path = root();
  const bytes = 'a'.repeat(21_000);
  writeFileSync(join(path, 'file.txt'), bytes);
  expect(verifiedSnapshotText(path, 'file.txt', fileHash(bytes), 20_000)).toHaveLength(20_000);
  writeFileSync(join(path, 'file.txt'), `${bytes.slice(0, -1)}b`);
  expect(() => verifiedSnapshotText(path, 'file.txt', fileHash(bytes), 20_000)).toThrow(
    'domain-tagged',
  );
});

test('symlink snapshots hash link targets without reading outside source evidence', () => {
  const path = root();
  const outside = root();
  writeFileSync(join(outside, 'secret.txt'), 'never read');
  const target = join(outside, 'secret.txt');
  symlinkSync(target, join(path, 'link'));
  expect(verifiedSnapshotText(path, 'link', sha(`symlink\0${target}`), 100)).toBeUndefined();
  expect(() => verifiedSnapshotText(path, 'link', fileHash('never read'), 100)).toThrow(
    'domain-tagged',
  );
});

test.each(['../escape', '/absolute', '.', 'sub/../../escape'])(
  'rejects traversal snapshot path %s',
  (path) => {
    expect(() => verifiedSnapshotText(root(), path, null, 10)).toThrow('Invalid blind snapshot');
  },
);

test('rejects parent-directory symlinks and unbound added/deleted content', () => {
  const path = root();
  const outside = root();
  writeFileSync(join(outside, 'file'), 'bytes');
  symlinkSync(outside, join(path, 'linked'));
  expect(() => verifiedSnapshotText(path, 'linked/file', fileHash('bytes'), 10)).toThrow('parent');
  writeFileSync(join(path, 'unbound'), 'bytes');
  expect(() => verifiedSnapshotText(path, 'unbound', null, 10)).toThrow('no bound hash');
});

test.each(['A', 'B'])(
  'rejects stale or forged prepared artifact %s hash even with legitimate source',
  (label) => {
    const fixture = arm();
    const artifact = anonymousArtifact(fixture.run, 'fixture-skill');
    const digest = sha(JSON.stringify(artifact));
    const prepared = {
      artifactASha256: label === 'A' ? '0'.repeat(64) : digest,
      artifactBSha256: label === 'B' ? '0'.repeat(64) : digest,
    };
    expect(() => verifyPreparedArtifactHashes(prepared, artifact, artifact)).toThrow(
      'artifact hash mismatch',
    );
  },
);

test('a rewritten manifest cannot evade the immutable anonymous-artifact seal', () => {
  const fixture = arm();
  const artifact = anonymousArtifact(fixture.run, 'fixture-skill');
  const prepared = {
    artifactASha256: sha(JSON.stringify(artifact)),
    artifactBSha256: sha(JSON.stringify(artifact)),
  };
  fixture.manifest.changes[0]!.afterSha256 = fileHash('rewritten');
  writeFileSync(join(fixture.path, 'files', 'file.txt'), 'rewritten');
  writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
  fixture.run.artifacts![0]!.sha256 = sha(readFileSync(fixture.manifestPath));
  expect(() =>
    verifyPreparedArtifactHashes(
      prepared,
      anonymousArtifact(fixture.run, 'fixture-skill'),
      artifact,
    ),
  ).toThrow('artifact hash mismatch');
});

test('new sealed prompt explanation distinguishes snapshot/scorer/full-versus-visible hash domains generically', () => {
  expect(SNAPSHOT_HASH_EXPLANATION).toContain('file\\0');
  expect(SNAPSHOT_HASH_EXPLANATION).toContain('symlink\\0');
  expect(SNAPSHOT_HASH_EXPLANATION).toContain('SHA256(raw bytes)');
  expect(SNAPSHOT_HASH_EXPLANATION).toContain('bounded or privacy-scrubbed');
});

test.each(['manifest', 'output'])(
  'missing %s digest does not silently qualify source evidence',
  (label) => {
    const f = arm();
    delete f.run.artifacts![label === 'manifest' ? 0 : 1]!.sha256;
    expect(() => anonymousArtifact(f.run, 'fixture-skill')).toThrow('artifact hash mismatch');
  },
);

test.each(['manifest', 'output'])(
  'durable %s leaf symlink is rejected before reading private content',
  (label) => {
    const f = arm();
    const path = label === 'manifest' ? f.manifestPath : f.outputPath;
    const target = join(root(), 'private');
    writeFileSync(target, readFileSync(path));
    rmSync(path);
    symlinkSync(target, path);
    expect(() => anonymousArtifact(f.run, 'fixture-skill')).toThrow('symlink');
  },
);

test('symlink ancestry above a snapshot or report root cannot bypass containment', () => {
  const f = arm();
  const aliasRoot = root();
  symlinkSync(f.path, join(aliasRoot, 'alias'));
  expect(() =>
    verifiedSnapshotText(join(aliasRoot, 'alias', 'files'), 'file.txt', fileHash(f.after), 10),
  ).toThrow('symlink');
  f.run.artifacts![0]!.location = join(aliasRoot, 'alias', 'run-manifest.json');
  expect(() => anonymousArtifact(f.run, 'fixture-skill')).toThrow('symlink');
});

test.each([
  'duplicate-path',
  'null-entry',
  'invalid-path',
  'invalid-change',
  'unbound-modified',
  'wrong-added',
  'wrong-deleted',
])('malformed snapshot record %s cannot be silently omitted', (mutation) => {
  const f = arm();
  const changes: any[] = f.manifest.changes;
  if (mutation === 'duplicate-path') changes.push({ ...changes[0] });
  if (mutation === 'null-entry') changes.push(null);
  if (mutation === 'invalid-path') changes[0].path = 17;
  if (mutation === 'invalid-change') changes[0].change = 'invented';
  if (mutation === 'unbound-modified') changes[0].afterSha256 = null;
  if (mutation === 'wrong-added') changes[0].change = 'added';
  if (mutation === 'wrong-deleted') changes[0].change = 'deleted';
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  f.run.artifacts![0]!.sha256 = sha(readFileSync(f.manifestPath));
  expect(() => anonymousArtifact(f.run, 'fixture-skill')).toThrow('change manifest');
});

test('regular-file reads reject oversized sparse files before allocating their contents', () => {
  const path = join(root(), 'oversized');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
  try {
    ftruncateSync(fd, MAX_BLIND_IMPORT_BYTES + 1);
    expect(() => readBoundedBlindDescriptor(fd, MAX_BLIND_IMPORT_BYTES)).toThrow('bounded');
    expect(() => readBoundedBlindFile(path, MAX_BLIND_IMPORT_BYTES)).toThrow('bounded');
  } finally {
    closeSync(fd);
  }
});

test('a full snapshot byte budget applies even when its visible text budget is exhausted', () => {
  const path = root();
  writeFileSync(join(path, 'file.txt'), 'four');
  expect(() =>
    verifiedSnapshotText(path, 'file.txt', fileHash('four'), 0, { remainingBytes: 3 }),
  ).toThrow('bounded');
});

test.each(['file-mode', 'hardlink', 'parent-mode'])(
  'private prepared artifact reads enforce %s',
  (mutation) => {
    const path = root();
    const file = join(path, 'prepared.json');
    writeFileSync(file, '{}', { mode: 0o600 });
    if (mutation === 'file-mode') chmodSync(file, 0o644);
    if (mutation === 'hardlink') linkSync(file, join(path, 'linked'));
    if (mutation === 'parent-mode') chmodSync(path, 0o755);
    expect(() => readBoundedBlindFile(file, 100, true)).toThrow('protected');
  },
);

test('durable private writes persist 0600 bytes and never overwrite prior artifacts or follow a leaf symlink', () => {
  const path = root();
  const file = join(path, 'assignment.json');
  const bytes = Buffer.from('{"assignment":true}');
  expect(writeProtectedBlindFile(file, bytes)).toBe(sha(bytes));
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
  expect(() => writeProtectedBlindFile(file, Buffer.from('replacement'))).toThrow();
  expect(readFileSync(file)).toEqual(bytes);
  symlinkSync(file, join(path, 'alias.json'));
  expect(() =>
    writeProtectedBlindFile(join(path, 'alias.json'), Buffer.from('replacement')),
  ).toThrow();
  expect(readFileSync(file)).toEqual(bytes);
});

test.each([
  'revisionHash',
  'suiteId',
  'evaluationContractHash',
  'evaluationContractVersion',
  'materializerId',
  'deterministicScorerId',
  'skill',
  'scenarioId',
  'pairId',
  'withIsA',
])('prepared %s metadata must bind the exact current eligible pair', (key) => {
  const run = {
    skill: 's',
    scenarioId: 'task',
    comparisonId: 'pair',
    revisionHash: 'rev',
    suiteId: 'suite',
    evaluationContractHash: 'contract',
    evaluationContractVersion: 3,
    materializerId: 'materializer',
    deterministicScorerId: 'scorer',
  } as SkillEvaluationRun;
  const prepared: any = { ...run, pairId: run.comparisonId, withIsA: false };
  expect(() => verifyPreparedCurrentBinding(prepared, run)).not.toThrow();
  prepared[key] = key === 'withIsA' ? 'false' : key === 'evaluationContractVersion' ? 4 : 'forged';
  expect(() => verifyPreparedCurrentBinding(prepared, run)).toThrow('exact current eligible');
});

test.each(['task-prompt.txt', 'README.md', 'contract.json'])(
  'public-contract %s is a bounded no-follow archive read',
  (name) => {
    const f = arm();
    const directory = join(f.path, 'public-contract');
    mkdirSync(directory);
    const entry = (text: string) => ({
      available: true,
      sha256: sha(text),
      byteLength: Buffer.byteLength(text),
      text,
    });
    const manifest: any = {
      ...f.manifest,
      publicContractSnapshot: {
        taskPrompt: entry('task'),
        fixtureFiles: { 'README.md': entry('readme'), 'contract.json': entry('{}') },
      },
    };
    for (const [file, text] of [
      ['task-prompt.txt', 'task'],
      ['README.md', 'readme'],
      ['contract.json', '{}'],
    ])
      writeFileSync(join(directory, file!), text!);
    writeFileSync(f.manifestPath, JSON.stringify(manifest));
    f.run.artifacts![0]!.sha256 = sha(readFileSync(f.manifestPath));
    expect(() => anonymousArtifact(f.run, 'fixture-skill')).not.toThrow();
    const target = join(root(), name);
    writeFileSync(target, readFileSync(join(directory, name)));
    rmSync(join(directory, name));
    symlinkSync(target, join(directory, name));
    expect(() => anonymousArtifact(f.run, 'fixture-skill')).toThrow('symlink');
  },
);

test('immutable historical guidance prefixes are accepted only with the same exact task/A/B tail', () => {
  const tail =
    '\nTASK\nexact task\nARTIFACT A\n{"finalOutput":"A"}\nARTIFACT B\n{"finalOutput":"B"}';
  expect(() =>
    verifyPreparedPromptBinding(`Historical instructions${tail}`, `New instructions${tail}`),
  ).not.toThrow();
  expect(() =>
    verifyPreparedPromptBinding(
      `Historical instructions${tail}`,
      `New instructions${tail.replace('"B"', '"changed"')}`,
    ),
  ).toThrow('exact current anonymous');
  expect(() =>
    verifyPreparedPromptBinding('Arbitrary same-hash sealed prompt', `New instructions${tail}`),
  ).toThrow('exact current anonymous');
});
