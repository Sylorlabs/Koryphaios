/**
 * Public API exports
 * - Queue service class
 * - Factory functions
 * - Helper methods
 */

// ============================================================================
// Connection
// ============================================================================

export {
  getRedisConnection,
  isRedisConnected,
  closeRedisConnection,
  testRedisConnection,
  type RedisConfig,
} from './connection';

// ============================================================================
// Types
// ============================================================================

export {
  QUEUE_NAMES,
  type QueueName,
  type LLMJobData,
  type LLMJobResult,
  type LLMJob,
  type FileJobData,
  type FileJobResult,
  type FileJob,
  type EmbeddingJobData,
  type EmbeddingJobResult,
  type EmbeddingJob,
  type AnalysisJobData,
  type AnalysisJobResult,
  type AnalysisJob,
  type JobStatus,
} from './types';

// ============================================================================
// Queues
// ============================================================================

export {
  // LLM Queue
  getLLMQueue,
  addLLMJob,
  addLLMJobs,
  getLLMJobStatus,
  pauseLLMQueue,
  resumeLLMQueue,
  getLLMQueueMetrics,
  cleanupLLMQueue,
  closeLLMQueue,
  llmQueueInstance,
} from './queues/llm-queue';

export {
  // File Queue
  getFileQueue,
  addFileReadJob,
  addFileWriteJob,
  addFileDeleteJob,
  addDirectoryIndexJob,
  addFileSearchJob,
  addFileJob,
  getFileJobStatus,
  pauseFileQueue,
  resumeFileQueue,
  getFileQueueMetrics,
  cleanupFileQueue,
  closeFileQueue,
  fileQueueInstance,
} from './queues/file-queue';

export {
  // Embedding Queue
  getEmbeddingQueue,
  addEmbeddingJob,
  addEmbeddingBatch,
  addFileEmbeddingJobs,
  getEmbeddingJobStatus,
  getEmbeddingJobsByFile,
  pauseEmbeddingQueue,
  resumeEmbeddingQueue,
  getEmbeddingQueueMetrics,
  cleanupEmbeddingQueue,
  retryFailedEmbeddingJobs,
  closeEmbeddingQueue,
  embeddingQueueInstance,
} from './queues/embedding-queue';

// ============================================================================
// Workers
// ============================================================================

export {
  // LLM Worker
  createLLMWorker,
  cancelLLMJob,
  cancelLLMJobsForSession,
  pauseLLMWorker,
  resumeLLMWorker,
  getLLMWorkerStatus,
  closeLLMWorker,
  llmWorkerInstance,
  type LLMWorkerOptions,
} from './workers/llm-worker';

export {
  // File Worker
  createFileWorker,
  pauseFileWorker,
  resumeFileWorker,
  getFileWorkerStatus,
  closeFileWorker,
  fileWorkerInstance,
  type FileWorkerOptions,
} from './workers/file-worker';

export {
  // Embedding Worker
  createEmbeddingWorker,
  pauseEmbeddingWorker,
  resumeEmbeddingWorker,
  getEmbeddingWorkerStatus,
  isEmbeddingServiceReady,
  closeEmbeddingWorker,
  embeddingWorkerInstance,
  cosineSimilarity,
  type EmbeddingWorkerOptions,
} from './workers/embedding-worker';

// ============================================================================
// Dashboard
// ============================================================================

export { QueueDashboard, getDashboard, handleDashboardRequest, initDashboard } from './dashboard';

// ============================================================================
// Queue Service (High-level API)
// ============================================================================

import { ProviderRegistry } from '../providers';
import { serverLog } from '../logger';
import { isRedisConnected, closeRedisConnection } from './connection';

import { getLLMQueue, closeLLMQueue } from './queues/llm-queue';

import { getFileQueue, closeFileQueue } from './queues/file-queue';

import { getEmbeddingQueue, closeEmbeddingQueue } from './queues/embedding-queue';

import { createLLMWorker, closeLLMWorker, type LLMWorkerOptions } from './workers/llm-worker';

import { createFileWorker, closeFileWorker, type FileWorkerOptions } from './workers/file-worker';

import {
  createEmbeddingWorker,
  closeEmbeddingWorker,
  type EmbeddingWorkerOptions,
} from './workers/embedding-worker';

import { initDashboard } from './dashboard';

export interface QueueServiceOptions {
  providerRegistry: ProviderRegistry;
  llmWorkerConcurrency?: number;
  fileWorkerConcurrency?: number;
  embeddingWorkerConcurrency?: number;
  projectRoot?: string;
  enableDashboard?: boolean;
}

export interface QueueServiceStatus {
  redisConnected: boolean;
  queues: {
    llm: boolean;
    file: boolean;
    embedding: boolean;
  };
  workers: {
    llm: boolean;
    file: boolean;
    embedding: boolean;
  };
  dashboard: boolean;
}

/**
 * High-level Queue Service that manages all queues and workers
 *
 * Usage:
 * ```typescript
 * const queueService = new QueueService({
 *   providerRegistry,
 *   llmWorkerConcurrency: 3,
 *   fileWorkerConcurrency: 5,
 * });
 *
 * await queueService.initialize();
 *
 * // Add jobs...
 * await queueService.addLLMJob({ ... });
 *
 * // Cleanup
 * await queueService.close();
 * ```
 */
export class QueueService {
  private options: QueueServiceOptions;
  private initialized = false;

  constructor(options: QueueServiceOptions) {
    this.options = options;
  }

  /**
   * Initialize all queues and workers
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) {
      serverLog.warn('QueueService already initialized');
      return true;
    }

    // Check Redis connection
    if (!isRedisConnected()) {
      serverLog.warn('Redis not available, QueueService operating in degraded mode');
      return false;
    }

    try {
      // Initialize queues (they're lazy-loaded, just verify connectivity)
      const llmQueue = getLLMQueue();
      const fileQueue = getFileQueue();
      const embeddingQueue = getEmbeddingQueue();

      if (!llmQueue || !fileQueue || !embeddingQueue) {
        serverLog.warn('Some queues could not be initialized');
      }

      // Initialize workers
      createLLMWorker({
        providerRegistry: this.options.providerRegistry,
        concurrency: this.options.llmWorkerConcurrency,
      });

      createFileWorker({
        concurrency: this.options.fileWorkerConcurrency,
        projectRoot: this.options.projectRoot,
      });

      createEmbeddingWorker({
        concurrency: this.options.embeddingWorkerConcurrency,
      });

      // Initialize dashboard
      if (this.options.enableDashboard !== false) {
        initDashboard();
      }

      this.initialized = true;
      serverLog.info('QueueService initialized successfully');
      return true;
    } catch (err) {
      serverLog.error({ err }, 'Failed to initialize QueueService');
      return false;
    }
  }

  /**
   * Get current status of all queues and workers
   */
  getStatus(): QueueServiceStatus {
    return {
      redisConnected: isRedisConnected(),
      queues: {
        llm: getLLMQueue() !== null,
        file: getFileQueue() !== null,
        embedding: getEmbeddingQueue() !== null,
      },
      workers: {
        llm: this.getLLMWorkerStatus().running,
        file: this.getFileWorkerStatus().running,
        embedding: this.getEmbeddingWorkerStatus().running,
      },
      dashboard: this.options.enableDashboard !== false,
    };
  }

  /**
   * Check if service is healthy
   */
  isHealthy(): boolean {
    const status = this.getStatus();
    return (
      status.redisConnected && status.queues.llm && status.queues.file && status.queues.embedding
    );
  }

  /**
   * Close all queues and workers gracefully
   */
  async close(): Promise<void> {
    serverLog.info('Closing QueueService...');

    // Close workers first to stop processing
    await closeLLMWorker();
    await closeFileWorker();
    await closeEmbeddingWorker();

    // Close queues
    await closeLLMQueue();
    await closeFileQueue();
    await closeEmbeddingQueue();

    // Close Redis connection
    await closeRedisConnection();

    this.initialized = false;
    serverLog.info('QueueService closed');
  }

  // ==========================================================================
  // Convenience methods
  // ==========================================================================

  /**
   * Add a job to the LLM queue
   */
  async addLLMJob(data: import('./types').LLMJobData) {
    const { addLLMJob } = await import('./queues/llm-queue');
    return addLLMJob(data);
  }

  /**
   * Add a job to the file queue
   */
  async addFileJob(data: import('./types').FileJobData) {
    const { addFileJob } = await import('./queues/file-queue');
    return addFileJob(data);
  }

  /**
   * Add a job to the embedding queue
   */
  async addEmbeddingJob(data: import('./types').EmbeddingJobData) {
    const { addEmbeddingJob } = await import('./queues/embedding-queue');
    return addEmbeddingJob(data);
  }

  // ==========================================================================
  // Worker status helpers
  // ==========================================================================

  private getLLMWorkerStatus() {
    const { getLLMWorkerStatus } = require('./workers/llm-worker');
    return getLLMWorkerStatus();
  }

  private getFileWorkerStatus() {
    const { getFileWorkerStatus } = require('./workers/file-worker');
    return getFileWorkerStatus();
  }

  private getEmbeddingWorkerStatus() {
    const { getEmbeddingWorkerStatus } = require('./workers/embedding-worker');
    return getEmbeddingWorkerStatus();
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create and initialize a QueueService with default options
 */
export async function createQueueService(
  providerRegistry: ProviderRegistry,
  options: Partial<Omit<QueueServiceOptions, 'providerRegistry'>> = {},
): Promise<QueueService> {
  const service = new QueueService({
    providerRegistry,
    llmWorkerConcurrency: 3,
    fileWorkerConcurrency: 5,
    embeddingWorkerConcurrency: 2,
    enableDashboard: true,
    ...options,
  });

  await service.initialize();
  return service;
}

/**
 * Check if the queue system is available
 */
export function isQueueSystemAvailable(): boolean {
  return isRedisConnected();
}

// ============================================================================
// Re-export service types (already exported inline)
// ============================================================================

// Types are already exported via: export type { QueueServiceOptions, QueueServiceStatus }
