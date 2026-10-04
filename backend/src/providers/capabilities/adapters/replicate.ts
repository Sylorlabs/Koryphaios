import { ValidationError } from '../../../errors/types';
import { capabilityFetch } from '../http';
import { decodeDataUrl, downloadAsset, pollJob, type JobState } from '../poll';
import { requireVisualCapability } from '../types';
import type {
  CapabilityAdapter,
  CapabilityGenerationRequest,
  CapabilityMediaResult,
  CapabilityModelDef,
  CapabilitySpeechRequest,
  CapabilityVerifyResult,
  ResolvedCapabilityConfig,
} from '../types';

/**
 * Replicate — asynchronous predictions API covering image, video, audio, and
 * embedding models.
 *
 * Base URL: `https://api.replicate.com/v1`
 * Auth:     `Authorization: Bearer <token>`
 * Submit:   `POST /models/{owner}/{name}/predictions`, or
 *           `POST /predictions` with a pinned `version`.
 * Poll:     `GET /predictions/{id}` until `succeeded` / `failed` / `canceled`.
 *
 * Sync mode is used via `Prefer: wait=60`: video models routinely run longer
 * than that, so the poller still has to handle the async case.
 */
const BASE_URL = 'https://api.replicate.com/v1';
const MAX_ASSET_BYTES = 96 * 1024 * 1024;

/**
 * A small, curated starter set. Replicate hosts hundreds of thousands of
 * models and publishes no filterable per-modality catalog, so this list is a
 * convenience default only — every entry can be overridden by typing any
 * `owner/name` the account can run, and no entitlement is implied.
 */
const MODEL_PRESETS: Array<CapabilityModelDef & { input?: Record<string, string> }> = [
  {
    id: 'black-forest-labs/flux-schnell',
    label: 'FLUX.1 [schnell]',
    capability: 'image',
    sizes: ['1024x1024', '1024x768', '768x1024'],
    input: { aspect_ratio: 'string', output_format: 'string' },
  },
  {
    id: 'black-forest-labs/flux-dev',
    label: 'FLUX.1 [dev]',
    capability: 'image',
    sizes: ['1024x1024', '1024x768', '768x1024'],
  },
  {
    id: 'google/imagen-4',
    label: 'Imagen 4',
    capability: 'image',
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
  },
  {
    id: 'minimax/video-01',
    label: 'MiniMax video 01',
    capability: 'video',
    durations: ['6s'],
    aspectRatios: ['16:9', '9:16'],
  },
  {
    id: 'kwaivgi/kling-v2.1',
    label: 'Kling 2.1',
    capability: 'video',
    durations: ['5s', '10s'],
    aspectRatios: ['16:9', '9:16', '1:1'],
  },
];

function authHeaders(config: ResolvedCapabilityConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}` };
}

interface ReplicatePrediction {
  id?: string;
  status?: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  error?: string | null;
  output?: unknown;
}

function interpret(prediction: ReplicatePrediction): JobState {
  const status = prediction.status;
  if (status === 'succeeded') return { kind: 'completed' };
  if (status === 'failed' || status === 'canceled') {
    return {
      kind: 'failed',
      reason:
        prediction.error?.trim() ||
        (status === 'canceled' ? 'the prediction was canceled upstream' : 'the model run failed'),
    };
  }
  return { kind: 'pending' };
}

/**
 * Normalize Replicate's polymorphic `output` into asset URLs.
 *
 * A model may return a bare URL string, an array of URLs (video frames),
 * a single object, or an array of objects — all of which occur in practice.
 */
function outputUrls(output: unknown): string[] {
  const collect = (value: unknown): string[] => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith('data:')) return [trimmed];
      if (/^https?:\/\//i.test(trimmed)) return [trimmed];
      return [];
    }
    if (Array.isArray(value)) return value.flatMap(collect);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // File outputs are addressed by their remote path.
      for (const key of ['url', 'video', 'image', 'audio', 'output']) {
        const nested = record[key];
        if (nested !== undefined) {
          const found = collect(nested);
          if (found.length) return found;
        }
      }
    }
    return [];
  };
  return collect(output);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** `owner/name` and bare `name` both need a valid two-segment path. */
function modelPath(model: string): string {
  const trimmed = model.trim().replace(/^\/+|\/+$/g, '');
  const segments = trimmed.split('/').filter(Boolean);
  if (segments.length !== 2 || !/^[\w.-]+$/.test(segments[0]) || !/^[\w.-]+$/.test(segments[1])) {
    throw new ValidationError(
      `Replicate models are addressed as owner/name — "${model}" is not a valid model reference.`,
    );
  }
  return segments.join('/');
}

function buildInput(request: CapabilityGenerationRequest): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: request.prompt };
  const options = request.options;
  const size = asString(options.size);
  if (size) {
    const [rawWidth, rawHeight] = size.split(/[x×]/i);
    const width = Number(rawWidth);
    const height = Number(rawHeight);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      input.width = width;
      input.height = height;
    } else {
      // Models that take a single size string rather than two dimensions.
      input.size = size;
    }
  }
  const aspect = asString(options.aspectRatio);
  if (aspect) input.aspect_ratio = aspect;
  const resolution = asString(options.resolution);
  if (resolution) input.resolution = resolution;
  const duration = asString(options.duration);
  if (duration) input.duration = duration;
  const negative = asString(options.negativePrompt);
  if (negative) input.negative_prompt = negative;
  const format = asString(options.outputFormat);
  if (format) input.output_format = format;
  const seed = options.seed;
  if (typeof seed === 'number' && Number.isFinite(seed)) input.seed = Math.round(seed);
  if (typeof options.sound === 'boolean') input.generate_audio = options.sound;
  if (request.sourceImage) {
    throw new ValidationError(
      'Replicate image-conditioned models take a hosted image URL, which a locally selected file does not provide.',
    );
  }
  return input;
}

export const replicateAdapter: CapabilityAdapter = {
  provider: 'replicate',
  capabilities: ['image', 'video', 'audio'],
  defaultBaseUrl: BASE_URL,

  async verify(config, signal): Promise<CapabilityVerifyResult> {
    try {
      await capabilityFetch('Replicate', `${config.baseUrl}/account`, config, {
        headers: authHeaders(config),
        signal,
        timeoutMs: 15_000,
      });
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Replicate credential check failed: ${message}`,
        credentialProblem: /HTTP 40[13]|credential|unauthorized|forbidden|token/i.test(message),
      };
    }
  },

  listModels(_config, capability): Promise<CapabilityModelDef[]> {
    const matching = MODEL_PRESETS.filter((model) => model.capability === capability);
    return Promise.resolve(
      matching.map(({ input: _input, ...model }) => ({ ...model, discovered: false })),
    );
  },

  async generate(request: CapabilityGenerationRequest): Promise<CapabilityMediaResult> {
    const capability = requireVisualCapability('Replicate', request.capability);
    const run = await runPrediction({
      config: request.config,
      path: modelPath(request.model),
      input: buildInput(request),
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    });
    // Multi-URL output is a frame sequence; the first frame is the still image.
    const asset = await materialize(run.urls[0], capability, request.signal, {
      provider: 'Replicate',
      mimeType: capability === 'video' ? 'video/mp4' : 'image/png',
    });
    return {
      capability,
      dataBase64: asset.base64,
      mimeType: asset.mimeType,
      meta: { predictionId: run.predictionId, model: request.model, frames: run.urls.length },
    };
  },

  /**
   * Replicate hosts speech and music models, so audio synthesis runs through the
   * same predictions contract as image and video rather than being advertised
   * without an implementation.
   */
  async synthesize(request: CapabilitySpeechRequest): Promise<CapabilityMediaResult> {
    const input: Record<string, unknown> = { text: request.text };
    if (typeof request.speed === 'number' && Number.isFinite(request.speed)) {
      input.speed = request.speed;
    }
    const run = await runPrediction({
      config: request.config,
      path: modelPath(request.model),
      input,
      signal: request.signal,
      timeoutMs: 120_000,
    });
    const asset = await materialize(run.urls[0], 'audio', request.signal, {
      provider: 'Replicate',
      mimeType: 'audio/wav',
    });
    return {
      capability: 'audio',
      dataBase64: asset.base64,
      mimeType: asset.mimeType,
      meta: { predictionId: run.predictionId, model: request.model },
    };
  },
};

/**
 * Submit a prediction and wait for a terminal state.
 *
 * Sync mode (`Prefer: wait=60`) covers most models in one round trip, but video
 * and audio routinely outlast it, so an unfinished prediction falls back to
 * polling. Output URLs are normalized across Replicate's polymorphic response
 * shapes, including an inline base64 payload for models that inline audio.
 */
async function runPrediction(request: {
  config: ResolvedCapabilityConfig;
  path: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{ predictionId: string; urls: string[] }> {
  const { config, path, signal } = request;
  const created = await capabilityFetch(
    'Replicate',
    `${config.baseUrl}/models/${path}/predictions`,
    config,
    {
      method: 'POST',
      headers: { ...authHeaders(config), Prefer: 'wait=60' },
      json: { input: request.input },
      signal,
      timeoutMs: 90_000,
    },
  );
  let prediction = (created.json ?? {}) as ReplicatePrediction;
  const predictionId = prediction.id;
  if (!predictionId) {
    throw new ValidationError('Replicate did not return a prediction id for this request.');
  }
  const terminal = (status: ReplicatePrediction['status']): boolean =>
    status === 'succeeded' || status === 'failed' || status === 'canceled';
  if (!terminal(prediction.status)) {
    prediction = await pollJob<ReplicatePrediction>({
      provider: 'Replicate',
      signal,
      timeoutMs: request.timeoutMs,
      status: async () => {
        const polled = await capabilityFetch(
          'Replicate',
          `${config.baseUrl}/predictions/${encodeURIComponent(predictionId)}`,
          config,
          { headers: authHeaders(config), signal },
        );
        prediction = (polled.json ?? {}) as ReplicatePrediction;
        return prediction;
      },
      interpret,
    });
  } else if (prediction.status !== 'succeeded') {
    throw new ValidationError(
      `Replicate run failed: ${prediction.error?.trim() ?? 'the model returned no output'}`,
    );
  }
  const urls = outputUrls(prediction.output);
  if (!urls.length) {
    throw new ValidationError(`Replicate model ${path} completed but returned no output.`);
  }
  return { predictionId, urls };
}

async function materialize(
  url: string,
  capability: 'image' | 'video' | 'audio',
  signal: AbortSignal,
  options: { provider: string; mimeType: string },
): Promise<{ base64: string; mimeType: string }> {
  const inline = decodeDataUrl(url);
  if (inline) return inline;
  return downloadAsset(url, {
    provider: options.provider,
    signal,
    maxBytes: MAX_ASSET_BYTES,
    mimeType: options.mimeType,
  });
}

export const REPLICATE_MODEL_PRESETS = MODEL_PRESETS;
