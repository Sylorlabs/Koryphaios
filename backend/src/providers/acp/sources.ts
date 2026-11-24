// Where ACP agents come from. Three read-only sources; nothing here installs,
// downloads or executes an agent.
//
//   (a) official registry  — https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
//                            fetched with a timeout, redirects refused, size-capped, cached.
//                            Entries show install instructions; the user confirms any add.
//   (b) PATH autodetect    — candidate binaries found on PATH are listed as available.
//                            Their argument sets are unverified until a probe succeeds.
//   (c) manual / custom    — handled by the agent store (see agent-store.ts).

import { findExecutableOnPath } from '../../runtime/platform';
import { serverLog } from '../../logger';

export const OFFICIAL_ACP_REGISTRY_URL =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const REGISTRY_HOST = 'cdn.agentclientprotocol.com';
const REGISTRY_TIMEOUT_MS = 10_000;
const REGISTRY_MAX_BYTES = 2 * 1024 * 1024;
const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000;
const REGISTRY_NEGATIVE_TTL_MS = 10 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface AcpRegistryInstall {
  kind: 'npx' | 'uvx' | 'binary' | 'unknown';
  /** Suggested argv for an explicit user add. Never executed by Kory on its own. */
  command?: string;
  args?: string[];
  /** Human-readable install instruction shown in the UI. */
  instructions: string;
}

export interface AcpRegistryEntry {
  id: string;
  name: string;
  version?: string;
  description?: string;
  repository?: string;
  website?: string;
  license?: string;
  icon?: string;
  install: AcpRegistryInstall;
}

export interface AcpRegistrySnapshot {
  ok: boolean;
  url: string;
  fetchedAt: number;
  /** 'network' for a live fetch, 'cache' when a cached snapshot is served. */
  source: 'network' | 'cache' | 'none';
  entries: AcpRegistryEntry[];
  error?: string;
}

// ─── Registry parsing ────────────────────────────────────────────────────────

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function parseInstall(distribution: unknown): AcpRegistryInstall {
  if (!distribution || typeof distribution !== 'object') {
    return { kind: 'unknown', instructions: 'No install information published.' };
  }
  const dist = distribution as Record<string, unknown>;
  const npx = dist.npx as { package?: unknown; args?: unknown } | undefined;
  if (npx && str(npx.package)) {
    const pkg = str(npx.package)!;
    const args = strArray(npx.args);
    return {
      kind: 'npx',
      command: 'npx',
      args: ['-y', pkg, ...args],
      instructions: `Runs via npx: npx -y ${pkg}${args.length ? ' ' + args.join(' ') : ''}`,
    };
  }
  const uvx = dist.uvx as { package?: unknown; args?: unknown } | undefined;
  if (uvx && str(uvx.package)) {
    const pkg = str(uvx.package)!;
    const args = strArray(uvx.args);
    return {
      kind: 'uvx',
      command: 'uvx',
      args: [pkg, ...args],
      instructions: `Runs via uvx: uvx ${pkg}${args.length ? ' ' + args.join(' ') : ''}`,
    };
  }
  if (dist.binary && typeof dist.binary === 'object') {
    return {
      kind: 'binary',
      instructions:
        'Published as a platform binary. Install it yourself, then add its path as a custom agent.',
    };
  }
  return { kind: 'unknown', instructions: 'No supported install method published.' };
}

/** Validate a registry payload and keep only well-formed entries. Exported for tests. */
export function parseAcpRegistry(raw: unknown): AcpRegistryEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const agents = (raw as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return [];
  const out: AcpRegistryEntry[] = [];
  for (const item of agents) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = str(rec.id);
    const name = str(rec.name);
    if (!id || !name || !ID_RE.test(id)) continue;
    out.push({
      id,
      name,
      version: str(rec.version),
      description: str(rec.description),
      repository: str(rec.repository),
      website: str(rec.website),
      license: str(rec.license),
      icon: str(rec.icon),
      install: parseInstall(rec.distribution),
    });
    if (out.length >= 500) break;
  }
  return out;
}

// ─── Registry fetch (cached, read-only) ──────────────────────────────────────

let cached: { snapshot: AcpRegistrySnapshot; expiresAt: number } | null = null;
let inflight: Promise<AcpRegistrySnapshot> | null = null;

export interface FetchRegistryOptions {
  fetchImpl?: typeof fetch;
  url?: string;
  timeoutMs?: number;
  force?: boolean;
  now?: () => number;
}

export function resetAcpRegistryCacheForTesting(): void {
  cached = null;
  inflight = null;
}

/**
 * Fetch the official registry. Never throws: a failure returns `ok: false` with
 * the last good entries (if any) so the UI keeps showing what it knew.
 */
export async function fetchAcpRegistry(
  opts: FetchRegistryOptions = {},
): Promise<AcpRegistrySnapshot> {
  const now = opts.now ?? Date.now;
  if (!opts.force && cached && cached.expiresAt > now()) {
    return { ...cached.snapshot, source: 'cache' };
  }
  if (inflight) return inflight;
  inflight = doFetch(opts, now).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doFetch(
  opts: FetchRegistryOptions,
  now: () => number,
): Promise<AcpRegistrySnapshot> {
  const url = opts.url ?? OFFICIAL_ACP_REGISTRY_URL;
  const fetchedAt = now();
  const fail = (error: string): AcpRegistrySnapshot => {
    const previous = cached?.snapshot.entries ?? [];
    const snapshot: AcpRegistrySnapshot = {
      ok: false,
      url,
      fetchedAt,
      source: previous.length > 0 ? 'cache' : 'none',
      entries: previous,
      error,
    };
    cached = {
      snapshot: { ...snapshot, source: 'network' },
      expiresAt: now() + REGISTRY_NEGATIVE_TTL_MS,
    };
    serverLog.warn({ error }, 'ACP agent registry fetch failed');
    return snapshot;
  };

  let expectedHost: string;
  try {
    expectedHost = new URL(url).host;
  } catch {
    return fail('registry URL is invalid');
  }

  try {
    const response = await (opts.fetchImpl ?? fetch)(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? REGISTRY_TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'koryphaios' },
    });
    if (response.status >= 300 && response.status < 400) {
      return fail(
        `registry responded with a redirect (HTTP ${response.status}); redirects are refused`,
      );
    }
    if (!response.ok) return fail(`registry responded with HTTP ${response.status}`);
    if (new URL(response.url || url).host !== expectedHost) {
      return fail('registry response came from an unexpected host');
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > REGISTRY_MAX_BYTES) return fail('registry response is too large');
    const text = await response.text();
    if (text.length > REGISTRY_MAX_BYTES) return fail('registry response is too large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail('registry response is not valid JSON');
    }
    const entries = parseAcpRegistry(parsed);
    if (entries.length === 0) return fail('registry contained no usable agents');
    const snapshot: AcpRegistrySnapshot = {
      ok: true,
      url,
      fetchedAt,
      source: 'network',
      entries,
    };
    cached = { snapshot, expiresAt: now() + REGISTRY_TTL_MS };
    return snapshot;
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    return fail(
      name === 'TimeoutError' || name === 'AbortError'
        ? `registry fetch timed out after ${opts.timeoutMs ?? REGISTRY_TIMEOUT_MS}ms`
        : 'registry fetch failed (network unavailable)',
    );
  }
}

// ─── PATH autodetect ─────────────────────────────────────────────────────────

export interface AutodetectCandidate {
  id: string;
  label: string;
  binary: string;
  args: string[];
  /** False until a probe proves the argument set. Listing is never enablement. */
  argsVerified: false;
}

/** Known ACP-capable agent CLIs that are not already a built-in Kory provider.
 *  Argument sets are candidates; a successful probe is the only verdict. */
export const AUTODETECT_CANDIDATES: readonly AutodetectCandidate[] = [
  {
    id: 'gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    args: ['--experimental-acp'],
    argsVerified: false,
  },
  { id: 'goose', label: 'Goose', binary: 'goose', args: ['acp'], argsVerified: false },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    binary: 'copilot',
    args: ['--acp'],
    argsVerified: false,
  },
  {
    id: 'codex-acp',
    label: 'Codex ACP adapter',
    binary: 'codex-acp',
    args: [],
    argsVerified: false,
  },
  {
    id: 'claude-agent-acp',
    label: 'Claude Agent ACP adapter',
    binary: 'claude-agent-acp',
    args: [],
    argsVerified: false,
  },
];

export interface AutodetectedAgent {
  id: string;
  label: string;
  binaryPath: string;
  args: string[];
  argsVerified: false;
}

export function autodetectAcpAgents(
  candidates: readonly AutodetectCandidate[] = AUTODETECT_CANDIDATES,
  find: (bin: string) => string | null = (bin) => findExecutableOnPath(bin),
): AutodetectedAgent[] {
  const found: AutodetectedAgent[] = [];
  for (const candidate of candidates) {
    const binaryPath = find(candidate.binary);
    if (!binaryPath) continue;
    found.push({
      id: candidate.id,
      label: candidate.label,
      binaryPath,
      args: [...candidate.args],
      argsVerified: candidate.argsVerified,
    });
  }
  return found;
}
