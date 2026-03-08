// Error taxonomy — consistent error handling across the codebase
// Each error type has a specific HTTP status code and structured output

/**
 * Base error class for all Koryphaios errors
 */
export class KoryphaiosError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    isOperational: boolean = true,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;
    
    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}

// ─── Authentication Errors (401) ─────────────────────────────────────────────

export class AuthenticationError extends KoryphaiosError {
  constructor(message: string = "Authentication required", details?: Record<string, unknown>) {
    super(message, "AUTH_REQUIRED", 401, true, details);
  }
}

export class InvalidTokenError extends KoryphaiosError {
  constructor(message: string = "Invalid or expired token", details?: Record<string, unknown>) {
    super(message, "INVALID_TOKEN", 401, true, details);
  }
}

export class SessionExpiredError extends KoryphaiosError {
  constructor(message: string = "Session has expired", details?: Record<string, unknown>) {
    super(message, "SESSION_EXPIRED", 401, true, details);
  }
}

// ─── Authorization Errors (403) ──────────────────────────────────────────────

export class AuthorizationError extends KoryphaiosError {
  constructor(message: string = "Access denied", details?: Record<string, unknown>) {
    super(message, "ACCESS_DENIED", 403, true, details);
  }
}

export class OwnershipError extends KoryphaiosError {
  constructor(resource: string, details?: Record<string, unknown>) {
    super(`You do not own this ${resource}`, "NOT_OWNER", 403, true, details);
  }
}

export class RateLimitError extends KoryphaiosError {
  public readonly retryAfter: number;

  constructor(retryAfter: number, details?: Record<string, unknown>) {
    super(
      `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
      "RATE_LIMITED",
      429,
      true,
      details
    );
    this.retryAfter = retryAfter;
  }
}

// ─── Validation Errors (400) ─────────────────────────────────────────────────

export class ValidationError extends KoryphaiosError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 400, true, details);
  }
}

export class InvalidInputError extends KoryphaiosError {
  constructor(field: string, reason: string, details?: Record<string, unknown>) {
    super(`Invalid ${field}: ${reason}`, "INVALID_INPUT", 400, true, { field, reason, ...details });
  }
}

export class MissingFieldError extends KoryphaiosError {
  constructor(field: string, details?: Record<string, unknown>) {
    super(`Missing required field: ${field}`, "MISSING_FIELD", 400, true, { field, ...details });
  }
}

export class MalformedJsonError extends KoryphaiosError {
  constructor(details?: Record<string, unknown>) {
    super("Invalid or malformed JSON in request body", "MALFORMED_JSON", 400, true, details);
  }
}

export class PayloadTooLargeError extends KoryphaiosError {
  constructor(maxSize: string, details?: Record<string, unknown>) {
    super(`Request body exceeds maximum size of ${maxSize}`, "PAYLOAD_TOO_LARGE", 413, true, details);
  }
}

// ─── Not Found Errors (404) ──────────────────────────────────────────────────

export class NotFoundError extends KoryphaiosError {
  constructor(resource: string, id?: string, details?: Record<string, unknown>) {
    super(
      id ? `${resource} not found: ${id}` : `${resource} not found`,
      "NOT_FOUND",
      404,
      true,
      { resource, id, ...details }
    );
  }
}

export class SessionNotFoundError extends NotFoundError {
  constructor(sessionId: string, details?: Record<string, unknown>) {
    super("Session", sessionId, details);
  }
}

export class ProviderNotFoundError extends NotFoundError {
  constructor(providerName: string, details?: Record<string, unknown>) {
    super("Provider", providerName, details);
  }
}

// ─── Conflict Errors (409) ───────────────────────────────────────────────────

export class ConflictError extends KoryphaiosError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CONFLICT", 409, true, details);
  }
}

export class DuplicateError extends KoryphaiosError {
  constructor(resource: string, field: string, value: string, details?: Record<string, unknown>) {
    super(
      `${resource} already exists with ${field}="${value}"`,
      "DUPLICATE",
      409,
      true,
      { resource, field, value, ...details }
    );
  }
}

// ─── Provider Errors (502/503) ───────────────────────────────────────────────

export class ProviderError extends KoryphaiosError {
  public readonly provider: string;
  public readonly retryable: boolean;

  constructor(
    provider: string,
    message: string,
    code: string = "PROVIDER_ERROR",
    statusCode: number = 502,
    retryable: boolean = false,
    details?: Record<string, unknown>
  ) {
    super(message, code, statusCode, true, { provider, ...details });
    this.provider = provider;
    this.retryable = retryable;
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(provider: string, details?: Record<string, unknown>) {
    super(provider, `Provider "${provider}" is unavailable`, "PROVIDER_UNAVAILABLE", 503, true, details);
  }
}

export class ProviderQuotaError extends ProviderError {
  constructor(provider: string, details?: Record<string, unknown>) {
    super(provider, `Provider "${provider}" quota exceeded`, "QUOTA_EXCEEDED", 429, true, details);
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(provider: string, details?: Record<string, unknown>) {
    super(provider, `Provider "${provider}" authentication failed`, "PROVIDER_AUTH_FAILED", 401, false, details);
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(provider: string, retryAfter?: number, details?: Record<string, unknown>) {
    super(
      provider,
      `Provider "${provider}" rate limit exceeded`,
      "PROVIDER_RATE_LIMITED",
      429,
      true,
      { retryAfter, ...details }
    );
  }
}

// ─── Internal Errors (500) ───────────────────────────────────────────────────

export class InternalError extends KoryphaiosError {
  constructor(message: string = "Internal server error", details?: Record<string, unknown>) {
    super(message, "INTERNAL_ERROR", 500, false, details);
  }
}

export class DatabaseError extends KoryphaiosError {
  constructor(operation: string, details?: Record<string, unknown>) {
    super(`Database operation failed: ${operation}`, "DATABASE_ERROR", 500, false, details);
  }
}

export class ConfigurationError extends KoryphaiosError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CONFIGURATION_ERROR", 500, false, details);
  }
}

export class EncryptionError extends KoryphaiosError {
  constructor(operation: string, details?: Record<string, unknown>) {
    super(`Encryption operation failed: ${operation}`, "ENCRYPTION_ERROR", 500, false, details);
  }
}

// ─── Circuit Breaker Errors ─────────────────────────────────────────────────

export class CircuitBreakerOpenError extends KoryphaiosError {
  public readonly circuitName: string;
  public readonly resetTime: number;

  constructor(circuitName: string, resetTime: number, details?: Record<string, unknown>) {
    super(
      `Circuit breaker "${circuitName}" is open. Resets at ${new Date(resetTime).toISOString()}`,
      "CIRCUIT_OPEN",
      503,
      true,
      { circuitName, resetTime, ...details }
    );
    this.circuitName = circuitName;
    this.resetTime = resetTime;
  }
}

// ─── Timeout Errors ─────────────────────────────────────────────────────────

export class TimeoutError extends KoryphaiosError {
  constructor(operation: string, timeoutMs: number, details?: Record<string, unknown>) {
    super(
      `Operation "${operation}" timed out after ${timeoutMs}ms`,
      "TIMEOUT",
      504,
      true,
      { operation, timeoutMs, ...details }
    );
  }
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Check if an error is operational (expected) vs a bug
 */
export function isOperationalError(error: Error): boolean {
  if (error instanceof KoryphaiosError) {
    return error.isOperational;
  }
  return false;
}

/**
 * Convert unknown error to KoryphaiosError
 */
export function normalizeError(error: unknown): KoryphaiosError {
  if (error instanceof KoryphaiosError) {
    return error;
  }
  
  if (error instanceof Error) {
    // Check for common error types
    if (error.message.includes("ECONNREFUSED")) {
      return new ProviderUnavailableError("unknown", { originalError: error.message });
    }
    if (error.message.includes("ETIMEDOUT") || error.message.includes("timeout")) {
      return new TimeoutError("unknown", 0, { originalError: error.message });
    }
    if (error.message.includes("rate limit", )) {
      return new RateLimitError(60, { originalError: error.message });
    }
    
    return new InternalError(error.message, { 
      originalName: error.name,
      stack: error.stack 
    });
  }
  
  return new InternalError(String(error));
}

/**
 * Get HTTP status code from any error
 */
export function getErrorStatusCode(error: unknown): number {
  if (error instanceof KoryphaiosError) {
    return error.statusCode;
  }
  return 500;
}

/**
 * Get error code from any error
 */
export function getErrorCode(error: unknown): string {
  if (error instanceof KoryphaiosError) {
    return error.code;
  }
  return "UNKNOWN_ERROR";
}