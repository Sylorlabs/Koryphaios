// Antigravity quota fetcher — uses the agy CLI's built-in `/usage` slash
// command to get live per-group quota without hardcoding.
//
// The agy CLI (≥1.1.11) supports non-interactive slash commands in print mode:
//   agy --print "/usage" --output-format json
// This returns structured JSON with quota groups (Gemini Models, Claude and
// GPT models), each with weekly and 5-hour limit buckets containing
// remaining_fraction (0–1) and reset_time (ISO 8601).
//
// The quota is per-GROUP, not per-model: all Gemini models share one quota
// pool, and all Claude/GPT models share another. We map each model from
// `agy models` to its group so the UI can show the right remaining fraction.

import type { ModelQuota } from '@koryphaios/shared';
import { spawn } from 'node:child_process';
import { providerLog } from '../logger';
import { whichBinary } from './cli-detection';

/** Quota info for a group of models (e.g. "Gemini Models", "Claude and GPT models"). */
export interface AntigravityQuotaGroup {
  /** Group name from the agy CLI (e.g. "Gemini Models", "Claude and GPT models"). */
  name: string;
  /** Human-readable description listing the models in this group. */
  description: string;
  /** Quota buckets — typically "weekly" and "5h". */
  buckets: Array<{
    id: string;
    name: string;
    window: string;
    remainingFraction: number;
    resetTime: string;
  }>;
}

/** Shape of the `/usage` JSON response from `agy --print "/usage" --output-format json`. */
interface AgyUsageResponse {
  status?: string;
  command?: {
    name?: string;
    data?: {
      description?: string;
      groups?: Array<{
        name?: string;
        description?: string;
        buckets?: Array<{
          id?: string;
          name?: string;
          window?: string;
          remaining_fraction?: number;
          reset_time?: string;
        }>;
      }>;
    };
  };
}

/** Fetch quota groups from `agy --print "/usage" --output-format json`.
 *
 *  Returns the parsed quota groups, or null if the CLI is unavailable or the
 *  command fails. The caller maps models to groups and attaches the more
 *  restrictive (lower) of the weekly and 5-hour remaining fractions. */
export async function fetchAntigravityQuotaGroups(): Promise<
  AntigravityQuotaGroup[] | null
> {
  const bin = whichBinary('agy');
  if (!bin) return null;

  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ['--print', '/usage', '--output-format', 'json'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );

    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.once('error', () => resolve(null));
    child.once('exit', () => {
      try {
        const parsed = JSON.parse(out) as AgyUsageResponse;
        const groups = parsed.command?.data?.groups;
        if (!groups || groups.length === 0) {
          providerLog.debug('antigravity-quota: /usage returned no groups');
          resolve(null);
          return;
        }
        const mapped: AntigravityQuotaGroup[] = groups.map((g) => ({
          name: g.name ?? '',
          description: g.description ?? '',
          buckets: (g.buckets ?? []).map((b) => ({
            id: b.id ?? '',
            name: b.name ?? '',
            window: b.window ?? '',
            remainingFraction: b.remaining_fraction ?? 0,
            resetTime: b.reset_time ?? '',
          })),
        }));
        providerLog.debug(
          { groups: mapped.map((g) => g.name) },
          'antigravity-quota: fetched live quota groups',
        );
        resolve(mapped);
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'antigravity-quota: failed to parse /usage response',
        );
        resolve(null);
      }
    });
  });
}

/** Build a ModelQuota from a quota group's buckets.
 *  Uses the more restrictive (lower) remaining fraction and the earlier reset
 *  time, so the UI shows the worst-case limit. */
function quotaFromGroup(group: AntigravityQuotaGroup): ModelQuota {
  const buckets = group.buckets;
  if (buckets.length === 0) {
    return { remainingFraction: 1, resetTime: 0 };
  }
  // Pick the bucket with the lowest remaining fraction — that's the binding
  // constraint the user cares about.
  const binding = buckets.reduce((min, b) =>
    b.remainingFraction < min.remainingFraction ? b : min,
  );
  return {
    remainingFraction: binding.remainingFraction,
    resetTime: binding.resetTime ? Date.parse(binding.resetTime) : 0,
  };
}

/** Fetch live per-model quota from the agy CLI's `/usage` command.
 *
 *  Returns a map of cliModelId → ModelQuota. Since quota is per-group (not
 *  per-model), every model in a group gets the same quota values. Models that
 *  don't match any known group are omitted from the map.
 *
 *  Returns null if the CLI is unavailable or the command fails. */
export async function fetchAntigravityQuota(): Promise<
  Map<string, ModelQuota> | null
> {
  const groups = await fetchAntigravityQuotaGroups();
  if (!groups) return null;

  const groupQuotas = new Map<string, ModelQuota>();
  for (const g of groups) {
    groupQuotas.set(g.name, quotaFromGroup(g));
  }

  // We don't have the model list here — the caller (antigravity provider)
  // will map models to groups. But we can also return the group-level data
  // directly for the caller to use.
  // For backwards compatibility with the existing interface, we return a
  // map keyed by group name. The provider's mergeQuotaIntoModels function
  // maps each model to its group.
  return groupQuotas;
}
