import { ValidationError } from '../../../errors/types';
import { capabilityFetch } from '../http';
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
 * Kling AI — asynchronous task API.
 *
 * Base URL: `https://api-singapore.klingai.com` — Kling moved off
 *   `api.klingai.com`; the old host still resolves for some regions but is no
 *   longer the documented endpoint, so the catalog default is the new one.
 * Auth:     `Authorization: Bearer <api key>` (the current single-key format;
 *           legacy Access Key / Secret Key pairs remain valid on older models).
 * Submit:   `POST /v1/videos/text2video` or `/v1/videos/image2video`
 * Poll:     `GET /v1/videos/{kind}/{task_id}`
 *
 * Every response is wrapped in `{ code, message, request_id, data }` where a
 * non-zero `code` is an error even on HTTP 200.
 */
const BASE_URL = 'https://api-singapore.klingai.com';
const MAX_ASSET_BYTES = 96 * 1024 * 1024;

const VIDEO_MODELS: CapabilityModelDef[] = [
  {
    id: 'kling-v2-6',
    label: 'Kling 2.6',
    capability: 'video',
    durations: ['5', '10'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  },
  {
    id: 'kling-v2-5-turbo',
    label: 'Kling 2.5 Turbo',
    capability: 'video',
    durations: ['5', '10'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  },
  {
    id: 'kling-v1-6',
    label: 'Kling 1.6',
    capability: 'video',
    durations: ['5', '10'],
    aspectRatios: ['16:9', '9:16', '1:1'],
  },
];

const IMAGE_MODELS: CapabilityModelDef[] = [
  {
    id: 'kling-image-3-0',
    label: 'Kling Image 3.0',
    capability: 'image',
    edits: true,
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  },
];

function authHeaders(config: ResolvedCapabilityConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}` };
}

/** Kling reports errors in an envelope that can carry HTTP 200. */
function envelopeError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const code = record.code;
  const data = record.data as Record<string, unknown> | undefined;
  // `code` is 0/absent on success; the status endpoint uses a task_status field.
  if (typeof code === 'number' && code !== 0) {
    const message = typeof record.message === 'string' ? record.message : '';
    return message || `the provider reported error code ${code}`;
  }
  if (typeof data?.task_status_msg === 'string' && data.task_status_msg.trim()) {
    return data.task_status_msg.trim();
  }
  return undefined;
}

interface KlingEnvelope {
  code?: number;
  message?: string;
  request_id?: string;
  data?: {
    task_id?: string;
    task_status?: string;
    task_status_msg?: string;
    task_result?: { videos?: Array<{ url?: string }>; images?: Array<{ url?: string }> };
  };
}

function interpret(envelope: KlingEnvelope): JobState {
  const status = (envelope.data?.task_status ?? '').toLowerCase();
  if (status === 'succeed' || status === 'succeeded') return { kind: 'completed' };
  if (status === 'failed') {
    return {
      kind: 'failed',
      reason: envelope.data?.task_status_msg?.trim() || 'the provider reported a failure',
    };
  }
  return { kind: 'pending' };
}

function resultUrl(envelope: KlingEnvelope, capability: 'image' | 'video'): string | undefined {
  const results = envelope.data?.task_result;
  const list = capability === 'video' ? results?.videos : results?.images;
  const url = list?.[0]?.url;
  return url?.trim() ? url.trim() : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Kling exposes separate task families per modality and input style. */
function submitPathFor(capability: 'image' | 'video', hasSourceImage: boolean): string {
  if (capability === 'image') return '/v1/images/image2generation';
  return `/v1/videos/${hasSourceImage ? 'image2video' : 'text2video'}`;
}

export const klingAiAdapter: CapabilityAdapter = {
  provider: 'klingai',
  capabilities: ['video', 'image'],
  defaultBaseUrl: BASE_URL,

  async verify(config, signal): Promise<CapabilityVerifyResult> {
    try {
      const result = await capabilityFetch(
        'Kling',
        `${config.baseUrl}/v1/videos/text2video?pageNum=1&pageSize=1`,
        config,
        { headers: authHeaders(config), signal, timeoutMs: 15_000 },
      );
      const failure = envelopeError(result.json);
      if (failure) {
        return {
          ok: false,
          error: `Kling credential check failed: ${failure}`,
          credentialProblem: /401|403|unauthor|forbidden|key/i.test(failure),
        };
      }
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Kling credential check failed: ${message}`,
        credentialProblem: /HTTP 40[13]|credential|unauthorized|forbidden/i.test(message),
      };
    }
  },

  listModels(_config, capability): Promise<CapabilityModelDef[]> {
    if (capability === 'video') return Promise.resolve(VIDEO_MODELS);
    if (capability === 'image') return Promise.resolve(IMAGE_MODELS);
    return Promise.resolve([]);
  },

  async generate(request: CapabilityGenerationRequest): Promise<CapabilityMediaResult> {
    const { config, signal } = request;
    const capability = requireVisualCapability('Kling', request.capability);
    if (request.sourceImage) {
      // Kling takes a publicly reachable image URL, not an upload.
      throw new ValidationError(
        'Kling image-to-video needs a publicly reachable source image URL, which a locally selected file does not provide. Use a text prompt here, or host the image first.',
      );
    }
    const submitPath = submitPathFor(capability, false);
    const payload: Record<string, unknown> = {
      model_name: request.model,
      prompt: request.prompt,
    };
    const negative = asString(request.options.negativePrompt);
    if (negative) payload.negative_prompt = negative;
    const duration = asString(request.options.duration);
    if (duration) payload.duration = duration;
    const aspectRatio = asString(request.options.aspectRatio) ?? asString(request.options.size);
    if (aspectRatio) payload.aspect_ratio = aspectRatio;
    // Kling uses std/pro rather than standard/professional.
    const mode = asString(request.options.mode) ?? asString(request.options.quality);
    if (mode) payload.mode = mode === 'professional' || mode === 'pro' ? 'pro' : 'std';
    // 2.6 and later generate synchronized audio natively.
    const sound = request.options.sound ?? request.options.audio;
    if (typeof sound === 'boolean') payload.sound = sound ? 'on' : 'off';

    const created = await capabilityFetch('Kling', `${config.baseUrl}${submitPath}`, config, {
      method: 'POST',
      headers: authHeaders(config),
      json: payload,
      signal,
      timeoutMs: 60_000,
    });
    const failure = envelopeError(created.json);
    if (failure) {
      throw new ValidationError(`Kling rejected this generation request: ${failure}`);
    }
    const taskId = (created.json as KlingEnvelope | undefined)?.data?.task_id;
    if (!taskId?.trim()) {
      throw new ValidationError('Kling did not return a task id for this request.');
    }

    let finished: KlingEnvelope = {};
    await pollJob<KlingEnvelope>({
      provider: 'Kling',
      signal,
      timeoutMs: request.timeoutMs,
      status: async () => {
        const polled = await capabilityFetch(
          'Kling',
          `${config.baseUrl}${submitPath}/${encodeURIComponent(taskId)}`,
          config,
          { headers: authHeaders(config), signal },
        );
        finished = (polled.json ?? {}) as KlingEnvelope;
        return finished;
      },
      interpret,
    });

    const url = resultUrl(finished, capability);
    if (!url) {
      throw new ValidationError(
        `Kling reported task ${taskId} completed but returned no ${capability} asset.`,
      );
    }
    const inline = decodeDataUrl(url);
    const asset = inline
      ? inline
      : await downloadAsset(url, {
          provider: 'Kling',
          signal,
          maxBytes: MAX_ASSET_BYTES,
          mimeType: capability === 'video' ? 'video/mp4' : 'image/png',
        });
    return {
      capability,
      dataBase64: asset.base64,
      mimeType: asset.mimeType,
      meta: { taskId, requestId: finished.request_id, model: request.model },
    };
  },
};

export const KLING_VIDEO_MODELS = VIDEO_MODELS;
export const KLING_IMAGE_MODELS = IMAGE_MODELS;
