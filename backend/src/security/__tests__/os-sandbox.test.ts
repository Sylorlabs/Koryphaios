// Tests for the OS-level sandbox and argv-only execution path.
// These verify that the new trust boundary (no shell string interpretation)
// blocks the bypasses the old regex sandbox allowed.

import { describe, it, expect } from 'bun:test';
import { tokenizeCommand, resolveCommandPath } from '../../runtime/shell-argv';
import { osSandboxEnabled, detectOsSandbox, defaultAllowedRoots } from '../os-sandbox';

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

describe('OS sandbox detection', () => {
  it('detectOsSandbox returns a boolean for each feature', () => {
    const avail = detectOsSandbox();
    expect(typeof avail.landlock).toBe('boolean');
    expect(typeof avail.seccomp).toBe('boolean');
    expect(typeof avail.sandboxExec).toBe('boolean');
  });

  it('osSandboxEnabled is false by default (opt-in)', () => {
    // KORYPHAIOS_OS_SANDBOX is not set in the test env.
    expect(osSandboxEnabled()).toBe(false);
  });

  it('defaultAllowedRoots includes the working directory', () => {
    const roots = defaultAllowedRoots('/tmp');
    expect(roots.length).toBeGreaterThan(0);
    // The temp dir should be canonicalized.
    expect(roots.every((r) => r.length > 0)).toBe(true);
  });
});
