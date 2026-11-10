import type { ModelDef, ProviderName } from '@koryphaios/shared';
import { getContext } from '../context';
import { serverLog } from '../logger';
import { getProviderDisplay } from './provider-display';

/**
 * Which providers can actually produce a media modality, according to the
 * provider's own catalog.
 *
 * The image studio and the video picker used to guess: a curated provider list
 * plus a model-name pattern, which is how text models ended up offered as image
 * generators and image models ended up in the video picker. This module answers
 * the question from the one source that cannot be wrong — the `outputModalities`
 * each adapter reports for its models — so a modality picker only offers models
 * the provider says it can produce.
 *
 * Transport (which endpoint a provider is called through) deliberately stays in
 * the routes: this module only answers "what can it make", never "how to call
 * it".
 */

/** Media modalities a picker can be built for. */
export type DetectedMediaModality = 'image' | 'video';

export interface DetectedMediaModel {
  /** Id sent to the provider, preferring the API-facing id. */
  id: string;
  label: string;
}

export interface DetectedMediaProvider {
  provider: string;
  label: string;
  /** Models the provider reports as producing the requested modality. */
  models: DetectedMediaModel[];
  /** A credential or endpoint is present, so a call can be attempted. */
  configured: boolean;
  /**
   * At least one model in the catalog publishes output modalities.
   *
   * When false, the catalog cannot classify anything (many OpenAI-compatible
   * endpoints list ids only), so a caller may fall back to its own declared
   * request catalog instead of guessing from model names.
   */
  reportsModalities: boolean;
}

function modalitiesOf(model: ModelDef): string[] {
  const reported = model.outputModalities;
  if (!Array.isArray(reported)) return [];
  return reported.map((modality) => String(modality).toLowerCase());
}

/** True when the provider reports this exact modality as an output. */
export function emitsModality(model: ModelDef, modality: DetectedMediaModality): boolean {
  return modalitiesOf(model).includes(modality);
}

function providerLabel(provider: string, configuredLabel: string | undefined): string {
  const label = configuredLabel?.trim();
  if (label) return label;
  try {
    return getProviderDisplay(provider as ProviderName)?.label ?? provider;
  } catch {
    return provider;
  }
}

/**
 * A failed or empty catalog is "no models", never an error and never an
 * invented entry: the picker degrades to an empty list instead of offering a
 * model that cannot be called.
 */
function readCatalog(provider: string): ModelDef[] {
  try {
    const adapter = getContext().providers.get(provider as ProviderName);
    const models = adapter?.listModels?.();
    return Array.isArray(models) ? models : [];
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err), provider },
      'Modality detection could not read the provider catalog',
    );
    return [];
  }
}

function isConfigured(config: { apiKey?: string; authToken?: string; baseUrl?: string }): boolean {
  return Boolean(config.apiKey?.trim() || config.authToken?.trim() || config.baseUrl?.trim());
}

/**
 * Every configured provider whose catalog was readable, with the models it
 * reports for `modality`.
 *
 * Providers that report a catalog but no models of that modality are returned
 * with an empty list rather than omitted, so a caller can tell "this provider
 * cannot make video" apart from "this provider publishes no modality data".
 */
export function detectMediaProviders(modality: DetectedMediaModality): DetectedMediaProvider[] {
  let configs: Record<
    string,
    { apiKey?: string; authToken?: string; baseUrl?: string; disabled?: boolean; label?: string }
  >;
  try {
    configs = getContext().providers.getConfigs() ?? {};
  } catch {
    return [];
  }

  const detected: DetectedMediaProvider[] = [];
  for (const [provider, config] of Object.entries(configs)) {
    if (!config || config.disabled) continue;
    const catalog = readCatalog(provider);
    if (catalog.length === 0) continue;
    const seen = new Set<string>();
    const models: DetectedMediaModel[] = [];
    for (const model of catalog) {
      if (!emitsModality(model, modality)) continue;
      const id = model.apiModelId?.trim() || model.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: model.name?.trim() || id });
    }
    detected.push({
      provider,
      label: providerLabel(provider, config.label),
      models,
      configured: isConfigured(config),
      reportsModalities: catalog.some((model) => modalitiesOf(model).length > 0),
    });
  }
  return detected;
}
