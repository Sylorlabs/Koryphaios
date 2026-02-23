// OpenTelemetry monitoring and observability.
// Provides distributed tracing, metrics, and logging integration.

import { trace, context, SpanStatusCode, SpanKind, type Attributes, type Span } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Resource } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION, SEMRESATTRS_DEPLOYMENT_ENVIRONMENT } from "@opentelemetry/semantic-conventions";

import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { serverLog } from "../logger";



let tracerInitialized = false;

/**
 * Initialize OpenTelemetry tracing.
 * Call this during application startup.
 */
export function initTelemetry(config: {
    enabled: boolean;
    serviceName?: string;
    environment?: string;
    otlpEndpoint?: string;
}): void {
    if (!config.enabled) {
        serverLog.info("OpenTelemetry disabled");
        return;
    }

    if (tracerInitialized) {
        serverLog.warn("OpenTelemetry already initialized");
        return;
    }

    try {
        const resource = Resource.default().merge(
            new Resource({
                [SEMRESATTRS_SERVICE_NAME]: config.serviceName || "koryphaios",
                [SEMRESATTRS_SERVICE_VERSION]: process.env.npm_package_version || "1.0.0",
                [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: config.environment || process.env.NODE_ENV || "production",
            })
        );



        const provider = new NodeTracerProvider({
            resource,
        });

        // Configure exporter
        let exporter;
        if (config.otlpEndpoint) {
            exporter = new OTLPTraceExporter({
                url: config.otlpEndpoint,
            });
            serverLog.info({ endpoint: config.otlpEndpoint }, "OpenTelemetry OTLP exporter configured");
        } else {
            // Console exporter for development
            serverLog.info("OpenTelemetry running in console mode (no OTLP endpoint configured)");
        }

        if (exporter) {
            provider.addSpanProcessor(
                new (require("@opentelemetry/sdk-trace-node").BatchSpanProcessor)(exporter)
            );
        }

        provider.register();

        // Register HTTP instrumentation
        registerInstrumentations({
            instrumentations: [
                new HttpInstrumentation({
                    applyCustomAttributesOnSpan: (span: Span) => {
                        // Add custom attributes to HTTP spans
                        span.setAttribute("custom.attribute", "value");
                    },
                }),
            ],
        });

        tracerInitialized = true;
        serverLog.info("OpenTelemetry initialized successfully");
    } catch (error) {
        serverLog.error({ error }, "Failed to initialize OpenTelemetry");
    }
}

/**
 * Get a tracer for creating spans.
 */
export function getTracer(name: string = "koryphaios") {
    return trace.getTracer(name);
}

/**
 * Wrap an async function with a span.
 */
export async function withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: {
        attributes?: Attributes;
        kind?: SpanKind;
    }
): Promise<T> {
    const tracer = getTracer();
    const span = tracer.startSpan(name, {
        kind: options?.kind,
        attributes: options?.attributes,
    });

    try {
        context.with(trace.setSpan(context.active(), span), async () => {
            const result = await fn(span);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
        });
        return context.with(trace.setSpan(context.active(), span), () => fn(span));
    } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error).message,
        });
        throw error;
    } finally {
        span.end();
    }
}

/**
 * Create a child span manually.
 */
export function createSpan(name: string, parentSpan?: Span) {
    const tracer = getTracer();
    return tracer.startSpan(name, {}, parentSpan ? trace.setSpan(context.active(), parentSpan) : undefined);
}

/**
 * Add attributes to the current span.
 */
export function setSpanAttributes(attributes: Attributes): void {
    const span = trace.getActiveSpan();
    if (span) {
        span.setAttributes(attributes);
    }
}

/**
 * Add an event to the current span.
 */
export function addSpanEvent(name: string, attributes?: Attributes): void {
    const span = trace.getActiveSpan();
    if (span) {
        span.addEvent(name, attributes);
    }
}

/**
 * Record an exception in the current span.
 */
export function recordException(error: Error): void {
    const span = trace.getActiveSpan();
    if (span) {
        span.recordException(error);
    }
}

/**
 * Set the status of the current span.
 */
export function setSpanStatus(code: SpanStatusCode, message?: string): void {
    const span = trace.getActiveSpan();
    if (span) {
        span.setStatus({ code, message });
    }
}

/**
 * Metrics recorder for custom metrics.
 */
export class MetricsRecorder {
    private counters = new Map<string, number>();
    private gauges = new Map<string, number>();
    private histograms = new Map<string, number[]>();

    increment(name: string, value: number = 1, attributes?: Record<string, unknown>): void {
        const current = this.counters.get(name) || 0;
        this.counters.set(name, current + value);

        // Also log to span if available
        addSpanEvent(`metric.${name}`, {
            value: current + value,
            type: "counter",
            ...attributes
        });
    }

    set(name: string, value: number, attributes?: Record<string, unknown>): void {
        this.gauges.set(name, value);

        addSpanEvent(`metric.${name}`, {
            value,
            type: "gauge",
            ...attributes
        });
    }

    record(name: string, value: number, attributes?: Record<string, unknown>): void {
        const values = this.histograms.get(name) || [];
        values.push(value);
        this.histograms.set(name, values);

        addSpanEvent(`metric.${name}`, {
            value,
            type: "histogram",
            ...attributes
        });
    }

    getCounter(name: string): number {
        return this.counters.get(name) || 0;
    }

    getGauge(name: string): number | undefined {
        return this.gauges.get(name);
    }

    getHistogram(name: string): number[] {
        return this.histograms.get(name) || [];
    }

    reset(): void {
        this.counters.clear();
        this.gauges.clear();
        this.histograms.clear();
    }
}

// Global metrics recorder
export const metrics = new MetricsRecorder();

/**
 * Performance measurement utility.
 */
export class PerformanceTimer {
    private startTime: number;
    private span?: ReturnType<typeof createSpan>;

    constructor(name: string, attributes?: Record<string, unknown>) {
        this.startTime = Date.now();
        this.span = createSpan(name);
        if (attributes && this.span) {
            this.span.setAttributes(attributes as Attributes);
        }

    }

    stop(): number {
        const duration = Date.now() - this.startTime;
        if (this.span) {
            this.span.setAttribute("duration_ms", duration);
            this.span.end();
        }
        return duration;
    }

    /**
     * Stop and record as a metric.
     */
    stopAndRecord(metricName: string): number {
        const duration = this.stop();
        metrics.record(metricName, duration);
        return duration;
    }
}

/**
 * Create a performance timer.
 */
export function startTimer(name: string, attributes?: Record<string, unknown>): PerformanceTimer {
    return new PerformanceTimer(name, attributes);
}
