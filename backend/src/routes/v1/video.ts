import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { recordApiUsageRequired } from '../../billing/api-usage-ledger';
import { AuthenticationError, ConflictError, ValidationError } from '../../errors/types';
import {
  deleteVideoHistoryEntry,
  getVideoHistoryEntry,
  listVideoHistory,
  saveVideoHistory,
} from '../../images/video-history';
import {
  listCapabilityProviders,
  requireCapabilityConfig,
} from '../../providers/capability-service';
import {
  capabilityAdapterSupports,
  capabilityProvidersFor,
  getCapabilityAdapter,
} from '../../providers/capabilities';
import { detectMediaProviders } from '../../providers/modality-detection';
import { reserveSpendCapacity } from '../../security/spend-caps-enforced';

/**
 * Video generation.
 *
 * Every video provider Koryphaios supports is asynchronous: the request is
 * submitted, the upstream job is polled to a terminal state, and the finished
 * clip is downloaded immediately. Provider URLs expire (Kling clears generated
 * media after 30 days), so bytes are always persisted rather than linked.
 *
 * Generation is owned by the backend rather than the browser request: closing
 * the settings view must not abort a job that has already been billed, so a
 * submitted job is tracked in-process and the completed clip lands in the
 * gallery even if the client has gone away.
 */

/** Video generation routinely runs for minutes; bound it generously. */
const GENERATION_TIMEOUT_MS = 15 * 60_000;
const COMPLETED_RESULT_RETENTION_MS = 30 * 60_000;

interface VideoJobBody {
  jobId?: string;
  prompt: string;
  provider?: string;
  model?: string;
  duration?: string;
  aspectRatio?: string;
  resolution?: string;
  sound?: boolean;
  seed?: number;
  negativePrompt?: string;
}

interface VideoJobRuntime {
  signal?: AbortSignal;
}

const videoJobs = new Map<string, AbortController>();
const completedVideoJobs = new Map<string, { completedAt: number; historyId?: string }>();

function pruneCompletedJobs(now = Date.now()): void {
  for (const [jobId, result] of completedVideoJobs) {
    if (result.completedAt + COMPLETED_RESULT_RETENTION_MS <= now) {
      completedVideoJobs.delete(jobId);
    }
  }
}

function cancelVideoJob(jobId: string): boolean {
  const controller = videoJobs.get(jobId);
  if (!controller) return false;
  controller.abort();
  videoJobs.delete(jobId);
  return true;
}

export function getVideoJobStatus(jobId: string): {
  status: 'running' | 'completed' | 'unknown';
  historyId?: string;
} {
  if (videoJobs.has(jobId)) return { status: 'running' };
  pruneCompletedJobs();
  const completed = completedVideoJobs.get(jobId);
  return completed
    ? { status: 'completed', historyId: completed.historyId }
    : { status: 'unknown' };
}

/**
 * Rough cost ceiling used for the spend gate before a job is submitted.
 *
 * These are deliberately high relative to typical per-second rates: the gate
 * exists to stop a runaway loop of video requests, not to bill accurately.
 * Actual cost is recorded per job in the usage ledger.
 */
function estimateVideoCostUsd(model: string, durationSeconds: number): number {
  const perSecond = /kling|wan|minimax|video/i.test(model) ? 0.08 : 0.05;
  return Number((perSecond * Math.max(1, durationSeconds)).toFixed(4));
}

function durationSeconds(duration: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?)/.exec(duration?.trim() ?? '');
  const value = match ? Number(match[1]) : 5;
  return Number.isFinite(value) && value > 0 ? value : 5;
}

export async function runVideoJob(body: VideoJobBody, runtime: VideoJobRuntime = {}) {
  const provider = body.provider?.trim();
  if (!provider) {
    throw new ValidationError(
      'No video provider was selected. Connect Luma, Kling AI, Prodia, or Replicate in Providers & models first.',
    );
  }
  const { adapter, config } = requireCapabilityConfig(provider);
  if (!adapter.generate || !adapter.capabilities.includes('video')) {
    throw new ValidationError(`${provider} does not support video generation.`);
  }
  const model = body.model?.trim();
  if (!model) {
    throw new ValidationError(`Choose a video model for ${provider} before generating.`);
  }
  const prompt = body.prompt.trim();
  if (!prompt) throw new ValidationError('Describe the video you want before generating.');

  const timeoutSignal = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
  const signal = runtime.signal ? AbortSignal.any([runtime.signal, timeoutSignal]) : timeoutSignal;
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Video generation cancelled', 'AbortError');
  }

  const seconds = durationSeconds(body.duration);
  const estimatedCostUsd = estimateVideoCostUsd(model, seconds);
  const estimatedCostCents = Math.max(1, Math.ceil(estimatedCostUsd * 100));
  const spendGate = await reserveSpendCapacity(undefined, estimatedCostCents);
  if (!spendGate.canProceed) {
    throw new ConflictError(
      spendGate.reason ?? 'A configured spend limit blocked this video request.',
      { spendPolicy: true, paused: spendGate.paused ?? false },
    );
  }

  try {
    const result = await adapter.generate({
      config,
      capability: 'video',
      model,
      prompt,
      options: {
        duration: body.duration,
        aspectRatio: body.aspectRatio,
        resolution: body.resolution,
        sound: body.sound,
        seed: body.seed,
        negativePrompt: body.negativePrompt,
      },
      signal,
      timeoutMs: GENERATION_TIMEOUT_MS,
    });
    if (result.capability !== 'video') {
      throw new ValidationError(
        `${provider} returned ${result.capability} output for a video request.`,
      );
    }
    const runId = randomUUID();
    const usageId = await recordApiUsageRequired({
      kind: 'video',
      provider,
      model,
      estimatedCostUsd,
      units: { measure: 'videos', amount: 1 },
      detail: `${body.duration ?? `${seconds}s`} · ${body.aspectRatio ?? 'default'} · ${
        body.sound ? 'audio on' : 'audio off'
      }`,
      runId,
    });
    const history = await saveVideoHistory({
      videoBase64: result.dataBase64,
      mimeType: result.mimeType,
      prompt,
      provider,
      model,
      duration: body.duration,
      aspectRatio: body.aspectRatio,
      resolution: body.resolution,
      mode: 'generate',
    });
    return {
      ok: true as const,
      data: {
        videoBase64: result.dataBase64,
        mimeType: result.mimeType,
        provider,
        model,
        historyId: history?.id,
        usageId,
        runId,
        estimatedCostUsd,
        spendWarning: spendGate.reason,
        meta: result.meta,
      },
    };
  } finally {
    spendGate.release();
  }
}

async function runTrackedVideoJob(jobId: string, body: VideoJobBody) {
  if (videoJobs.has(jobId)) {
    throw new ConflictError('This video generation is already in progress.');
  }
  const controller = new AbortController();
  videoJobs.set(jobId, controller);
  try {
    const response = await runVideoJob(body, { signal: controller.signal });
    pruneCompletedJobs();
    completedVideoJobs.set(jobId, {
      completedAt: Date.now(),
      historyId: response.data.historyId,
    });
    return response;
  } finally {
    videoJobs.delete(jobId);
  }
}

const VideoRequest = t.Object({
  /** Stable client request id so a deliberate cancel can target this job. */
  jobId: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  prompt: t.String({ minLength: 1, maxLength: 8000 }),
  provider: t.Optional(t.String()),
  model: t.Optional(t.String()),
  duration: t.Optional(t.String({ maxLength: 16 })),
  aspectRatio: t.Optional(t.String({ maxLength: 16 })),
  resolution: t.Optional(t.String({ maxLength: 16 })),
  sound: t.Optional(t.Boolean()),
  seed: t.Optional(t.Integer()),
  negativePrompt: t.Optional(t.String({ maxLength: 2500 })),
});

/** Request options this provider's adapter actually forwards upstream. */
export interface VideoProviderCapabilities {
  audio: boolean;
  resolution: boolean;
  negativePrompt: boolean;
  /** True when the request path takes a bare seconds value ("5", not "5s"). */
  durationSeconds: boolean;
}

/**
 * Which controls the picker may show for a provider.
 *
 * Read from the adapter's declared `requestOptions` rather than a provider-name
 * list, so the picker cannot offer a toggle the request path silently drops.
 */
function videoProviderCapabilities(provider: string): VideoProviderCapabilities {
  const declared = getCapabilityAdapter(provider)?.requestOptions;
  return {
    audio: declared?.audio ?? false,
    resolution: declared?.resolution ?? false,
    negativePrompt: declared?.negativePrompt ?? false,
    durationSeconds: declared?.durationSeconds ?? false,
  };
}

/** True when a video generation request path exists for this provider. */
function videoTransport(provider: string): boolean {
  return capabilityAdapterSupports(provider, 'video');
}

export const videoRoutes = new Elysia({ prefix: '/api/video' })
  .onBeforeHandle(({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
  })
  .get('/providers', async () => {
    const summaries = await listCapabilityProviders('video');
    const supported = capabilityProvidersFor('video');
    // A provider only belongs here when its own catalog reports video output AND
    // a video transport exists to call it. Providers whose catalog reports video
    // but that Koryphaios cannot drive (chat providers with no video request
    // path) are not offered, and neither are image or text models.
    const detected = detectMediaProviders('video')
      .filter(
        (entry) =>
          entry.models.length > 0 &&
          !supported.includes(entry.provider) &&
          videoTransport(entry.provider),
      )
      .map((entry) => ({
        provider: entry.provider,
        label: entry.label,
        configured: entry.configured,
        detected: true,
        capabilities: videoProviderCapabilities(entry.provider),
        models: entry.models.map((model) => ({ id: model.id, label: model.label })),
      }));
    return {
      ok: true,
      data: [
        ...summaries.map((entry) => ({
          ...entry,
          detected: false,
          capabilities: videoProviderCapabilities(entry.provider),
          models: entry.models.map((model) => ({
            id: model.id,
            label: model.label,
            durations: model.durations,
            aspectRatios: model.aspectRatios,
          })),
        })),
        ...detected,
      ],
      // Providers that implement video but whose credential is not connected, so
      // the UI can offer to connect them instead of hiding them.
      unconnected: [
        ...supported.filter(
          (provider) => !summaries.some((entry) => entry.provider === provider && entry.configured),
        ),
        ...detected.filter((entry) => !entry.configured).map((entry) => entry.provider),
      ],
    };
  })
  .post('/generate', async ({ body }) => runTrackedVideoJob(body.jobId ?? randomUUID(), body), {
    body: VideoRequest,
  })
  .post(
    '/jobs/:id/cancel',
    ({ params }) => ({ ok: true, data: { cancelled: cancelVideoJob(params.id) } }),
    { params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }) },
  )
  .get('/jobs/:id', ({ params }) => ({ ok: true, data: getVideoJobStatus(params.id) }), {
    params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
  })
  .get('/history', async ({ request }) => {
    const rawLimit = new URL(request.url).searchParams.get('limit');
    const limit = Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : 24;
    return { ok: true, data: await listVideoHistory(limit) };
  })
  .get(
    '/history/:id',
    async ({ params }) => {
      const entry = await getVideoHistoryEntry(params.id);
      if (!entry) throw new ValidationError('Video not found in history.');
      return { ok: true, data: entry };
    },
    { params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }) },
  )
  .delete(
    '/history/:id',
    async ({ params }) => {
      const deleted = await deleteVideoHistoryEntry(params.id);
      if (!deleted) throw new ValidationError('Video not found in history.');
      return { ok: true };
    },
    { params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }) },
  );

/** Reset in-process job tracking. Test-only. */
export function resetVideoJobsForTests(): void {
  for (const controller of videoJobs.values()) controller.abort();
  videoJobs.clear();
  completedVideoJobs.clear();
}
