import { describe, expect, it } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLI_ADAPTER_COMPATIBILITY,
  CLI_ADAPTER_COMPATIBILITY_BY_PROVIDER,
  CLI_ADAPTER_PROVIDER_NAMES,
  getCliAdapterCompatibility,
} from '../cli-compatibility';
import { createIsolatedTestEnvironment } from '../../../../scripts/test-backend-isolated';

// Deliberately do not import adapters or registry: inventory validation needs no
// provider constructors, credential discovery, transport mocks or CLI processes.
const root = resolve(import.meta.dir, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('offline CLI compatibility evidence', () => {
  it('covers every standard and managed CLI harness declared by the registry', () => {
    const registry = read('backend/src/providers/registry.ts');
    const declared = ['CLI_HARNESS_PROVIDERS', 'MANAGED_CLI_PROVIDERS'].flatMap((name) => {
      const declaration = registry.match(
        new RegExp(`${name} = new Set<ProviderName>\\(\\[([\\s\\S]*?)\\]\\)`),
      );
      // If the declaration changes shape, require an explicit inventory review.
      expect(declaration, `${name} declaration must remain auditable`).not.toBeNull();
      return [...declaration![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    });
    const catalog = CLI_ADAPTER_COMPATIBILITY.map((entry) => entry.provider);
    expect(new Set(catalog).size).toBe(catalog.length);
    expect([...catalog].sort()).toEqual([...declared].sort());
  });

  for (const entry of CLI_ADAPTER_COMPATIBILITY) {
    it(`${entry.provider}: keeps release support unknown and evidence traceable`, () => {
      expect(entry.supportedVersions).toBe('unknown');
      expect(entry.liveVerification).toBe('not-established');
      expect(entry.versionBoundary.detail.length).toBeGreaterThan(20);
      expect(entry.revalidate.length).toBeGreaterThan(0);
      expect(entry.evidence.some((item) => item.level === 'source-contract')).toBe(true);
      expect(entry.evidence.some((item) => item.level !== 'source-contract')).toBe(true);
      for (const evidence of entry.evidence) {
        expect(evidence.path.startsWith('backend/src/providers/')).toBe(true);
        expect(evidence.path.split('/')).not.toContain('..');
        expect(statSync(resolve(root, evidence.path)).isFile()).toBe(true);
        expect(read(evidence.path)).toContain(evidence.anchor);
        expect(evidence.scope.length).toBeGreaterThan(20);
        if (evidence.level !== 'source-contract') expect(evidence.path).toEndWith('.test.ts');
      }
    });
  }

  it('does not infer CLI compatibility for SDK/API providers or unknown aliases', () => {
    for (const name of [
      'kimicode',
      'kilocode',
      'codebuff',
      'openai',
      'chatbase',
      'Claude',
      'unknown',
      '',
    ]) {
      expect(getCliAdapterCompatibility(name)).toBeUndefined();
    }
    expect(getCliAdapterCompatibility('codex-auth')?.binary).toBe('codex');
  });

  it('derives report names and lookup evidence from the same manifest entries', () => {
    expect(CLI_ADAPTER_PROVIDER_NAMES).toEqual(
      CLI_ADAPTER_COMPATIBILITY.map((entry) => entry.provider),
    );
    expect([...CLI_ADAPTER_COMPATIBILITY_BY_PROVIDER.keys()]).toEqual(CLI_ADAPTER_PROVIDER_NAMES);
    for (const entry of CLI_ADAPTER_COMPATIBILITY) {
      expect(CLI_ADAPTER_COMPATIBILITY_BY_PROVIDER.get(entry.provider)).toBe(entry);
      expect(getCliAdapterCompatibility(entry.provider)).toBe(entry);
    }
  });

  it('keeps source version references distinct from synthetic versions and support ranges', () => {
    expect(getCliAdapterCompatibility('freebuff')?.versionBoundary.kind).toBe('source-reference');
    for (const entry of CLI_ADAPTER_COMPATIBILITY) {
      if (entry.provider !== 'freebuff') {
        expect(entry.versionBoundary.kind).toBe('unknown');
      }
    }
  });

  it('keeps the documentation matrix in sync with the explicit inventory', () => {
    const doc = read('docs/provider-compatibility.md');
    // The matrix is column-aligned, so tolerate padding between the closing
    // backtick and the cell separator.
    const rows = [...doc.matchAll(/^\| `([^`]+)`\s+\|/gm)].map((match) => match[1]!);
    expect(rows.sort()).toEqual(CLI_ADAPTER_COMPATIBILITY.map((entry) => entry.provider).sort());
    for (const entry of CLI_ADAPTER_COMPATIBILITY) {
      const row = doc
        .split('\n')
        .find((line) => new RegExp(`^\\| \`${entry.provider}\`\\s+\\|`).test(line));
      expect(row).toContain('Unknown');
    }
  });

  it('uses the runner isolation boundary without carrying ambient live opt-ins or credentials', () => {
    // Force the live flag off before invoking the helper: its explicit live mode
    // intentionally forwards the source environment. These are fake values only.
    const env = createIsolatedTestEnvironment(
      {
        PATH: '/synthetic/bin',
        OPENAI_API_KEY: 'synthetic-secret',
        KORY_RUN_LIVE_PROVIDER_TESTS: '0',
        KORY_LIVE_CLAUDE: '1',
        HOME: '/synthetic/real-home',
      },
      '/synthetic/isolated-home',
    );
    expect(env.HOME).toBe('/synthetic/isolated-home');
    expect(env.KORY_DISABLE_CLI_AUTODETECT).toBe('1');
    expect(env.KORY_RUN_LIVE_PROVIDER_TESTS).toBe('0');
    expect(env.KORY_LIVE_CLAUDE).toBe('0');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
