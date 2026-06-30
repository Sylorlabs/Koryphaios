#!/usr/bin/env bun
/**
 * Probe CLI-backed providers: registry status + live model lists after background refresh.
 */
import { join } from 'node:path';
import { ProviderRegistry } from '../src/providers/registry';
import { loadConfig } from '../src/runtime/config';
import { getModelsForProvider } from '../src/providers/models';
import {
  ClaudeCodeProvider,
} from '../src/providers/claude-code';
import { GrokBuildProvider } from '../src/providers/grok-build';
import { AntigravityProvider } from '../src/providers/antigravity';
import { CodexProvider } from '../src/providers/codex';
import {
  detectClaudeCodeLogin,
  detectGrokCLILogin,
  detectAntigravityCLILogin,
  detectCodexAuthToken,
  detectCodexCLILogin,
} from '../src/providers/auth-utils';
import { whichBinary } from '../src/providers/cli-detection';
import type { ModelDef, ProviderName } from '@koryphaios/shared';

const PROJECT_ROOT = join(import.meta.dir, '../..');
const WAIT_MS = 10_000;

type Row = {
  provider: string;
  cliInstalled: boolean;
  cliLoggedIn: boolean;
  configDisabled: boolean | null;
  registryConnected: boolean;
  modelCount: number;
  sampleIds: string[];
  sampleApiModelIds: string[];
  listSource: 'live' | 'catalog-stub' | 'mixed' | 'n/a';
  notes: string;
};

function stubIds(provider: ProviderName): Set<string> {
  return new Set(getModelsForProvider(provider).map((m) => m.id));
}

function classifyList(
  provider: ProviderName,
  models: ModelDef[],
  opts: { hasRealModelIds?: boolean; countDiffersFromStub?: boolean },
): 'live' | 'catalog-stub' | 'mixed' | 'n/a' {
  if (models.length === 0) return 'n/a';
  const stub = stubIds(provider);
  const allStub = models.every((m) => stub.has(m.id));
  const anyNew = models.some((m) => !stub.has(m.id));
  if (opts.hasRealModelIds) return opts.countDiffersFromStub || anyNew ? 'mixed' : 'live';
  if (anyNew) return 'live';
  if (allStub && !opts.countDiffersFromStub) return 'catalog-stub';
  return 'mixed';
}

function summarizeModels(models: ModelDef[]) {
  return {
    sampleIds: models.slice(0, 4).map((m) => m.id),
    sampleApiModelIds: models.slice(0, 4).map((m) => m.apiModelId ?? m.id),
  };
}

async function main() {
  const config = loadConfig(PROJECT_ROOT);
  const registry = new ProviderRegistry(config);

  console.log(`Waiting ${WAIT_MS}ms for background model refresh...`);
  await Bun.sleep(WAIT_MS);

  const targets: ProviderName[] = ['claude', 'grok', 'antigravity', 'codex'];
  const rows: Row[] = [];

  for (const name of targets) {
    const provider = registry.get(name);
    const cfg = config.providers?.[name];
    const connected = provider?.isAvailable() ?? false;
    const models = connected ? (provider?.listModels() ?? []) : [];
    const stub = getModelsForProvider(name);
    const { sampleIds, sampleApiModelIds } = summarizeModels(models);

    let listSource: Row['listSource'] = connected
      ? classifyList(name, models, {
          hasRealModelIds: name === 'claude' && models.some((m) => !!m.realModelId),
          countDiffersFromStub: models.length !== stub.length,
        })
      : 'n/a';

    const notes: string[] = [];
    if (cfg?.disabled) notes.push('disabled in koryphaios.json');
    if (name === 'codex' && !detectCodexAuthToken() && detectCodexCLILogin()) {
      notes.push('~/.codex/auth.json exists but .koryphaios/codex-home/auth.json missing');
    }

    rows.push({
      provider: name,
      cliInstalled: !!whichBinary(name === 'antigravity' ? 'agy' : name),
      cliLoggedIn:
        name === 'claude'
          ? detectClaudeCodeLogin()
          : name === 'grok'
            ? detectGrokCLILogin()
            : name === 'antigravity'
              ? detectAntigravityCLILogin()
              : detectCodexCLILogin() || !!detectCodexAuthToken(),
      configDisabled: cfg?.disabled ?? null,
      registryConnected: connected,
      modelCount: models.length,
      sampleIds,
      sampleApiModelIds,
      listSource,
      notes: notes.join('; ') || '—',
    });
  }

  // Force-enable probe (ignores config.disabled) to test CLI connectivity directly.
  console.log('\n--- Force-enabled CLI probe (auth markers, not config.disabled) ---');
  const forced: Array<{ name: ProviderName; provider: { isAvailable(): boolean; listModels(): ModelDef[] } }> = [
    { name: 'claude', provider: new ClaudeCodeProvider({ name: 'claude', authToken: 'cli:claude:probe', disabled: false }) },
    { name: 'grok', provider: new GrokBuildProvider({ name: 'grok', authToken: 'cli:grok:probe', disabled: false }) },
    { name: 'antigravity', provider: new AntigravityProvider({ name: 'antigravity', authToken: 'cli:antigravity:probe', disabled: false }) },
    { name: 'codex', provider: new CodexProvider({ name: 'codex', authToken: 'cli:codex:probe', disabled: false }) },
  ];

  await Bun.sleep(WAIT_MS);

  const forcedRows = forced.map(({ name, provider }) => {
    const available = provider.isAvailable();
    const models = available ? provider.listModels() : [];
    const stub = getModelsForProvider(name);
    const { sampleIds, sampleApiModelIds } = summarizeModels(models);
    return {
      provider: `${name} (forced)`,
      available,
      modelCount: models.length,
      sampleIds,
      sampleApiModelIds,
      listSource: available
        ? classifyList(name, models, {
            hasRealModelIds: name === 'claude',
            countDiffersFromStub: models.length !== stub.length,
          })
        : 'n/a',
    };
  });

  console.log('\n=== Registry (loadConfig) ===');
  console.table(rows);
  console.log('\n=== Force-enabled providers ===');
  console.table(forcedRows);

  // Extra wait for Claude alias probes (up to 12s each, parallel).
  console.log('\nWaiting +15s for Claude alias probes...');
  await Bun.sleep(15_000);
  const claude = registry.get('claude');
  if (claude?.isAvailable()) {
    const late = claude.listModels();
    console.log('Claude models after +15s:', late.map((m) => ({ id: m.id, apiModelId: m.apiModelId, realModelId: m.realModelId, name: m.name })));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});