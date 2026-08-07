/**
 * Worker for embedding generation
 *
 * STUB: No real embedding provider is wired in. Per the AGENTS.md stub rule,
 * this worker logs a warning on every job and returns empty results
 * (success: false, no embedding vector) instead of producing meaningless
 * mock vectors. The prior implementation generated deterministic-but-random
 * vectors and reported success: true, which looked like a working embedding
 * pipeline in logs/dashboards but had no semantic meaning. Do not restore
 * mock vector generation — wire in a real provider or leave this returning
 * empty results.
 *
 * To enable real embeddings:
 *   1. Replace processEmbeddingJob's stub return with a real embedding API call.
 *   2. Set MemoryManagerService.embeddingProviderAvailable = true.
 *   3. Update isEmbeddingServiceReady() to reflect real readiness.
 */

import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, type EmbeddingJobData, type EmbeddingJobResult } from '../types';
import { serverLog } from '../../logger';

let embeddingWorker: Worker<EmbeddingJobData, EmbeddingJobResult> | null = null;

export interface EmbeddingWorkerOptions {
  concurrency?: number;
  embeddingModel?: string;
  apiKey?: string;
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
      processEmbeddingJob,
      {
        connection,
        concurrency: options.concurrency ?? 2,
      },
    );

    embeddingWorker.on('completed', (job, result) => {
      serverLog.debug(
        { jobId: job.id, contentId: job.data.contentId, success: result.success, dimensions: result.dimensions },
        'Embedding job completed',
      );
    });

    embeddingWorker.on('failed', (job, err) => {
      serverLog.error({ jobId: job?.id, contentId: job?.data?.contentId, error: err.message }, 'Embedding job failed');
    });

    embeddingWorker.on('progress', (job, progress) => {
      serverLog.debug({ jobId: job.id, progress }, 'Embedding job progress');
    });

    embeddingWorker.on('error', (err) => {
      serverLog.error({ error: err.message }, 'Embedding worker error');
    });

    serverLog.warn(
      { concurrency: options.concurrency ?? 2 },
      'Embedding worker started in STUB mode — jobs will be accepted but return empty results (no embedding provider configured)',
    );
    return embeddingWorker;
  } catch (err) {
    serverLog.error({ err }, 'Failed to create embedding worker');
    return null;
  }
}

async function processEmbeddingJob(job: Job<EmbeddingJobData>): Promise<EmbeddingJobResult> {
  const { content, contentId, contentType, filePath } = job.data;

  // STUB: No embedding provider is configured. Per the AGENTS.md stub rule,
  // log a warning and return empty results (success: false, no vector) rather
  // than generating meaningless mock vectors. The job "completes" (so BullMQ
  // does not retry it forever) but carries success: false so callers and
  // dashboards can see nothing was produced.
  serverLog.warn(
    { jobId: job.id, contentId, contentType, filePath, contentLength: content?.length ?? 0 },
    'Embedding job accepted but no embedding provider is configured — returning empty result (stub)',
  );

  await job.updateProgress(100);

  return {
    success: false,
    isStub: true,
    error: 'No embedding provider configured; stub returns empty results',
  };
}

/**
 * Calculate cosine similarity between two embeddings.
 *
 * Pure utility retained for when a real provider is wired in. Not currently
 * used by the stub path, which produces no vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Embeddings must have same dimensions');
  }
  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }
  return dotProduct;
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

export function getEmbeddingWorkerStatus(): { running: boolean; concurrency: number; isStub: boolean } {
  return {
    running: embeddingWorker !== null,
    concurrency: embeddingWorker?.opts?.concurrency ?? 0,
    isStub: true,
  };
}

export async function closeEmbeddingWorker(): Promise<void> {
  if (embeddingWorker) {
    await embeddingWorker.close();
    embeddingWorker = null;
    serverLog.info('Embedding worker closed');
  }
}

/**
 * Check if the embedding service is ready.
 *
 * Returns false until a real embedding provider is wired in. The prior stub
 * returned true, which misled callers into thinking semantic search was
 * available. Do not flip this to true until processEmbeddingJob produces real
 * vectors.
 */
export function isEmbeddingServiceReady(): boolean {
  return false;
}

export { embeddingWorker as embeddingWorkerInstance };
