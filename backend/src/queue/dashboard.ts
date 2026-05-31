/**
 * Bull Board dashboard setup
 * Mount at /admin/queues
 *
 * Note: Using a custom implementation since @bull-board requires Express/Fastify
 * This provides a lightweight dashboard that works with Bun's native HTTP server
 */

import { getLLMQueue, getLLMQueueMetrics } from './queues/llm-queue';
import { getFileQueue, getFileQueueMetrics } from './queues/file-queue';
import { getEmbeddingQueue, getEmbeddingQueueMetrics } from './queues/embedding-queue';
import { getLLMWorkerStatus } from './workers/llm-worker';
import { getFileWorkerStatus } from './workers/file-worker';
import { getEmbeddingWorkerStatus } from './workers/embedding-worker';
import { isRedisConnected } from './connection';
import { serverLog } from '../logger';

// ============================================================================
// Dashboard HTML Template
// ============================================================================

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Koryphaios Queue Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
    }
    .header {
      background: #1e293b;
      padding: 1.5rem 2rem;
      border-bottom: 1px solid #334155;
    }
    .header h1 {
      font-size: 1.5rem;
      color: #f8fafc;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      display: inline-block;
    }
    .status-connected { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
    .status-disconnected { background: #ef4444; }
    .container {
      padding: 2rem;
      max-width: 1400px;
      margin: 0 auto;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 1.5rem;
      border: 1px solid #334155;
      transition: border-color 0.2s;
    }
    .card:hover {
      border-color: #475569;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    .card-title {
      font-size: 1.125rem;
      font-weight: 600;
      color: #f8fafc;
    }
    .card-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-weight: 500;
    }
    .badge-active { background: #166534; color: #bbf7d0; }
    .badge-inactive { background: #991b1b; color: #fecaca; }
    .badge-stub { background: #854d0e; color: #fef08a; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 1rem;
      margin-top: 1rem;
    }
    .metric {
      background: #0f172a;
      padding: 1rem;
      border-radius: 8px;
      text-align: center;
    }
    .metric-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: #f8fafc;
    }
    .metric-label {
      font-size: 0.75rem;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 0.25rem;
    }
    .waiting { color: #f59e0b; }
    .active { color: #3b82f6; }
    .completed { color: #22c55e; }
    .failed { color: #ef4444; }
    .delayed { color: #a855f7; }
    .refresh-bar {
      background: #1e293b;
      padding: 1rem 2rem;
      border-bottom: 1px solid #334155;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .refresh-info {
      color: #94a3b8;
      font-size: 0.875rem;
    }
    .refresh-btn {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      transition: background 0.2s;
    }
    .refresh-btn:hover {
      background: #2563eb;
    }
    .error-state {
      text-align: center;
      padding: 3rem;
      color: #94a3b8;
    }
    .error-state h2 {
      color: #ef4444;
      margin-bottom: 0.5rem;
    }
    .info-text {
      font-size: 0.875rem;
      color: #94a3b8;
      margin-top: 0.5rem;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .animate-pulse {
      animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>
      <span class="status-indicator {{redisStatusClass}}"></span>
      Koryphaios Queue Dashboard
    </h1>
  </div>
  
  <div class="refresh-bar">
    <span class="refresh-info">{{redisInfo}}</span>
    <button class="refresh-btn" onclick="location.reload()">Refresh</button>
  </div>

  <div class="container">
    {{#if redisConnected}}
    <div class="grid">
      <!-- LLM Queue -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">🤖 LLM Queue</span>
          <span class="card-badge {{llm.badgeClass}}">{{llm.status}}</span>
        </div>
        <div class="info-text">Concurrency: {{llm.concurrency}} | Rate limit: 10/sec</div>
        <div class="metrics">
          <div class="metric">
            <div class="metric-value waiting">{{llm.metrics.waiting}}</div>
            <div class="metric-label">Waiting</div>
          </div>
          <div class="metric">
            <div class="metric-value active">{{llm.metrics.active}}</div>
            <div class="metric-label">Active</div>
          </div>
          <div class="metric">
            <div class="metric-value completed">{{llm.metrics.completed}}</div>
            <div class="metric-label">Completed</div>
          </div>
          <div class="metric">
            <div class="metric-value failed">{{llm.metrics.failed}}</div>
            <div class="metric-label">Failed</div>
          </div>
        </div>
        {{#if llm.metrics.delayed}}
        <div class="metrics" style="margin-top: 0.5rem;">
          <div class="metric">
            <div class="metric-value delayed">{{llm.metrics.delayed}}</div>
            <div class="metric-label">Delayed</div>
          </div>
        </div>
        {{/if}}
      </div>

      <!-- File Queue -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">📁 File Queue</span>
          <span class="card-badge {{file.badgeClass}}">{{file.status}}</span>
        </div>
        <div class="info-text">Concurrency: {{file.concurrency}} | Timeout: 5min</div>
        <div class="metrics">
          <div class="metric">
            <div class="metric-value waiting">{{file.metrics.waiting}}</div>
            <div class="metric-label">Waiting</div>
          </div>
          <div class="metric">
            <div class="metric-value active">{{file.metrics.active}}</div>
            <div class="metric-label">Active</div>
          </div>
          <div class="metric">
            <div class="metric-value completed">{{file.metrics.completed}}</div>
            <div class="metric-label">Completed</div>
          </div>
          <div class="metric">
            <div class="metric-value failed">{{file.metrics.failed}}</div>
            <div class="metric-label">Failed</div>
          </div>
        </div>
        {{#if file.metrics.delayed}}
        <div class="metrics" style="margin-top: 0.5rem;">
          <div class="metric">
            <div class="metric-value delayed">{{file.metrics.delayed}}</div>
            <div class="metric-label">Delayed</div>
          </div>
        </div>
        {{/if}}
      </div>

      <!-- Embedding Queue -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">🔍 Embedding Queue</span>
          <span class="card-badge {{embedding.badgeClass}}">{{embedding.status}}</span>
        </div>
        <div class="info-text">Concurrency: {{embedding.concurrency}} | Timeout: 2min | {{embedding.stubText}}</div>
        <div class="metrics">
          <div class="metric">
            <div class="metric-value waiting">{{embedding.metrics.waiting}}</div>
            <div class="metric-label">Waiting</div>
          </div>
          <div class="metric">
            <div class="metric-value active">{{embedding.metrics.active}}</div>
            <div class="metric-label">Active</div>
          </div>
          <div class="metric">
            <div class="metric-value completed">{{embedding.metrics.completed}}</div>
            <div class="metric-label">Completed</div>
          </div>
          <div class="metric">
            <div class="metric-value failed">{{embedding.metrics.failed}}</div>
            <div class="metric-label">Failed</div>
          </div>
        </div>
        {{#if embedding.metrics.delayed}}
        <div class="metrics" style="margin-top: 0.5rem;">
          <div class="metric">
            <div class="metric-value delayed">{{embedding.metrics.delayed}}</div>
            <div class="metric-label">Delayed</div>
          </div>
        </div>
        {{/if}}
      </div>
    </div>
    {{else}}
    <div class="error-state">
      <h2>⚠️ Redis Not Connected</h2>
      <p>The queue dashboard requires a Redis connection.</p>
      <p class="info-text">Please ensure Redis is running and configured correctly.</p>
    </div>
    {{/if}}
  </div>

  <script>
    // Auto-refresh every 10 seconds
    setTimeout(() => location.reload(), 10000);
  </script>
</body>
</html>`;

// ============================================================================
// Dashboard Data Types
// ============================================================================

interface DashboardData {
  redisConnected: boolean;
  redisStatusClass: string;
  redisInfo: string;
  llm: QueueCardData;
  file: QueueCardData;
  embedding: QueueCardData;
}

interface QueueCardData {
  status: string;
  badgeClass: string;
  concurrency: number;
  metrics: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  stubText?: string;
}

// ============================================================================
// Dashboard Service
// ============================================================================

class QueueDashboard {
  private data: DashboardData | null = null;
  private lastUpdate = 0;
  private readonly CACHE_TTL = 1000; // 1 second cache

  /**
   * Get current dashboard data
   */
  async getData(): Promise<DashboardData> {
    // Return cached data if fresh
    if (this.data && Date.now() - this.lastUpdate < this.CACHE_TTL) {
      return this.data;
    }

    const redisConnected = isRedisConnected();

    const [llmMetrics, fileMetrics, embeddingMetrics] = await Promise.all([
      getLLMQueueMetrics(),
      getFileQueueMetrics(),
      getEmbeddingQueueMetrics(),
    ]);

    const llmWorkerStatus = getLLMWorkerStatus();
    const fileWorkerStatus = getFileWorkerStatus();
    const embeddingWorkerStatus = getEmbeddingWorkerStatus();

    this.data = {
      redisConnected,
      redisStatusClass: redisConnected ? 'status-connected' : 'status-disconnected',
      redisInfo: redisConnected
        ? 'Redis connected • Auto-refresh every 10s'
        : 'Redis disconnected • Queues unavailable',
      llm: {
        status: llmWorkerStatus.running ? 'Active' : 'Inactive',
        badgeClass: llmWorkerStatus.running ? 'badge-active' : 'badge-inactive',
        concurrency: llmWorkerStatus.concurrency,
        metrics: llmMetrics ?? { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      },
      file: {
        status: fileWorkerStatus.running ? 'Active' : 'Inactive',
        badgeClass: fileWorkerStatus.running ? 'badge-active' : 'badge-inactive',
        concurrency: fileWorkerStatus.concurrency,
        metrics: fileMetrics ?? { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      },
      embedding: {
        status: embeddingWorkerStatus.running ? 'Active' : 'Inactive',
        badgeClass: embeddingWorkerStatus.running
          ? embeddingWorkerStatus.isStub
            ? 'badge-stub'
            : 'badge-active'
          : 'badge-inactive',
        concurrency: embeddingWorkerStatus.concurrency,
        metrics: embeddingMetrics ?? { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
        stubText: embeddingWorkerStatus.isStub ? 'Stub mode' : 'Live',
      },
    };

    this.lastUpdate = Date.now();
    return this.data;
  }

  /**
   * Render HTML dashboard
   */
  async renderHTML(): Promise<string> {
    const data = await this.getData();
    return this.renderTemplate(DASHBOARD_HTML, data);
  }

  /**
   * Get dashboard data as JSON
   */
  async getJSON(): Promise<Record<string, unknown>> {
    const data = await this.getData();
    return {
      redis: {
        connected: data.redisConnected,
      },
      queues: {
        llm: {
          status: data.llm.status,
          concurrency: data.llm.concurrency,
          metrics: data.llm.metrics,
        },
        file: {
          status: data.file.status,
          concurrency: data.file.concurrency,
          metrics: data.file.metrics,
        },
        embedding: {
          status: data.embedding.status,
          concurrency: data.embedding.concurrency,
          metrics: data.embedding.metrics,
          isStub: data.embedding.stubText === 'Stub mode',
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Simple template renderer
   */
  private renderTemplate(template: string, data: DashboardData): string {
    let html = template;

    // Replace simple variables
    html = html.replace(/\{\{redisConnected\}\}/g, data.redisConnected.toString());
    html = html.replace(/\{\{redisStatusClass\}\}/g, data.redisStatusClass);
    html = html.replace(/\{\{redisInfo\}\}/g, data.redisInfo);

    // Replace queue data
    html = this.replaceQueueData(html, 'llm', data.llm);
    html = this.replaceQueueData(html, 'file', data.file);
    html = this.replaceQueueData(html, 'embedding', data.embedding);

    // Handle conditionals
    if (data.redisConnected) {
      html = html.replace(/\{\{#if redisConnected\}\}/g, '');
      html = html.replace(/\{\{\/if\}\}/g, '');
    } else {
      // Remove the grid content if Redis is not connected
      const gridMatch = html.match(/\{\{#if redisConnected\}\}([\s\S]*?)\{\{\/if\}\}/);
      if (gridMatch) {
        html = html.replace(gridMatch[0], '');
      }
    }

    // Handle delayed metrics conditionals
    ['llm', 'file', 'embedding'].forEach((queueType) => {
      const metrics = (data as any)[queueType].metrics;
      const regex = new RegExp(
        `\\{\\{#if ${queueType}\\.metrics\\.delayed\\}\\}([\\s\\S]*?)\\{\\{/if\\}\\}`,
        'g',
      );
      const match = html.match(regex);
      if (match) {
        if (metrics.delayed > 0) {
          html = html.replace(match[0], match[1]);
        } else {
          html = html.replace(match[0], '');
        }
      }
    });

    return html;
  }

  private replaceQueueData(html: string, queueName: string, queueData: QueueCardData): string {
    const prefix = `{{${queueName}.`;

    html = html.replace(new RegExp(`${prefix}status}}`, 'g'), queueData.status);
    html = html.replace(new RegExp(`${prefix}badgeClass}}`, 'g'), queueData.badgeClass);
    html = html.replace(
      new RegExp(`${prefix}concurrency}}`, 'g'),
      queueData.concurrency.toString(),
    );
    html = html.replace(new RegExp(`${prefix}stubText}}`, 'g'), queueData.stubText ?? '');

    // Metrics
    html = html.replace(
      new RegExp(`${prefix}metrics\\.waiting}}`, 'g'),
      queueData.metrics.waiting.toString(),
    );
    html = html.replace(
      new RegExp(`${prefix}metrics\\.active}}`, 'g'),
      queueData.metrics.active.toString(),
    );
    html = html.replace(
      new RegExp(`${prefix}metrics\\.completed}}`, 'g'),
      queueData.metrics.completed.toString(),
    );
    html = html.replace(
      new RegExp(`${prefix}metrics\\.failed}}`, 'g'),
      queueData.metrics.failed.toString(),
    );
    html = html.replace(
      new RegExp(`${prefix}metrics\\.delayed}}`, 'g'),
      queueData.metrics.delayed.toString(),
    );

    return html;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let dashboard: QueueDashboard | null = null;

export function getDashboard(): QueueDashboard {
  if (!dashboard) {
    dashboard = new QueueDashboard();
  }
  return dashboard;
}

/**
 * Handle dashboard HTTP requests
 * Returns a Response object for Bun.serve
 */
export async function handleDashboardRequest(
  pathname: string,
  method: string,
): Promise<Response | null> {
  // Only handle dashboard routes
  if (!pathname.startsWith('/admin/queues')) {
    return null;
  }

  // Handle API endpoint for JSON data
  if (pathname === '/admin/queues/api' || pathname === '/admin/queues/api/') {
    const dash = getDashboard();
    const data = await dash.getJSON();
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
  }

  // Handle main dashboard page
  if (pathname === '/admin/queues' || pathname === '/admin/queues/') {
    const dash = getDashboard();
    const html = await dash.renderHTML();
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache',
      },
    });
  }

  return null;
}

/**
 * Initialize dashboard
 */
export function initDashboard(): void {
  serverLog.info('Queue dashboard initialized at /admin/queues');
}

// Export the class and singleton
export { QueueDashboard };
