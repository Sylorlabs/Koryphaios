/** Model-specific composer preferences that are safe to keep on this device. */

import type {
  FusionCatalog,
  FusionSelection,
  ModelParameterDef,
  ModelParameterValues,
  ModelSpeedTier,
} from '@koryphaios/shared';
import { isFusionPairingAvailable, sanitizeModelParameterValues } from '@koryphaios/shared';

type ModelPreference = {
  reasoningLevel?: string;
  /** Retired Fast switch — kept so a saved true still migrates onto the
   * model's first speed tier via `initialSpeedTier`. */
  fastMode?: boolean;
  /** The chosen faster serving tier id (`null` = explicit Off). */
  speedTier?: string | null;
  /** Composer "Model settings" overrides for this model — keys absent mean
   * the provider's own default applies. */
  modelParameters?: ModelParameterValues;
  /** Devin Fusion slot selection — only meaningful on `devin:fusion`. */
  fusion?: FusionSelection;
  contextWindow?: number;
};

const STORAGE_KEY = 'koryphaios-composer-preferences-v1';
const MAX_MODELS = 48;

function storage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

function readAll(): Record<string, ModelPreference> {
  const local = storage();
  if (!local) return {};
  try {
    const parsed = JSON.parse(local.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, ModelPreference> = {};
    for (const [model, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      const preference: ModelPreference = {
        ...(typeof value.reasoningLevel === 'string' && value.reasoningLevel
          ? { reasoningLevel: value.reasoningLevel.slice(0, 80) }
          : {}),
        ...(typeof value.fastMode === 'boolean' ? { fastMode: value.fastMode } : {}),
        ...(typeof value.speedTier === 'string' && value.speedTier
          ? { speedTier: value.speedTier.slice(0, 64) }
          : value.speedTier === null
            ? { speedTier: null }
            : {}),
        ...(typeof value.contextWindow === 'number' &&
        Number.isFinite(value.contextWindow) &&
        value.contextWindow > 0
          ? { contextWindow: value.contextWindow }
          : {}),
        ...(value.modelParameters &&
        typeof value.modelParameters === 'object' &&
        !Array.isArray(value.modelParameters)
          ? {
              modelParameters: Object.fromEntries(
                Object.entries(value.modelParameters as Record<string, unknown>).filter(
                  ([, v]) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string',
                ),
              ),
            }
          : {}),
        ...(isFusionSelection(value.fusion) ? { fusion: value.fusion } : {}),
      };
      if (
        preference.reasoningLevel !== undefined ||
        preference.fastMode !== undefined ||
        preference.speedTier !== undefined ||
        preference.contextWindow !== undefined ||
        preference.fusion !== undefined ||
        (preference.modelParameters !== undefined &&
          Object.keys(preference.modelParameters).length > 0)
      ) {
        result[model.slice(0, 300)] = preference;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeAll(preferences: Record<string, ModelPreference>): void {
  const local = storage();
  if (!local) return;
  try {
    const capped = Object.fromEntries(Object.entries(preferences).slice(-MAX_MODELS));
    local.setItem(STORAGE_KEY, JSON.stringify(capped));
  } catch {}
}

function safeModel(model: string): string {
  return model.trim().slice(0, 300);
}

export function loadComposerPreference(model: string): ModelPreference {
  return readAll()[safeModel(model)] ?? {};
}

/** The speed control's starting state for a model: the user's saved tier when
 *  it is still offered, the first tier for a saved legacy `fastMode: true`,
 *  or Off when the model was never configured — never the previous model's
 *  value. */
export function initialSpeedTier(
  saved: { speedTier?: string | null; fastMode?: boolean },
  tiers: ModelSpeedTier[],
): string | null {
  if (saved.speedTier && tiers.some((tier) => tier.id === saved.speedTier)) {
    return saved.speedTier;
  }
  if (saved.fastMode === true && tiers.length > 0) return tiers[0].id;
  return null;
}

/** Shape guard for a stored Fusion selection — pairing availability is
 * checked against the live catalog by `initialFusionSelection`. */
function isFusionSelection(raw: unknown): raw is FusionSelection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const v = raw as Record<string, unknown>;
  return (
    typeof v.lead === 'string' &&
    typeof v.leadEffort === 'string' &&
    typeof v.leadFast === 'boolean' &&
    typeof v.sidekick === 'string' &&
    (v.sidekickEffort === null || typeof v.sidekickEffort === 'string')
  );
}

/** Fusion's starting selection for a model: the saved pairing when the live
 * catalog still offers it, else the vendor's own default. An unknown catalog
 * returns the saved selection untouched so a not-yet-loaded provider can't
 * erase a choice. */
export function initialFusionSelection(
  saved: { fusion?: FusionSelection },
  catalog: FusionCatalog | undefined,
): FusionSelection | null {
  if (!catalog) return saved.fusion ?? null;
  if (saved.fusion && isFusionPairingAvailable(catalog, saved.fusion)) {
    return saved.fusion;
  }
  return { ...catalog.defaultSelection };
}

/** The settings panel's starting values for a model: only the saved keys the
 * model's live parameter list still declares. An unknown def returns the
 * saved object untouched so a not-yet-loaded catalog can't erase a choice. */
export function initialModelParameters(
  saved: { modelParameters?: ModelParameterValues },
  defs: ModelParameterDef[] | undefined,
): ModelParameterValues {
  if (!defs) return saved.modelParameters ?? {};
  return sanitizeModelParameterValues(defs, saved.modelParameters);
}

export function saveComposerPreference(model: string, next: ModelPreference): void {
  const key = safeModel(model);
  if (!key) return;
  const all = readAll();
  const merged = { ...all[key], ...next };
  // An explicit undefined erases the field: only defined values are stored,
  // so "Default" clears the persisted session budget instead of keeping a
  // stale one.
  const stored: ModelPreference = {};
  if (merged.reasoningLevel !== undefined) stored.reasoningLevel = merged.reasoningLevel;
  if (merged.fastMode !== undefined) stored.fastMode = merged.fastMode;
  if (merged.speedTier !== undefined) stored.speedTier = merged.speedTier;
  if (merged.modelParameters !== undefined) stored.modelParameters = merged.modelParameters;
  if (merged.fusion !== undefined) stored.fusion = merged.fusion;
  if (merged.contextWindow !== undefined) stored.contextWindow = merged.contextWindow;
  all[key] = stored;
  writeAll(all);
}
