import { z } from 'zod';
import type { ModelDef, ProviderConfig, ProviderName } from '@koryphaios/shared';
import type { ProviderRegistry } from '../providers/registry';
import type { Provider, ProviderEvent, StreamRequest } from '../providers/types';
import { CustomProvider } from '../providers/custom';
import { AntigravityProvider } from '../providers/antigravity';
import { readPortableAntigravityCredential, stageAntigravityCredential } from '../providers/antigravity-credentials';
import type { ProviderExecutionScope } from '../providers/execution-scope';
import { bindProviderExecutionScope, withProviderExecutionScope } from '../providers/execution-scope';
import { splitProviderKey } from '../providers/provider-key';

const text = z.string().min(1).max(512);
const modelSchema = z.object({
  id: text, name: text, apiModelId: text.optional(),
  contextWindow: z.number().int().nonnegative().max(10_000_000),
  maxOutputTokens: z.number().int().nonnegative().max(1_000_000),
  canReason: z.boolean().optional(), vision: z.boolean().optional(), functionCall: z.boolean().optional(),
  supportsAttachments: z.boolean().optional(), supportsStreaming: z.boolean().optional(),
  contextVerified: z.boolean().optional(),
  reasoningLevels: z.array(text).max(20).optional(),
  reasoningVariants: z.record(z.string().max(64), text).optional(),
  aliases: z.array(text).max(100).optional(),
  tier: z.enum(['flagship', 'fast', 'cheap', 'reasoning']).optional(),
});
const configSchema = z.object({
  // A staged entry keeps the provider's own name so the target resolves the
  // same model string. The entry is still built as a portable adapter, never
  // as a native CLI or an arbitrary executable.
  name: z.string().max(64).regex(/^(?:custom:[a-zA-Z0-9_-]+|[a-z0-9][a-z0-9_-]*)$/),
  label: z.string().max(160).optional(),
  baseUrl: z.string().url().max(2048).optional(),
  apiKey: z.string().max(32_768).optional(), authToken: z.string().max(32_768).optional(),
  headers: z.record(z.string().max(128), z.string().max(16_384)).optional(),
  kind: z.enum(['openai', 'anthropic', 'gemini']).optional(),
  adapter: z.string().max(128).optional(),
});
const bundleSchema = z.object({
  version: z.literal(1),
  providers: z.array(z.object({ config: configSchema, models: z.array(modelSchema).min(1).max(2000) })).min(1).max(32),
  antigravityCredential: z.string().max(256 * 1024).optional(),
});
export type DeviceProviderBundle = z.infer<typeof bundleSchema>;

export function parseDeviceProviderBundle(value: unknown): DeviceProviderBundle {
  if (JSON.stringify(value)?.length > 800_000) throw new Error('Device provider configuration is too large.');
  const result = bundleSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid device provider configuration (${result.error.issues.slice(0, 4).map((issue) => issue.path.join('.')).join(', ')}).`);
  const names = result.data.providers.map((entry) => entry.config.name);
  if (new Set(names).size !== names.length) throw new Error('Duplicate device providers.');
  for (const entry of result.data.providers) {
    // Antigravity is the one native adapter staged by name. Everything else is
    // an HTTP provider, so it must carry the endpoint it is called through.
    if (entry.config.name === 'antigravity') continue;
    if (!entry.config.baseUrl) throw new Error('A staged provider needs its endpoint.');
    const url = new URL(entry.config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid device provider endpoint.');
  }
  return result.data;
}

/** Called only by an authenticated human command on the credential-owning desktop. */
export async function buildDeviceProviderBundle(registry: ProviderRegistry, model?: string, signal?: AbortSignal): Promise<DeviceProviderBundle> {
  const requested = model && model !== 'auto' ? splitProviderKey(model).provider : undefined;
  // A user who selected a model explicitly can share that provider for this
  // run. Without a selection only the portable families are bundled, so a
  // routine linked chat never sweeps every credential into one grant.
  const providers = registry.getStatus().filter((entry) => entry.enabled && entry.adapterAvailable &&
    (requested
      ? entry.name === requested
      : entry.name === 'antigravity' || String(entry.name).startsWith('custom:'))).flatMap((entry) => {
      const adapter = registry.get(entry.name);
      if (!adapter) return [];
      const models = entry.allAvailableModels.filter((candidate) => entry.models.includes(candidate.id));
      if (!models.length) return [];
      const config = adapter.config;
      return [{ config: { name: String(entry.name), label: entry.label, baseUrl: config.baseUrl?.trim() || undefined,
        apiKey: config.apiKey, authToken: config.authToken, headers: config.headers,
        kind: config.kind, adapter: config.adapter }, models }];
    });
  const bundle = parseDeviceProviderBundle({ version: 1, providers });
  if (requested && !bundle.providers.some((entry) => entry.config.name === requested))
    throw new Error('The selected desktop provider is unavailable.');
  if (bundle.providers.some((entry) => entry.config.name === 'antigravity'))
    bundle.antigravityCredential = await readPortableAntigravityCredential({ signal });
  signal?.throwIfAborted();
  return bundle;
}

export function stageDeviceProviders(value: unknown, sessionId: string, authorize: () => void): {
  scope: ProviderExecutionScope;
  cleanup: () => void;
  bind: () => void;
} {
  const bundle = parseDeviceProviderBundle(value);
  const providers = new Map<ProviderName, Provider>();
  const scope: ProviderExecutionScope = { sessionId, providers, assertActive: authorize };
  const cleanups: Array<() => void> = [];
  let live = true;
  let unbind: (() => void) | undefined;
  const cleanup = () => { live = false; unbind?.(); for (const fn of cleanups.splice(0)) fn(); providers.clear(); };
  scope.assertActive = () => { if (!live) throw new Error('Device provider run has ended.'); authorize(); };
  try {
    for (const entry of bundle.providers) {
      const name = entry.config.name as ProviderName;
      const models = entry.models.map((model) => ({ ...model, provider: name })) as ModelDef[];
      const config = { ...entry.config, name, disabled: false, custom: name.startsWith('custom:'),
        models: models.map((model) => model.id), selectedModels: models.map((model) => model.id) } as ProviderConfig;
      let adapter: Provider;
      if (name === 'antigravity') {
        const stage = stageAntigravityCredential(bundle.antigravityCredential);
        cleanups.push(stage.cleanup);
        scope.antigravityHome = stage.home;
        scope.antigravityModels = models;
        adapter = new AntigravityProvider(config);
      } else adapter = new CustomProvider(config);
      providers.set(name, {
        name, config,
        imageInputTransport: adapter.imageInputTransport,
        mediaInputKinds: adapter.mediaInputKinds,
        isAvailable: () => withProviderExecutionScope(scope, () => adapter.isAvailable()),
        listModels: () => { scope.assertActive(); return models; },
        async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
          scope.assertActive();
          if (request.sessionId !== sessionId) throw new Error('Device credentials are scoped to another chat.');
          const stream = adapter.streamResponse(request);
          try {
            for (;;) {
              const next = await withProviderExecutionScope(scope, () => stream.next());
              scope.assertActive();
              if (next.done) return;
              yield next.value;
            }
          } finally { await stream.return(undefined); }
        },
      });
    }
    return { scope, cleanup, bind: () => { scope.assertActive(); unbind ??= bindProviderExecutionScope(scope); } };
  } catch (error) { cleanup(); throw error; }
}
