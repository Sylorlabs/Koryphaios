// Tests for the OS-level sandbox and argv-only execution path.
// These verify that the new trust boundary (no shell string interpretation)
// blocks the bypasses the old regex sandbox allowed.

import { describe, it, expect } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizePath, findExecutableOnPath, isMac, isUnix } from '../../runtime/platform';
import { tokenizeCommand, resolveCommandPath } from '../../runtime/shell-argv';
import {
  osSandboxEnabled,
  osSandboxAvailable,
  detectOsSandbox,
  defaultAllowedRoots,
  spawnSandboxed,
} from '../os-sandbox';

describe('shell-argv tokenizer', () => {
  it('tokenizes a simple command', () => {
    const { argv, needsShell } = tokenizeCommand('git status');
    expect(argv).toEqual(['git', 'status']);
    expect(needsShell).toBe(false);
  });

  it('preserves quoted arguments literally', () => {
    const { argv, needsShell } = tokenizeCommand("echo 'hello world'");
    expect(argv).toEqual(['echo', 'hello world']);
    expect(needsShell).toBe(false);
  });

  it('handles double quotes with escapes', () => {
    const { argv } = tokenizeCommand('echo "say \\"hi\\""');
    expect(argv).toEqual(['echo', 'say "hi"']);
  });

  it('detects pipes as shell features', () => {
    const { needsShell, shellFeatures } = tokenizeCommand('cat file | grep pattern');
    expect(needsShell).toBe(true);
    expect(shellFeatures).toContain('|');
  });

  it('detects && as a shell feature', () => {
    const { needsShell, shellFeatures } = tokenizeCommand('npm test && npm run build');
    expect(needsShell).toBe(true);
    expect(shellFeatures).toContain('&&');
  });

  it('detects output redirection as a shell feature', () => {
    const { needsShell, shellFeatures } = tokenizeCommand('echo hello > file.txt');
    expect(needsShell).toBe(true);
    expect(shellFeatures).toContain('>');
  });

  it('detects semicolons as a shell feature', () => {
    const { needsShell, shellFeatures } = tokenizeCommand('ls; rm -rf /');
    expect(needsShell).toBe(true);
    expect(shellFeatures).toContain(';');
  });

  it('passes command substitution literally (no shell to interpret it)', () => {
    // $(...) is passed as literal characters — no shell interprets it.
    // This is the key security property: the old `bash -c` path would
    // execute the substitution; argv-only passes it as text.
    const { argv, needsShell } = tokenizeCommand('echo $(rm -rf /)');
    expect(argv).toEqual(['echo', '$(rm', '-rf', '/)']);
    expect(needsShell).toBe(false);
  });

  it('passes backticks literally', () => {
    const { argv } = tokenizeCommand('echo `cat /etc/passwd`');
    expect(argv).toEqual(['echo', '`cat', '/etc/passwd`']);
  });

  it('handles backslash escapes outside quotes', () => {
    const { argv } = tokenizeCommand('echo hello\\ world');
    expect(argv).toEqual(['echo', 'hello world']);
  });

  it('strips comments at token start', () => {
    const { argv } = tokenizeCommand('echo hello # this is a comment');
    expect(argv).toEqual(['echo', 'hello']);
  });

  it('handles empty command', () => {
    const { argv, needsShell } = tokenizeCommand('');
    expect(argv).toEqual([]);
    expect(needsShell).toBe(false);
  });

  it('detects unterminated single quote', () => {
    const { needsShell, shellFeatures } = tokenizeCommand("echo 'unterminated");
    expect(needsShell).toBe(true);
    expect(shellFeatures).toContain('unterminated-quote');
  });

  it('detects &> (redirect stdout+stderr)', () => {
    const { needsShell, shellFeatures } = tokenizeCommand('cmd &> file.txt');
    expect(needsShell).toBe(true);
    expect(shellFeatures).toContain('&>');
  });

  it('detects >| (force overwrite redirect)', () => {
    const { needsShell, shellFeatures } = tokenizeCommand('cmd >| file.txt');
    expect(needsShell).toBe(true);
    expect(shellFeatures).toContain('>|');
  });

  it('detects <<< (here-string)', () => {
    const { needsShell, shellFeatures } = tokenizeCommand('cat <<< "hello"');
    expect(needsShell).toBe(true);
    expect(shellFeatures).toContain('<<<');
  });

  it('detects <( (process substitution)', () => {
    const { needsShell, shellFeatures } = tokenizeCommand('diff <(ls a) <(ls b)');
    expect(needsShell).toBe(true);
    expect(shellFeatures).toContain('<(');
  });

  it('detects >() (process substitution output)', () => {
    const { needsShell, shellFeatures } = tokenizeCommand('tee >(grep foo)');
    expect(needsShell).toBe(true);
    expect(shellFeatures).toContain('>(');
  });

  it('detects <> (read-write redirect)', () => {
    const { needsShell, shellFeatures } = tokenizeCommand('cmd <> file.txt');
    expect(needsShell).toBe(true);
    expect(shellFeatures).toContain('<>');
  });

  it('handles nested quotes', () => {
    const { argv } = tokenizeCommand('echo "he said \'hello\'"');
    expect(argv).toEqual(['echo', "he said 'hello'"]);
  });

  it('handles empty quoted arguments', () => {
    const { argv } = tokenizeCommand('echo "" hello');
    expect(argv).toEqual(['echo', '', 'hello']);
  });

  it('handles unicode in commands', () => {
    const { argv } = tokenizeCommand('echo "café résumé"');
    expect(argv).toEqual(['echo', 'café résumé']);
  });
});

describe('resolveCommandPath', () => {
  it('resolves a known binary on PATH', () => {
    const path = resolveCommandPath('ls');
    expect(path).not.toBeNull();
    expect(path!.includes('ls')).toBe(true);
  });

  it('returns null for a non-existent command', () => {
    const path = resolveCommandPath('nonexistent-binary-xyz-123');
    expect(path).toBeNull();
  });

  it('passes through absolute paths', () => {
    const path = resolveCommandPath('/bin/ls');
    expect(path).toBe('/bin/ls');
  });

  it('passes through relative paths', () => {
    const path = resolveCommandPath('./script.sh');
    expect(path).toBe('./script.sh');
  });
});

async function runSandbox(argv: string[], workspace: string, readOnlyRoots: string[] = [], blockSubprocesses = false) {
  const { proc, cleanup } = spawnSandboxed(argv, {
    allowedRoots: [workspace],
    requiredWorkspaceRoot: workspace,
    readOnlyRoots,
    cwd: workspace,
    blockNetwork: true,
    blockSubprocesses,
  });
  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      proc.once('error', reject);
      proc.once('close', (code) => resolve(code ?? 1));
    });
    return { code, stdout, stderr };
  } finally {
    cleanup();
  }
}

const kernelSandboxAvailable = isUnix() && osSandboxEnabled();
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

describe('macOS subprocess confinement', () => {
  it.skipIf(!isMac() || !osSandboxEnabled())('permits the initial exec but blocks descendant commands', async () => {
    const workspace = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-one-exec-')));
    try {
      const initial = await runSandbox(['/usr/bin/true'], workspace, [], true);
      expect(initial.code, initial.stderr).toBe(0);
      const child = await runSandbox(['/bin/bash', '-c', '/usr/bin/true'], workspace, [], true);
      expect(child.code).not.toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('read-only source roots', () => {
  it.skipIf(!kernelSandboxAvailable)(
    'imports committed source objects while denying source writes and symlink escapes',
    async () => {
      const fixture = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-readonly-source-')));
      const source = join(fixture, 'source');
      const workspace = join(fixture, 'workspace');
      const git = findExecutableOnPath('git');
      expect(git).not.toBeNull();
      const runGit = (cwd: string, ...args: string[]) => {
        const result = Bun.spawnSync([git!, '-C', cwd, ...args]);
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        return result.stdout.toString().trim();
      };
      try {
        mkdirSync(source);
        mkdirSync(workspace);
        writeFileSync(join(source, 'original.txt'), 'original\n');
        runGit(source, 'init');
        runGit(source, 'add', '.');
        runGit(source, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
          '-c', 'commit.gpgsign=false', 'commit', '-m', 'source');
        const commit = runGit(source, 'rev-parse', 'HEAD');
        const config = readFileSync(join(source, '.git/config'), 'utf8');
        runGit(workspace, 'init');
        symlinkSync(source, join(workspace, 'source-link'));

        const imported = await runSandbox(
          [git!, '-C', workspace, 'fetch', '--no-tags', '--no-write-fetch-head', source, commit],
          workspace,
          [source],
        );
        expect(imported.code, imported.stderr).toBe(0);
        expect(runGit(workspace, 'show', `${commit}:original.txt`)).toBe('original');
        for (const command of [
          `printf bad > ${quote(join(source, 'original.txt'))}`,
          `printf bad > ${quote(join(source, 'created.txt'))}`,
          'printf bad > source-link/symlink-escape.txt',
          `${quote(git!)} -C ${quote(source)} config --local isolation.escape bad`,
          `${quote(git!)} -C ${quote(source)} update-ref refs/heads/escape HEAD`,
        ]) {
          const result = await runSandbox(['/bin/sh', '-c', command], workspace, [source]);
          expect(result.code, command).not.toBe(0);
        }
        expect(readFileSync(join(source, 'original.txt'), 'utf8')).toBe('original\n');
        expect(readFileSync(join(source, '.git/config'), 'utf8')).toBe(config);
        expect(existsSync(join(source, 'created.txt'))).toBe(false);
        expect(existsSync(join(source, 'symlink-escape.txt'))).toBe(false);
        expect(runGit(source, 'branch', '--list', 'escape')).toBe('');
        expect(runGit(source, 'rev-parse', 'HEAD')).toBe(commit);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!kernelSandboxAvailable)('rejects a read-only root containing private writable scratch', () => {
    const previous = process.env.TMPDIR;
    const fixture = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-scratch-overlap-')));
    const workspace = join(fixture, 'workspace');
    const readOnly = join(fixture, 'read-only');
    mkdirSync(workspace);
    mkdirSync(readOnly);
    process.env.TMPDIR = readOnly;
    try {
      expect(() => spawnSandboxed(['/bin/echo', 'must-not-run'], {
        allowedRoots: [workspace],
        requiredWorkspaceRoot: workspace,
        readOnlyRoots: [readOnly],
        cwd: workspace,
        blockNetwork: true,
        blockSubprocesses: false,
      })).toThrow('Read-only root overlaps a writable sandbox root');
      expect(readdirSync(readOnly)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.skipIf(!kernelSandboxAvailable)('rejects overlapping writable and read-only roots', () => {
    const fixture = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-root-overlap-')));
    const workspace = join(fixture, 'workspace');
    const nested = join(workspace, 'nested');
    mkdirSync(nested, { recursive: true });
    try {
      for (const readOnlyRoot of [fixture, workspace, nested]) {
        expect(() => spawnSandboxed(['/bin/echo', 'must-not-run'], {
          allowedRoots: [fixture],
          requiredWorkspaceRoot: workspace,
          readOnlyRoots: [readOnlyRoot],
          cwd: workspace,
          blockNetwork: true,
          blockSubprocesses: false,
        })).toThrow('Read-only root overlaps a writable sandbox root');
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('OS sandbox detection', () => {
  it('detectOsSandbox returns a boolean for each feature', () => {
    const avail = detectOsSandbox();
    expect(typeof avail.landlock).toBe('boolean');
    expect(typeof avail.seccomp).toBe('boolean');
    expect(typeof avail.sandboxExec).toBe('boolean');
  });

  it('osSandboxEnabled tracks engine availability, not an opt-in env var', () => {
    // Confinement is now requested by policy (`workspace.sandbox`) rather than
    // an environment flag, so this reports whether a real engine exists.
    const previous = process.env.KORYPHAIOS_OS_SANDBOX;
    delete process.env.KORYPHAIOS_OS_SANDBOX;
    try {
      expect(osSandboxEnabled()).toBe(osSandboxAvailable());
    } finally {
      if (previous === undefined) delete process.env.KORYPHAIOS_OS_SANDBOX;
      else process.env.KORYPHAIOS_OS_SANDBOX = previous;
    }
  });

  it('KORYPHAIOS_OS_SANDBOX=0 is an explicit process-wide kill switch', () => {
    const previous = process.env.KORYPHAIOS_OS_SANDBOX;
    process.env.KORYPHAIOS_OS_SANDBOX = '0';
    try {
      expect(osSandboxEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.KORYPHAIOS_OS_SANDBOX;
      else process.env.KORYPHAIOS_OS_SANDBOX = previous;
    }
  });

  it('defaultAllowedRoots includes the working directory', () => {
    const roots = defaultAllowedRoots('/tmp');
    expect(roots.length).toBeGreaterThan(0);
    // The temp dir should be canonicalized.
    expect(roots.every((r) => r.length > 0)).toBe(true);
  });
});
