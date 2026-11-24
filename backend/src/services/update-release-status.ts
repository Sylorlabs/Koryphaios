/**
 * Read-only GitHub Actions release activity.
 *
 * The signed Tauri `latest.json` manifest is still the only thing that can make
 * an update installable. This probe answers the earlier question: did the
 * configured release trigger start, and which version is it preparing or
 * building? It deliberately never turns a failed or incomplete run into an
 * available update.
 *
 * Configuration:
 *   KORY_UPDATE_REPO               owner/repo (default Sylorlabs/Koryphaios)
 *   KORY_UPDATE_WORKFLOW           desktop release workflow (default release-desktop.yml)
 *   KORY_UPDATE_PREPARE_WORKFLOW   release-preparation workflow (default auto-release.yml)
 *   KORY_UPDATE_GITHUB_TOKEN       optional read-only token for API rate limits
 */

import type {
  UpdateReleaseActivity,
  UpdateReleaseRunStatus,
  UpdateReleaseStatus,
  UpdateReleaseTrigger,
} from '@koryphaios/shared';
import { VERSION } from '../constants';

const DEFAULT_REPO = 'Sylorlabs/Koryphaios';
const DEFAULT_RELEASE_WORKFLOW = 'release-desktop.yml';
const DEFAULT_PREPARE_WORKFLOW = 'auto-release.yml';
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60_000;
const ERROR_CACHE_TTL_MS = 60_000;
const MAX_RUNS = 10;

type FetchImpl = typeof fetch;

interface GitHubRun {
  id?: number;
  head_branch?: string | null;
  head_sha?: string | null;
  status?: string | null;
  conclusion?: string | null;
  event?: string | null;
  html_url?: string | null;
  created_at?: string | null;
  run_started_at?: string | null;
  head_commit?: { message?: string | null } | null;
}

interface WorkflowRunsResponse {
  workflow_runs?: GitHubRun[];
}

export interface UpdateReleaseDeps {
  fetch?: FetchImpl;
  now?: () => number;
  repo?: string;
  releaseWorkflow?: string;
  prepareWorkflow?: string;
  token?: string | null;
  cacheTtlMs?: number;
  errorCacheTtlMs?: number;
}

interface ResolvedConfig {
  repo: string;
  releaseWorkflow: string;
  prepareWorkflow: string;
  token: string | null;
}

interface CacheEntry {
  key: string;
  expiresAt: number;
  status: UpdateReleaseStatus;
}

let cached: CacheEntry | null = null;
let inFlight: Promise<UpdateReleaseStatus> | null = null;

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeRepo(value: string | undefined): string {
  const candidate = clean(value ?? process.env.KORY_UPDATE_REPO) || DEFAULT_REPO;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate) ? candidate : DEFAULT_REPO;
}

function safeWorkflow(
  value: string | undefined,
  fallback: string,
  envValue: string | undefined,
): string {
  const candidate = clean(value ?? envValue) || fallback;
  return /^[A-Za-z0-9_.-]+$/.test(candidate) ? candidate : fallback;
}

function resolveConfig(deps: UpdateReleaseDeps): ResolvedConfig {
  return {
    repo: safeRepo(deps.repo),
    releaseWorkflow: safeWorkflow(
      deps.releaseWorkflow,
      DEFAULT_RELEASE_WORKFLOW,
      process.env.KORY_UPDATE_WORKFLOW,
    ),
    prepareWorkflow: safeWorkflow(
      deps.prepareWorkflow,
      DEFAULT_PREPARE_WORKFLOW,
      process.env.KORY_UPDATE_PREPARE_WORKFLOW,
    ),
    token: clean(deps.token ?? process.env.KORY_UPDATE_GITHUB_TOKEN) || null,
  };
}

function githubHeaders(token: string | null): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'koryphaios-updater',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchJson<T>(url: string, token: string | null, fetchImpl: FetchImpl): Promise<T> {
  const response = await fetchImpl(url, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  return (await response.json()) as T;
}

async function fetchRuns(
  repo: string,
  workflow: string,
  token: string | null,
  fetchImpl: FetchImpl,
): Promise<GitHubRun[]> {
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/` +
    `${encodeURIComponent(workflow)}/runs?per_page=${MAX_RUNS}`;
  const body = await fetchJson<WorkflowRunsResponse>(url, token, fetchImpl);
  return Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
}

async function readVersionAtRevision(
  repo: string,
  revision: string | null | undefined,
  fetchImpl: FetchImpl,
): Promise<string | null> {
  if (!revision || !/^[0-9a-f]{7,40}$/i.test(revision)) return null;
  try {
    const response = await fetchImpl(
      `https://raw.githubusercontent.com/${repo}/${revision}/desktop/src-tauri/tauri.conf.json`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const config = (await response.json()) as { version?: unknown };
    return typeof config.version === 'string' && config.version.trim()
      ? config.version.trim()
      : null;
  } catch {
    return null;
  }
}

function normalizeStatus(status: string | null | undefined): UpdateReleaseRunStatus {
  if (status === 'queued' || status === 'in_progress' || status === 'completed') return status;
  return 'unknown';
}

function isActive(run: GitHubRun): boolean {
  return run.status === 'queued' || run.status === 'in_progress';
}

function versionFromTag(branch: string | null | undefined): string | null {
  const match = /^v(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?)$/.exec(branch ?? '');
  return match?.[1] ?? null;
}

function versionParts(version: string): { core: number[]; prerelease: string | null } {
  const normalized = version.replace(/^v/, '');
  const [core = '', prerelease] = normalized.split('-', 2);
  return {
    core: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
    prerelease: prerelease ?? null,
  };
}

/** Tauri's comparator semantics: a newer version is a higher core first. */
export function isVersionNewer(candidate: string, current: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    const a = left.core[index] ?? 0;
    const b = right.core[index] ?? 0;
    if (a !== b) return a > b;
  }
  if (left.prerelease === right.prerelease) return false;
  // A stable release outranks a prerelease with the same core.
  if (left.prerelease === null) return true;
  if (right.prerelease === null) return false;
  return left.prerelease > right.prerelease;
}

function newestRun(runs: readonly GitHubRun[]): GitHubRun | undefined {
  return [...runs].sort((a, b) => {
    const aTime = Date.parse(a.created_at ?? '') || 0;
    const bTime = Date.parse(b.created_at ?? '') || 0;
    return bTime - aTime;
  })[0];
}

function runUrl(run: GitHubRun, repo: string): string {
  return run.html_url ?? (run.id ? `https://github.com/${repo}/actions/runs/${run.id}` : '');
}

function toActivity(
  run: GitHubRun,
  repo: string,
  phase: UpdateReleaseActivity['phase'],
  workflow: string,
  trigger: UpdateReleaseTrigger,
  version: string | null,
  tag: string | null,
): UpdateReleaseActivity | null {
  const url = runUrl(run, repo);
  if (!url) return null;
  return {
    phase,
    version,
    tag,
    status: normalizeStatus(run.status),
    conclusion: run.conclusion ?? null,
    runUrl: url,
    workflow,
    trigger,
    startedAt: run.run_started_at ?? run.created_at ?? null,
  };
}

function prepareTrigger(run: GitHubRun): UpdateReleaseTrigger | null {
  if (run.event === 'workflow_dispatch') return 'manual';
  if (run.event === 'push' && /(?:^|\s)\/update(?:\s|$)/.test(run.head_commit?.message ?? '')) {
    return 'commit';
  }
  return null;
}

async function loadReleaseActivity(
  config: ResolvedConfig,
  deps: UpdateReleaseDeps,
  now: number,
): Promise<UpdateReleaseStatus> {
  const fetchImpl = deps.fetch ?? fetch;
  const failures: string[] = [];

  const [releaseRuns, prepareRuns] = await Promise.all([
    fetchRuns(config.repo, config.releaseWorkflow, config.token, fetchImpl).catch(() => {
      failures.push('release');
      return [] as GitHubRun[];
    }),
    fetchRuns(config.repo, config.prepareWorkflow, config.token, fetchImpl).catch(() => {
      failures.push('prepare');
      return [] as GitHubRun[];
    }),
  ]);

  const buildRun = newestRun(
    releaseRuns.filter((run) => {
      if (!isActive(run)) return false;
      const version = versionFromTag(run.head_branch);
      return version !== null && isVersionNewer(version, VERSION);
    }),
  );

  let activity: UpdateReleaseActivity | null = null;
  if (buildRun) {
    const version = versionFromTag(buildRun.head_branch);
    activity = toActivity(
      buildRun,
      config.repo,
      'building',
      config.releaseWorkflow,
      buildRun.event === 'workflow_dispatch' ? 'manual' : 'tag',
      version,
      buildRun.head_branch ?? (version ? `v${version}` : null),
    );
  }

  if (!activity) {
    const prepareRun = newestRun(
      prepareRuns.filter((run) => isActive(run) && prepareTrigger(run) !== null),
    );
    if (prepareRun) {
      const version = await readVersionAtRevision(config.repo, prepareRun.head_sha, fetchImpl);
      if (version === null || isVersionNewer(version, VERSION)) {
        activity = toActivity(
          prepareRun,
          config.repo,
          'preparing',
          config.prepareWorkflow,
          prepareTrigger(prepareRun) ?? 'manual',
          version,
          null,
        );
      }
    }
  }

  return {
    repo: config.repo,
    currentVersion: VERSION,
    checkedAt: new Date(now).toISOString(),
    activity,
    // A probe failure is only surfaced when it left us with no answer at all.
    error: activity ? null : failures.length > 0 ? 'Release status temporarily unavailable.' : null,
  };
}

export interface GetUpdateReleaseStatusOptions {
  force?: boolean;
  deps?: UpdateReleaseDeps;
}

export async function getUpdateReleaseStatus(
  options: GetUpdateReleaseStatusOptions = {},
): Promise<UpdateReleaseStatus> {
  const deps = options.deps ?? {};
  const config = resolveConfig(deps);
  const cacheKey = `${config.repo}|${config.releaseWorkflow}|${config.prepareWorkflow}`;
  const now = deps.now?.() ?? Date.now();

  if (!options.force && cached && cached.key === cacheKey && cached.expiresAt > now) {
    return cached.status;
  }
  if (!options.force && inFlight) return inFlight;

  const promise = loadReleaseActivity(config, deps, now)
    .then((status) => {
      const ttl = status.error
        ? (deps.errorCacheTtlMs ?? ERROR_CACHE_TTL_MS)
        : (deps.cacheTtlMs ?? CACHE_TTL_MS);
      cached = { key: cacheKey, expiresAt: now + ttl, status };
      return status;
    })
    .finally(() => {
      if (inFlight === promise) inFlight = null;
    });

  inFlight = promise;
  return promise;
}

/** Test seam: the probe cache is process-wide so the UI never hammers GitHub. */
export function resetUpdateReleaseStatusCache(): void {
  cached = null;
  inFlight = null;
}
