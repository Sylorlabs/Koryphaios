// Circuit Breaker — prevents cascading failures from failing external services

import { serverLog } from '../logger';
import { CircuitBreakerOpenError, TimeoutError } from '../errors/types';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  name: string;
  failureThreshold: number;
  successThreshold: number;
  resetTimeoutMs: number;
  requestTimeoutMs: number;
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

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
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
      resetTimeoutMs: 30000,
      requestTimeoutMs: 30000,
      enableLogging: true,
      ...config,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.transitionTo('HALF_OPEN');
      } else {
        throw new CircuitBreakerOpenError(
          this.config.name,
          this.lastFailureTime! + this.config.resetTimeoutMs,
        );
      }
    }

    this.totalRequests++;
    const startTime = Date.now();

    try {
      const result = await this.executeWithTimeout(fn);
      this.recordSuccess(Date.now() - startTime);
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

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

  private recordSuccess(responseTime: number): void {
    this.successes++;
    this.totalSuccesses++;
    this.lastSuccessTime = Date.now();

    // Keep last 100 response times
    this.responseTimes.push(responseTime);
    if (this.responseTimes.length > 100) {
      this.responseTimes.shift();
    }

    if (this.state === 'HALF_OPEN') {
      if (this.successes >= this.config.successThreshold) {
        this.transitionTo('CLOSED');
      }
    } else if (this.state === 'CLOSED') {
      this.failures = 0;
    }
  }

  private recordFailure(): void {
    this.failures++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.transitionTo('OPEN');
    } else if (this.state === 'CLOSED') {
      if (this.failures >= this.config.failureThreshold) {
        this.transitionTo('OPEN');
      }
    }
  }

  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return false;
    return Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs;
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === 'CLOSED') {
      this.failures = 0;
      this.successes = 0;
    } else if (newState === 'HALF_OPEN') {
      this.successes = 0;
    }

    if (this.config.enableLogging) {
      serverLog.info(
        { circuit: this.config.name, oldState, newState },
        `Circuit breaker state changed: ${oldState} -> ${newState}`,
      );
    }
  }

  getState(): CircuitState {
    return this.state;
  }

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

  private getAverageResponseTime(): number {
    if (this.responseTimes.length === 0) return 0;
    const sum = this.responseTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.responseTimes.length);
  }

  forceOpen(): void {
    this.transitionTo('OPEN');
    this.lastFailureTime = Date.now();
  }

  forceClose(): void {
    this.transitionTo('CLOSED');
  }

  reset(): void {
    this.state = 'CLOSED';
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

export class CircuitBreakerRegistry {
  private circuits = new Map<string, CircuitBreaker>();
  private defaultConfig: Omit<CircuitBreakerConfig, 'name'>;

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

  getAll(): Map<string, CircuitBreaker> {
    return new Map(this.circuits);
  }

  getAllStats(): CircuitBreakerStats[] {
    return Array.from(this.circuits.values()).map((c) => c.getStats());
  }

  hasOpenCircuit(): boolean {
    for (const circuit of this.circuits.values()) {
      if (circuit.getState() === 'OPEN') {
        return true;
      }
    }
    return false;
  }

  resetAll(): void {
    for (const circuit of this.circuits.values()) {
      circuit.reset();
    }
  }
}

let registry: CircuitBreakerRegistry | null = null;

export function getCircuitBreakerRegistry(): CircuitBreakerRegistry {
  if (!registry) {
    registry = new CircuitBreakerRegistry();
  }
  return registry;
}

export function getCircuitBreaker(
  name: string,
  config?: Partial<CircuitBreakerConfig>,
): CircuitBreaker {
  return getCircuitBreakerRegistry().get(name, config);
}
