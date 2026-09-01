// Codex CLI on-disk model metadata cache reader.
//
// The official `codex` CLI maintains an authenticated per-model metadata cache
// at `<profileDir>/models_cache.json` (profileDir is whatever was passed as
// CODEX_HOME / HOME at launch — typically `~/.codex` for the primary account
// and `~/.codex2` for the next one). Each entry contains the model slug plus
// the CLI's OWN view of the context window, the supported reasoning levels,
// the visibility flag, etc. Reading it is the only way to learn the real
// context limit for a model the CLI exposes — the live `model/list` JSON-RPC
// response deliberately omits it.
//
// Mirrors the grok-build pattern (`readGrokCliModelsCache`) so each model's
// context window is stamped onto the discovered ModelDef as
// `contextWindow: <n>` and `contextVerified: true`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelDef } from '@koryphaios/shared';
import { providerLog } from '../logger';

export interface CodexCliModelMeta {
  /** Real model slug as passed to `codex --model`. */
  slug: string;
  /** Display name from the CLI's own cache. */
  displayName?: string;
  /** Effective context window in tokens. Already validated (>= 1024). */
  contextWindow?: number;
  /** CLI-reported max output tokens. */
  maxOutputTokens?: number;
  /** Whether the model should be visible in pickers (visibility === 'list'). */
  visible: boolean;
  /** Parsed reasoning effort levels from the CLI's cache. */
  reasoningLevels?: string[];
  /** CLI-reported default reasoning effort (already in `reasoningLevels`). */
  defaultReasoningLevel?: string;
}

interface CodexModelsCacheFile {
  fetched_at?: string;
  models?: Array<{
    slug?: unknown;
    display_name?: unknown;
    context_window?: unknown;
    max_context_window?: unknown;
    max_output_tokens?: unknown;
    visibility?: unknown;
    supported_reasoning_levels?: Array<{ effort?: unknown }> | null;
    default_reasoning_level?: unknown;
  }>;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 1024) return undefined;
  return Math.floor(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Parse the raw JSON of `<profileDir>/models_cache.json`. Pure / synchronous. */
export function parseCodexCliModelsCache(raw: string): Map<string, CodexCliModelMeta> {
  const out = new Map<string, CodexCliModelMeta>();
  if (!raw || !raw.trim()) return out;
  let parsed: CodexModelsCacheFile;
  try {
    parsed = JSON.parse(raw) as CodexModelsCacheFile;
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'codex: failed to parse models_cache.json',
    );
    return out;
  }
  if (!Array.isArray(parsed.models)) return out;
  for (const entry of parsed.models) {
    const slug = asString(entry?.slug);
    if (!slug) continue;
    // visibility: 'list' = public, 'hide' = internal. Default to public so a
    // cache from a newer CLI that omits the field still lights the picker.
    const visible = entry?.visibility !== 'hide';
    const reasoningLevels = Array.isArray(entry?.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
          .map((e) => asString(e?.effort))
          .filter((level): level is string => !!level)
      : undefined;
    out.set(slug, {
      slug,
      displayName: asString(entry?.display_name),
      // `context_window` is the canonical limit; `max_context_window` is the
      // CLI's hard ceiling and only wins if `context_window` is absent.
      contextWindow:
        asPositiveInt(entry?.context_window) ?? asPositiveInt(entry?.max_context_window),
      maxOutputTokens: asPositiveInt(entry?.max_output_tokens),
      visible,
      ...(reasoningLevels && reasoningLevels.length > 0 ? { reasoningLevels } : {}),
      ...(asString(entry?.default_reasoning_level)
        ? { defaultReasoningLevel: asString(entry?.default_reasoning_level) }
        : {}),
    });
  }
  return out;
}


/** Read `<profileDir>/models_cache.json` and return a slug → meta map.
 *  Returns null when the file is missing or unreadable. */
export function readCodexModelsCacheFromProfile(
  profileDir: string,
): Map<string, CodexCliModelMeta> | null {
  if (!profileDir) return null;
  const path = join(profileDir, 'models_cache.json');
  if (!existsSync(path)) return null;
  try {
    return parseCodexCliModelsCache(readFileSync(path, 'utf8'));
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err), path },
      'codex: failed to read models_cache.json',
    );
    return null;
  }
}

/** Read every Codex profile home (~/.codex, ~/.codex2, …) and merge them
 *  into one map. The first match for a slug wins so the primary profile
 *  beats the secondary when both have a cache. */
export function readAllCodexModelsCaches(): Map<string, CodexCliModelMeta> {
  const merged = new Map<string, CodexCliModelMeta>();
  const home = homedir();
  if (!home) return merged;
  const candidates = [join(home, '.codex')];
  // Follow the same pattern Codex uses internally for the next profile.
  for (let i = 2; i <= 9; i++) candidates.push(join(home, `.codex${i}`));
  for (const profileDir of candidates) {
    if (!existsSync(profileDir)) continue;
    const map = readCodexModelsCacheFromProfile(profileDir);
    if (!map) continue;
    for (const [slug, meta] of map) {
      if (!merged.has(slug)) merged.set(slug, meta);
    }
  }
  return merged;
}

/** Apply the CLI's authoritative `models_cache.json` metadata onto a list of
 *  already-discovered ModelDefs. Per-model values only overwrite when the
 *  cache actually reports a real value — invented zeros are not preserved.
 *  Returns a new array; the input is not mutated. */
export function enrichCodexModelsWithCliCache(
  models: ModelDef[],
  cache: Map<string, CodexCliModelMeta> | null,
): ModelDef[] {
  if (!cache || cache.size === 0) return models;
  return models.map((m) => {
    const key = m.apiModelId ?? m.id;
    if (!key) return m;
    const meta = cache.get(key);
    if (!meta) return m;
    const next: ModelDef = { ...m };
    if (meta.contextWindow && meta.contextWindow > 0) {
      next.contextWindow = meta.contextWindow;
      next.contextVerified = true;
    }
    if (meta.maxOutputTokens && meta.maxOutputTokens > 0) {
      next.maxOutputTokens = meta.maxOutputTokens;
    }
    if (meta.displayName && !m.name) next.name = meta.displayName;
    if (meta.reasoningLevels && meta.reasoningLevels.length > 0) {
      next.reasoningLevels = meta.reasoningLevels;
      next.canReason = true;
    }
    return next;
  });
}

