/**
 * Worker for embedding generation
 * For now, stub implementation that returns mock embeddings
 * Real embedding service will be implemented later
 */

import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, type EmbeddingJobData, type EmbeddingJobResult } from '../types';
import { serverLog } from '../../logger';

// ============================================================================
// Worker State
// ============================================================================

let embeddingWorker: Worker<EmbeddingJobData, EmbeddingJobResult> | null = null;

// Mock embedding dimensions (matches common embedding models like text-embedding-3-small)
const MOCK_DIMENSIONS = 1536;

// ============================================================================
// Worker Setup
// ============================================================================

export interface EmbeddingWorkerOptions {
  concurrency?: number;
  // Will be used when real embedding service is implemented
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
        concurrency: options.concurrency ?? 2, // Lower concurrency for GPU/memory intensive ops
      },
    );

    embeddingWorker.on('completed', (job, result) => {
      serverLog.debug(
        {
          jobId: job.id,
          contentId: job.data.contentId,
          contentType: job.data.contentType,
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

    serverLog.info(
      { concurrency: options.concurrency ?? 2 },
      'Embedding worker started (stub mode)',
    );
    return embeddingWorker;
  } catch (err) {
    serverLog.error({ err }, 'Failed to create embedding worker');
    return null;
  }
}

// ============================================================================
// Job Processing
// ============================================================================

async function processEmbeddingJob(job: Job<EmbeddingJobData>): Promise<EmbeddingJobResult> {
  const { content, contentId, contentType, filePath, startLine, endLine, metadata } = job.data;

  serverLog.info(
    {
      jobId: job.id,
      contentId,
      contentType,
      filePath,
      contentLength: content.length,
    },
    'Processing embedding job',
  );

  try {
    // Update progress
    await job.updateProgress(10);

    // Validate input
    if (!content || content.length === 0) {
      throw new Error('Content is required for embedding generation');
    }

    if (!contentId) {
      throw new Error('Content ID is required');
    }

    await job.updateProgress(30);

    // TODO: Replace with real embedding service when available
    // For now, generate deterministic mock embeddings based on content hash
    const embedding = generateMockEmbedding(content);

    await job.updateProgress(80);

    // Simulate some processing time (would be API call in real implementation)
    await new Promise((resolve) => setTimeout(resolve, 100));

    await job.updateProgress(100);

    serverLog.debug(
      { jobId: job.id, contentId, dimensions: embedding.length },
      'Embedding generated',
    );

    return {
      success: true,
      embedding,
      dimensions: embedding.length,
    };
  } catch (error: any) {
    serverLog.error(
      { jobId: job.id, contentId, error: error.message },
      'Embedding generation error',
    );

    return {
      success: false,
      error: error.message ?? 'Unknown error during embedding generation',
    };
  }
}

/**
 * Generate a deterministic mock embedding based on content hash
 * This ensures the same content always produces the same embedding
 */
function generateMockEmbedding(content: string): number[] {
  // Simple hash function for deterministic pseudo-random numbers
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Use the hash as a seed for a simple PRNG
  let seed = Math.abs(hash) || 1;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  // Generate embedding vector with some content-based variation
  const embedding: number[] = [];
  const contentLengthNorm = Math.min(content.length / 1000, 1); // Normalize content length influence

  for (let i = 0; i < MOCK_DIMENSIONS; i++) {
    // Generate values between -1 and 1 with some structure
    let value = (random() * 2 - 1) * 0.5; // Base random value

    // Add some content-length based bias for variety
    if (i < 10) {
      value += contentLengthNorm * (random() * 0.3);
    }

    // Normalize to unit vector (approximately)
    embedding.push(value);
  }

  // Normalize the vector
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  return embedding.map((val) => val / magnitude);
}

/**
 * Calculate cosine similarity between two embeddings (for testing)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Embeddings must have same dimensions');
  }

  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }

  return dotProduct; // Already normalized, so this is the cosine similarity
}

// ============================================================================
// Worker Control
// ============================================================================

/**
 * Pause the embedding worker
 */
export async function pauseEmbeddingWorker(): Promise<void> {
  if (embeddingWorker) {
    await embeddingWorker.pause();
    serverLog.info('Embedding worker paused');
  }
}

/**
 * Resume the embedding worker
 */
export async function resumeEmbeddingWorker(): Promise<void> {
  if (embeddingWorker) {
    await embeddingWorker.resume();
    serverLog.info('Embedding worker resumed');
  }
}

/**
 * Get worker status
 */
export function getEmbeddingWorkerStatus(): {
  running: boolean;
  concurrency: number;
  isStub: boolean;
} {
  return {
    running: embeddingWorker !== null,
    concurrency: embeddingWorker?.opts?.concurrency ?? 0,
    isStub: true, // Indicates this is a stub implementation
  };
}

/**
 * Close the embedding worker
 */
export async function closeEmbeddingWorker(): Promise<void> {
  if (embeddingWorker) {
    await embeddingWorker.close();
    embeddingWorker = null;
    serverLog.info('Embedding worker closed');
  }
}

/**
 * Check if the embedding service is ready
 * (Will be used when real service is implemented)
 */
export function isEmbeddingServiceReady(): boolean {
  // Stub always returns true
  return true;
}

// Export the worker instance for advanced use cases
export { embeddingWorker as embeddingWorkerInstance };
