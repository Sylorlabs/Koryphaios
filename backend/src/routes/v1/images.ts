import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { estimateImageCostUsd, recordApiUsageRequired } from '../../billing/api-usage-ledger';
import {
  deleteImageHistoryEntry,
  getImageHistoryEntry,
  listImageHistory,
  saveImageHistory,
} from '../../images/image-history';
import { getContext } from '../../context';
import {
  AuthenticationError,
  ConflictError,
  ProviderQuotaError,
  ProviderRateLimitError,
  ValidationError,
} from '../../errors/types';
import { serverLog } from '../../logger';
import { reserveSpendCapacity } from '../../security/spend-caps-enforced';

const EFFECT_PROMPTS: Record<string, string> = {
  none: '',
  cinematic: 'Cinematic lighting, dramatic composition, subtle film grain, high dynamic range.',
  illustration:
    'Polished editorial illustration, expressive shapes, rich color harmony, crisp detail.',
  neon: 'Neon glow, luminous color accents, atmospheric haze, deep contrast.',
  miniature: 'Tilt-shift miniature photography, tactile materials, shallow depth of field.',
  watercolor: 'Layered watercolor washes, textured paper, soft pigment blooms, elegant detail.',
};

/** How a provider's image-generation API is addressed. */
type ImageAdapter = 'openai-images' | 'google-gemini' | 'openrouter-chat';

interface ImageModelDef {
  id: string;
  label: string;
  /** Supported canvas sizes ('auto' when the model can choose). */
  sizes?: string[];
  /** Supported quality values. */
  qualities?: string[];
  /** Supported output formats. */
  formats?: string[];
  /** Supported background modes. */
  background?: string[];
  /** Canvas size → API aspect ratio (Gemini/Imagen-style APIs). */
  aspectRatios?: Record<string, string>;
  /** Request explicit base64 responses (DALL·E-style APIs). */
  b64Json?: boolean;
  /** Model accepts a source image for editing. */
  edits?: boolean;
  /** User-defined model: send only explicitly chosen, non-default options. */
  custom?: boolean;
}

/** Optional source image for edit-style generation. */
export interface SourceImage {
  base64: string;
  mimeType: string;
}

export interface ImageJobRuntime {
  signal?: AbortSignal;
  /** Chat-owned images must not leak into the unscoped studio gallery. */
  history: 'studio' | 'none';
  /** Session owner for chat generation; absent for standalone Studio work. */
  sessionId?: string;
  /** Authoritative run generation, or a standalone Studio request id. */
  runId?: string;
  /** Stable id shared with the generated chat message to prevent double counting. */
  usageId?: string;
}

/**
 * Studio generation is intentionally owned by the backend rather than the
 * browser request.  Closing or reloading the settings view must not abort a
 * paid provider request that is already underway; the completed image is
 * written to the durable gallery and will be visible after the next load.
 */
const studioImageJobs = new Map<string, AbortController>();
const completedStudioImageJobs = new Map<
  string,
  { completedAt: number; historyId?: string }
>();
const STUDIO_IMAGE_JOB_RESULT_RETENTION_MS = 10 * 60_000;

function pruneCompletedStudioImageJobs(now = Date.now()): void {
  for (const [jobId, result] of completedStudioImageJobs) {
    if (result.completedAt + STUDIO_IMAGE_JOB_RESULT_RETENTION_MS <= now) {
      completedStudioImageJobs.delete(jobId);
    }
  }
}

function startStudioImageJob(jobId: string): AbortController {
  if (studioImageJobs.has(jobId)) {
    throw new ConflictError('This image generation is already in progress.');
  }
  const controller = new AbortController();
  studioImageJobs.set(jobId, controller);
  return controller;
}

async function runStudioImageJob(
  jobId: string,
  body: ImageJobBody,
  sourceImage?: SourceImage,
) {
  const controller = startStudioImageJob(jobId);
  try {
    const response = await runImageJob(body, sourceImage, {
      signal: controller.signal,
      history: 'studio',
    });
    pruneCompletedStudioImageJobs();
    completedStudioImageJobs.set(jobId, {
      completedAt: Date.now(),
      historyId: response.data.historyId,
    });
    return response;
  } catch (error) {
    // A user-directed cancellation is an expected terminal outcome, never an
    // internal server failure (and never a misleading persisted error).
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ConflictError('Image generation was cancelled.');
    }
    throw error;
  } finally {
    // Do not delete a newer retry which happens to reuse an id after this
    // request has settled.
    if (studioImageJobs.get(jobId) === controller) studioImageJobs.delete(jobId);
  }
}

function cancelStudioImageJob(jobId: string): boolean {
  const controller = studioImageJobs.get(jobId);
  if (!controller) return false;
  controller.abort(new DOMException('Image generation cancelled', 'AbortError'));
  return true;
}

function getStudioImageJobStatus(
  jobId: string,
): { status: 'running' | 'completed' | 'unknown'; historyId?: string } {
  if (studioImageJobs.has(jobId)) return { status: 'running' };
  pruneCompletedStudioImageJobs();
  const completed = completedStudioImageJobs.get(jobId);
  return completed ? { status: 'completed', historyId: completed.historyId } : { status: 'unknown' };
}

interface ImageProviderDef {
  id: string;
  label: string;
  adapter: ImageAdapter;
  /** Default API base; overridden by the provider's configured baseUrl. */
  baseUrl: string;
  /** Path appended to the base URL. */
  path: string;
  models: ImageModelDef[];
  /** User-defined custom provider entry. */
  custom?: boolean;
  /** Endpoint-authenticated local server: a base URL alone counts as configured. */
  endpointAuth?: boolean;
  /** Normalize the base URL to include /v1 before appending the path. */
  ensureV1?: boolean;
}

/** Shape of a stored provider config returned by the provider registry. */
interface ProviderSettingsConfig {
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  disabled?: boolean;
  custom?: boolean;
  kind?: 'openai' | 'anthropic' | 'gemini';
  label?: string;
  models?: string[];
}

const GPT_IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
const GPT_IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'];
const GPT_IMAGE_FORMATS = ['png', 'jpeg', 'webp'];

const GEMINI_IMAGE_MODELS: ImageModelDef[] = [
  {
    id: 'gemini-2.5-flash-image',
    label: 'Gemini 2.5 Flash Image',
    edits: true,
    sizes: GPT_IMAGE_SIZES,
    aspectRatios: { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' },
    formats: ['png', 'jpeg'],
  },
];

const IMAGEN_IMAGE_MODELS: ImageModelDef[] = [
  {
    id: 'imagen-4.0-generate-001',
    label: 'Imagen 4',
    sizes: GPT_IMAGE_SIZES,
    aspectRatios: { '1024x1024': '1:1', '1536x1024': '4:3', '1024x1536': '3:4' },
    formats: ['png', 'jpeg'],
  },
  {
    id: 'imagen-4.0-fast-generate-001',
    label: 'Imagen 4 Fast',
    sizes: GPT_IMAGE_SIZES,
    aspectRatios: { '1024x1024': '1:1', '1536x1024': '4:3', '1024x1536': '3:4' },
    formats: ['png', 'jpeg'],
  },
  {
    id: 'imagen-4.0-ultra-generate-001',
    label: 'Imagen 4 Ultra',
    sizes: GPT_IMAGE_SIZES,
    aspectRatios: { '1024x1024': '1:1', '1536x1024': '4:3', '1024x1536': '3:4' },
    formats: ['png', 'jpeg'],
  },
];

/** Built-in image-capable providers. Custom OpenAI/Gemini-compatible providers are appended dynamically. */
export const IMAGE_PROVIDERS: ImageProviderDef[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    adapter: 'openai-images',
    baseUrl: 'https://api.openai.com/v1',
    path: '/images/generations',
    models: [
      {
        id: 'gpt-image-2',
        label: 'GPT Image 2',
        sizes: GPT_IMAGE_SIZES,
        qualities: GPT_IMAGE_QUALITIES,
        formats: GPT_IMAGE_FORMATS,
        edits: true,
      },
      {
        id: 'gpt-image-1.5',
        edits: true,
        label: 'GPT Image 1.5',
        sizes: GPT_IMAGE_SIZES,
        qualities: GPT_IMAGE_QUALITIES,
        formats: GPT_IMAGE_FORMATS,
        background: ['auto', 'opaque', 'transparent'],
      },
      {
        id: 'gpt-image-1',
        edits: true,
        label: 'GPT Image 1',
        sizes: GPT_IMAGE_SIZES,
        qualities: GPT_IMAGE_QUALITIES,
        formats: GPT_IMAGE_FORMATS,
        background: ['auto', 'opaque', 'transparent'],
      },
      {
        id: 'gpt-image-1-mini',
        edits: true,
        label: 'GPT Image 1 Mini',
        sizes: GPT_IMAGE_SIZES,
        qualities: GPT_IMAGE_QUALITIES,
        formats: GPT_IMAGE_FORMATS,
        background: ['auto', 'opaque', 'transparent'],
      },
      {
        id: 'dall-e-3',
        label: 'DALL·E 3',
        sizes: ['1024x1024', '1792x1024', '1024x1792'],
        qualities: ['standard', 'hd'],
        formats: ['png'],
        b64Json: true,
      },
    ],
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    adapter: 'openai-images',
    baseUrl: 'https://api.x.ai/v1',
    path: '/images/generations',
    ensureV1: true,
    models: [
      {
        id: 'grok-imagine-image-2.0',
        label: 'Grok Imagine Image 2.0',
        sizes: GPT_IMAGE_SIZES,
        qualities: ['low', 'medium'],
        formats: ['jpeg'],
        aspectRatios: {
          '1024x1024': '1:1',
          '1536x1024': '3:2',
          '1024x1536': '2:3',
        },
        b64Json: true,
      },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    adapter: 'google-gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    path: '/v1beta',
    models: [...GEMINI_IMAGE_MODELS, ...IMAGEN_IMAGE_MODELS],
  },
  {
    id: 'aistudio',
    label: 'Google AI Studio',
    adapter: 'google-gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    path: '/v1beta',
    models: [...GEMINI_IMAGE_MODELS, ...IMAGEN_IMAGE_MODELS],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    adapter: 'openrouter-chat',
    baseUrl: 'https://openrouter.ai/api',
    path: '/v1/chat/completions',
    models: [
      {
        id: 'google/gemini-2.5-flash-image',
        label: 'Gemini 2.5 Flash Image',
        formats: ['png', 'jpeg'],
      },
      {
        id: 'google/gemini-2.5-flash-image-preview',
        label: 'Gemini 2.5 Flash Image Preview',
        formats: ['png', 'jpeg'],
      },
    ],
  },
  {
    id: 'local',
    label: 'Local endpoint',
    adapter: 'openai-images',
    baseUrl: '',
    path: '/images/generations',
    endpointAuth: true,
    ensureV1: true,
    models: [],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    adapter: 'openai-images',
    baseUrl: 'http://localhost:1234',
    path: '/images/generations',
    endpointAuth: true,
    ensureV1: true,
    models: [],
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp server',
    adapter: 'openai-images',
    baseUrl: 'http://localhost:8080',
    path: '/images/generations',
    endpointAuth: true,
    ensureV1: true,
    models: [],
  },
];

function customImageProviders(
  configs: Record<string, ProviderSettingsConfig | undefined>,
): ImageProviderDef[] {
  const defs: ImageProviderDef[] = [];
  for (const [id, config] of Object.entries(configs)) {
    if (!config?.custom || config.disabled) continue;
    if (config.kind !== 'openai' && config.kind !== 'gemini') continue;
    const baseUrl = config.baseUrl?.trim();
    if (!baseUrl) continue;
    defs.push({
      id,
      label: config.label?.trim() || id,
      adapter: config.kind === 'gemini' ? 'google-gemini' : 'openai-images',
      baseUrl,
      path: config.kind === 'gemini' ? '/v1beta' : '/images/generations',
      custom: true,
      models: (config.models ?? []).map((modelId) => ({
        id: modelId,
        label: modelId,
        custom: true,
      })),
    });
  }
  return defs;
}

function isImageProviderConfigured(
  def: ImageProviderDef,
  config: ProviderSettingsConfig | undefined,
): boolean {
  if (!config || config.disabled) return false;
  if (config.apiKey?.trim() || config.authToken?.trim()) return true;
  return Boolean((def.custom || def.endpointAuth) && config.baseUrl?.trim());
}

const DISCOVERED_IMAGE_MODEL_PATTERN =
  /(flux|stable[-_ ]?diffusion|sdxl|sd3|sd15|diffus|dall|imagen|image)/i;

/**
 * Merge image-capable models discovered from the authenticated provider
 * (registry catalog cache — e.g. a local server's /v1/models) into the curated
 * list. Chat models are ignored; curated entries win over discovered duplicates.
 */
function mergeDiscoveredImageModels(def: ImageProviderDef): ImageModelDef[] {
  let registryProvider:
    | {
        listModels(): Array<{ id: string; name?: string; apiModelId?: string }>;
      }
    | undefined;
  try {
    registryProvider = getContext().providers.get(def.id);
  } catch {
    return def.models;
  }
  if (!registryProvider) return def.models;
  let live: Array<{ id: string; name?: string; apiModelId?: string }> = [];
  try {
    live = registryProvider.listModels();
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err), provider: def.id },
      'Image model discovery failed',
    );
    return def.models;
  }
  const curated = new Set(def.models.map((model) => model.id));
  const discovered = live
    .map((model) => {
      const id = model.apiModelId?.trim() || model.id;
      return { id, label: model.name?.trim() || id };
    })
    .filter(
      (model): model is { id: string; label: string } =>
        DISCOVERED_IMAGE_MODEL_PATTERN.test(model.id) && !curated.has(model.id),
    )
    .map((model) => ({ ...model, custom: true as const }));
  return [...def.models, ...discovered];
}

function resolveImageProvider(
  id: string | undefined,
  configs: Record<string, ProviderSettingsConfig | undefined>,
): ImageProviderDef | undefined {
  const all = [...IMAGE_PROVIDERS, ...customImageProviders(configs)];
  if (id) return all.find((def) => def.id === id);
  return all.find((def) => isImageProviderConfigured(def, configs[def.id]));
}

/** Keep a requested option only when the model supports it (custom models pass values through, minus 'auto'). */
function pickOption(
  supported: string[] | undefined,
  requested: string | undefined,
  customModel: boolean,
): string | undefined {
  if (!requested) return undefined;
  if (!supported) return customModel && requested !== 'auto' ? requested : undefined;
  return supported.includes(requested) ? requested : undefined;
}

function pickFormat(model: ImageModelDef, requested?: string): string {
  const formats = model.formats ?? ['png'];
  return requested && formats.includes(requested) ? requested : (formats[0] ?? 'png');
}

function authHeaders(
  def: ImageProviderDef,
  config: ProviderSettingsConfig,
): Record<string, string> {
  const token = config.apiKey ?? config.authToken ?? '';
  if (def.adapter === 'google-gemini') {
    return { 'Content-Type': 'application/json', 'x-goog-api-key': token };
  }
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

interface ImageGenerationResult {
  imageBase64: string;
  mimeType: string;
  revisedPrompt?: string;
}

interface GenerateOptions {
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
}

type OpenAIImageResponse = {
  data?: Array<{ b64_json?: string; revised_prompt?: string }>;
  error?: { message?: string };
};

async function generateWithOpenAIImages(
  def: ImageProviderDef,
  model: ImageModelDef,
  config: ProviderSettingsConfig,
  prompt: string,
  options: GenerateOptions,
  signal: AbortSignal,
  sourceImage?: SourceImage,
): Promise<ImageGenerationResult> {
  let base = (config.baseUrl?.trim() || def.baseUrl).replace(/\/+$/, '');
  if (def.ensureV1) base = `${base.replace(/\/v1$/, '')}/v1`;
  if (!base) throw new ValidationError(`${def.label} needs a base URL in Providers & models.`);
  const format = pickFormat(model, options.outputFormat);
  if (sourceImage) {
    return generateWithOpenAIEdits(
      def,
      model,
      config,
      prompt,
      options,
      sourceImage,
      base,
      format,
      signal,
    );
  }
  const payload: Record<string, unknown> = { model: model.id, prompt, n: 1 };
  const size = pickOption(model.sizes, options.size, Boolean(model.custom));
  const aspectRatio = size ? model.aspectRatios?.[size] : undefined;
  if (aspectRatio) payload.aspect_ratio = aspectRatio;
  else if (size) payload.size = size;
  const quality = pickOption(model.qualities, options.quality, Boolean(model.custom));
  if (quality) payload.quality = quality;
  const background = pickOption(model.background, options.background, Boolean(model.custom));
  if (background) payload.background = background;
  if (model.custom) {
    if (format !== 'png') payload.output_format = format;
  } else if (model.b64Json) {
    payload.response_format = 'b64_json';
  } else {
    payload.output_format = format;
  }
  const response = await fetch(`${base}${def.path}`, {
    method: 'POST',
    headers: authHeaders(def, config),
    body: JSON.stringify(payload),
    signal,
  });
  const result = (await response.json().catch(() => ({}))) as OpenAIImageResponse;
  if (!response.ok) {
    throw new ValidationError(
      result.error?.message || `${def.label} returned HTTP ${response.status}`,
    );
  }
  const image = result.data?.[0];
  if (!image?.b64_json) throw new ValidationError(`${def.label} returned no image data.`);
  return {
    imageBase64: image.b64_json,
    mimeType: `image/${format}`,
    revisedPrompt: image.revised_prompt,
  };
}

/** Multipart edit request against the OpenAI-compatible /images/edits endpoint. */
async function generateWithOpenAIEdits(
  def: ImageProviderDef,
  model: ImageModelDef,
  config: ProviderSettingsConfig,
  prompt: string,
  options: GenerateOptions,
  sourceImage: SourceImage,
  base: string,
  format: string,
  signal: AbortSignal,
): Promise<ImageGenerationResult> {
  const form = new FormData();
  form.set(
    'image',
    new Blob([Uint8Array.from(Buffer.from(sourceImage.base64, 'base64'))], {
      type: sourceImage.mimeType,
    }),
    `source.${sourceImage.mimeType.includes('jpeg') ? 'jpg' : (sourceImage.mimeType.split('/')[1] ?? 'png')}`,
  );
  form.set('model', model.id);
  form.set('prompt', prompt);
  form.set('n', '1');
  const size = pickOption(model.sizes, options.size, Boolean(model.custom));
  if (size) form.set('size', size);
  const quality = pickOption(model.qualities, options.quality, Boolean(model.custom));
  if (quality) form.set('quality', quality);
  const background = pickOption(model.background, options.background, Boolean(model.custom));
  if (background) form.set('background', background);
  if (!model.custom && !model.b64Json && format !== 'png') form.set('output_format', format);
  const headers = authHeaders(def, config);
  delete headers['Content-Type'];
  const response = await fetch(`${base}/images/edits`, {
    method: 'POST',
    headers,
    body: form,
    signal,
  });
  const result = (await response.json().catch(() => ({}))) as OpenAIImageResponse;
  if (!response.ok) {
    throw new ValidationError(
      result.error?.message || `${def.label} edit returned HTTP ${response.status}`,
    );
  }
  const image = result.data?.[0];
  if (!image?.b64_json) throw new ValidationError(`${def.label} edit returned no image data.`);
  return {
    imageBase64: image.b64_json,
    mimeType: `image/${format}`,
    revisedPrompt: image.revised_prompt,
  };
}

type GoogleImageResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
  }>;
  predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
  error?: { message?: string; code?: number; status?: string };
};

/**
 * Google uses HTTP 429 for both a temporary rate limit and a project/model
 * quota of zero. Those have very different recovery paths, so do not reduce
 * either to a generic validation or server error.
 */
function throwGoogleImageError(
  def: ImageProviderDef,
  model: ImageModelDef,
  response: Response,
  result: GoogleImageResponse,
): never {
  const upstreamMessage = result.error?.message?.trim();
  const retryAfter = upstreamMessage?.match(/retry in\s+([\d.]+)s/i)?.[1];
  const retryAfterSeconds = retryAfter ? Math.ceil(Number(retryAfter)) : undefined;
  const details = {
    model: model.id,
    upstreamStatus: response.status,
    ...(retryAfterSeconds ? { retryAfter: retryAfterSeconds } : {}),
  };

  // A zero allowance cannot be fixed by waiting. Google includes "limit: 0"
  // and/or free-tier quota identifiers in this response.
  if (
    response.status === 429 &&
    /quota exceeded|limit:\s*0|free[_ -]?tier.*requests/i.test(upstreamMessage ?? '')
  ) {
    throw new ProviderQuotaError(
      def.label,
      details,
      `${def.label} cannot generate images with this API key because its ${model.label} quota is exhausted. Enable billing or select a provider/model with available image capacity.`,
    );
  }

  if (response.status === 429) {
    throw new ProviderRateLimitError(def.label, retryAfterSeconds, details);
  }

  throw new ValidationError(
    upstreamMessage || `${def.label} returned HTTP ${response.status}`,
    details,
  );
}

async function generateWithGoogle(
  def: ImageProviderDef,
  model: ImageModelDef,
  config: ProviderSettingsConfig,
  prompt: string,
  options: GenerateOptions,
  signal: AbortSignal,
  sourceImage?: SourceImage,
): Promise<ImageGenerationResult> {
  const base = (config.baseUrl?.trim() || def.baseUrl).replace(/\/+$/, '').replace(/\/v1beta$/, '');
  const format = pickFormat(model, options.outputFormat);
  const aspect =
    options.size && options.size !== 'auto' ? model.aspectRatios?.[options.size] : undefined;
  const isImagen = model.id.startsWith('imagen');
  if (isImagen && sourceImage)
    throw new ValidationError(`${def.label} does not support image editing with ${model.label}.`);
  const url = `${base}/v1beta/models/${encodeURIComponent(model.id)}:${
    isImagen ? 'predict' : 'generateContent'
  }`;
  const sourcePart = sourceImage
    ? [{ inlineData: { mimeType: sourceImage.mimeType, data: sourceImage.base64 } }]
    : [];
  const body = isImagen
    ? {
        instances: [{ prompt }],
        parameters: { sampleCount: 1, ...(aspect ? { aspectRatio: aspect } : {}) },
      }
    : {
        contents: [{ parts: [...sourcePart, { text: prompt }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          ...(aspect ? { imageConfig: { aspectRatio: aspect } } : {}),
        },
      };
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(def, config),
    body: JSON.stringify(body),
    signal,
  });
  const result = (await response.json().catch(() => ({}))) as GoogleImageResponse;
  if (!response.ok) {
    throwGoogleImageError(def, model, response, result);
  }
  const inline = result.candidates?.[0]?.content?.parts?.find(
    (part) => part.inlineData?.data,
  )?.inlineData;
  const prediction = result.predictions?.[0];
  const base64 = inline?.data ?? prediction?.bytesBase64Encoded;
  if (!base64) throw new ValidationError(`${def.label} returned no image data.`);
  return {
    imageBase64: base64,
    mimeType: inline?.mimeType ?? prediction?.mimeType ?? `image/${format}`,
  };
}

type OpenRouterImageResponse = {
  choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
  error?: { message?: string };
};

async function generateWithOpenRouter(
  def: ImageProviderDef,
  model: ImageModelDef,
  config: ProviderSettingsConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<ImageGenerationResult> {
  const base = (config.baseUrl?.trim() || def.baseUrl).replace(/\/+$/, '');
  const response = await fetch(`${base}${def.path}`, {
    method: 'POST',
    headers: authHeaders(def, config),
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['image', 'text'],
    }),
    signal,
  });
  const result = (await response.json().catch(() => ({}))) as OpenRouterImageResponse;
  if (!response.ok) {
    throw new ValidationError(
      result.error?.message || `${def.label} returned HTTP ${response.status}`,
    );
  }
  const dataUrl = result.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  const match = dataUrl?.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new ValidationError(`${def.label} returned no image data.`);
  return { imageBase64: match[2] ?? '', mimeType: match[1] ?? 'image/png' };
}

export interface ImageJobBody {
  prompt: string;
  provider?: string;
  model?: string;
  effect?: string;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
}

export function resolveImageModelSelection(
  selection: string | undefined,
): { provider: string; model: string } | undefined {
  if (!selection || selection === 'auto') return undefined;
  const separator = selection.indexOf(':');
  if (separator < 1) return undefined;
  const provider = selection.slice(0, separator);
  const model = selection.slice(separator + 1);
  if (!model) return undefined;
  const configs = getContext().providers.getConfigs() as Record<
    string,
    ProviderSettingsConfig | undefined
  >;
  const definition = resolveImageProvider(provider, configs);
  if (!definition || !mergeDiscoveredImageModels(definition).some((item) => item.id === model)) {
    return undefined;
  }
  return { provider, model };
}

export async function runImageJob(
  body: ImageJobBody,
  sourceImage?: SourceImage,
  runtime: ImageJobRuntime = { history: 'studio' },
) {
  const configs = getContext().providers.getConfigs() as Record<
    string,
    ProviderSettingsConfig | undefined
  >;
  const def = resolveImageProvider(body.provider, configs);
  if (!def) {
    throw new ValidationError(
      body.provider
        ? `Unknown image provider: ${body.provider}`
        : 'No image providers are configured. Connect one in Providers & models first.',
    );
  }
  const config = configs[def.id];
  if (!config || !isImageProviderConfigured(def, config)) {
    throw new ValidationError(`Connect ${def.label} in Providers before generating images.`);
  }
  const model: ImageModelDef | undefined = body.model
    ? (def.models.find((candidate) => candidate.id === body.model) ?? {
        id: body.model,
        label: body.model,
        custom: true,
      })
    : def.models[0];
  if (!model) {
    throw new ValidationError(`Add an image model to ${def.label} before generating images.`);
  }
  if (sourceImage && !model.edits) {
    throw new ValidationError(
      `${model.label} does not support image editing. Pick a source image.`,
    );
  }
  const effect = body.effect ?? 'none';
  const prompt = [body.prompt.trim(), EFFECT_PROMPTS[effect]].filter(Boolean).join('\n\n');
  const options: GenerateOptions = {
    size: body.size,
    quality: body.quality,
    background: body.background,
    outputFormat: body.outputFormat,
  };
  const timeoutSignal = AbortSignal.timeout(180_000);
  const signal = runtime.signal ? AbortSignal.any([runtime.signal, timeoutSignal]) : timeoutSignal;
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Image generation cancelled', 'AbortError');
  }
  const estimatedCostUsd = estimateImageCostUsd(model.id, options.quality);
  const estimatedCostCents =
    estimatedCostUsd === undefined ? 0 : Math.max(1, Math.ceil(estimatedCostUsd * 100));
  const spendGate = await reserveSpendCapacity(runtime.sessionId, estimatedCostCents);
  const spendWarning = spendGate.canProceed ? spendGate.reason : undefined;
  if (spendGate.reason && spendGate.canProceed) {
    serverLog.warn(
      { sessionId: runtime.sessionId, model: model.id, warning: spendGate.reason },
      'Image request proceeding with spend-cap warning',
    );
  }
  if (!spendGate.canProceed) {
    throw new ConflictError(
      spendGate.reason ?? 'A configured spend limit blocked this image request.',
      { spendPolicy: true, paused: spendGate.paused ?? false },
    );
  }
  const { result, runId, usageId } = await (async () => {
    try {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Image generation cancelled', 'AbortError');
      }
      const result =
        def.adapter === 'google-gemini'
          ? await generateWithGoogle(def, model, config, prompt, options, signal, sourceImage)
          : def.adapter === 'openrouter-chat'
            ? await generateWithOpenRouter(def, model, config, prompt, signal)
            : await generateWithOpenAIImages(
                def,
                model,
                config,
                prompt,
                options,
                signal,
                sourceImage,
              );
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Image generation cancelled', 'AbortError');
      }
      const runId = runtime.runId ?? randomUUID();
      const usageId = await recordApiUsageRequired({
        id: runtime.usageId,
        kind: 'image',
        provider: def.id,
        model: model.id,
        estimatedCostUsd,
        units: { measure: 'images', amount: 1 },
        detail: `${sourceImage ? 'edit · ' : ''}${options.size ?? 'auto'} · ${options.quality ?? 'auto'}`,
        sessionId: runtime.sessionId,
        runId,
      });
      return { result, runId, usageId };
    } finally {
      spendGate.release();
    }
  })();
  const historyEntry =
    runtime.history === 'studio'
      ? await saveImageHistory({
          imageBase64: result.imageBase64,
          mimeType: result.mimeType,
          prompt: body.prompt.trim(),
          revisedPrompt: result.revisedPrompt,
          provider: def.id,
          model: model.id,
          effect,
          size: options.size,
          quality: options.quality,
          mode: sourceImage ? 'edit' : 'generate',
        })
      : undefined;
  return {
    ok: true,
    data: {
      ...result,
      provider: def.id,
      model: model.id,
      historyId: historyEntry?.id,
      usageId,
      runId,
      estimatedCostUsd,
      spendWarning,
    },
  };
}

const ImageRequest = t.Object({
  /** Stable client request id so a deliberate cancel can target this job. */
  jobId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  prompt: t.String({ minLength: 1, maxLength: 32000 }),
  provider: t.Optional(t.String()),
  model: t.Optional(t.String()),
  effect: t.Optional(
    t.Union([
      t.Literal('none'),
      t.Literal('cinematic'),
      t.Literal('illustration'),
      t.Literal('neon'),
      t.Literal('miniature'),
      t.Literal('watercolor'),
    ]),
  ),
  size: t.Optional(
    t.Union([
      t.Literal('auto'),
      t.Literal('1024x1024'),
      t.Literal('1536x1024'),
      t.Literal('1024x1536'),
      t.Literal('1792x1024'),
      t.Literal('1024x1792'),
    ]),
  ),
  quality: t.Optional(
    t.Union([
      t.Literal('auto'),
      t.Literal('low'),
      t.Literal('medium'),
      t.Literal('high'),
      t.Literal('standard'),
      t.Literal('hd'),
    ]),
  ),
  background: t.Optional(
    t.Union([t.Literal('auto'), t.Literal('opaque'), t.Literal('transparent')]),
  ),
  outputFormat: t.Optional(t.Union([t.Literal('png'), t.Literal('jpeg'), t.Literal('webp')])),
});

const ImageEditRequest = t.Composite([
  ImageRequest,
  t.Object({ imageBase64: t.String({ minLength: 1 }) }),
]);

export const imageRoutes = new Elysia({ prefix: '/api/images' })
  .onBeforeHandle(({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
  })
  .get('/providers', () => {
    const configs = getContext().providers.getConfigs() as Record<
      string,
      ProviderSettingsConfig | undefined
    >;
    const defs = [...IMAGE_PROVIDERS, ...customImageProviders(configs)];
    return {
      ok: true,
      data: defs.map((def) => ({
        id: def.id,
        label: def.label,
        adapter: def.adapter,
        configured: isImageProviderConfigured(def, configs[def.id]),
        models: mergeDiscoveredImageModels(def).map((model) => ({
          id: model.id,
          label: model.label,
          sizes: model.sizes,
          qualities: model.qualities,
          formats: model.formats,
          background: model.background,
          edits: model.edits ?? false,
        })),
      })),
    };
  })
  .post(
    '/generate',
    async ({ body }) => runStudioImageJob(body.jobId ?? randomUUID(), body),
    { body: ImageRequest },
  )
  .post(
    '/edit',
    async ({ body }) =>
      runStudioImageJob(
        body.jobId ?? randomUUID(),
        body,
        {
          base64: body.imageBase64,
          mimeType: 'image/png',
        },
      ),
    { body: ImageEditRequest },
  )
  .post(
    '/jobs/:id/cancel',
    ({ params }) => ({ ok: true, data: { cancelled: cancelStudioImageJob(params.id) } }),
    { params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }) },
  )
  .get(
    '/jobs/:id',
    ({ params }) => ({ ok: true, data: getStudioImageJobStatus(params.id) }),
    { params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }) },
  )
  .get('/history', async ({ request }) => {
    const rawLimit = new URL(request.url).searchParams.get('limit');
    const limit = Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : 24;
    return { ok: true, data: await listImageHistory(limit) };
  })
  .get('/history/:id', async ({ params }) => {
    const entry = await getImageHistoryEntry(params.id);
    if (!entry) throw new ValidationError('Image not found in history.');
    return { ok: true, data: entry };
  })
  .delete('/history/:id', async ({ params }) => {
    const deleted = await deleteImageHistoryEntry(params.id);
    if (!deleted) throw new ValidationError('Image not found in history.');
    return { ok: true };
  });
