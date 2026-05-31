/**
 * Worker that processes LLM jobs
 * Should:
 * - Call provider APIs
 * - Track token usage
 * - Update job progress
 * - Handle rate limits with backoff
 */

import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, type LLMJobData, type LLMJobResult } from '../types';
import { ProviderRegistry } from '../../providers';
import { serverLog, providerLog } from '../../logger';
import type { StreamRequest, ProviderMessage, ProviderEvent } from '../../providers/types';

// ============================================================================
// Worker State
// ============================================================================

let llmWorker: Worker<LLMJobData, LLMJobResult> | null = null;
let providerRegistry: ProviderRegistry | null = null;

// Track in-flight requests for cancellation
const inFlightRequests = new Map<string, AbortController>();

// ============================================================================
// Worker Setup
// ============================================================================

export interface LLMWorkerOptions {
  providerRegistry: ProviderRegistry;
  concurrency?: number;
}

export function createLLMWorker(
  options: LLMWorkerOptions,
): Worker<LLMJobData, LLMJobResult> | null {
  if (llmWorker) {
    serverLog.warn('LLM worker already exists, returning existing instance');
    return llmWorker;
  }

  providerRegistry = options.providerRegistry;
  const connection = getRedisConnection();

  if (!connection) {
    serverLog.warn('Redis not available, LLM worker disabled');
    return null;
  }

  try {
    llmWorker = new Worker<LLMJobData, LLMJobResult>(QUEUE_NAMES.LLM, processLLMJob, {
      connection,
      concurrency: options.concurrency ?? 3,
      // Rate limiting at worker level as well
      limiter: {
        max: 10,
        duration: 1000,
      },
    });

    llmWorker.on('completed', (job, result) => {
      serverLog.info(
        {
          jobId: job.id,
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
        },
        'LLM job completed',
      );
      inFlightRequests.delete(job.id as string);
    });

    llmWorker.on('failed', (job, err) => {
      serverLog.error({ jobId: job?.id, error: err.message }, 'LLM job failed');
      if (job) {
        inFlightRequests.delete(job.id as string);
      }
    });

    llmWorker.on('progress', (job, progress) => {
      serverLog.debug({ jobId: job.id, progress }, 'LLM job progress');
    });

    llmWorker.on('error', (err) => {
      serverLog.error({ error: err.message }, 'LLM worker error');
    });

    serverLog.info({ concurrency: options.concurrency ?? 3 }, 'LLM worker started');
    return llmWorker;
  } catch (err) {
    serverLog.error({ err }, 'Failed to create LLM worker');
    return null;
  }
}

// ============================================================================
// Job Processing
// ============================================================================

async function processLLMJob(job: Job<LLMJobData>): Promise<LLMJobResult> {
  const {
    sessionId,
    prompt,
    model,
    provider,
    systemPrompt,
    maxTokens,
    temperature,
    reasoningLevel,
    timeout,
  } = job.data;

  serverLog.info({ jobId: job.id, sessionId, model, provider }, 'Processing LLM job');

  // Create abort controller for this job
  const abortController = new AbortController();
  inFlightRequests.set(job.id as string, abortController);

  const startTime = Date.now();

  try {
    // Check for job cancellation
    if (await job.isFailed()) {
      throw new Error('Job was cancelled');
    }

    await job.updateProgress(10);

    // Get provider from registry
    if (!providerRegistry) {
      throw new Error('Provider registry not initialized');
    }

    const providerInstance = providerRegistry.get(provider as any);
    if (!providerInstance) {
      throw new Error(`Provider '${provider}' not found or not available`);
    }

    if (!providerInstance.isAvailable()) {
      throw new Error(`Provider '${provider}' is not available`);
    }

    await job.updateProgress(20);

    // Build request
    const messages: ProviderMessage[] = [{ role: 'user', content: prompt }];

    const request: StreamRequest = {
      model,
      messages,
      systemPrompt: systemPrompt ?? 'You are a helpful assistant.',
      maxTokens,
      temperature,
      reasoningLevel,
      signal: abortController.signal,
    };

    await job.updateProgress(30);

    // Call provider and collect response
    let content = '';
    let thinking = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let finishReason: string = 'stop';

    const stream = providerInstance.streamResponse(request);
    let lastProgressUpdate = Date.now();

    for await (const event of stream) {
      // Check for cancellation during processing
      if (abortController.signal.aborted) {
        throw new Error('Job was cancelled');
      }

      // Check if job was manually failed/cancelled
      const jobState = await job.getState();
      if (jobState === 'failed') {
        throw new Error('Job was cancelled externally');
      }

      switch (event.type) {
        case 'content_delta':
          if (event.content) {
            content += event.content;
          }
          break;
        case 'thinking_delta':
          if (event.thinking) {
            thinking += event.thinking;
          }
          break;
        case 'usage_update':
          if (typeof event.tokensIn === 'number') tokensIn = event.tokensIn;
          if (typeof event.tokensOut === 'number') tokensOut = event.tokensOut;
          break;
        case 'complete':
          if (event.finishReason) {
            finishReason = event.finishReason;
          }
          break;
        case 'error':
          throw new Error(event.error ?? 'Provider error');
      }

      // Update progress periodically (every 500ms)
      const now = Date.now();
      if (now - lastProgressUpdate > 500) {
        // Progress from 30% to 90% based on content length heuristic
        const progress = Math.min(30 + Math.floor(content.length / 100), 90);
        await job.updateProgress(progress);
        lastProgressUpdate = now;
      }
    }

    await job.updateProgress(100);

    const latencyMs = Date.now() - startTime;

    providerLog.info({ model, provider, tokensIn, tokensOut, latencyMs }, 'LLM call completed');

    return {
      content,
      thinking,
      tokensIn,
      tokensOut,
      latencyMs,
      model,
      finishReason,
    };
  } catch (error: any) {
    providerLog.error({ jobId: job.id, model, provider, error: error.message }, 'LLM job error');

    // Determine if this is a rate limit error
    if (
      error.message?.includes('rate limit') ||
      error.message?.includes('429') ||
      error.message?.includes('too many requests')
    ) {
      // Let BullMQ handle the retry with backoff
      throw error;
    }

    // Re-throw for BullMQ to handle retry
    throw error;
  } finally {
    inFlightRequests.delete(job.id as string);
  }
}

// ============================================================================
// Worker Control
// ============================================================================

/**
 * Cancel a running job by ID
 */
export async function cancelLLMJob(jobId: string): Promise<boolean> {
  const controller = inFlightRequests.get(jobId);
  if (controller) {
    controller.abort();
    inFlightRequests.delete(jobId);
    serverLog.info({ jobId }, 'LLM job cancelled');
    return true;
  }
  return false;
}

/**
 * Cancel all running jobs for a session
 */
export async function cancelLLMJobsForSession(sessionId: string): Promise<number> {
  let cancelled = 0;
  for (const [jobId, controller] of inFlightRequests.entries()) {
    // Note: This is a simplification. In production, you'd track sessionId per job
    controller.abort();
    inFlightRequests.delete(jobId);
    cancelled++;
  }
  serverLog.info({ sessionId, cancelled }, 'Cancelled LLM jobs for session');
  return cancelled;
}

/**
 * Pause the LLM worker
 */
export async function pauseLLMWorker(): Promise<void> {
  if (llmWorker) {
    await llmWorker.pause();
    serverLog.info('LLM worker paused');
  }
}

/**
 * Resume the LLM worker
 */
export async function resumeLLMWorker(): Promise<void> {
  if (llmWorker) {
    await llmWorker.resume();
    serverLog.info('LLM worker resumed');
  }
}

/**
 * Get worker status
 */
export function getLLMWorkerStatus(): {
  running: boolean;
  concurrency: number;
  inFlightJobs: number;
} {
  return {
    running: llmWorker !== null,
    concurrency: llmWorker?.opts?.concurrency ?? 0,
    inFlightJobs: inFlightRequests.size,
  };
}

/**
 * Close the LLM worker
 */
export async function closeLLMWorker(): Promise<void> {
  // Cancel all in-flight requests
  for (const [jobId, controller] of inFlightRequests.entries()) {
    controller.abort();
  }
  inFlightRequests.clear();

  if (llmWorker) {
    await llmWorker.close();
    llmWorker = null;
    providerRegistry = null;
    serverLog.info('LLM worker closed');
  }
}

// Export the worker instance for advanced use cases
export { llmWorker as llmWorkerInstance };
