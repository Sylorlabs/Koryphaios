// Provider Health Monitoring System
// Monitors provider availability, API health, and performance metrics.

import type { Provider } from "../providers/types";
import type { ProviderName, ModelDef } from "@koryphaios/shared";
import { getRedis } from "../state/redis-client";
import { metrics, startTimer } from "./telemetry";
import { serverLog } from "../logger";

export interface ProviderHealthStatus {
    provider: ProviderName;
    healthy: boolean;
    lastCheck: number;
    latency?: number;
    error?: string;
    modelsAvailable?: number;
    streamingSupported?: boolean;
}

export interface ProviderTestResult {
    provider: ProviderName;
    success: boolean;
    latency: number;
    error?: string;
    modelsTested?: number;
}

const HEALTH_CHECK_INTERVAL = 300_000; // 5 minutes
const HEALTH_CHECK_TIMEOUT = 10_000; // 10 seconds

/**
 * Provider Health Monitor
 * Tracks provider health and performance metrics.
 */
export class ProviderHealthMonitor {
    private readonly healthStatus = new Map<ProviderName, ProviderHealthStatus>();
    private readonly testResults = new Map<ProviderName, ProviderTestResult[]>();
    private checkInterval?: ReturnType<typeof setInterval>;

    constructor(private readonly providers: Map<ProviderName, Provider>) {
        // Start periodic health checks
        this.startPeriodicChecks();
    }

    /**
     * Start periodic health checks for all providers.
     */
    private startPeriodicChecks(): void {
        this.checkInterval = setInterval(() => {
            this.checkAllProviders().catch((err) => {
                serverLog.error({ err }, "Provider health check failed");
            });
        }, HEALTH_CHECK_INTERVAL);
    }

    /**
     * Stop periodic health checks.
     */
    stopPeriodicChecks(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = undefined;
        }
    }

    /**
     * Check health of a specific provider.
     */
    async checkProvider(providerName: ProviderName): Promise<ProviderHealthStatus> {
        const provider = this.providers.get(providerName);
        const startTime = Date.now();

        if (!provider) {
            const status: ProviderHealthStatus = {
                provider: providerName,
                healthy: false,
                lastCheck: startTime,
                error: "Provider not initialized",
            };
            this.healthStatus.set(providerName, status);
            return status;
        }

        try {
            // Check if provider is available (has credentials)
            const isAvailable = provider.isAvailable();
            if (!isAvailable) {
                const status: ProviderHealthStatus = {
                    provider: providerName,
                    healthy: false,
                    lastCheck: startTime,
                    error: "No credentials configured",
                };
                this.healthStatus.set(providerName, status);
                return status;
            }

            // Test API endpoint with timeout
            const testResult = await this.testApiEndpoint(provider);

            const latency = Date.now() - startTime;
            const status: ProviderHealthStatus = {
                provider: providerName,
                healthy: testResult.success,
                lastCheck: startTime,
                latency,
                error: testResult.error,
                modelsAvailable: testResult.modelsTested,
                streamingSupported: true, // Assume streaming is supported
            };

            this.healthStatus.set(providerName, status);

            // Record metrics
            if (testResult.success) {
                metrics.record(`provider.${providerName}.latency`, latency);
                metrics.record(`provider.${providerName}.healthy`, 1);
            } else {
                metrics.record(`provider.${providerName}.unhealthy`, 1);
            }

            return status;
        } catch (error: any) {
            const latency = Date.now() - startTime;
            const status: ProviderHealthStatus = {
                provider: providerName,
                healthy: false,
                lastCheck: startTime,
                latency,
                error: error.message || "Unknown error",
            };
            this.healthStatus.set(providerName, status);
            metrics.record(`provider.${providerName}.error`, 1);
            return status;
        }
    }

    /**
     * Test provider API endpoint.
     */
    async testApiEndpoint(provider: Provider): Promise<ProviderTestResult> {
        const timer = startTimer(`provider.${provider.name}.test`);
        const startTime = Date.now();

        try {
            // Try to list models (this is a lightweight API call)
            const models = await Promise.race([
                provider.listModels(),
                new Promise<ModelDef[]>((_, reject) =>
                    setTimeout(() => reject(new Error("Health check timeout")), HEALTH_CHECK_TIMEOUT)
                ),
            ]) as ModelDef[];

            const latency = Date.now() - startTime;

            return {
                provider: provider.name,
                success: true,
                latency,
                modelsTested: models.length,
            };
        } catch (error: any) {
            const latency = Date.now() - startTime;
            return {
                provider: provider.name,
                success: false,
                latency,
                error: error.message || "API test failed",
            };
        } finally {
            timer.stop();
        }
    }

    /**
     * Check health of all providers.
     */
    async checkAllProviders(): Promise<Map<ProviderName, ProviderHealthStatus>> {
        const results = new Map<ProviderName, ProviderHealthStatus>();

        for (const [name] of this.providers) {
            const status = await this.checkProvider(name);
            results.set(name, status);
        }

        // Cache results in Redis if available
        const redis = getRedis();
        if (redis) {
            try {
                const cacheData = JSON.stringify(Array.from(results.entries()));
                await redis.setex("provider:health", 300, cacheData); // Cache for 5 minutes
            } catch (err) {
                serverLog.warn({ err }, "Failed to cache provider health in Redis");
            }
        }

        return results;
    }

    /**
     * Get health status for all providers.
     */
    getAllHealthStatus(): Map<ProviderName, ProviderHealthStatus> {
        return new Map(this.healthStatus);
    }

    /**
     * Get health status for a specific provider.
     */
    getHealthStatus(providerName: ProviderName): ProviderHealthStatus | undefined {
        return this.healthStatus.get(providerName);
    }

    /**
     * Get only healthy providers.
     */
    getHealthyProviders(): ProviderName[] {
        const healthy: ProviderName[] = [];
        for (const [name, status] of this.healthStatus) {
            if (status.healthy) {
                healthy.push(name);
            }
        }
        return healthy;
    }

    /**
     * Get only unhealthy providers.
     */
    getUnhealthyProviders(): ProviderName[] {
        const unhealthy: ProviderName[] = [];
        for (const [name, status] of this.healthStatus) {
            if (!status.healthy) {
                unhealthy.push(name);
            }
        }
        return unhealthy;
    }

    /**
     * Get provider health summary.
     */
    getHealthSummary(): {
        total: number;
        healthy: number;
        unhealthy: number;
        unknown: number;
    } {
        let healthy = 0;
        let unhealthy = 0;
        let unknown = 0;

        for (const provider of this.providers.keys()) {
            const status = this.healthStatus.get(provider);
            if (!status) {
                unknown++;
            } else if (status.healthy) {
                healthy++;
            } else {
                unhealthy++;
            }
        }

        return {
            total: this.providers.size,
            healthy,
            unhealthy,
            unknown,
        };
    }

    /**
     * Record test result for a provider.
     */
    recordTestResult(result: ProviderTestResult): void {
        const results = this.testResults.get(result.provider) || [];
        results.push(result);

        // Keep only last 100 results per provider
        if (results.length > 100) {
            results.shift();
        }

        this.testResults.set(result.provider, results);
    }

    /**
     * Get test results for a provider.
     */
    getTestResults(providerName: ProviderName): ProviderTestResult[] {
        return this.testResults.get(providerName) || [];
    }

    /**
     * Get average latency for a provider.
     */
    getAverageLatency(providerName: ProviderName): number | null {
        const results = this.testResults.get(providerName);
        if (!results || results.length === 0) return null;

        const successfulResults = results.filter((r) => r.success);
        if (successfulResults.length === 0) return null;

        const total = successfulResults.reduce((sum, r) => sum + r.latency, 0);
        return total / successfulResults.length;
    }

    /**
     * Get success rate for a provider.
     */
    getSuccessRate(providerName: ProviderName): number {
        const results = this.testResults.get(providerName);
        if (!results || results.length === 0) return 0;

        const successful = results.filter((r) => r.success).length;
        return successful / results.length;
    }

    /**
     * Cleanup resources.
     */
    destroy(): void {
        this.stopPeriodicChecks();
        this.healthStatus.clear();
        this.testResults.clear();
    }
}

/**
 * Health check endpoint handler.
 * Returns health status for all providers.
 */
export async function getProviderHealthHandler(
    monitor: ProviderHealthMonitor,
): Promise<{
    summary: ReturnType<ProviderHealthMonitor["getHealthSummary"]>;
    providers: Record<string, ProviderHealthStatus>;
}> {
    const summary = monitor.getHealthSummary();
    const providersMap = monitor.getAllHealthStatus();

    const providers: Record<string, ProviderHealthStatus> = {};
    for (const [name, status] of providersMap) {
        providers[name] = status;
    }

    return {
        summary,
        providers,
    };
}

/**
 * Health check for a single provider.
 */
export async function getSingleProviderHealth(
    monitor: ProviderHealthMonitor,
    providerName: ProviderName,
): Promise<ProviderHealthStatus> {
    return await monitor.checkProvider(providerName);
}
