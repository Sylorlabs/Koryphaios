import { describe, expect, it } from 'bun:test';
import {
  codexImageArgs,
  codexInvocationIsolationArgs,
  extractKoryToolEnvelope,
  formatCodexCliError,
  resolveCodexSandbox,
} from '../codex-cli';
import { supportsKoryControlPlaneTools } from '../provider-harness';
import { SANDBOX_PRESETS, type SandboxPolicy } from '@koryphaios/shared';

describe('Codex CLI Kory control-plane bridge', () => {
  it('converts an allowed explicit envelope without leaking it into visible content', () => {
    const result = extractKoryToolEnvelope(
      'Delegating now.\n<KORY_TOOL_CALL>{"name":"delegate_to_worker","input":{"task":"audit","domain":"review"}}</KORY_TOOL_CALL>',
      ['delegate_to_worker'],
    );

    expect(result.content).toBe('Delegating now.');
    expect(result.tool).toEqual({
      name: 'delegate_to_worker',
      input: { task: 'audit', domain: 'review' },
    });
  });

  it('does not turn malformed or unauthorized text into a Kory tool call', () => {
    expect(
      extractKoryToolEnvelope(
        '<KORY_TOOL_CALL>{"name":"shell","input":{"command":"rm -rf /"}}</KORY_TOOL_CALL>',
        ['delegate_to_worker'],
      ).tool,
    ).toBeUndefined();
    expect(
      extractKoryToolEnvelope('<KORY_TOOL_CALL>not-json</KORY_TOOL_CALL>', ['delegate_to_worker']).tool,
    ).toBeUndefined();
  });

  it('only exposes Kory control-plane tools to CLI harnesses with a real bridge', () => {
    expect(supportsKoryControlPlaneTools('codex')).toBe(true);
    for (const provider of ['claude', 'grok', 'antigravity', 'cursor', 'devin', 'cline']) {
      expect(supportsKoryControlPlaneTools(provider)).toBe(true);
    }
    expect(supportsKoryControlPlaneTools('gemini-cli')).toBe(false);
  });

  it('keeps account auth but ignores unrelated profile MCP configuration', () => {
    expect(codexInvocationIsolationArgs()).toEqual(['--ignore-user-config']);
  });

  it('passes every pasted image through the official repeatable CLI flag', () => {
    expect(codexImageArgs(['/tmp/one.png', '/tmp/two.jpg'])).toEqual([
      '--image', '/tmp/one.png', '--image', '/tmp/two.jpg',
    ]);
  });

  it('turns an external MCP OAuth crash into an actionable provider error', () => {
    expect(
      formatCodexCliError(
        'worker quit with fatal: AuthRequired(AuthRequiredError { error="invalid_token", resource_metadata="oauth-protected-resource/mcp" })',
        1,
      ),
    ).toContain('external MCP server');
  });
});

describe('resolveCodexSandbox', () => {
  // Codex only exposes `read-only` and `workspace-write`. The resolver must
  // honor the host-imposed SandboxPolicy, collapsing to the stricter mode
  // when the policy disables edits or shell. A manager/worker with a
  // readonly sandbox must NOT silently get workspace-write.

  it('critic role is always read-only regardless of sandbox', () => {
    expect(resolveCodexSandbox('critic', undefined)).toBe('read-only');
    expect(resolveCodexSandbox('critic', SANDBOX_PRESETS.trusted)).toBe('read-only');
  });

  it('manager with no sandbox gets workspace-write (full access for local turns)', () => {
    expect(resolveCodexSandbox('manager', undefined)).toBe('workspace-write');
    expect(resolveCodexSandbox('worker', undefined)).toBe('workspace-write');
  });

  it('manager with readonly sandbox → read-only (the bug this test guards)', () => {
    expect(resolveCodexSandbox('manager', SANDBOX_PRESETS.readonly)).toBe('read-only');
    expect(resolveCodexSandbox('worker', SANDBOX_PRESETS.readonly)).toBe('read-only');
  });

  it('manager with hardened sandbox → read-only (no shell, collapse to stricter)', () => {
    expect(resolveCodexSandbox('manager', SANDBOX_PRESETS.hardened)).toBe('read-only');
  });

  it('manager with balanced sandbox → workspace-write', () => {
    expect(resolveCodexSandbox('manager', SANDBOX_PRESETS.balanced)).toBe('workspace-write');
  });

  it('manager with trusted sandbox → workspace-write', () => {
    expect(resolveCodexSandbox('manager', SANDBOX_PRESETS.trusted)).toBe('workspace-write');
  });

  it('custom sandbox with allowEdits=false → read-only', () => {
    const custom: SandboxPolicy = {
      ...SANDBOX_PRESETS.balanced,
      preset: 'custom',
      allowEdits: false,
    };
    expect(resolveCodexSandbox('manager', custom)).toBe('read-only');
  });

  it('custom sandbox with allowShell=false → read-only (Codex has no edits-only mode)', () => {
    const custom: SandboxPolicy = {
      ...SANDBOX_PRESETS.balanced,
      preset: 'custom',
      allowShell: false,
    };
    expect(resolveCodexSandbox('manager', custom)).toBe('read-only');
  });
});
