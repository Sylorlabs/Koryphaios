/**
 * Queue Job Type Definitions
 */

import type { Job } from 'bullmq';
import type { WorkerDomain } from '@koryphaios/shared';

// ============================================================================
// LLM Queue
// ============================================================================

export interface LLMJobData {
  sessionId: string;
  prompt: string;
  model: string;
  provider: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningLevel?: string;
  priority: 'high' | 'normal' | 'low';
  timeout?: number;
}

export interface LLMJobResult {
  content: string;
  thinking?: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  model: string;
  finishReason: string;
}

export type LLMJob = Job<LLMJobData, LLMJobResult>;

// ============================================================================
// File Queue
// ============================================================================

export interface FileJobData {
  operation: 'read' | 'write' | 'delete' | 'index' | 'search';
  path: string;
  content?: string;
  recursive?: boolean;
  sessionId?: string;
}

export interface FileJobResult {
  success: boolean;
  content?: string;
  error?: string;
  files?: string[];
}

export type FileJob = Job<FileJobData, FileJobResult>;

// ============================================================================
// Embedding Queue (for RAG)
// ============================================================================

export interface EmbeddingJobData {
  content: string;
  contentId: string;
  contentType: 'file' | 'function' | 'class' | 'text';
  filePath?: string;
  startLine?: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
}

export interface EmbeddingJobResult {
  success: boolean;
  embedding?: number[];
  dimensions?: number;
  error?: string;
}

export type EmbeddingJob = Job<EmbeddingJobData, EmbeddingJobResult>;

// ============================================================================
// Analysis Queue
// ============================================================================

export interface AnalysisJobData {
  type: 'critic' | 'summarize' | 'extract-symbols' | 'dependency-analysis';
  sessionId: string;
  content: string;
  context?: Record<string, unknown>;
  domain?: WorkerDomain;
}

export interface AnalysisJobResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export type AnalysisJob = Job<AnalysisJobData, AnalysisJobResult>;

// ============================================================================
// Job Status
// ============================================================================

export interface JobStatus {
  id: string;
  name: string;
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';
  progress: number;
  attempts: number;
  maxAttempts: number;
  data: unknown;
  result?: unknown;
  failedReason?: string;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
}

// ============================================================================
// Queue Names
// ============================================================================

export const QUEUE_NAMES = {
  LLM: 'llm',
  FILE: 'file',
  EMBEDDING: 'embedding',
  ANALYSIS: 'analysis',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
