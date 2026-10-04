// Custom (bring-your-own) provider — user-defined endpoints.
//
// A user can add their own provider by giving a base URL + optional API key and choosing
// a wire format ("kind"): OpenAI-compatible (default — the most common), Anthropic-compatible
// (/v1/messages), or Gemini-compatible. We wrap the matching built-in provider so all the
// streaming/parsing logic is reused, and merge any explicitly-declared models with whatever
// the endpoint's /models discovery returns.
//
// Endpoints outside those three dialects are covered by the wire-adapter chain
// (wire-adapters/): auto-detected when an adapter's catalog signature matches
// (Ollama /api/tags), or pinned explicitly from the settings Advanced section.
// An adapter id is stored on the provider config and takes precedence over
// `kind` when constructing the inference backend.

import type { ProviderConfig, ModelDef, ProviderName } from '@koryphaios/shared';
import { serverLog } from '../logger';
import { type Provider, type ProviderEvent, type StreamRequest, createGenericModel } from './types';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GoogleProvider } from './google';
import { applyModelsDevMetadata, refreshModelsDevCache, modelsDevKeysFor } from './models-dev';
import { WireAdapterProvider } from './wire-adapters/wire-adapter-provider';
import { getWireAdapter, listWireAdapters } from './wire-adapters/registry';

export type CustomProviderKind = 'openai' | 'anthropic' | 'gemini';

export interface CustomProviderProbeInput {
  kind?: CustomProviderKind;
  /** Wire-adapter id pinning a non-SDK dialect (see wire-adapters/registry). */
  adapter?: string;
  baseUrl: string;
  apiKey?: string;
  authToken?: string;
  headers?: Record<string, string>;
}

export interface CustomProviderProbeResult {
  success: boolean;
  normalizedBaseUrl?: string;
  models: string[];
  status?: number;
  error?: string;
  /** Authentication failures can never be bypassed. Catalog/network gaps can. */
  canSaveUnverified: boolean;
  /** Wire format used for the probe — explicit input, or auto-detected below. */
  detectedKind?: CustomProviderKind;
  /** Wire adapter selected (auto-detected or explicit), if any. */
  detectedAdapter?: string;
}

const MAX_MODEL_CATALOG_BYTES = 2 * 1024 * 1024;
const TERMINAL_API_PATHS = [
  /\/chat\/completions$/i,
  /\/responses$/i,
  /\/messages$/i,
  /\/models(?:\/[^/]+(?::[a-z]+)?)?$/i,
];

/**
 * Turn the URL users normally copy from provider docs into an API base URL.
 * Koryphaios accepts only HTTP(S), rejects embedded credentials, removes
 * query/fragment material, and repairs common terminal API paths.
 */
export function normalizeCustomProviderBaseUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('A base URL is required');

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Enter a complete endpoint URL beginning with http:// or https://');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Custom provider endpoints must use http:// or https://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Do not put credentials in the endpoint URL; use the API key field');
  }

  parsed.search = '';
  parsed.hash = '';
  let pathname = parsed.pathname.replace(/\/+$/, '');
  for (const terminalPath of TERMINAL_API_PATHS) {
    if (terminalPath.test(pathname)) {
      pathname = pathname.replace(terminalPath, '');
      break;
    }
  }
  parsed.pathname = pathname || '/';

  return parsed.toString().replace(/\/$/, '');
}

/**
 * Ordered catalog candidates for a base whose wire format is already pinned.
 *
 * A stored base is only guaranteed to be the *inference* root. The Anthropic
 * SDK owns the `/v1` segment, so an Anthropic-compatible deployment is
 * commonly configured with a version-less root (`https://host`,
 * `https://api.anthropic.com`) and appends `/v1` itself. Naively concatenating
 * `/models` onto such a base lands on the deployment's web front end, which
 * answers 200 with HTML — a hard "did not return valid JSON" failure for a
 * provider that serves requests perfectly. `detectCustomProviderKind` already
 * probes both shapes; pinned-kind re-verification has to agree with it.
 *
 * The base's own path is tried first so a base that already carries its version
 * segment is never probed twice.
 */
function modelCatalogUrls(baseUrl: string, kind: CustomProviderKind): string[] {
  const root = baseUrl.replace(/\/+$/, '');
  const candidates = [`${root}/models`];
  if (kind === 'anthropic' || kind === 'gemini') {
    const versioned = kind === 'gemini' ? `${root}/v1beta/models` : `${root}/v1/models`;
    if (!candidates.includes(versioned)) candidates.push(versioned);
  }
  return candidates;
}

function modelIdsFromCatalog(payload: unknown, kind: CustomProviderKind): string[] {
  if (!payload || typeof payload !== 'object') return [];
  let entries: unknown;
  if (Array.isArray(payload)) {
    entries = payload;
  } else if (kind === 'gemini') {
    entries = (payload as Record<string, unknown>).models;
  } else {
    const record = payload as Record<string, unknown>;
    entries = Array.isArray(record.data) ? record.data : record.models;
  }
  if (!Array.isArray(entries)) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(0, 10_000)) {
    // Generic arrays may carry bare string ids directly.
    const raw =
      typeof entry === 'string'
        ? entry
        : ((entry as Record<string, unknown> | null)?.[kind === 'gemini' ? 'name' : 'id'] ??
          (entry as Record<string, unknown> | null)?.name ??
          undefined);
    if (typeof raw !== 'string') continue;
    const id = raw.replace(/^models\//, '').trim();
    if (!id || id.length > 512 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// ─── Wire-format auto-detection ─────────────────────────────────────────────
// The settings form no longer asks for an API format: when a staged endpoint
// is probed without an explicit kind, these probes determine whether it
// speaks OpenAI-, Anthropic-, or Gemini-compatible HTTP by fetching candidate
// catalog URLs and classifying the JSON shape that comes back.
//
// Detection signals (verified against live provider docs):
// - OpenAI-compatible:  GET {base}/models          -> { "object": "list",
//   "data": [{ "id", ... }] } with `Authorization: Bearer`. Served by vLLM,
//   Ollama, LM Studio, OpenRouter-style gateways, and most self-hosted APIs.
// - Anthropic-compatible: GET {base}/v1/models     -> { "data": [{ "type":
//   "model", "id", "display_name", "created_at", ... }], "has_more", ... }
//   with `x-api-key` + `anthropic-version: 2023-06-01`. The Anthropic SDK
//   appends `/v1/...` itself, so compatible bases are version-less roots.
// - Gemini native:        GET {base}/models (or {base}/v1beta/models)
//   -> { "models": [{ "name": "models/...", ... }] } with `x-goog-api-key`.
//   (Google's own OpenAI facade classifies as OpenAI by shape, which is
//   correct — it is spoken through the OpenAI path.)
//
// Generic catalogs that match none of the three dialects cleanly — bare JSON
// arrays of ids, Ollama/`/api/tags`-style `{ "models": [{ "name": ... }] }`
// lists, or `{ "data": [{ "name": ... }] }` rows — classify as OpenAI-
// compatible (the most common dialect) with their ids extracted. Native
// Gemini catalogs are kept distinct by their `models/...` name prefix or
// `supportedGenerationMethods` entries, so a generic gateway is never
// misrouted onto the Gemini wire.
//
// OpenAI and Anthropic catalogs both use a top-level `data` array, so the
// classifier keys on envelope/entry markers, never on status codes: a wrong
// auth scheme also returns 401, which proves nothing about the protocol.

/** Classify a decoded model-catalog payload by its JSON shape. */
export function classifyCatalogPayload(payload: unknown): CustomProviderKind | null {
  if (!payload || typeof payload !== 'object') return null;

  // Generic bare-array catalogs: ["id", ...] or [{ "id" | "name" }, ...].
  if (Array.isArray(payload)) {
    const hasUsableEntry = payload.some(
      (entry) =>
        typeof entry === 'string' ||
        (!!entry &&
          typeof entry === 'object' &&
          (typeof (entry as Record<string, unknown>).id === 'string' ||
            typeof (entry as Record<string, unknown>).name === 'string')),
    );
    return hasUsableEntry ? 'openai' : null;
  }

  const record = payload as Record<string, unknown>;

  // Gemini native: { "models": [{ "name": "models/..." }] }. Gemini entries
  // always carry the `models/` name prefix or `supportedGenerationMethods`;
  // lists without either marker (Ollama-style name rows, proxies) are generic
  // and fall through to the OpenAI default rather than the Gemini wire.
  const models = record.models;
  if (Array.isArray(models)) {
    const objects = models.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
    );
    if (objects.length === 0) return null;
    const geminiShaped = objects.some(
      (entry) =>
        (typeof entry.name === 'string' && entry.name.startsWith('models/')) ||
        entry.supportedGenerationMethods !== undefined,
    );
    if (geminiShaped) return 'gemini';
    const hasNamedEntry = objects.some(
      (entry) => typeof entry.name === 'string' || typeof entry.id === 'string',
    );
    return hasNamedEntry ? 'openai' : null;
  }

  const data = record.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  // Anthropic markers: pagination envelope or per-model display metadata.
  if (
    record.has_more !== undefined ||
    record.first_id !== undefined ||
    record.last_id !== undefined
  ) {
    return 'anthropic';
  }
  const first = data.find((entry) => !!entry && typeof entry === 'object') as
    Record<string, unknown> | undefined;
  if (
    first &&
    (typeof first.display_name === 'string' ||
      typeof first.created_at === 'string' ||
      first.type === 'model')
  ) {
    return 'anthropic';
  }
  // OpenAI markers: the `{ "object": "list" }` envelope, bare `{ id }` rows,
  // or generic `{ name }` rows that carry no Anthropic display metadata.
  if (record.object === 'list') return 'openai';
  if (first && (typeof first.id === 'string' || typeof first.name === 'string')) return 'openai';
  return null;
}

export interface CustomProviderDetection {
  /** Winning wire format, or 'openai' (the most common) when nothing matched. */
  kind: CustomProviderKind;
  /** Wire adapter selected for a non-SDK dialect, when one matched. */
  adapter?: string;
  models: string[];
  status?: number;
  /** Base to persist: scheme-upgraded and family-adjusted when applicable. */
  normalizedBaseUrl: string;
  authFailure: boolean;
  unreachable: boolean;
  sawCatalogResponse: boolean;
}

interface DetectionProbe {
  url: string;
  /** Catalog path suffix, used to reconstruct the base after redirects. */
  suffix: string;
  headers: Headers;
}

interface DetectionOutcome {
  probe: DetectionProbe;
  status?: number;
  networkError: boolean;
  finalUrl?: string;
  classified: CustomProviderKind | null;
  /** Wire adapter whose matchCatalog recognized this payload, if any. */
  adapter?: string;
  /** Decoded catalog payload, retained briefly for adapter matching. */
  payload?: unknown;
  models: string[];
  sawCatalogResponse: boolean;
}

/** Reconstruct the API base from a final (post-redirect) catalog URL by
 *  removing exactly the suffix this probe appended. */
function baseFromCatalogUrl(finalUrl: string, suffix: string): string | null {
  if (suffix && finalUrl.endsWith(suffix)) {
    return finalUrl.slice(0, -suffix.length).replace(/\/+$/, '');
  }
  return null;
}

function detectionHeaders(
  userHeaders: Record<string, string> | undefined,
  scheme: 'none' | 'bearer' | 'anthropic' | 'gemini',
  credential: string | undefined,
): Headers {
  const headers = new Headers(userHeaders ?? {});
  headers.set('Accept', 'application/json');
  headers.set('User-Agent', 'Koryphaios/1.0');
  if (!credential) return headers;
  if (scheme === 'anthropic') {
    headers.set('x-api-key', credential);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  } else if (scheme === 'gemini') {
    headers.set('x-goog-api-key', credential);
  } else if (scheme === 'bearer') {
    headers.set('Authorization', `Bearer ${credential}`);
  }
  return headers;
}

async function runDetectionProbe(
  probe: DetectionProbe,
  timeoutMs: number,
): Promise<DetectionOutcome> {
  const outcome: DetectionOutcome = {
    probe,
    networkError: false,
    classified: null,
    models: [],
    sawCatalogResponse: false,
  };
  let response: Response;
  try {
    response = await fetch(probe.url, {
      method: 'GET',
      headers: probe.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    outcome.networkError = true;
    return outcome;
  }
  outcome.status = response.status;
  try {
    outcome.finalUrl = response.url || undefined;
  } catch {
    outcome.finalUrl = undefined;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return outcome;
  }
  outcome.sawCatalogResponse = true;
  let payload: unknown;
  try {
    payload = await readBoundedJson(response);
  } catch {
    await response.body?.cancel().catch(() => {});
    return outcome;
  }
  const classified = classifyCatalogPayload(payload);
  outcome.classified = classified;
  // The adapter chain claims generic shapes too: an OpenAI classification of
  // `{ models: [...] }` is a weak default, and an adapter whose distinctive
  // catalog signature matches (Ollama digest/detail markers on /api/tags)
  // beats it. Distinct SDK envelopes (anthropic/gemini) are never overridden.
  const adapterClaimable = !classified || classified === 'openai';
  if (adapterClaimable) {
    for (const adapter of listWireAdapters()) {
      if (adapter.matchCatalog(payload, probe.suffix)) {
        outcome.adapter = adapter.id;
        outcome.classified = null;
        // Adapter catalogs are model lists under `models`/`data` or bare
        // arrays, same extraction rules as the generic openai shape.
        outcome.models = modelIdsFromCatalog(payload, 'openai');
        break;
      }
    }
  }
  if (!outcome.adapter && classified) {
    outcome.models = modelIdsFromCatalog(payload, classified);
  }
  outcome.payload = payload;
  return outcome;
}

/**
 * Probe a staged endpoint with no assumed wire format and determine which
 * protocol it speaks. Candidate catalog URLs for every family are fetched in
 * parallel; each 200-JSON response is shape-classified, and conflicts
 * (multi-protocol gateways) resolve toward OpenAI, whose adapter is the most
 * capable path in this codebase.
 */
export async function detectCustomProviderKind(
  input: Omit<CustomProviderProbeInput, 'kind'>,
  options: { timeoutMs?: number } = {},
): Promise<CustomProviderDetection> {
  const normalizedBaseUrl = normalizeCustomProviderBaseUrl(input.baseUrl);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const credential = input.apiKey?.trim() || input.authToken?.trim() || undefined;
  const root = normalizedBaseUrl.replace(/\/+$/, '');

  const probes: DetectionProbe[] = [];
  const push = (suffix: string, scheme: 'none' | 'bearer' | 'anthropic' | 'gemini') => {
    if (scheme !== 'none' && !credential) return;
    probes.push({
      url: `${root}${suffix}`,
      suffix,
      headers: detectionHeaders(input.headers, scheme, credential),
    });
  };
  // Canonical catalog URL for every family, unauthenticated first (keyless
  // local servers answer here) plus each family's auth scheme.
  push('/models', 'none');
  push('/models', 'bearer');
  push('/models', 'anthropic');
  push('/models', 'gemini');
  // Anthropic-native path (compatible bases are version-less roots) and
  // Gemini-native versioned path, for bases that don't carry the segment.
  push('/v1/models', 'none');
  push('/v1/models', 'anthropic');
  push('/v1beta/models', 'none');
  push('/v1beta/models', 'gemini');
  // Wire-adapter catalog paths (e.g. Ollama's /api/tags), keyless and
  // bearer-authenticated. Unauthenticated first, mirroring the SDK probes.
  for (const adapter of listWireAdapters()) {
    for (const path of adapter.catalogPaths) {
      push(path, 'none');
      push(path, 'bearer');
    }
  }

  const outcomes = await Promise.all(probes.map((probe) => runDetectionProbe(probe, timeoutMs)));

  // An http base that redirects to https is stored upgraded: GET catalog
  // checks follow the redirect and pass, which masks the scheme problem
  // until inference POSTs fail. Adopt the redirect target's base whenever a
  // probe that produced a response landed on https.
  let effectiveBase = normalizedBaseUrl;
  for (const outcome of outcomes) {
    if (outcome.networkError || !outcome.finalUrl) continue;
    try {
      const requested = new URL(outcome.probe.url);
      const final = new URL(outcome.finalUrl);
      if (requested.protocol !== 'http:' || final.protocol !== 'https:') continue;
      const rebuilt = baseFromCatalogUrl(outcome.finalUrl, outcome.probe.suffix);
      if (rebuilt && rebuilt.startsWith('https:')) {
        effectiveBase = rebuilt;
        break;
      }
      // Same-host redirect that also rewrote the path: still adopt the
      // secure scheme rather than storing a base known to redirect.
      if (final.host === requested.host) {
        effectiveBase = normalizedBaseUrl.replace(/^http:/, 'https:');
        break;
      }
    } catch {
      // Ignore malformed URLs; other probes still count.
    }
  }

  const priority: CustomProviderKind[] = ['openai', 'anthropic', 'gemini'];
  let winner: DetectionOutcome | null = null;
  for (const kind of priority) {
    const match = outcomes.find((outcome) => outcome.classified === kind);
    if (match) {
      winner = match;
      break;
    }
  }

  // Adapter chain: consulted only when no SDK dialect matched. An adapter
  // match means the endpoint speaks a dialect the SDKs cannot (Ollama native,
  // …), so the base is stored as-probed — no /v1 fix-up.
  let adapterId: string | undefined;
  if (!winner) {
    const adapterMatch = outcomes.find((outcome) => outcome.adapter !== undefined);
    if (adapterMatch?.adapter) {
      adapterId = adapterMatch.adapter;
      winner = adapterMatch;
    }
  }
  // An explicit adapter pin always wins: the user knows the endpoint's
  // dialect better than the probe does. Keep models from any successful
  // catalog response, but never let SDK classification override the pin.
  if (input.adapter && getWireAdapter(input.adapter)) {
    adapterId = input.adapter;
    winner ??= outcomes.find((outcome) => outcome.sawCatalogResponse) ?? null;
  }

  const attempted = outcomes.length;
  const networkErrors = outcomes.filter((outcome) => outcome.networkError).length;
  const authStatuses = outcomes.filter(
    (outcome) => outcome.status === 401 || outcome.status === 403,
  );
  const sawCatalogResponse = outcomes.some((outcome) => outcome.sawCatalogResponse);
  const representativeStatus =
    authStatuses[0]?.status ?? outcomes.find((outcome) => outcome.status !== undefined)?.status;

  if (winner?.classified) {
    let kind = winner.classified;
    // The Anthropic SDK appends `/v1/...` itself and expects a version-less
    // root, so a base that carried the segment for probing is stored stripped.
    if (kind === 'anthropic') {
      effectiveBase = effectiveBase.replace(/\/v1\/?$/, '');
    } else if (kind === 'openai' && winner.probe.suffix === '/v1/models') {
      // The OpenAI SDK POSTs `{baseURL}/chat/completions`, so the stored base
      // must include the version segment. Discovery found the catalog at
      // `{root}/v1/models` on a version-less base: persist the `/v1` root the
      // endpoint actually serves (Ollama-style roots, pasted bare hosts).
      if (!/\/v1\/?$/.test(effectiveBase)) {
        effectiveBase = `${effectiveBase.replace(/\/+$/, '')}/v1`;
      }
    }
    return {
      kind,
      models: winner.models,
      status: winner.status ?? 200,
      normalizedBaseUrl: effectiveBase,
      authFailure: false,
      unreachable: false,
      sawCatalogResponse: true,
    };
  }

  if (adapterId) {
    return {
      kind: 'openai',
      adapter: adapterId,
      models: winner?.models ?? [],
      status: winner?.status ?? representativeStatus,
      normalizedBaseUrl: effectiveBase,
      authFailure: false,
      unreachable: false,
      sawCatalogResponse: true,
    };
  }

  return {
    kind: 'openai',
    models: [],
    status: representativeStatus,
    normalizedBaseUrl: effectiveBase,
    authFailure:
      attempted > 0 && authStatuses.length === attempted - networkErrors && authStatuses.length > 0,
    unreachable: attempted > 0 && networkErrors === attempted,
    sawCatalogResponse,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_CATALOG_BYTES) {
    throw new Error('catalog-too-large');
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_MODEL_CATALOG_BYTES) {
      await reader.cancel();
      throw new Error('catalog-too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Probe a staged custom provider before it is allowed into durable config.
 *
 * When `input.kind` is set, the legacy single-format probe runs unchanged.
 * When it is omitted (the settings form no longer asks), the wire format is
 * auto-detected from the endpoint's catalog responses.
 */
export async function probeCustomProvider(
  input: CustomProviderProbeInput,
  options: { timeoutMs?: number } = {},
): Promise<CustomProviderProbeResult> {
  if (!input.kind) {
    return probeWithDetectedKind(input, options);
  }
  const result = await probeWithExplicitKind({ ...input, kind: input.kind }, options);
  return { ...result, detectedKind: input.kind };
}

async function probeWithDetectedKind(
  input: Omit<CustomProviderProbeInput, 'kind'>,
  options: { timeoutMs?: number } = {},
): Promise<CustomProviderProbeResult> {
  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeCustomProviderBaseUrl(input.baseUrl);
  } catch (error: unknown) {
    return {
      success: false,
      models: [],
      error: error instanceof Error ? error.message : 'The endpoint URL is invalid',
      canSaveUnverified: false,
      detectedKind: 'openai',
    };
  }

  const detection = await detectCustomProviderKind(
    { ...input, baseUrl: normalizedBaseUrl },
    options,
  );
  const base = detection.normalizedBaseUrl || normalizedBaseUrl;
  const detectedAdapter =
    detection.adapter ??
    (input.adapter && getWireAdapter(input.adapter) ? input.adapter : undefined);
  if (detection.models.length > 0) {
    return {
      success: true,
      normalizedBaseUrl: base,
      models: detection.models,
      status: detection.status ?? 200,
      detectedKind: detection.kind,
      detectedAdapter,
      canSaveUnverified: false,
    };
  }
  if (detection.unreachable) {
    return {
      success: false,
      normalizedBaseUrl: base,
      models: [],
      detectedKind: detection.kind,
      detectedAdapter,
      error: 'Koryphaios could not reach the endpoint.',
      canSaveUnverified: true,
    };
  }
  if (detection.authFailure) {
    const credential = input.apiKey?.trim() || input.authToken?.trim();
    return {
      success: false,
      normalizedBaseUrl: base,
      models: [],
      status: detection.status,
      detectedKind: detection.kind,
      detectedAdapter,
      error: credential
        ? `The endpoint rejected this API key (HTTP ${detection.status}). Nothing was saved.`
        : `This endpoint requires credentials (HTTP ${detection.status}). Nothing was saved.`,
      canSaveUnverified: false,
    };
  }
  if (detection.sawCatalogResponse) {
    return {
      success: false,
      normalizedBaseUrl: base,
      models: [],
      status: detection.status,
      detectedKind: detection.kind,
      detectedAdapter,
      error: 'The endpoint responded, but its model catalog contained no valid model IDs.',
      canSaveUnverified: true,
    };
  }
  return {
    success: false,
    normalizedBaseUrl: base,
    models: [],
    status: detection.status,
    detectedKind: detection.kind,
    detectedAdapter,
    error: `Koryphaios could not verify a model catalog at ${base}${
      detection.status ? ` (HTTP ${detection.status})` : ''
    }.`,
    canSaveUnverified: true,
  };
}

/** Legacy single-format probe used when the caller pins the wire format
 * (stored-provider re-verification, API clients, tests). */
async function probeWithExplicitKind(
  input: CustomProviderProbeInput & { kind: CustomProviderKind },
  options: { timeoutMs?: number } = {},
): Promise<CustomProviderProbeResult> {
  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeCustomProviderBaseUrl(input.baseUrl);
  } catch (error: unknown) {
    return {
      success: false,
      models: [],
      error: error instanceof Error ? error.message : 'The endpoint URL is invalid',
      canSaveUnverified: false,
    };
  }

  const kind = input.kind;
  if (kind === 'gemini' && !input.apiKey?.trim() && !input.authToken?.trim()) {
    return {
      success: false,
      normalizedBaseUrl,
      models: [],
      error:
        'Gemini-compatible endpoints require an API key. Nothing was saved; use OpenAI-compatible for a keyless local endpoint that exposes that wire format.',
      canSaveUnverified: false,
    };
  }
  const headers = new Headers(input.headers ?? {});
  headers.set('Accept', 'application/json');
  headers.set('User-Agent', 'Koryphaios/1.0');
  const credential = input.apiKey?.trim() || input.authToken?.trim();
  if (credential) {
    if (kind === 'anthropic' && input.apiKey?.trim()) {
      headers.set('x-api-key', credential);
      if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
    } else if (kind === 'gemini') {
      headers.set('x-goog-api-key', credential);
    } else {
      headers.set('Authorization', `Bearer ${credential}`);
    }
  }

  const catalogUrls = modelCatalogUrls(normalizedBaseUrl, kind);
  // A candidate that answers 2xx with a non-catalog body (an HTML front end, a
  // login page) is not a verdict — keep trying the remaining candidates and
  // only report the last attempt's outcome. Auth rejections are terminal on
  // the first candidate: they describe the credential, not the path.
  let lastFailure: CustomProviderProbeResult | null = null;

  for (const catalogUrl of catalogUrls) {
    try {
      const response = await fetch(catalogUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        lastFailure = {
          success: false,
          normalizedBaseUrl,
          models: [],
          status,
          error:
            status === 401 || status === 403
              ? credential
                ? `The endpoint rejected this API key (HTTP ${status}). Nothing was saved.`
                : `This endpoint requires credentials (HTTP ${status}). Nothing was saved.`
              : `Koryphaios could not verify a model catalog at ${catalogUrl} (HTTP ${status}).`,
          canSaveUnverified: status !== 401 && status !== 403,
        };
        if (status === 401 || status === 403) return lastFailure;
        continue;
      }

      let payload: unknown;
      try {
        payload = await readBoundedJson(response);
      } catch (error: unknown) {
        const tooLarge = error instanceof Error && error.message === 'catalog-too-large';
        lastFailure = {
          success: false,
          normalizedBaseUrl,
          models: [],
          status: response.status,
          error: tooLarge
            ? "The model catalog was larger than Koryphaios's 2 MiB safety limit."
            : 'The model catalog did not return valid JSON.',
          canSaveUnverified: true,
        };
        // Too large is a real verdict about the payload, not the path.
        if (tooLarge) return lastFailure;
        continue;
      }

      const models = modelIdsFromCatalog(payload, kind);
      if (models.length === 0) {
        lastFailure = {
          success: false,
          normalizedBaseUrl,
          models: [],
          status: response.status,
          error: 'The endpoint responded, but its model catalog contained no valid model IDs.',
          canSaveUnverified: true,
        };
        continue;
      }
      return {
        success: true,
        normalizedBaseUrl,
        models,
        status: response.status,
        canSaveUnverified: false,
      };
    } catch (error: unknown) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      lastFailure = {
        success: false,
        normalizedBaseUrl,
        models: [],
        error: timedOut
          ? 'The endpoint did not answer within 5 seconds.'
          : 'Koryphaios could not reach the endpoint.',
        canSaveUnverified: true,
      };
    }
  }

  return (
    lastFailure ?? {
      success: false,
      normalizedBaseUrl,
      models: [],
      error: 'Koryphaios could not reach the endpoint.',
      canSaveUnverified: true,
    }
  );
}

export class CustomProvider implements Provider {
  readonly name: ProviderName;
  private readonly inner: Provider;
  private catalogRefreshRequested = false;

  constructor(readonly config: ProviderConfig) {
    this.name = config.name;
    // A pinned wire adapter (non-SDK dialect) takes precedence over `kind`.
    const adapter = config.adapter ? getWireAdapter(config.adapter) : undefined;
    if (adapter) {
      this.inner = new WireAdapterProvider(config, adapter);
    } else {
      const kind: CustomProviderKind = config.kind ?? 'openai';
      if (kind === 'anthropic') {
        this.inner = new AnthropicProvider(config, config.name);
      } else if (kind === 'gemini') {
        this.inner = new GoogleProvider({ ...config });
      } else {
        this.inner = new OpenAIProvider(config, config.name, config.baseUrl);
      }
    }
  }

  isAvailable(): boolean {
    // A custom provider is usable as long as it's enabled and has an endpoint. The API key
    // is optional (many self-hosted OpenAI-compatible servers don't require one).
    if (this.config.disabled) return false;
    if (!this.config.baseUrl) return false;
    return true;
  }

  listModels(): ModelDef[] {
    const declared = (this.config.models ?? []).map((id) => {
      const m = createGenericModel(id, this.name);
      m.apiModelId = id;
      return m;
    });
    let live: ModelDef[] = [];
    if (this.catalogRefreshRequested) {
      try {
        live = this.inner.listModels();
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Custom provider: live model list failed',
        );
        live = [];
      }
    }
    const seen = new Set<string>();
    const merged: ModelDef[] = [];
    // Live discovery is route truth: verified context windows, display names,
    // and reasoning tiers reported by the endpoint itself. Declared ids only
    // backfill models the live catalog no longer reports (saved-unverified
    // endpoints, or a failed refresh) — they must never shadow live metadata
    // with the generic placeholder, or sessions compact against a foreign
    // window and die on the route's real limit.
    for (const m of [...live, ...declared]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
    // Custom endpoints report bare ids only. Enrich through the wire-format
    // family (models.dev lab entries) so reasoning levels, real context
    // windows, and output limits resolve exactly like first-party providers.
    // Enrichment only fills in fields for ids the catalog actually carries —
    // unknown ids stay generic rather than invented.
    return applyModelsDevMetadata(this.name, merged, modelsDevKeysFor(this.name, this.config.kind));
  }

  refreshModels(forceRefresh = false): void | Promise<unknown> {
    this.catalogRefreshRequested = true;
    refreshModelsDevCache();
    return this.inner.refreshModels?.(forceRefresh);
  }

  getModelDiscoveryError(): string | undefined {
    return this.inner.getModelDiscoveryError?.();
  }

  streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    return this.inner.streamResponse(request);
  }

  get imageInputTransport(): Provider['imageInputTransport'] {
    return this.inner.imageInputTransport;
  }
  get mediaInputKinds(): Provider['mediaInputKinds'] {
    return this.inner.mediaInputKinds;
  }
}

/** Derive a stable provider id from a user-supplied label. */
export function customProviderId(label: string): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `custom:${slug || 'provider'}`;
}

export function isCustomProviderId(name: string): boolean {
  return typeof name === 'string' && name.startsWith('custom:');
}
