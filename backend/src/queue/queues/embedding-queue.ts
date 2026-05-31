/**
 * Embedding generation queue (for RAG)
 * Features:
 * - Generate embeddings for code chunks
 * - Batch processing support
 * - 2 minute timeout
 */

import { Queue, type JobsOptions } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, type EmbeddingJobData, type EmbeddingJobResult } from '../types';
import { serverLog } from '../../logger';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const BATCH_TIMEOUT = 5 * 60 * 1000; // 5 minutes for batch jobs

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
  removeOnComplete: 200,
  removeOnFail: false,
};

// ============================================================================
// Embedding Queue Singleton
// ============================================================================

let embeddingQueue: Queue<EmbeddingJobData, EmbeddingJobResult> | null = null;

export function getEmbeddingQueue(): Queue<EmbeddingJobData, EmbeddingJobResult> | null {
  if (!embeddingQueue) {
    const connection = getRedisConnection();
    if (!connection) {
      serverLog.warn('Redis not available, embedding queue disabled');
      return null;
    }

    try {
      embeddingQueue = new Queue<EmbeddingJobData, EmbeddingJobResult>(QUEUE_NAMES.EMBEDDING, {
        connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });

      embeddingQueue.on('error', (error) => {
        serverLog.error({ error }, 'Embedding queue error');
      });

      serverLog.info('Embedding queue initialized (2 min timeout)');
    } catch (err) {
      serverLog.error({ err }, 'Failed to create embedding queue');
      return null;
    }
  }

  return embeddingQueue;
}

/**
 * Add a single embedding generation job
 */
export async function addEmbeddingJob(
  data: EmbeddingJobData,
  options?: { jobId?: string; priority?: number },
): Promise<ReturnType<Queue<EmbeddingJobData, EmbeddingJobResult>['add']> | null> {
  const queue = getEmbeddingQueue();
  if (!queue) {
    serverLog.warn('Cannot add embedding job: Redis unavailable');
    return null;
  }

  return queue.add(`embedding:${data.contentId}`, data, {
    jobId: options?.jobId,
    priority: options?.priority ?? 5,
    ...DEFAULT_JOB_OPTIONS,
  });
}

/**
 * Add multiple embedding jobs in batch
 * Uses a parent job with children for better tracking
 */
export async function addEmbeddingBatch(
  jobs: EmbeddingJobData[],
  options?: { priority?: number },
): Promise<Array<Awaited<
  ReturnType<Queue<EmbeddingJobData, EmbeddingJobResult>['add']>
> | null> | null> {
  const queue = getEmbeddingQueue();
  if (!queue) {
    serverLog.warn('Cannot add embedding batch: Redis unavailable');
    return null;
  }

  const priority = options?.priority ?? 5;

  // Add all jobs as a batch
  return Promise.all(
    jobs.map((data, index) =>
      queue.add(`embedding:batch:${Date.now()}:${index}`, data, {
        priority,
        ...DEFAULT_JOB_OPTIONS,
      }),
    ),
  );
}

/**
 * Add embedding jobs for a file's code chunks
 * Creates jobs for each chunk of the file
 */
export async function addFileEmbeddingJobs(
  filePath: string,
  chunks: Array<{
    content: string;
    contentId: string;
    startLine: number;
    endLine: number;
    contentType: 'function' | 'class' | 'text';
  }>,
  options?: { priority?: number },
): Promise<Array<Awaited<
  ReturnType<Queue<EmbeddingJobData, EmbeddingJobResult>['add']>
> | null> | null> {
  const jobs: EmbeddingJobData[] = chunks.map((chunk) => ({
    content: chunk.content,
    contentId: chunk.contentId,
    contentType: chunk.contentType,
    filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    metadata: {
      source: 'file_chunk',
      chunkCount: chunks.length,
    },
  }));

  return addEmbeddingBatch(jobs, options);
}

/**
 * Get job status by ID
 */
export async function getEmbeddingJobStatus(jobId: string): Promise<{
  id: string;
  state: string;
  progress: number;
  result?: EmbeddingJobResult;
  failedReason?: string;
} | null> {
  const queue = getEmbeddingQueue();
  if (!queue) return null;

  const job = await queue.getJob(jobId);
  if (!job) return null;

  const state = await job.getState();
  return {
    id: job.id as string,
    state,
    progress: job.progress as number,
    result: job.returnvalue ?? undefined,
    failedReason: job.failedReason ?? undefined,
  };
}

/**
 * Get all jobs for a specific file
 */
export async function getEmbeddingJobsByFile(filePath: string): Promise<
  Array<{
    id: string;
    state: string;
    progress: number;
    data: EmbeddingJobData;
    result?: EmbeddingJobResult;
  }>
> {
  const queue = getEmbeddingQueue();
  if (!queue) return [];

  // Get all jobs (this might be expensive for large queues)
  // In production, consider using a more targeted approach
  const jobs = await queue.getJobs(['waiting', 'active', 'completed', 'failed']);

  const results = await Promise.all(
    jobs
      .filter((job) => job.data.filePath === filePath)
      .map(async (job) => ({
        id: job.id as string,
        state: await job.getState(),
        progress: job.progress as number,
        data: job.data,
        result: job.returnvalue ?? undefined,
      })),
  );

  return results;
}

/**
 * Get queue metrics
 */
export async function getEmbeddingQueueMetrics(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
} | null> {
  const queue = getEmbeddingQueue();
  if (!queue) return null;

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Pause the embedding queue
 */
export async function pauseEmbeddingQueue(): Promise<void> {
  const queue = getEmbeddingQueue();
  if (queue) {
    await queue.pause();
    serverLog.info('Embedding queue paused');
  }
}

/**
 * Resume the embedding queue
 */
export async function resumeEmbeddingQueue(): Promise<void> {
  const queue = getEmbeddingQueue();
  if (queue) {
    await queue.resume();
    serverLog.info('Embedding queue resumed');
  }
}

/**
 * Clean up old completed jobs
 */
export async function cleanupEmbeddingQueue(
  olderThan: number = 24 * 60 * 60 * 1000,
): Promise<void> {
  const queue = getEmbeddingQueue();
  if (!queue) return;

  const cutoff = Date.now() - olderThan;
  await queue.clean(cutoff, 100, 'completed');
  serverLog.info({ olderThan }, 'Embedding queue cleaned up');
}

/**
 * Retry failed jobs
 */
export async function retryFailedEmbeddingJobs(): Promise<number> {
  const queue = getEmbeddingQueue();
  if (!queue) return 0;

  const failedJobs = await queue.getFailed();
  let retried = 0;

  for (const job of failedJobs) {
    try {
      await job.retry();
      retried++;
    } catch (err) {
      serverLog.error({ jobId: job.id, err }, 'Failed to retry embedding job');
    }
  }

  serverLog.info({ retried, total: failedJobs.length }, 'Retried failed embedding jobs');
  return retried;
}

/**
 * Close the embedding queue connection
 */
export async function closeEmbeddingQueue(): Promise<void> {
  if (embeddingQueue) {
    await embeddingQueue.close();
    embeddingQueue = null;
    serverLog.info('Embedding queue closed');
  }
}

// Export the queue instance getter for advanced use cases
export { embeddingQueue as embeddingQueueInstance };
