import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, type EmbeddingJobData, type EmbeddingJobResult } from '../types';
import { serverLog } from '../../logger';
import {
  configuredEmbeddingClient,
  EmbeddingError,
  type EmbeddingClient,
} from '../../memory/semantic-embeddings';
export { cosineSimilarity } from '../../memory/semantic-embeddings';

let embeddingWorker: Worker<EmbeddingJobData, EmbeddingJobResult> | null = null;

export interface EmbeddingWorkerOptions {
  concurrency?: number;
  /** Explicit client injection; otherwise uses opt-in environment configuration. */
  client?: EmbeddingClient;
}

export function createEmbeddingWorker(
  options: EmbeddingWorkerOptions = {},
): Worker<EmbeddingJobData, EmbeddingJobResult> | null {
  if (embeddingWorker) {
    serverLog.warn('Embedding worker already exists, returning existing instance');
    return embeddingWorker;
  }

  const connection = getRedisConnection();
  if (!connection) {
    serverLog.warn('Redis not available, embedding worker disabled');
    return null;
  }

  try {
    embeddingWorker = new Worker<EmbeddingJobData, EmbeddingJobResult>(
      QUEUE_NAMES.EMBEDDING,
      (job) => processEmbeddingJob(job, options.client),
      {
        connection,
        concurrency: options.concurrency ?? 2,
      },
    );

    embeddingWorker.on('completed', (job, result) => {
      serverLog.debug(
        {
          jobId: job.id,
          contentId: job.data.contentId,
          success: result.success,
          dimensions: result.dimensions,
        },
        'Embedding job completed',
      );
    });

    embeddingWorker.on('failed', (job, err) => {
      serverLog.error(
        { jobId: job?.id, contentId: job?.data?.contentId, error: err.message },
        'Embedding job failed',
      );
    });

    embeddingWorker.on('progress', (job, progress) => {
      serverLog.debug({ jobId: job.id, progress }, 'Embedding job progress');
    });

    embeddingWorker.on('error', (err) => {
      serverLog.error({ error: err.message }, 'Embedding worker error');
    });

    workerClient = options.client;
    serverLog.info(
      { concurrency: options.concurrency ?? 2, configured: isEmbeddingServiceReady() },
      'Embedding worker started',
    );
    return embeddingWorker;
  } catch (err) {
    serverLog.error({ err }, 'Failed to create embedding worker');
    return null;
  }
}

/** Shared with active memory retrieval; failures contain only bounded, sanitized codes. */
export async function processEmbeddingJob(
  job: Pick<Job<EmbeddingJobData>, 'data' | 'updateProgress'>,
  client?: EmbeddingClient | null,
): Promise<EmbeddingJobResult> {
  try {
    const effectiveClient = client === undefined ? configuredEmbeddingClient() : client;
    if (!effectiveClient) {
      await job.updateProgress(100);
      return {
        success: false,
        isStub: true,
        error: 'Embeddings disabled; explicit configuration required',
      };
    }
    const [embedding] = await effectiveClient.embed([job.data.content]);
    await job.updateProgress(100);
    return { success: true, isStub: false, embedding, dimensions: embedding.length };
  } catch (error) {
    return {
      success: false,
      isStub: false,
      error: error instanceof EmbeddingError ? error.message : 'Embedding job failed',
    };
  }
}

export async function pauseEmbeddingWorker(): Promise<void> {
  if (embeddingWorker) {
    await embeddingWorker.pause();
    serverLog.info('Embedding worker paused');
  }
}

export async function resumeEmbeddingWorker(): Promise<void> {
  if (embeddingWorker) {
    await embeddingWorker.resume();
    serverLog.info('Embedding worker resumed');
  }
}

export function getEmbeddingWorkerStatus(): {
  running: boolean;
  concurrency: number;
  isStub: boolean;
} {
  return {
    running: embeddingWorker !== null,
    concurrency: embeddingWorker?.opts?.concurrency ?? 0,
    isStub: !isEmbeddingServiceReady(),
  };
}

export async function closeEmbeddingWorker(): Promise<void> {
  if (embeddingWorker) {
    await embeddingWorker.close();
    embeddingWorker = null;
    workerClient = undefined;
    serverLog.info('Embedding worker closed');
  }
}

/** Configuration readiness only; does not assert remote availability or valid billing. */
let workerClient: EmbeddingClient | undefined;
export function isEmbeddingServiceReady(): boolean {
  try {
    return !!(workerClient ?? configuredEmbeddingClient());
  } catch {
    return false;
  }
}

export { embeddingWorker as embeddingWorkerInstance };
