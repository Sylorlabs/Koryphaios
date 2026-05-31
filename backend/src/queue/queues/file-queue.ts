/**
 * File operation queue
 * Features:
 * - File read/write/delete operations
 * - Directory indexing
 * - Background file search
 * - 5 minute timeout for large operations
 */

import { Queue, type JobsOptions } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, type FileJobData, type FileJobResult } from '../types';
import { serverLog } from '../../logger';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
  removeOnComplete: 50,
  removeOnFail: false,
};

// ============================================================================
// File Queue Singleton
// ============================================================================

let fileQueue: Queue<FileJobData, FileJobResult> | null = null;

export function getFileQueue(): Queue<FileJobData, FileJobResult> | null {
  if (!fileQueue) {
    const connection = getRedisConnection();
    if (!connection) {
      serverLog.warn('Redis not available, file queue disabled');
      return null;
    }

    try {
      fileQueue = new Queue<FileJobData, FileJobResult>(QUEUE_NAMES.FILE, {
        connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });

      fileQueue.on('error', (error) => {
        serverLog.error({ error }, 'File queue error');
      });

      serverLog.info('File queue initialized (5 min timeout)');
    } catch (err) {
      serverLog.error({ err }, 'Failed to create file queue');
      return null;
    }
  }

  return fileQueue;
}

/**
 * Add a file read job
 */
export async function addFileReadJob(
  path: string,
  sessionId?: string,
  options?: { jobId?: string; priority?: number },
): Promise<ReturnType<Queue<FileJobData, FileJobResult>['add']> | null> {
  const queue = getFileQueue();
  if (!queue) {
    serverLog.warn('Cannot add file read job: Redis unavailable');
    return null;
  }

  return queue.add(
    `file:read:${path}`,
    { operation: 'read', path, sessionId },
    {
      jobId: options?.jobId,
      priority: options?.priority ?? 5,
      ...DEFAULT_JOB_OPTIONS,
    },
  );
}

/**
 * Add a file write job
 */
export async function addFileWriteJob(
  path: string,
  content: string,
  sessionId?: string,
  options?: { jobId?: string; priority?: number },
): Promise<ReturnType<Queue<FileJobData, FileJobResult>['add']> | null> {
  const queue = getFileQueue();
  if (!queue) {
    serverLog.warn('Cannot add file write job: Redis unavailable');
    return null;
  }

  return queue.add(
    `file:write:${path}`,
    { operation: 'write', path, content, sessionId },
    {
      jobId: options?.jobId,
      priority: options?.priority ?? 3, // Higher priority for writes
      ...DEFAULT_JOB_OPTIONS,
    },
  );
}

/**
 * Add a file delete job
 */
export async function addFileDeleteJob(
  path: string,
  sessionId?: string,
  options?: { jobId?: string; priority?: number },
): Promise<ReturnType<Queue<FileJobData, FileJobResult>['add']> | null> {
  const queue = getFileQueue();
  if (!queue) {
    serverLog.warn('Cannot add file delete job: Redis unavailable');
    return null;
  }

  return queue.add(
    `file:delete:${path}`,
    { operation: 'delete', path, sessionId },
    {
      jobId: options?.jobId,
      priority: options?.priority ?? 3,
      ...DEFAULT_JOB_OPTIONS,
    },
  );
}

/**
 * Add a directory indexing job
 */
export async function addDirectoryIndexJob(
  path: string,
  recursive = true,
  sessionId?: string,
  options?: { jobId?: string; priority?: number; delay?: number },
): Promise<ReturnType<Queue<FileJobData, FileJobResult>['add']> | null> {
  const queue = getFileQueue();
  if (!queue) {
    serverLog.warn('Cannot add directory index job: Redis unavailable');
    return null;
  }

  return queue.add(
    `file:index:${path}`,
    { operation: 'index', path, recursive, sessionId },
    {
      jobId: options?.jobId,
      priority: options?.priority ?? 10, // Lower priority for indexing
      delay: options?.delay,
      ...DEFAULT_JOB_OPTIONS,
    },
  );
}

/**
 * Add a file search job
 */
export async function addFileSearchJob(
  path: string,
  sessionId?: string,
  options?: { jobId?: string; priority?: number },
): Promise<ReturnType<Queue<FileJobData, FileJobResult>['add']> | null> {
  const queue = getFileQueue();
  if (!queue) {
    serverLog.warn('Cannot add file search job: Redis unavailable');
    return null;
  }

  return queue.add(
    `file:search:${path}`,
    { operation: 'search', path, sessionId },
    {
      jobId: options?.jobId,
      priority: options?.priority ?? 5,
      ...DEFAULT_JOB_OPTIONS,
    },
  );
}

/**
 * Add a generic file job
 */
export async function addFileJob(
  data: FileJobData,
  options?: { jobId?: string; priority?: number; delay?: number },
): Promise<ReturnType<Queue<FileJobData, FileJobResult>['add']> | null> {
  const queue = getFileQueue();
  if (!queue) {
    serverLog.warn('Cannot add file job: Redis unavailable');
    return null;
  }

  return queue.add(`file:${data.operation}:${data.path}`, data, {
    jobId: options?.jobId,
    priority: options?.priority ?? 5,
    delay: options?.delay,
    ...DEFAULT_JOB_OPTIONS,
  });
}

/**
 * Get job status by ID
 */
export async function getFileJobStatus(jobId: string): Promise<{
  id: string;
  state: string;
  progress: number;
  result?: FileJobResult;
  failedReason?: string;
} | null> {
  const queue = getFileQueue();
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
 * Get queue metrics
 */
export async function getFileQueueMetrics(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
} | null> {
  const queue = getFileQueue();
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
 * Pause the file queue
 */
export async function pauseFileQueue(): Promise<void> {
  const queue = getFileQueue();
  if (queue) {
    await queue.pause();
    serverLog.info('File queue paused');
  }
}

/**
 * Resume the file queue
 */
export async function resumeFileQueue(): Promise<void> {
  const queue = getFileQueue();
  if (queue) {
    await queue.resume();
    serverLog.info('File queue resumed');
  }
}

/**
 * Clean up old jobs
 */
export async function cleanupFileQueue(olderThan: number = 24 * 60 * 60 * 1000): Promise<void> {
  const queue = getFileQueue();
  if (!queue) return;

  const cutoff = Date.now() - olderThan;
  await queue.clean(cutoff, 100, 'completed');
  serverLog.info({ olderThan }, 'File queue cleaned up');
}

/**
 * Close the file queue connection
 */
export async function closeFileQueue(): Promise<void> {
  if (fileQueue) {
    await fileQueue.close();
    fileQueue = null;
    serverLog.info('File queue closed');
  }
}

// Export the queue instance getter for advanced use cases
export { fileQueue as fileQueueInstance };
