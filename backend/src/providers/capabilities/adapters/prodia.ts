import { ValidationError } from '../../../errors/types';
import { capabilityFetch } from '../http';
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
 * Prodia — unified inference job endpoint.
 *
 * Base URL: `https://inference.prodia.com/v2/job`
 * Auth:     `Authorization: Bearer <token>` (v2 tokens are JWTs)
 * Body:     `{ type: "inference.<model>.<task>.v<n>", config: { prompt, ... } }`
 *
 * Prodia is asked with an explicit `Accept` header, so the endpoint streams the
 * finished asset straight back rather than handing out a job id — no polling is
 * needed for the v2 surface. The legacy v1 surface (`api.prodia.com/v1/sd/*`
 * with an `X-Prodia-Key` header) is a different, poll-based contract and is
 * deliberately not wired: a v2 token cannot authenticate against it.
 */
const BASE_URL = 'https://inference.prodia.com/v2/job';
const MAX_ASSET_BYTES = 96 * 1024 * 1024;

interface JobModel extends CapabilityModelDef {
  /** Prodia job type sent as `type`. */
  jobType: string;
}

const IMAGE_MODELS: JobModel[] = [
  {
    jobType: 'inference.flux-fast.schnell.txt2img.v2',
    id: 'flux-fast.schnell',
    label: 'FLUX.1 [schnell] fast',
    capability: 'image',
    edits: true,
    sizes: ['512x512', '768x512', '1024x768', '768x1024', '1024x1024'],
  },
  {
    jobType: 'inference.flux-2.klein.txt2img.v1',
    id: 'flux-2.klein',
    label: 'FLUX.2 Klein',
    capability: 'image',
    edits: true,
    sizes: ['512x512', '768x512', '1024x768', '768x1024', '1024x1024'],
  },
  {
    jobType: 'inference.flux-2.klein.9b.txt2img.v1',
    id: 'flux-2.klein.9b',
    label: 'FLUX.2 Klein 9B',
    capability: 'image',
    edits: true,
    sizes: ['512x512', '768x512', '1024x768', '768x1024', '1024x1024'],
  },
  {
    jobType: 'inference.flux-2.dev.txt2img.v1',
    id: 'flux-2.dev',
    label: 'FLUX.2 Dev',
    capability: 'image',
    edits: true,
    sizes: ['512x512', '768x512', '1024x768', '768x1024', '1024x1024'],
  },
  {
    jobType: 'inference.flux-2.pro.txt2img.v1',
    id: 'flux-2.pro',
    label: 'FLUX.2 Pro',
    capability: 'image',
    edits: true,
    sizes: ['512x512', '768x512', '1024x768', '768x1024', '1024x1024'],
  },
  {
    jobType: 'inference.gemini-3-1-flash.txt2img.v1',
    id: 'gemini-3-1-flash',
    label: 'Gemini 3.1 Flash Image',
    capability: 'image',
    edits: true,
  },
  {
    jobType: 'inference.recraft.v4.txt2img.v1',
    id: 'recraft-v4',
    label: 'Recraft V4',
    capability: 'image',
    edits: true,
  },
];

const VIDEO_MODELS: JobModel[] = [
  {
    jobType: 'inference.wan2-7.txt2video.v1',
    id: 'wan2-7',
    label: 'Wan 2.7',
    capability: 'video',
    durations: ['5s'],
    aspectRatios: ['16:9', '9:16', '1:1'],
  },
];

const BY_ID = new Map<string, JobModel>([...IMAGE_MODELS, ...VIDEO_MODELS].map((m) => [m.id, m]));
const BY_JOB_TYPE = new Map<string, JobModel>(
  [...IMAGE_MODELS, ...VIDEO_MODELS].map((m) => [m.jobType, m]),
);

function authHeaders(config: ResolvedCapabilityConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}` };
}

/**
 * Resolve the job type for a request. A model id the adapter does not know is
 * treated as a literal Prodia job type so a user can run any job their account
 * has access to without this build having to enumerate it.
 */
function resolveJobType(model: string, capability: 'image' | 'video'): JobModel {
  const known = BY_ID.get(model) ?? BY_JOB_TYPE.get(model);
  if (known) return known;
  if (/txt2img|img2img/i.test(model) && capability === 'image') return jobModel(model, 'image');
  if (/txt2video|img2video/i.test(model) && capability === 'video') return jobModel(model, 'video');
  throw new ValidationError(
    `Prodia model "${model}" is not a known Prodia job type. Use a job type such as inference.flux-2.klein.txt2img.v1.`,
  );
}

function jobModel(jobType: string, capability: 'image' | 'video'): JobModel {
  return { jobType, id: jobType, label: jobType, capability };
}

/** Parse "1024x768" into the separate width/height Prodia expects. */
function parseSize(size: string | undefined): { width?: number; height?: number } {
  const match = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(size ?? '');
  if (!match) return {};
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return {};
  return { width, height };
}

export const prodiaAdapter: CapabilityAdapter = {
  provider: 'prodia',
  capabilities: ['image', 'video'],
  defaultBaseUrl: BASE_URL,

  async verify(config, signal): Promise<CapabilityVerifyResult> {
    try {
      // `inference.ping.v1` is the documented no-op job used to validate a token.
      await capabilityFetch('Prodia', `${config.baseUrl}`, config, {
        method: 'POST',
        headers: { ...authHeaders(config), Accept: 'application/json' },
        json: { type: 'inference.ping.v1' },
        signal,
        timeoutMs: 20_000,
      });
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Prodia credential check failed: ${message}`,
        credentialProblem: /HTTP 40[13]|credential|unauthorized|forbidden|token/i.test(message),
      };
    }
  },

  listModels(_config, capability): Promise<CapabilityModelDef[]> {
    if (capability === 'image') return Promise.resolve(IMAGE_MODELS);
    if (capability === 'video') return Promise.resolve(VIDEO_MODELS);
    return Promise.resolve([]);
  },

  async generate(request: CapabilityGenerationRequest): Promise<CapabilityMediaResult> {
    const { config, signal } = request;
    const capability = requireVisualCapability('Prodia', request.capability);
    const model = resolveJobType(request.model, capability);
    // An img2img job needs an uploaded input; a txt2img job must not carry one.
    const wantsInput = /img2img|img2video/i.test(model.jobType);

    const config_body: Record<string, unknown> = { prompt: request.prompt };
    const { width, height } = parseSize(
      typeof request.options.size === 'string' ? request.options.size : undefined,
    );
    if (width && height) {
      config_body.width = width;
      config_body.height = height;
    }
    const negative = request.options.negativePrompt;
    if (typeof negative === 'string' && negative.trim())
      config_body.negative_prompt = negative.trim();
    const steps = request.options.steps;
    if (typeof steps === 'number' && Number.isFinite(steps)) config_body.steps = Math.round(steps);
    const seed = request.options.seed;
    if (typeof seed === 'number' && Number.isFinite(seed)) config_body.seed = Math.round(seed);
    const duration = request.options.duration;
    if (typeof duration === 'string' && duration.trim()) config_body.duration = duration.trim();
    const aspect = request.options.aspectRatio;
    if (typeof aspect === 'string' && aspect.trim()) config_body.aspect_ratio = aspect.trim();

    const accept = capability === 'video' ? 'video/mp4' : 'image/jpeg';
    let response: Response;
    try {
      response = await fetch(config.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: accept,
          ...(wantsInput ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(wantsInput
          ? { body: await buildMultipart(model.jobType, config_body, request.sourceImage) }
          : { body: JSON.stringify({ type: model.jobType, config: config_body }) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]),
      });
    } catch (err: unknown) {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Prodia generation cancelled', 'AbortError');
      }
      throw new ValidationError(
        `Prodia could not be reached (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined);
      throw new ValidationError(
        (payload && typeof payload === 'object'
          ? String(
              (payload as Record<string, unknown>).error ??
                (payload as Record<string, unknown>).message ??
                '',
            )
          : '') || `Prodia returned HTTP ${response.status}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength) {
      throw new ValidationError('Prodia returned an empty asset for this job.');
    }
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new ValidationError(
        `Prodia produced a ${bytes.byteLength}-byte asset, above the supported limit.`,
      );
    }
    return {
      capability,
      dataBase64: Buffer.from(bytes).toString('base64'),
      mimeType: response.headers.get('content-type')?.split(';')[0] || accept,
      meta: { jobType: model.jobType },
    };
  },
};

/** img2img/img2video jobs send the job description and the input as parts. */
async function buildMultipart(
  jobType: string,
  jobConfig: Record<string, unknown>,
  sourceImage: CapabilityGenerationRequest['sourceImage'],
): Promise<FormData> {
  if (!sourceImage) {
    throw new ValidationError('This Prodia job type needs a source image but none was provided.');
  }
  const form = new FormData();
  form.set(
    'job',
    new Blob([JSON.stringify({ type: jobType, config: jobConfig })], { type: 'application/json' }),
    'job.json',
  );
  const extension = sourceImage.mimeType.includes('png') ? 'png' : 'jpg';
  form.set(
    'input',
    new Blob([Buffer.from(sourceImage.base64, 'base64')], { type: sourceImage.mimeType }),
    `input.${extension}`,
  );
  return form;
}

export const PRODIA_IMAGE_MODELS = IMAGE_MODELS;
export const PRODIA_VIDEO_MODELS = VIDEO_MODELS;
