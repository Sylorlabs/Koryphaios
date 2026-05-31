# Queue System Integration Guide

This guide shows how to integrate the Redis Job Queue system into the Koryphaios backend.

## Step 1: Import Queue System

In `server.ts`, add the import:

```typescript
// At the top of server.ts with other imports
import {
  QueueService,
  createQueueService,
  handleDashboardRequest,
  isQueueSystemAvailable,
} from './queue';
```

## Step 2: Initialize Queue Service

In the `main()` function, after initializing providers:

```typescript
// Initialize providers (existing code)
const providers = new ProviderRegistry(config);
await providers.initializeEncryptedCredentials();

// Initialize Queue Service (NEW)
let queueService: QueueService | undefined;
if (isQueueSystemAvailable()) {
  queueService = await createQueueService(providers, {
    llmWorkerConcurrency: 3,
    fileWorkerConcurrency: 5,
    embeddingWorkerConcurrency: 2,
    projectRoot: PROJECT_ROOT,
    enableDashboard: true,
  });

  const status = queueService.getStatus();
  serverLog.info({ queues: status.queues, workers: status.workers }, 'Queue service initialized');
} else {
  serverLog.warn('Redis unavailable - queue features disabled');
}
```

## Step 3: Add Dashboard Route

In the `fetch` handler, add the dashboard route handler:

```typescript
async fetch(req, server) {
  const url = new URL(req.url);
  const method = req.method;
  const origin = req.headers.get("origin");
  const requestId = generateCorrelationId();

  try {
    serverLog.debug({ requestId, method, path: url.pathname }, "Incoming request");

    // ... existing path validation and CORS code ...

    // === DASHBOARD ROUTE (NEW) ===
    const dashboardResponse = await handleDashboardRequest(url.pathname, method);
    if (dashboardResponse) {
      // Add CORS headers to dashboard response
      const headers = { ...dashboardResponse.headers };
      Object.entries(getCorsHeaders(origin)).forEach(([key, value]) => {
        if (!headers[key]) headers[key] = value;
      });
      return new Response(dashboardResponse.body, {
        status: dashboardResponse.status,
        headers,
      });
    }

    // ... rest of existing routes ...
  }
}
```

## Step 4: Use Queue in KoryManager

To make the queue service available to `KoryManager`, modify the KoryManager constructor:

In `kory/manager.ts`:

```typescript
import type { QueueService } from '../queue';

export class KoryManager {
  constructor(
    private providers: ProviderRegistry,
    private tools: ToolRegistry,
    private projectRoot: string,
    private config: KoryphaiosConfig,
    private sessions: SessionStore,
    private messages: MessageStore,
    private queueService?: QueueService, // Add optional parameter
  ) {}

  async processTask(sessionId: string, content: string, model?: string, reasoningLevel?: string) {
    // ... existing code ...

    // Option 1: Queue LLM calls (NEW)
    if (this.queueService) {
      const job = await this.queueService.addLLMJob({
        sessionId,
        prompt: content,
        model: selectedModel,
        provider: provider.name,
        systemPrompt: 'You are a helpful assistant.',
        priority: 'normal',
      });

      if (job) {
        serverLog.info({ jobId: job.id, sessionId }, 'LLM job queued');
        return;
      }
    }

    // Option 2: Direct processing (fallback)
    // ... existing direct processing code ...
  }
}
```

Then in `server.ts`:

```typescript
// Initialize Kory
const kory = new KoryManager(
  providers,
  tools,
  PROJECT_ROOT,
  config,
  sessions,
  messages,
  queueService, // Pass queue service
);
```

## Step 5: Graceful Shutdown

In the `gracefulShutdown` function, close the queue service:

```typescript
async function gracefulShutdown(signal: string) {
  // ... existing shutdown code ...

  // 5. Shut down pub/sub broker
  wsBroker.shutdown();

  // 5c. Close queue service (NEW)
  if (queueService) {
    await queueService.close();
    serverLog.info('Queue service closed');
  }

  // ... rest of shutdown code ...
}
```

## Alternative: Direct Queue Usage

If you prefer not to use the high-level `QueueService`, you can use queues directly:

```typescript
import { addLLMJob, getLLMJobStatus } from './queue';

// In your route handler or manager:
const job = await addLLMJob({
  sessionId: 'session-123',
  prompt: 'Hello',
  model: 'claude-3-5-sonnet',
  provider: 'anthropic',
  priority: 'high',
});

if (job) {
  // Poll for completion (or use WebSocket to notify client)
  setInterval(async () => {
    const status = await getLLMJobStatus(job.id as string);
    if (status?.state === 'completed') {
      console.log('Result:', status.result);
    }
  }, 1000);
}
```

## Testing the Integration

1. Start Redis:

   ```bash
   docker run -d -p 6379:6379 redis:7-alpine
   ```

2. Start the backend:

   ```bash
   bun run dev
   ```

3. Visit the dashboard:

   ```
   http://127.0.0.1:3001/admin/queues
   ```

4. Check the API:
   ```bash
   curl http://127.0.0.1:3001/admin/queues/api
   ```

## Monitoring

Add these to your health check endpoint:

```typescript
if (url.pathname === '/api/health') {
  return json(
    {
      ok: true,
      data: {
        version: VERSION,
        uptime: process.uptime(),
        providers: providers.getAvailable().length,
        wsClients: wsManager.clientCount,
        queueSystem: queueService?.getStatus() ?? null,
      },
    },
    200,
    corsHeaders,
  );
}
```

## Complete Integration Diff

Here's a summary of all changes needed in `server.ts`:

```diff
+ import {
+   QueueService,
+   createQueueService,
+   handleDashboardRequest,
+   isQueueSystemAvailable,
+ } from "./queue";

  async function main() {
    // ... existing initialization code ...

+   let queueService: QueueService | undefined;
+   if (isQueueSystemAvailable()) {
+     queueService = await createQueueService(providers, {
+       llmWorkerConcurrency: 3,
+       fileWorkerConcurrency: 5,
+       embeddingWorkerConcurrency: 2,
+       projectRoot: PROJECT_ROOT,
+     });
+   }

-   const kory = new KoryManager(providers, tools, PROJECT_ROOT, config, sessions, messages);
+   const kory = new KoryManager(providers, tools, PROJECT_ROOT, config, sessions, messages, queueService);

    // ... in fetch handler ...
+   const dashboardResponse = await handleDashboardRequest(url.pathname, method);
+   if (dashboardResponse) {
+     const headers = { ...dashboardResponse.headers };
+     Object.entries(getCorsHeaders(origin)).forEach(([key, value]) => {
+       if (!headers[key]) headers[key] = value;
+     });
+     return new Response(dashboardResponse.body, {
+       status: dashboardResponse.status,
+       headers,
+     });
+   }

    // ... in gracefulShutdown ...
+   if (queueService) {
+     await queueService.close();
+   }
  }
```
