# Koryphaios Redis Job Queue System (Phase 2.1)

A BullMQ-based job queue system for background processing of LLM calls, file operations, and embedding generation.

## Features

- **LLM Queue**: Rate-limited (10/sec) background LLM calls with priority support
- **File Queue**: Async file read/write/delete/index operations (5 min timeout)
- **Embedding Queue**: Code chunk embedding generation for RAG (2 min timeout)
- **Graceful Fallback**: Works without Redis (logs warning, returns null)
- **Dashboard**: Built-in web dashboard at `/admin/queues`

## Quick Start

### 1. Start Redis

```bash
# Using Docker
docker run -d -p 6379:6379 redis:7-alpine

# Or using Homebrew on macOS
brew install redis
brew services start redis
```

### 2. Configure Environment

Add to your `.env`:

```bash
REDIS_HOST=localhost
REDIS_PORT=6379
# REDIS_PASSWORD=your_password  # Optional
# REDIS_DB=0                     # Optional
```

### 3. Initialize in Server

```typescript
import { QueueService, createQueueService } from './queue';
import { ProviderRegistry } from './providers';

// In your main function:
const providers = new ProviderRegistry(config);

// Create and initialize queue service
const queueService = await createQueueService(providers, {
  llmWorkerConcurrency: 3,
  fileWorkerConcurrency: 5,
  embeddingWorkerConcurrency: 2,
  projectRoot: PROJECT_ROOT,
  enableDashboard: true,
});

// Check status
console.log(queueService.getStatus());
```

### 4. Add Dashboard Route

In `server.ts`, add to the fetch handler:

```typescript
import { handleDashboardRequest } from './queue';

// In the fetch handler:
const dashboardResponse = await handleDashboardRequest(url.pathname, method);
if (dashboardResponse) {
  // Add CORS headers if needed
  return dashboardResponse;
}
```

## Usage Examples

### Queue an LLM Job

```typescript
import { addLLMJob } from './queue';

const job = await addLLMJob({
  sessionId: 'session-123',
  prompt: 'Explain quantum computing',
  model: 'claude-3-5-sonnet',
  provider: 'anthropic',
  priority: 'normal',
  systemPrompt: 'You are a helpful assistant.',
  maxTokens: 1000,
  temperature: 0.7,
});

if (job) {
  console.log('Job queued:', job.id);

  // Check status later
  const status = await getLLMJobStatus(job.id as string);
  console.log(status?.state); // "waiting" | "active" | "completed" | "failed"
}
```

### Queue a File Operation

```typescript
import { addFileReadJob, addFileWriteJob, addDirectoryIndexJob } from './queue';

// Read file
await addFileReadJob('/path/to/file.ts', sessionId);

// Write file
await addFileWriteJob('/path/to/output.txt', 'Hello World', sessionId);

// Index directory
await addDirectoryIndexJob('/path/to/project', true, sessionId);
```

### Queue Embedding Generation

```typescript
import { addEmbeddingJob, addFileEmbeddingJobs } from './queue';

// Single embedding
await addEmbeddingJob({
  content: "function hello() { return 'world'; }",
  contentId: 'chunk-123',
  contentType: 'function',
  filePath: 'example.ts',
  startLine: 1,
  endLine: 3,
});

// Batch for file chunks
await addFileEmbeddingJobs('/path/to/file.ts', [
  { content: '...', contentId: 'chunk-1', startLine: 1, endLine: 10, contentType: 'function' },
  { content: '...', contentId: 'chunk-2', startLine: 12, endLine: 20, contentType: 'class' },
]);
```

## Queue Configuration

### Default Job Options

All queues use these defaults:

```typescript
{
  attempts: 3,                    // Retry 3 times
  backoff: {
    type: "exponential",
    delay: 2000,                 // Start with 2s delay
  },
  removeOnComplete: 100,         // Keep last 100 completed
  removeOnFail: false,           // Keep failed jobs for inspection
}
```

### LLM Queue Rate Limiting

The LLM queue is rate-limited at both queue and worker levels:

- **Queue level**: 10 jobs per second
- **Worker concurrency**: 3 concurrent jobs (configurable)

### Timeouts

- LLM jobs: 60 seconds (in job data, enforced by worker)
- File jobs: 5 minutes
- Embedding jobs: 2 minutes

## Dashboard

Access the dashboard at:

- `http://127.0.0.1:3001/admin/queues` if you are using the current default `config/app.config.json`
- `http://<configured-host>:<configured-port>/admin/queues` if your backend config differs

Features:

- Real-time queue metrics (waiting, active, completed, failed)
- Worker status
- Redis connection status
- Auto-refresh every 10 seconds

JSON API: `GET /admin/queues/api`

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   KoryManager   │────▶│   LLM Queue  │────▶│   LLM Worker    │
└─────────────────┘     └──────────────┘     └─────────────────┘
                               │                      │
                               ▼                      ▼
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   File Tools    │────▶│  File Queue  │────▶│  File Worker    │
└─────────────────┘     └──────────────┘     └─────────────────┘
                               │                      │
                               ▼                      ▼
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   RAG Indexer   │────▶│Embedding Q   │────▶│ Embedding Worker│
└─────────────────┘     └──────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │    Redis     │
                        └──────────────┘
```

## Worker Implementation

### LLM Worker

- Processes LLM calls via ProviderRegistry
- Tracks token usage
- Updates job progress (0-100%)
- Supports job cancellation
- Handles rate limits with exponential backoff

### File Worker

- Performs file read/write/delete operations
- Directory indexing with ignore patterns
- Validates paths are within project root (security)
- 5 minute timeout for large operations

### Embedding Worker

- Currently stub implementation (returns mock embeddings)
- Deterministic mock embeddings based on content hash
- Ready for integration with real embedding service
- Batch processing support

## Graceful Degradation

If Redis is unavailable:

1. Queue creation returns `null`
2. Job additions log warning and return `null`
3. Dashboard shows "Redis Not Connected"
4. Application continues to function without queue features

## API Reference

See `index.ts` for full exports:

- **Queues**: `getLLMQueue()`, `getFileQueue()`, `getEmbeddingQueue()`
- **Job Helpers**: `addLLMJob()`, `addFileReadJob()`, `addEmbeddingJob()`
- **Workers**: `createLLMWorker()`, `createFileWorker()`, `createEmbeddingWorker()`
- **Dashboard**: `handleDashboardRequest()`, `getDashboard()`
- **Service**: `QueueService`, `createQueueService()`

## Testing

Run a quick test:

```typescript
import { isQueueSystemAvailable, getLLMQueueMetrics } from './queue';

if (isQueueSystemAvailable()) {
  const metrics = await getLLMQueueMetrics();
  console.log('LLM Queue:', metrics);
}
```

## Troubleshooting

### Redis Connection Issues

```bash
# Test Redis connection
redis-cli ping
# Should return: PONG
```

### Queue Not Processing Jobs

1. Check Redis is running
2. Verify worker is created: `getLLMWorkerStatus()`
3. Check job state: `getLLMJobStatus(jobId)`

### Rate Limiting

If you see "LLM queue rate limit exceeded" warnings:

- This is expected behavior
- Jobs will be retried with exponential backoff
- Adjust `limiter` in queue config if needed
