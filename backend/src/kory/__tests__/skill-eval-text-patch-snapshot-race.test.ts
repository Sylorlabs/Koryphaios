import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalizePath, findExecutableOnPath, isUnix } from '../../runtime/platform';
import { snapshotSkillEvalWorkspace } from '../../eval/skills/skill-eval-text-patch';

const roots: string[] = [];
const mkfifoBinary = findExecutableOnPath('mkfifo');
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-snapshot-race-')));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  const path = join(workspace, 'parent', 'sub', 'probe.txt');
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(outside, 'parent', 'sub'), { recursive: true });
  writeFileSync(path, 'ORIGINAL_PUBLIC_DATA');
  writeFileSync(join(outside, 'parent', 'sub', 'probe.txt'), 'OUTSIDE_CONTENT_CANARY');
  writeFileSync(
    join(outside, 'parent', 'sub', 'OUTSIDE_FILENAME_CANARY.txt'),
    'OUTSIDE_CONTENT_CANARY',
  );
  return { root, workspace, outside, path };
}

async function racedSnapshot(f: ReturnType<typeof fixture>, mode: string) {
  const source = `
import { mock } from 'bun:test';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const { workspace, outside, path, mode, mkfifoBinary } = JSON.parse(await Bun.stdin.text());
const originalLstat = fs.lstatSync;
const originalReaddir = fs.readdirSync;
let swapped = false;
function swap() {
  if (swapped) return;
  swapped = true;
  if (mode === 'fifo') {
    fs.rmSync(path);
    const result = spawnSync(mkfifoBinary, [path], { timeout: 500, stdio: 'ignore' });
    if (result.error || result.status !== 0) throw new Error('FIFO setup failed');
  } else if (mode === 'growth') {
    fs.writeFileSync(path, 'GROWTH_CONTENT_CANARY'.repeat(10000));
  } else if (mode === 'replacement') {
    fs.renameSync(path, path + '.original');
    fs.writeFileSync(path, 'REPLACEMENT_CONTENT_CANARY');
  } else {
    const target = mode === 'leaf-symlink' ? path :
      mode === 'root-swap' ? workspace :
      mode === 'ancestor-swap' ? join(workspace, 'parent') : dirname(path);
    const destination = mode === 'leaf-symlink' ? join(outside, 'parent', 'sub', 'probe.txt') :
      mode === 'root-swap' ? outside :
      mode === 'ancestor-swap' ? join(outside, 'parent') : join(outside, 'parent', 'sub');
    fs.renameSync(target, target + '.original');
    fs.symlinkSync(destination, target, mode === 'leaf-symlink' ? 'file' : 'dir');
  }
  process.stdout.write('snapshot-replaced\\n');
}
mock.module('node:fs', () => ({ ...fs,
  lstatSync(...args) {
    const stat = originalLstat(...args);
    if (mode !== 'directory-list' && String(args[0]) === path) swap();
    return stat;
  },
  readdirSync(...args) {
    if (mode === 'directory-list' && String(args[0]) === dirname(path)) swap();
    return originalReaddir(...args);
  },
}));
const { snapshotSkillEvalWorkspace } = await import(${JSON.stringify(resolve(import.meta.dir, '../../eval/skills/skill-eval-text-patch.ts'))});
process.stdout.write(JSON.stringify({ snapshot: snapshotSkillEvalWorkspace(workspace) }) + '\\n');
`;
  const child = Bun.spawn([process.execPath, '-e', source], {
    cwd: f.root,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(JSON.stringify({ ...f, mode, mkfifoBinary }));
  child.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 1_200);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await child.exited;
  }
}

describe('text-patch workspace snapshot bounded reads', () => {
  test
    .skipIf(!isUnix())
    .each([
      'leaf-symlink',
      'growth',
      'replacement',
      'parent-swap',
      'ancestor-swap',
      'root-swap',
      'directory-list',
    ])('does not publish post-observation %s bytes or outside metadata', async (mode) => {
    const result = await racedSnapshot(fixture(), mode);
    expect(result.stdout).toContain('snapshot-replaced\n');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('OUTSIDE_CONTENT_CANARY');
    expect(result.stdout).not.toContain('OUTSIDE_FILENAME_CANARY');
    expect(result.stdout).not.toContain('GROWTH_CONTENT_CANARY');
    expect(result.stdout).not.toContain('REPLACEMENT_CONTENT_CANARY');
  });

  test.skipIf(!isUnix() || !mkfifoBinary)(
    'rejects a post-lstat FIFO without blocking the host',
    async () => {
      const result = await racedSnapshot(fixture(), 'fifo');
      expect(result.stdout).toContain('snapshot-replaced\n');
      expect(result.stderr).toBe('');
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('content omitted');
    },
  );

  test('omits invalid UTF-8 instead of inventing replacement text', () => {
    const f = fixture();
    writeFileSync(f.path, Buffer.from([0xff]));
    const snapshot = snapshotSkillEvalWorkspace(f.workspace);
    expect(snapshot).toContain(
      'FILE parent/sub/probe.txt (1 bytes; binary or too large; content omitted)',
    );
    expect(snapshot).not.toContain('�');
  });

  test('preserves exact valid UTF-8, byte limits, omission labels and skipped directories', () => {
    const f = fixture();
    rmSync(join(f.workspace, 'parent'), { recursive: true });
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      writeFileSync(join(f.workspace, name), 'x'.repeat(120_000));
    }
    writeFileSync(join(f.workspace, 'e-large.txt'), 'x'.repeat(120_001));
    writeFileSync(join(f.workspace, 'f-binary.txt'), Buffer.from([0]));
    mkdirSync(join(f.workspace, '.git'));
    writeFileSync(join(f.workspace, '.git', 'secret'), 'SKIPPED_METADATA_CANARY');
    const snapshot = snapshotSkillEvalWorkspace(f.workspace);
    const contents = [
      ...snapshot.matchAll(/<kory-file-content>\n([\s\S]*?)\n<\/kory-file-content>/gu),
    ];
    expect(contents.reduce((sum, match) => sum + Buffer.byteLength(match[1]!), 0)).toBe(400_000);
    expect(snapshot).toContain('FILE d.txt (120000 bytes; truncated)');
    expect(snapshot).not.toContain('SKIPPED_METADATA_CANARY');
    // Separate file-limit controls are visible before the total-byte limit is exhausted.
    rmSync(join(f.workspace, 'a.txt'));
    rmSync(join(f.workspace, 'b.txt'));
    rmSync(join(f.workspace, 'c.txt'));
    rmSync(join(f.workspace, 'd.txt'));
    writeFileSync(join(f.workspace, 'a-utf8.txt'), '﻿héllo 新 😀\n');
    const exact = snapshotSkillEvalWorkspace(f.workspace);
    expect(exact).toContain('﻿héllo 新 😀\n');
    expect(exact).toContain(
      'FILE e-large.txt (120001 bytes; binary or too large; content omitted)',
    );
    expect(exact).toContain('FILE f-binary.txt (1 bytes; binary or too large; content omitted)');
  });

  test('truncates only complete UTF-8 code points at the total-byte boundary', () => {
    const f = fixture();
    rmSync(join(f.workspace, 'parent'), { recursive: true });
    for (const name of ['a.txt', 'b.txt', 'c.txt'])
      writeFileSync(join(f.workspace, name), 'x'.repeat(120_000));
    writeFileSync(join(f.workspace, 'd.txt'), 'x'.repeat(39_997));
    writeFileSync(join(f.workspace, 'e.txt'), '😀');
    const snapshot = snapshotSkillEvalWorkspace(f.workspace);
    expect(snapshot).toContain(
      'FILE e.txt (4 bytes; truncated)\n<kory-file-content>\n\n</kory-file-content>',
    );
    expect(snapshot).not.toContain('\uD83D');
  });
});
