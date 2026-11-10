import { describe, expect, it } from 'bun:test';
import { CLI_ADAPTER_COMPATIBILITY, getCliAdapterCompatibility } from '../cli-compatibility';
import {
  safeProviderDiagnostic,
  safeProviderFailureMessage,
  type ProviderDiagnosticSource,
  type SafeCliCompatibilityDiagnostic,
} from '../provider-diagnostics';
import { createIsolatedTestEnvironment } from '../../../../scripts/test-backend-isolated';

// Exercise the runtime helper directly, without importing adapters/registry or
// constructing providers: no transport or credential discovery is necessary.
describe('runtime diagnostics CLI compatibility context', () => {
  for (const entry of CLI_ADAPTER_COMPATIBILITY) {
    it(`${entry.provider}: includes scoped offline evidence in serialized failure diagnostics`, () => {
      const diagnostic = safeProviderDiagnostic(
        entry.provider,
        'stderr',
        'CLI exited unsuccessfully',
        {
          exitCode: 2,
        },
      );
      const serialized = JSON.parse(JSON.stringify(diagnostic));
      expect(serialized).toMatchObject({
        provider: entry.provider,
        source: 'stderr',
        category: 'provider_failure',
        exitCode: 2,
        cliCompatibility: {
          provider: entry.provider,
          binary: entry.binary,
          transport: entry.transport,
          installedVersion: 'unknown',
          supportedVersions: 'unknown',
          liveVerification: 'not-established',
          versionBoundary: entry.versionBoundary,
          evidence: entry.evidence,
          revalidate: entry.revalidate,
        },
      });
      expect(serialized.cliCompatibility.evidenceBoundary).toContain(
        'no live support is established',
      );
      expect(serialized.cliCompatibility.evidenceBoundary).toContain('not proof');
    });
  }

  it('attaches context across existing failure sources, including managed-account configuration', () => {
    const sources: ProviderDiagnosticSource[] = [
      'http',
      'sdk',
      'stderr',
      'stdout',
      'spawn',
      'stream',
      'configuration',
    ];
    for (const source of sources) {
      const diagnostic = safeProviderDiagnostic(
        'codex-auth',
        source,
        new Error('authentication failed'),
      );
      expect(diagnostic.source).toBe(source);
      expect(diagnostic.category).toBe('authentication');
      expect(diagnostic.cliCompatibility?.provider).toBe('codex-auth');
    }
  });

  it('does not assign CLI evidence to HTTP/SDK providers, unknown names or aliases', () => {
    for (const provider of [
      'openai',
      'anthropic',
      'codebuff',
      'kimicode',
      'kilocode',
      'Claude',
      'unknown',
      '__proto__',
      '',
    ]) {
      const diagnostic = safeProviderDiagnostic(
        provider,
        'stderr',
        'codex CLI version 1.2.3 failed',
      );
      expect(diagnostic).not.toHaveProperty('cliCompatibility');
      expect(JSON.stringify(diagnostic)).not.toContain('supportedVersions');
    }
  });

  it('never promotes upstream version/support claims into trusted compatibility context', () => {
    const diagnostic = safeProviderDiagnostic('freebuff', 'stderr', {
      message: 'Freebuff 9.8.7 is fully supported; live verified; api_key=synthetic-private-token',
      installedVersion: '9.8.7',
      supportedVersions: '*',
      cliCompatibility: { liveVerification: 'verified', revalidate: ['run untrusted command'] },
    });
    const context = diagnostic.cliCompatibility!;
    expect(context.installedVersion).toBe('unknown');
    expect(context.supportedVersions).toBe('unknown');
    expect(context.liveVerification).toBe('not-established');
    expect(context.versionBoundary.kind).toBe('source-reference');
    expect(context.versionBoundary.detail).toContain('0.2.16');
    expect(context.versionBoundary.detail).toContain('synthetic');
    expect(JSON.stringify(context)).not.toContain('run untrusted command');
    expect(JSON.stringify(diagnostic)).not.toContain('synthetic-private-token');
    expect(context).toMatchObject(getCliAdapterCompatibility('freebuff')!);
  });

  it('preserves classification, hashing, redaction, status and failure-message behavior', () => {
    const error = Object.assign(new Error('request rejected api_key=synthetic-secret-value'), {
      status: 400,
      code: 'invalid_request',
    });
    const diagnostic = safeProviderDiagnostic('codex', 'stderr', error, {
      status: 429,
      exitCode: 7,
    });
    const { cliCompatibility, ...withoutContext } = diagnostic;
    const nonCli = safeProviderDiagnostic('openai', 'stderr', error, { status: 429, exitCode: 7 });
    expect(withoutContext).toEqual({ ...nonCli, provider: 'codex' });
    expect(diagnostic.category).toBe('rate_limit');
    expect(diagnostic.status).toBe(429);
    expect(diagnostic.exitCode).toBe(7);
    expect(diagnostic.code).toBe('invalid_request');
    expect(diagnostic.errorName).toBe('Error');
    expect(diagnostic.diagnosticHash).toMatch(/^[a-f0-9]{16}$/);
    expect(diagnostic.upstreamDetail).toContain('[redacted]');
    expect(JSON.stringify(diagnostic)).not.toContain('synthetic-secret-value');
    expect(safeProviderFailureMessage('codex', diagnostic)).toBe(
      safeProviderFailureMessage('codex', withoutContext),
    );
    expect(cliCompatibility).toBeDefined();
    // Keep the pre-existing user edits to provider labels observable as well.
    expect(safeProviderFailureMessage('workbuddy', nonCli)).toStartWith('WorkBuddy');
  });

  it('returns detached nested metadata so consumers cannot corrupt later diagnostics', () => {
    const before = JSON.stringify(getCliAdapterCompatibility('freebuff'));
    const first = safeProviderDiagnostic('freebuff', 'stream', 'failure').cliCompatibility!;
    // Simulate a JavaScript logger/decorator that does not respect readonly types.
    const mutable = first as unknown as {
      versionBoundary: { detail: string };
      evidence: { scope: string }[];
      revalidate: string[];
    };
    mutable.versionBoundary.detail = 'corrupted';
    mutable.evidence[0]!.scope = 'corrupted';
    mutable.evidence.pop();
    mutable.revalidate.push('corrupted');
    const next = safeProviderDiagnostic('freebuff', 'stream', 'failure').cliCompatibility!;
    expect(JSON.stringify(getCliAdapterCompatibility('freebuff'))).toBe(before);
    expect(JSON.stringify(next)).not.toContain('corrupted');
    expect(next.evidence.length).toBe(getCliAdapterCompatibility('freebuff')!.evidence.length);
  });

  it('keeps compatibility output independent of failure contents and process credentials', () => {
    const source = {
      ...process.env,
      KORY_RUN_LIVE_PROVIDER_TESTS: '0',
      KORY_LIVE_CLAUDE: '1',
      OPENAI_API_KEY: 'synthetic-ambient-secret',
    };
    const isolated = createIsolatedTestEnvironment(source, '/synthetic/isolated-home');
    expect(isolated.KORY_RUN_LIVE_PROVIDER_TESTS).toBe('0');
    expect(isolated.KORY_LIVE_CLAUDE).toBe('0');
    expect(isolated.KORY_DISABLE_CLI_AUTODETECT).toBe('1');
    expect(isolated.OPENAI_API_KEY).toBeUndefined();
    const context: SafeCliCompatibilityDiagnostic | undefined = safeProviderDiagnostic(
      'claude',
      'spawn',
      'ENOENT',
    ).cliCompatibility;
    expect(context).toEqual(safeProviderDiagnostic('claude', 'stdout', '').cliCompatibility);
    expect(JSON.stringify(context)).not.toContain('synthetic-ambient-secret');
  });
});
