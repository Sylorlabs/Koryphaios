import type { ModelDef } from '@koryphaios/shared';

/** One availability contract for every "is this model enabled" check, shared
 * by the registry, compaction, and provider validation so the backend agrees
 * with the composer picker. */

/** Resolve a caller-supplied id (model id or alias) to its live catalog id. */
export function resolveCatalogModelId(
  catalog: readonly Pick<ModelDef, 'id' | 'aliases'>[],
  modelId: string,
): string | null {
  const match = catalog.find((m) => m.id === modelId || m.aliases?.includes(modelId));
  return match?.id ?? null;
}

/** The enabled id list for a provider status. A `selectedModels` list that
 * resolves to zero live catalog entries is treated as unfiltered — every
 * entry is stale (e.g. a removed model id), and the picker rule "empty means
 * all" applies so the saved selection cannot silently hide the whole catalog. */
export function resolveEnabledModelIds(
  catalog: readonly Pick<ModelDef, 'id' | 'aliases'>[],
  selectedModels: readonly string[],
): string[] {
  if (selectedModels.length === 0) return catalog.map((m) => m.id);
  const enabled = catalog
    .filter(
      (m) =>
        selectedModels.includes(m.id) ||
        m.aliases?.some((alias) => selectedModels.includes(alias)),
    )
    .map((m) => m.id);
  return enabled.length > 0 ? enabled : catalog.map((m) => m.id);
}

/** Whether `modelId` (id or alias) exists in the live catalog AND is enabled.
 * `enabledIds` must already carry the all-stale fallback (resolveEnabledModelIds
 * or a status row produced through it). */
export function isModelEnabledInCatalog(
  catalog: readonly Pick<ModelDef, 'id' | 'aliases'>[],
  enabledIds: readonly string[],
  modelId: string,
): boolean {
  const resolved = resolveCatalogModelId(catalog, modelId);
  return resolved !== null && enabledIds.includes(resolved);
}
