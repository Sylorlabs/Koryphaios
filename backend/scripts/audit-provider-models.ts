#!/usr/bin/env bun
/**
 * Audit every provider's model list: connection + live discovery vs static fallback.
 * Usage: bun run scripts/audit-provider-models.ts [--wait-ms=8000]
 */

import type { ModelDef, ProviderName } from '@koryphaios/shared';
import { ProviderRegistry } from '../src/providers/registry';
import { getModelsForProvider } from '../src/providers/models';
import { ENV_API_KEY_MAP, ENV_AUTH_TOKEN_MAP, PROVIDER_AUTH_MODE } from '../src/providers/constants';
import { cliAutoEnableCreds, canAutoEnable } from '../src/providers/cli-detection';
import { loadConfig } from '../src/runtime/config';
import { PROJECT_ROOT } from '../src/runtime/paths';
import { loadEnvFromProject } from '../src/runtime/env';

const waitMs = Number(process.argv.find((a) => a.startsWith('--wait-ms='))?.split('=')[1] ?? 8_000);

/** Providers with no remote /models discovery API — curated lists are expected. */
const STATIC_BY_DESIGN = new Set<ProviderName>(['jules', 'gitlab', 'bedrock']);

/** CLI-backed providers whose live lists reuse catalog ids but refresh names/realModelId. */
const CLI_PROVIDERS = new Set<ProviderName>(['claude', 'grok', 'antigravity', 'codex']);

type AuditRow = {
  provider: ProviderName;
  available: boolean;
  verified: boolean;
  verifyError?: string;
  modelCount: number;
  genericCount: number;
  catalogOnly: boolean;
  sampleIds: string[];
  source: 'live' | 'fallback' | 'static' | 'none';
  note: string;
};

function hasEnvCred(name: ProviderName): boolean {
  for (const v of ENV_API_KEY_MAP[name] ?? []) {
    const val = process.env[v]?.trim();
    if (val && !val.startsWith('env:') && !val.startsWith('enc:')) return true;
  }
  for (const v of ENV_AUTH_TOKEN_MAP[name] ?? []) {
    const val = process.env[v]?.trim();
    if (val && !val.startsWith('env:') && !val.startsWith('enc:')) return true;
  }
  return false;
}

function hasCliCred(name: ProviderName): boolean {
  return canAutoEnable(name);
}

function classifyModels(
  name: ProviderName,
  models: ModelDef[],
): { source: AuditRow['source']; catalogOnly: boolean; note: string } {
  if (STATIC_BY_DESIGN.has(name)) {
    return { source: 'static', catalogOnly: false, note: 'curated static list (no discovery API)' };
  }

  const fallback = getModelsForProvider(name);
  const fallbackIds = new Set(fallback.map((m) => m.apiModelId ?? m.id));
  const modelIds = models.map((m) => m.apiModelId ?? m.id);

  if (modelIds.length === 0) {
    return { source: 'none', catalogOnly: true, note: 'no models returned' };
  }

  const allInFallback = modelIds.every((id) => fallbackIds.has(id)) && modelIds.length <= fallback.length;
  const hasNew = modelIds.some((id) => !fallbackIds.has(id));
  const hasGeneric = models.some((m) => m.isGeneric);

  const hasResolvedAliases = models.some((m) => !!m.realModelId);
  const namesDifferFromCatalog =
    models.length > 0 &&
    models.some((m, i) => {
      const fb = fallback[i];
      return fb && m.name !== fb.name;
    });

  if (hasNew || (hasGeneric && !allInFallback) || hasResolvedAliases || namesDifferFromCatalog) {
    return {
      source: 'live',
      catalogOnly: false,
      note: hasNew
        ? 'discovered ids beyond catalog'
        : hasResolvedAliases
          ? 'CLI/API resolved real model ids'
          : namesDifferFromCatalog
            ? 'live display names from CLI/API'
            : 'generic discovered models',
    };
  }
  if (CLI_PROVIDERS.has(name) && models.length > 0) {
    return { source: 'live', catalogOnly: false, note: 'CLI-backed provider with refreshed model list' };
  }
  if (allInFallback && fallback.length > 0) {
    return { source: 'fallback', catalogOnly: true, note: 'catalog fallback only (refresh may still be pending)' };
  }
  if (models.every((m) => m.isGeneric)) {
    return { source: 'live', catalogOnly: false, note: 'generic models from API' };
  }
  return { source: 'static', catalogOnly: false, note: 'curated static list' };
}

async function main() {
  loadEnvFromProject(PROJECT_ROOT);
  const config = loadConfig(PROJECT_ROOT);

  const registry = new ProviderRegistry(config);
  await registry.initializeEncryptedCredentials();

  const providerNames = Object.keys(PROVIDER_AUTH_MODE) as ProviderName[];
  const rows: AuditRow[] = [];

  for (const name of providerNames.sort()) {
    const userCfg = config.providers?.[name];
    const autoCli = cliAutoEnableCreds(name);
    const hasCred =
      hasEnvCred(name) ||
      hasCliCred(name) ||
      !!userCfg?.apiKey ||
      !!userCfg?.authToken ||
      (userCfg?.disabled === false && (userCfg?.baseUrl || name === 'llamacpp' || name === 'lmstudio'));

    const existing = registry.get(name);
    const alreadyAvailable = existing?.isAvailable() ?? false;

    if ((hasCred || autoCli) && !alreadyAvailable && userCfg?.disabled !== true) {
      const creds: { apiKey?: string; authToken?: string; baseUrl?: string } = {};
      if (userCfg?.apiKey) creds.apiKey = userCfg.apiKey;
      if (userCfg?.authToken) creds.authToken = userCfg.authToken;
      else if (autoCli?.authToken) creds.authToken = autoCli.authToken;
      if (autoCli?.apiKey) creds.apiKey = autoCli.apiKey;
      if (userCfg?.baseUrl) creds.baseUrl = userCfg.baseUrl;
      await registry.setCredentials(name, creds);
    }

    const verify =
      hasCred || autoCli || alreadyAvailable
        ? await registry.verifyConnection(name)
        : { success: false, error: 'no credential' };

    let models = registry.get(name)?.listModels() ?? getModelsForProvider(name);
    const initial = models.map((m) => m.apiModelId ?? m.id);

    const provider = registry.get(name);
    if (provider?.isAvailable()) {
      await Bun.sleep(waitMs);
      registry.refreshProvider(name);
      models = provider.listModels();
    }

    const finalIds = models.map((m) => m.apiModelId ?? m.id);
    const changed = JSON.stringify(initial) !== JSON.stringify(finalIds);
    const { source, catalogOnly, note } = classifyModels(name, models);

    rows.push({
      provider: name,
      available: provider?.isAvailable() ?? false,
      verified: verify.success,
      verifyError: verify.error,
      modelCount: models.length,
      genericCount: models.filter((m) => m.isGeneric).length,
      catalogOnly,
      sampleIds: finalIds.slice(0, 5),
      source: changed && source === 'fallback' ? 'live' : source,
      note: changed ? `${note}; refreshed after ${waitMs}ms` : note,
    });
  }

  const connected = rows.filter((r) => r.available && r.verified);
  const liveLists = rows.filter((r) => r.source === 'live' && r.modelCount > 0);
  const stubOnly = rows.filter(
    (r) => r.available && r.verified && r.catalogOnly && r.modelCount > 0 && !STATIC_BY_DESIGN.has(r.provider),
  );

  console.log('\n=== PROVIDER MODEL AUDIT ===\n');
  for (const r of rows) {
    const status = r.available ? (r.verified ? 'OK' : 'UNVERIFIED') : 'OFF';
    console.log(
      `${r.provider.padEnd(18)} ${status.padEnd(12)} models=${String(r.modelCount).padEnd(3)} source=${r.source.padEnd(8)} ${r.sampleIds.join(', ')}`,
    );
    if (r.verifyError && r.available) console.log(`  verify: ${r.verifyError}`);
    if (r.note) console.log(`  note: ${r.note}`);
  }

  console.log(`\nConnected+verified: ${connected.length}`);
  console.log(`Live model lists:   ${liveLists.length}`);
  console.log(`Catalog-only stubs: ${stubOnly.length} → ${stubOnly.map((r) => r.provider).join(', ') || 'none'}`);

  if (stubOnly.length > 0) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});