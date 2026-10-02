import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT } from '../runtime/paths';
import { ensureSecureDir, hardenFilePermissions } from '../security/fs-permissions';

const STORE_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PROBES = 256;

export type VerifiedReasoningCacheScope = 'shared' | 'isolated';

export interface ProviderReasoningCacheProbe {
  provider: string;
  model: string;
  scope: VerifiedReasoningCacheScope;
  samples: number;
  observedAt: number;
}

interface ProviderCacheCapabilityStore {
  version: typeof STORE_VERSION;
  probes: ProviderReasoningCacheProbe[];
}

function dataRoot(): string {
  return process.env.KORYPHAIOS_DATA_DIR?.trim() || join(PROJECT_ROOT, '.koryphaios');
}

export function providerCacheCapabilityStorePath(): string {
  return join(dataRoot(), 'cache', 'provider-cache-capabilities.json');
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function probeKey(provider: string, model: string): string {
  return createHash('sha256')
    .update(`${normalize(provider)}\0${normalize(model)}`)
    .digest('hex');
}

function validProbe(value: unknown): value is ProviderReasoningCacheProbe {
  if (!value || typeof value !== 'object') return false;
  const probe = value as Partial<ProviderReasoningCacheProbe>;
  return (
    typeof probe.provider === 'string' &&
    probe.provider.trim().length > 0 &&
    typeof probe.model === 'string' &&
    probe.model.trim().length > 0 &&
    (probe.scope === 'shared' || probe.scope === 'isolated') &&
    typeof probe.samples === 'number' &&
    Number.isFinite(probe.samples) &&
    probe.samples >= 1 &&
    typeof probe.observedAt === 'number' &&
    Number.isFinite(probe.observedAt) &&
    probe.observedAt >= 0
  );
}

function readStore(): ProviderCacheCapabilityStore {
  const path = providerCacheCapabilityStorePath();
  if (!existsSync(path)) return { version: STORE_VERSION, probes: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProviderCacheCapabilityStore>;
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.probes)) {
      return { version: STORE_VERSION, probes: [] };
    }
    return { version: STORE_VERSION, probes: parsed.probes.filter(validProbe) };
  } catch {
    return { version: STORE_VERSION, probes: [] };
  }
}

export function readProviderReasoningCacheProbe(
  provider: string,
  model: string,
  options?: { now?: number; maxAgeMs?: number },
): ProviderReasoningCacheProbe | undefined {
  const now = options?.now ?? Date.now();
  const maxAgeMs = Math.max(0, options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  const wanted = probeKey(provider, model);
  return readStore().probes.find(
    (probe) =>
      probeKey(probe.provider, probe.model) === wanted && now - probe.observedAt <= maxAgeMs,
  );
}

export function writeProviderReasoningCacheProbe(
  input: Omit<ProviderReasoningCacheProbe, 'observedAt'> & { observedAt?: number },
): ProviderReasoningCacheProbe {
  const provider = normalize(input.provider);
  const model = input.model.trim();
  if (!provider || !model) throw new Error('Provider cache probe requires provider and model');
  if (!Number.isFinite(input.samples) || input.samples < 1) {
    throw new Error('Provider cache probe samples must be at least 1');
  }
  const record: ProviderReasoningCacheProbe = {
    provider,
    model,
    scope: input.scope,
    samples: Math.floor(input.samples),
    observedAt: input.observedAt ?? Date.now(),
  };
  const current = readStore();
  const wanted = probeKey(provider, model);
  const now = record.observedAt;
  const next: ProviderCacheCapabilityStore = {
    version: STORE_VERSION,
    probes: [
      ...current.probes
        .filter(
          (probe) =>
            probeKey(probe.provider, probe.model) !== wanted &&
            now - probe.observedAt <= DEFAULT_MAX_AGE_MS,
        )
        .sort((a, b) => b.observedAt - a.observedAt)
        .slice(0, MAX_PROBES - 1),
      record,
    ],
  };
  const destination = providerCacheCapabilityStorePath();
  ensureSecureDir(dirname(destination));
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  hardenFilePermissions(temporary);
  renameSync(temporary, destination);
  hardenFilePermissions(destination);
  return record;
}
