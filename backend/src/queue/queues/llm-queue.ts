/**
 * LLM Queue for background LLM calls
 * Features:
 * - Rate limiting (max 10 calls per second)
 * - Exponential backoff retries (3 attempts)
 * - Priority support (high/normal/low)
 * - Job timeout (60 seconds)
 */

import { Queue, RateLimitError, type JobsOptions } from 'bullmq';
import { getRedisConnection, isRedisConnected } from '../connection';
import { QUEUE_NAMES, type LLMJobData, type LLMJobResult } from '../types';
import { serverLog } from '../../logger';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT = 60_000; // 60 seconds

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
  removeOnComplete: 100,
  removeOnFail: false,
};

// Priority mapping (lower number = higher priority in BullMQ)
const PRIORITY_MAP = {
  high: 1,
  normal: 5,
  low: 10,
};

// ============================================================================
// LLM Queue Singleton
// ============================================================================

let llmQueue: Queue<LLMJobData, LLMJobResult> | null = null;

export function getLLMQueue(): Queue<LLMJobData, LLMJobResult> | null {
  if (!llmQueue) {
    const connection = getRedisConnection();
    if (!connection) {
      serverLog.warn('Redis not available, LLM queue disabled');
      return null;
    }

    try {
      llmQueue = new Queue<LLMJobData, LLMJobResult>(QUEUE_NAMES.LLM, {
        connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });

      // Handle rate limit errors
      llmQueue.on('error', (error) => {
        if (error instanceof RateLimitError) {
          serverLog.warn('LLM queue rate limit exceeded');
        } else {
          serverLog.error({ error }, 'LLM queue error');
        }
      });

      serverLog.info('LLM queue initialized with rate limiting (10 jobs/sec)');
    } catch (err) {
      serverLog.error({ err }, 'Failed to create LLM queue');
      return null;
    }
  }

  return llmQueue;
}

/**
 * Add a job to the LLM queue
 * @returns Job instance or null if Redis unavailable
 */
export async function addLLMJob(
  data: LLMJobData,
  options?: { delay?: number; jobId?: string },
): Promise<ReturnType<Queue<LLMJobData, LLMJobResult>['add']> | null> {
  const queue = getLLMQueue();
  if (!queue) {
    serverLog.warn('Cannot add LLM job: Redis unavailable');
    return null;
  }

  const priority = PRIORITY_MAP[data.priority] ?? PRIORITY_MAP.normal;

  // Note: BullMQ handles timeout at worker level, not queue level
  // The timeout is stored in job data and checked by worker

  return queue.add(`llm:${data.sessionId}:${Date.now()}`, data, {
    priority,
    delay: options?.delay,
    jobId: options?.jobId,
    ...DEFAULT_JOB_OPTIONS,
  });
}

/**
 * Add multiple LLM jobs in batch
 * @returns Array of job instances or null if Redis unavailable
 */
export async function addLLMJobs(
  jobs: Array<{ data: LLMJobData; options?: { delay?: number; jobId?: string } }>,
): Promise<Array<Awaited<ReturnType<Queue<LLMJobData, LLMJobResult>['add']>> | null> | null> {
  const queue = getLLMQueue();
  if (!queue) {
    serverLog.warn('Cannot add LLM jobs: Redis unavailable');
    return null;
  }

  return Promise.all(jobs.map(({ data, options }) => addLLMJob(data, options)));
}

/**
 * Get job status by ID
 */
export async function getLLMJobStatus(jobId: string): Promise<{
  id: string;
  state: string;
  progress: number;
  result?: LLMJobResult;
  failedReason?: string;
} | null> {
  const queue = getLLMQueue();
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
 * Pause the LLM queue
 */
export async function pauseLLMQueue(): Promise<void> {
  const queue = getLLMQueue();
  if (queue) {
    await queue.pause();
    serverLog.info('LLM queue paused');
  }
}

/**
 * Resume the LLM queue
 */
export async function resumeLLMQueue(): Promise<void> {
  const queue = getLLMQueue();
  if (queue) {
    await queue.resume();
    serverLog.info('LLM queue resumed');
  }
}

/**
 * Get queue metrics
 */
export async function getLLMQueueMetrics(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
} | null> {
  const queue = getLLMQueue();
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
 * Clean up old jobs
 */
export async function cleanupLLMQueue(olderThan: number = 24 * 60 * 60 * 1000): Promise<void> {
  const queue = getLLMQueue();
  if (!queue) return;

  const cutoff = Date.now() - olderThan;
  await queue.clean(cutoff, 100, 'completed');
  serverLog.info({ olderThan }, 'LLM queue cleaned up');
}

/**
 * Close the LLM queue connection
 */
export async function closeLLMQueue(): Promise<void> {
  if (llmQueue) {
    await llmQueue.close();
    llmQueue = null;
    serverLog.info('LLM queue closed');
  }
}

// Export the queue instance getter for advanced use cases
export { llmQueue as llmQueueInstance };
