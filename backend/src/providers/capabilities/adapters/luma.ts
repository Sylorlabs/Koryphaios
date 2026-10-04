import { ValidationError } from '../../../errors/types';
import { capabilityFetch, jsonString } from '../http';
import { decodeDataUrl, downloadAsset, pollJob, type JobState } from '../poll';
import { requireVisualCapability } from '../types';
import type {
  CapabilityAdapter,
  CapabilityGenerationRequest,
  CapabilityMediaResult,
  CapabilityModelDef,
  CapabilityVerifyResult,
  ResolvedCapabilityConfig,
} from '../types';

/**
 * Luma Dream Machine — asynchronous generation endpoint.
 *
 * Base URL: `https://api.lumalabs.ai/dream-machine/v1`
 * Auth:     `Authorization: Bearer <key>`
 * Submit:   `POST /generations` → `{ id }`
 * Poll:     `GET /generations/{id}` → `state: dreaming | completed | failed`
 *
 * Finished jobs expose their asset in `assets` (video/image) on the Dream
 * Machine surface, or in `output[0]` on the newer Agents surface. Both are
 * checked because Luma is mid-migration between them.
 */
const BASE_URL = 'https://api.lumalabs.ai/dream-machine/v1';
const MAX_ASSET_BYTES = 96 * 1024 * 1024;

const VIDEO_MODELS: CapabilityModelDef[] = [
  {
    id: 'ray-2',
    label: 'Ray 2',
    capability: 'video',
    durations: ['5s', '9s'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '4:5'],
  },
  {
    id: 'ray-flash-2',
    label: 'Ray 2 Flash',
    capability: 'video',
    durations: ['5s', '9s'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  },
];

const IMAGE_MODELS: CapabilityModelDef[] = [
  { id: 'photon-1', label: 'Photon 1', capability: 'image', edits: true },
  { id: 'photon-flash-1', label: 'Photon Flash 1', capability: 'image', edits: true },
];

function authHeaders(config: ResolvedCapabilityConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}` };
}

interface LumaJob {
  id?: string;
  state?: string;
  failure_reason?: string | null;
  assets?: { video?: string; image?: string };
  output?: Array<{ url?: string }>;
}

function assetUrl(job: LumaJob, capability: 'image' | 'video'): string | undefined {
  const direct = capability === 'video' ? job.assets?.video : job.assets?.image;
  if (direct?.trim()) return direct.trim();
  const first = job.output?.[0]?.url;
  if (!first?.trim()) return undefined;
  // `output` is modality-agnostic, so only trust it when the extension agrees.
  if (capability === 'video' && !/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(first)) return undefined;
  if (capability === 'image' && !/\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(first)) return undefined;
  return first.trim();
}

function interpret(job: LumaJob): JobState {
  const state = (job.state ?? '').toLowerCase();
  if (state === 'completed') return { kind: 'completed' };
  if (state === 'failed') {
    return {
      kind: 'failed',
      reason: job.failure_reason?.trim() || 'the provider reported a failure',
    };
  }
  return { kind: 'pending' };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export const lumaAdapter: CapabilityAdapter = {
  provider: 'luma',
  capabilities: ['video', 'image'],
  defaultBaseUrl: BASE_URL,

  async verify(config, signal): Promise<CapabilityVerifyResult> {
    try {
      await capabilityFetch('Luma', `${config.baseUrl}/ping`, config, {
        headers: authHeaders(config),
        signal,
        timeoutMs: 15_000,
      });
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Luma credential check failed: ${message}`,
        credentialProblem: /HTTP 40[13]|credential|unauthorized|forbidden/i.test(message),
      };
    }
  },

  /**
   * Luma publishes no model enumeration endpoint. These entries describe how to
   * call the models the adapter supports, not an entitlement claim — the video
   * and image studios still accept any other model id the account can run.
   */
  listModels(_config, capability): Promise<CapabilityModelDef[]> {
    if (capability === 'video') return Promise.resolve(VIDEO_MODELS);
    if (capability === 'image') return Promise.resolve(IMAGE_MODELS);
    return Promise.resolve([]);
  },

  async generate(request: CapabilityGenerationRequest): Promise<CapabilityMediaResult> {
    const { config, signal } = request;
    const capability = requireVisualCapability('Luma', request.capability);
    const payload: Record<string, unknown> = { prompt: request.prompt, model: request.model };
    // Luma rejects unrecognized keys, so forward only options actually chosen.
    const aspectRatio = asString(request.options.aspectRatio) ?? asString(request.options.size);
    if (aspectRatio) payload.aspect_ratio = aspectRatio;
    const duration = asString(request.options.duration);
    if (duration) payload.duration = duration;
    const resolution = asString(request.options.resolution);
    if (resolution) payload.resolution = resolution;
    if (typeof request.options.loop === 'boolean') payload.loop = request.options.loop;
    if (request.sourceImage) {
      throw new ValidationError(
        'Luma image-to-video requires a publicly reachable first frame, which a locally selected file does not provide. Use a text prompt here, or choose Kling or Replicate for image-to-video.',
      );
    }

    const created = await capabilityFetch('Luma', `${config.baseUrl}/generations`, config, {
      method: 'POST',
      headers: authHeaders(config),
      json: payload,
      signal,
      timeoutMs: 60_000,
    });
    const jobId = jsonString(created.json, 'id');
    if (!jobId) {
      throw new ValidationError('Luma did not return a generation id for this request.');
    }

    let finished: LumaJob = {};
    await pollJob<LumaJob>({
      provider: 'Luma',
      signal,
      timeoutMs: request.timeoutMs,
      status: async () => {
        const polled = await capabilityFetch(
          'Luma',
          `${config.baseUrl}/generations/${encodeURIComponent(jobId)}`,
          config,
          { headers: authHeaders(config), signal },
        );
        finished = (polled.json ?? {}) as LumaJob;
        return finished;
      },
      interpret,
    });

    const url = assetUrl(finished, capability);
    if (!url) {
      throw new ValidationError(
        `Luma reported job ${jobId} completed but returned no ${capability} asset.`,
      );
    }
    const inline = decodeDataUrl(url);
    const asset = inline
      ? inline
      : await downloadAsset(url, {
          provider: 'Luma',
          signal,
          maxBytes: MAX_ASSET_BYTES,
          mimeType: capability === 'video' ? 'video/mp4' : 'image/png',
        });
    return {
      capability,
      dataBase64: asset.base64,
      mimeType: asset.mimeType,
      meta: { generationId: jobId, model: request.model },
    };
  },
};

export const LUMA_VIDEO_MODELS = VIDEO_MODELS;
export const LUMA_IMAGE_MODELS = IMAGE_MODELS;
