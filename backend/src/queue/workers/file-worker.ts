/**
 * Worker for file operations
 * Should handle all file operations from FileJobData
 */

import { Worker, Job } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, type FileJobData, type FileJobResult } from '../types';
import { serverLog, toolLog } from '../../logger';
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// ============================================================================
// Worker State
// ============================================================================

let fileWorker: Worker<FileJobData, FileJobResult> | null = null;

// ============================================================================
// Worker Setup
// ============================================================================

export interface FileWorkerOptions {
  concurrency?: number;
  projectRoot?: string;
}

export function createFileWorker(
  options: FileWorkerOptions = {},
): Worker<FileJobData, FileJobResult> | null {
  if (fileWorker) {
    serverLog.warn('File worker already exists, returning existing instance');
    return fileWorker;
  }

  const connection = getRedisConnection();

  if (!connection) {
    serverLog.warn('Redis not available, file worker disabled');
    return null;
  }

  try {
    fileWorker = new Worker<FileJobData, FileJobResult>(
      QUEUE_NAMES.FILE,
      (job) => processFileJob(job, options.projectRoot),
      {
        connection,
        concurrency: options.concurrency ?? 5,
      },
    );

    fileWorker.on('completed', (job, result) => {
      serverLog.debug(
        {
          jobId: job.id,
          operation: job.data.operation,
          path: job.data.path,
          success: result.success,
        },
        'File job completed',
      );
    });

    fileWorker.on('failed', (job, err) => {
      serverLog.error(
        {
          jobId: job?.id,
          operation: job?.data?.operation,
          path: job?.data?.path,
          error: err.message,
        },
        'File job failed',
      );
    });

    fileWorker.on('progress', (job, progress) => {
      serverLog.debug({ jobId: job.id, progress }, 'File job progress');
    });

    fileWorker.on('error', (err) => {
      serverLog.error({ error: err.message }, 'File worker error');
    });

    serverLog.info({ concurrency: options.concurrency ?? 5 }, 'File worker started');
    return fileWorker;
  } catch (err) {
    serverLog.error({ err }, 'Failed to create file worker');
    return null;
  }
}

// ============================================================================
// Job Processing
// ============================================================================

async function processFileJob(
  job: Job<FileJobData>,
  projectRoot: string = process.cwd(),
): Promise<FileJobResult> {
  const { operation, path, content, recursive, sessionId } = job.data;

  serverLog.info({ jobId: job.id, operation, path, sessionId }, 'Processing file job');

  try {
    // Validate path is within project root (security check)
    const resolvedPath = resolve(path);
    const resolvedRoot = resolve(projectRoot);

    if (!resolvedPath.startsWith(resolvedRoot)) {
      throw new Error('Path is outside project root');
    }

    await job.updateProgress(10);

    switch (operation) {
      case 'read':
        return await handleRead(resolvedPath, job);
      case 'write':
        return await handleWrite(resolvedPath, content, job);
      case 'delete':
        return await handleDelete(resolvedPath, job);
      case 'index':
        return await handleIndex(resolvedPath, recursive ?? true, job);
      case 'search':
        return await handleSearch(resolvedPath, job);
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  } catch (error: any) {
    toolLog.error({ jobId: job.id, operation, path, error: error.message }, 'File operation error');
    return {
      success: false,
      error: error.message ?? 'Unknown error',
    };
  }
}

async function handleRead(filePath: string, job: Job<FileJobData>): Promise<FileJobResult> {
  await job.updateProgress(30);

  if (!existsSync(filePath)) {
    return { success: false, error: 'File not found' };
  }

  const stats = statSync(filePath);
  if (stats.isDirectory()) {
    return { success: false, error: 'Path is a directory, not a file' };
  }

  await job.updateProgress(50);

  const content = readFileSync(filePath, 'utf-8');

  await job.updateProgress(100);

  return {
    success: true,
    content,
  };
}

async function handleWrite(
  filePath: string,
  content: string | undefined,
  job: Job<FileJobData>,
): Promise<FileJobResult> {
  if (content === undefined) {
    return { success: false, error: 'Content is required for write operation' };
  }

  await job.updateProgress(30);

  // Ensure directory exists using Bun
  const dir = join(filePath, '..');
  try {
    await Bun.write(join(dir, '.mkdir-check'), '');
    // Clean up the test file
    try {
      unlinkSync(join(dir, '.mkdir-check'));
    } catch {
      // Ignore cleanup errors
    }
  } catch {
    // Directory might already exist
  }

  await job.updateProgress(60);

  writeFileSync(filePath, content, 'utf-8');

  await job.updateProgress(100);

  return { success: true };
}

async function handleDelete(filePath: string, job: Job<FileJobData>): Promise<FileJobResult> {
  await job.updateProgress(30);

  if (!existsSync(filePath)) {
    return { success: false, error: 'File not found' };
  }

  await job.updateProgress(60);

  unlinkSync(filePath);

  await job.updateProgress(100);

  return { success: true };
}

/**
 * Recursively list all files in a directory
 */
async function listFilesRecursive(
  dirPath: string,
  files: string[] = [],
  ignorePatterns: string[] = ['node_modules', '.git', '.koryphaios'],
): Promise<string[]> {
  if (!existsSync(dirPath)) return files;

  const stats = statSync(dirPath);
  if (!stats.isDirectory()) {
    files.push(dirPath);
    return files;
  }

  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    // Skip ignored patterns
    if (
      ignorePatterns.some((pattern) => entry.name === pattern || fullPath.includes(`/${pattern}/`))
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      await listFilesRecursive(fullPath, files, ignorePatterns);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function handleIndex(
  dirPath: string,
  recursive: boolean,
  job: Job<FileJobData>,
): Promise<FileJobResult> {
  await job.updateProgress(20);

  if (!existsSync(dirPath)) {
    return { success: false, error: 'Directory not found' };
  }

  const stats = statSync(dirPath);
  if (!stats.isDirectory()) {
    return { success: false, error: 'Path is not a directory' };
  }

  await job.updateProgress(40);

  let files: string[] = [];

  if (recursive) {
    files = await listFilesRecursive(dirPath);
  } else {
    // Simple directory listing
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        files.push(join(dirPath, entry.name));
      }
    }
  }

  await job.updateProgress(100);

  return {
    success: true,
    files,
  };
}

async function handleSearch(filePath: string, job: Job<FileJobData>): Promise<FileJobResult> {
  await job.updateProgress(30);

  // For now, this is a simplified search that just lists files
  // In production, this would integrate with a search index
  if (!existsSync(filePath)) {
    return { success: false, error: 'Path not found' };
  }

  await job.updateProgress(60);

  const stats = statSync(filePath);
  let files: string[] = [];

  if (stats.isDirectory()) {
    files = await listFilesRecursive(filePath);
  } else {
    files = [filePath];
  }

  await job.updateProgress(100);

  return {
    success: true,
    files,
  };
}

// ============================================================================
// Worker Control
// ============================================================================

/**
 * Pause the file worker
 */
export async function pauseFileWorker(): Promise<void> {
  if (fileWorker) {
    await fileWorker.pause();
    serverLog.info('File worker paused');
  }
}

/**
 * Resume the file worker
 */
export async function resumeFileWorker(): Promise<void> {
  if (fileWorker) {
    await fileWorker.resume();
    serverLog.info('File worker resumed');
  }
}

/**
 * Get worker status
 */
export function getFileWorkerStatus(): {
  running: boolean;
  concurrency: number;
} {
  return {
    running: fileWorker !== null,
    concurrency: fileWorker?.opts?.concurrency ?? 0,
  };
}

/**
 * Close the file worker
 */
export async function closeFileWorker(): Promise<void> {
  if (fileWorker) {
    await fileWorker.close();
    fileWorker = null;
    serverLog.info('File worker closed');
  }
}

// Export the worker instance for advanced use cases
export { fileWorker as fileWorkerInstance };
