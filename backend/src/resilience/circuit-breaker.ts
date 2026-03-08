// Circuit Breaker — prevents cascading failures from failing external services
// Implements the Circuit Breaker pattern with three states: CLOSED, OPEN, HALF_OPEN

import { serverLog } from "../logger";
import { CircuitBreakerOpenError, TimeoutError } from "../errors/types";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  /** Name of the circuit for logging/metrics */
  name: string;
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Number of successes in half-open state before closing */
  successThreshold: number;
  /** Time in ms before attempting to close an open circuit */
  resetTimeoutMs: number;
  /** Time in ms before timing out a request */
  requestTimeoutMs: number;
  /** Enable logging */
  enableLogging?: boolean;
}

export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
  totalTimeouts: number;
  avgResponseTime: number;
}

/**
 * Circuit Breaker implementation
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Requests fail fast, no calls to underlying service
 * - HALF_OPEN: Limited requests allowed to test if service recovered
 */
export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private successes = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private totalRequests = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private totalTimeouts = 0;
  private responseTimes: number[] = [];
  private resetTimer: Timer | null = null;

  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> & { name: string }) {
    this.config = {
      failureThreshold: 5,
      successThreshold: 3,
      resetTimeoutMs: 30000, // 30 seconds
      requestTimeoutMs: 30000, // 30 seconds
      enableLogging: true,
      ...config,
    };
  }

  /**
   * Execute a function through the circuit breaker
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.state === "OPEN") {
      if (this.shouldAttemptReset()) {
        this.transitionTo("HALF_OPEN");
      } else {
        throw new CircuitBreakerOpenError(
          this.config.name,
          this.lastFailureTime! + this.config.resetTimeoutMs
        );
      }
    }

    this.totalRequests++;
    const startTime = Date.now();

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(fn);
      
      const responseTime = Date.now() - startTime;
      this.recordSuccess(responseTime);
      
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Execute function with timeout
   */
  private executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.totalTimeouts++;
        reject(new TimeoutError(this.config.name, this.config.requestTimeoutMs));
      }, this.config.requestTimeoutMs);

      fn()
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Record a successful call
   */
  private recordSuccess(responseTime: number): void {
    this.successes++;
    this.totalSuccesses++;
    this.lastSuccessTime = Date.now();
    
    // Track response times (keep last 100)
    this.responseTimes.push(responseTime);
    if (this.responseTimes.length > 100) {
      this.responseTimes.shift();
    }

    if (this.state === "HALF_OPEN") {
      if (this.successes >= this.config.successThreshold) {
        this.transitionTo("CLOSED");
      }
    } else if (this.state === "CLOSED") {
      // Reset failure count on success
      this.failures = 0;
    }

    if (this.config.enableLogging) {
      serverLog.debug(
        { circuit: this.config.name, state: this.state, responseTime },
        "Circuit breaker recorded success"
      );
    }
  }

  /**
   * Record a failed call
   */
  private recordFailure(): void {
    this.failures++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === "HALF_OPEN") {
      // Single failure in half-open state opens the circuit
      this.transitionTo("OPEN");
    } else if (this.state === "CLOSED") {
      if (this.failures >= this.config.failureThreshold) {
        this.transitionTo("OPEN");
      }
    }

    if (this.config.enableLogging) {
      serverLog.warn(
        { 
          circuit: this.config.name, 
          state: this.state, 
          failures: this.failures,
          threshold: this.config.failureThreshold 
        },
        "Circuit breaker recorded failure"
      );
    }
  }

  /**
   * Check if enough time has passed to attempt reset
   */
  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return false;
    return Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs;
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === "CLOSED") {
      this.failures = 0;
      this.successes = 0;
    } else if (newState === "HALF_OPEN") {
      this.successes = 0;
    }

    if (this.config.enableLogging) {
      serverLog.info(
        { circuit: this.config.name, oldState, newState },
        `Circuit breaker state changed: ${oldState} -> ${newState}`
      );
    }
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      name: this.config.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      totalTimeouts: this.totalTimeouts,
      avgResponseTime: this.getAverageResponseTime(),
    };
  }

  /**
   * Get average response time
   */
  private getAverageResponseTime(): number {
    if (this.responseTimes.length === 0) return 0;
    const sum = this.responseTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.responseTimes.length);
  }

  /**
   * Force open the circuit (for testing or manual intervention)
   */
  forceOpen(): void {
    this.transitionTo("OPEN");
    this.lastFailureTime = Date.now();
  }

  /**
   * Force close the circuit (for testing or manual intervention)
   */
  forceClose(): void {
    this.transitionTo("CLOSED");
  }

  /**
   * Reset all statistics
   */
  reset(): void {
    this.state = "CLOSED";
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.totalRequests = 0;
    this.totalFailures = 0;
    this.totalSuccesses = 0;
    this.totalTimeouts = 0;
    this.responseTimes = [];
  }
}

// ─── Circuit Breaker Registry ────────────────────────────────────────────────

/**
 * Registry for managing multiple circuit breakers
 */
export class CircuitBreakerRegistry {
  private circuits = new Map<string, CircuitBreaker>();
  private defaultConfig: Omit<CircuitBreakerConfig, "name">;

  constructor(defaultConfig?: Partial<CircuitBreakerConfig>) {
    this.defaultConfig = {
      failureThreshold: 5,
      successThreshold: 3,
      resetTimeoutMs: 30000,
      requestTimeoutMs: 30000,
      enableLogging: true,
      ...defaultConfig,
    };
  }

  /**
   * Get or create a circuit breaker by name
   */
  get(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let circuit = this.circuits.get(name);
    if (!circuit) {
      circuit = new CircuitBreaker({
        ...this.defaultConfig,
        ...config,
        name,
      });
      this.circuits.set(name, circuit);
    }
    return circuit;
  }

  /**
   * Get all circuit breakers
   */
  getAll(): Map<string, CircuitBreaker> {
    return new Map(this.circuits);
  }

  /**
   * Get statistics for all circuits
   */
  getAllStats(): CircuitBreakerStats[] {
    return Array.from(this.circuits.values()).map((c) => c.getStats());
  }

  /**
   * Check if any circuit is open
   */
  hasOpenCircuit(): boolean {
    for (const circuit of this.circuits.values()) {
      if (circuit.getState() === "OPEN") {
        return true;
      }
    }
    return false;
  }

  /**
   * Reset all circuits
   */
  resetAll(): void {
    for (const circuit of this.circuits.values()) {
      circuit.reset();
    }
  }
}

// ─── Singleton Registry ──────────────────────────────────────────────────────

let registry: CircuitBreakerRegistry | null = null;

export function getCircuitBreakerRegistry(): CircuitBreakerRegistry {
  if (!registry) {
    registry = new CircuitBreakerRegistry();
  }
  return registry;
}

export function getCircuitBreaker(
  name: string, 
  config?: Partial<CircuitBreakerConfig>
): CircuitBreaker {
  return getCircuitBreakerRegistry().get(name, config);
}