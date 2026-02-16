// Error handling utilities — Structured error types and recovery strategies

import { serverLog } from "./logger";

/**
 * Base error class with structured logging support
 */
export class KoryphaiosError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "KoryphaiosError";
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      context: this.context,
    };
  }
}

/**
 * Configuration errors (startup)
 */
export class ConfigError extends KoryphaiosError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "CONFIG_ERROR", 500, context);
    this.name = "ConfigError";
  }
}

/**
 * Validation errors (user input)
 */
export class ValidationError extends KoryphaiosError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 400, context);
    this.name = "ValidationError";
  }
}

/**
 * Provider errors (API failures)
 */
export class ProviderError extends KoryphaiosError {
  constructor(
    message: string,
    public readonly provider: string,
    context?: Record<string, unknown>,
  ) {
    super(message, "PROVIDER_ERROR", 502, { ...context, provider });
    this.name = "ProviderError";
  }
}

/**
 * Session errors (not found, etc.)
 */
export class SessionError extends KoryphaiosError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "SESSION_ERROR", 404, context);
    this.name = "SessionError";
  }
}

/**
 * Tool execution errors
 */
export class ToolExecutionError extends KoryphaiosError {
  constructor(
    message: string,
    public readonly toolName: string,
    context?: Record<string, unknown>,
  ) {
    super(message, "TOOL_EXECUTION_ERROR", 500, { ...context, toolName });
    this.name = "ToolExecutionError";
  }
}

/**
 * Rate limit errors
 */
export class RateLimitError extends KoryphaiosError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "RATE_LIMIT_ERROR", 429, context);
    this.name = "RateLimitError";
  }
}

type ErrorStackFrame = {
  functionName?: string;
  file?: string;
  line?: number;
  column?: number;
  raw: string;
};

type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  frames: ErrorStackFrame[];
  topFrame?: ErrorStackFrame;
  cause?: unknown;
};

function parseStackFrames(stack?: string): ErrorStackFrame[] {
  if (!stack) return [];
  const lines = stack.split("\n").slice(1);
  const frames: ErrorStackFrame[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    // Common Node/Bun formats:
    // at fn (/path/file.ts:10:20)
    // at /path/file.ts:10:20
    const withFn = /^at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/.exec(line);
    if (withFn) {
      frames.push({
        functionName: withFn[1],
        file: withFn[2],
        line: Number(withFn[3]),
        column: Number(withFn[4]),
        raw: line,
      });
      continue;
    }
    const noFn = /^at\s+(.+):(\d+):(\d+)$/.exec(line);
    if (noFn) {
      frames.push({
        file: noFn[1],
        line: Number(noFn[2]),
        column: Number(noFn[3]),
        raw: line,
      });
      continue;
    }
    frames.push({ raw: line });
  }

  return frames;
}

function selectTopProjectFrame(frames: ErrorStackFrame[]): ErrorStackFrame | undefined {
  return frames.find((f) => {
    const file = f.file ?? "";
    return file.includes("/backend/src/") || file.includes("/shared/src/") || file.includes("/frontend/src/");
  }) ?? frames[0];
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const frames = parseStackFrames(err.stack);
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      frames,
      topFrame: selectTopProjectFrame(frames),
      cause: (err as any).cause,
    };
  }
  return {
    name: "UnknownError",
    message: typeof err === "string" ? err : String(err),
    frames: [],
  };
}

/**
 * Error handler that logs and returns appropriate response
 */
export function handleError(err: unknown, context?: Record<string, unknown>): {
  message: string;
  code: string;
  statusCode: number;
} {
  const serialized = serializeError(err);

  if (err instanceof KoryphaiosError) {
    serverLog.error({
      code: err.code,
      message: serialized.message,
      context: { ...err.context, ...context },
      error: serialized,
    }, "Koryphaios error");
    
    return {
      message: err.message,
      code: err.code,
      statusCode: err.statusCode,
    };
  }

  if (err instanceof Error) {
    serverLog.error({
      message: serialized.message,
      context,
      error: serialized,
    }, "Unexpected error");
    
    return {
      message: "Internal server error",
      code: "INTERNAL_ERROR",
      statusCode: 500,
    };
  }

  serverLog.error({ err: serialized, context }, "Unknown error type");
  return {
    message: "Internal server error",
    code: "UNKNOWN_ERROR",
    statusCode: 500,
  };
}

/**
 * Safe async wrapper with error recovery
 */
export async function safeAsync<T>(
  operation: () => Promise<T>,
  fallback: T,
  context?: Record<string, unknown>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    handleError(err, context);
    return fallback;
  }
}

/**
 * File operation error handler
 */
export function handleFileError(err: unknown, path: string, operation: string): never {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    
    if (code === "ENOENT") {
      throw new KoryphaiosError(
        `File not found: ${path}`,
        "FILE_NOT_FOUND",
        404,
        { path, operation },
      );
    }
    
    if (code === "EACCES" || code === "EPERM") {
      throw new KoryphaiosError(
        `Permission denied: ${path}`,
        "FILE_PERMISSION_DENIED",
        403,
        { path, operation },
      );
    }
    
    if (code === "EEXIST") {
      throw new KoryphaiosError(
        `File already exists: ${path}`,
        "FILE_EXISTS",
        409,
        { path, operation },
      );
    }
  }

  throw new KoryphaiosError(
    `File operation failed: ${operation} on ${path}`,
    "FILE_ERROR",
    500,
    { path, operation, error: String(err) },
  );
}

/**
 * JSON parse with error handling
 */
export function safeJsonParse<T>(
  data: string,
  fallback: T,
  context?: Record<string, unknown>,
): T {
  try {
    return JSON.parse(data) as T;
  } catch (err) {
    serverLog.warn({ context, error: String(err) }, "JSON parse failed, using fallback");
    return fallback;
  }
}

/**
 * Correlation ID for request tracing
 */
let correlationIdCounter = 0;

export function generateCorrelationId(): string {
  return `kory-${Date.now()}-${++correlationIdCounter}`;
}
