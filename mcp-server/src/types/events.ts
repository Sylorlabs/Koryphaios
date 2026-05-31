/**
 * Event system type definitions
 */

import type { DetectedError, ErrorAnalysis } from './errors.js';
import type { DebugSession, PerformanceProfile } from './debugging.js';

export interface EventEmitter<T extends Record<string, unknown[]>> {
  on<K extends keyof T>(event: K, listener: (...args: T[K]) => void): void;
  off<K extends keyof T>(event: K, listener: (...args: T[K]) => void): void;
  emit<K extends keyof T>(event: K, ...args: T[K]): void;
  once<K extends keyof T>(event: K, listener: (...args: T[K]) => void): void;
  removeAllListeners<K extends keyof T>(event?: K): void;
}

export interface ServerEvents extends Record<string, unknown[]> {
  'server:started': [{ port: number; host: string }];
  'server:stopped': [];
  'server:error': [Error];
  'client:connected': [{ clientId: string; clientInfo: unknown }];
  'client:disconnected': [{ clientId: string }];
  'error:detected': [DetectedError];
  'error:analyzed': [ErrorAnalysis];
  'error:resolved': [{ errorId: string; resolution: string }];
  'debug:session-started': [DebugSession];
  'debug:session-ended': [{ sessionId: string }];
  'debug:breakpoint-hit': [{ sessionId: string; breakpointId: string; location: unknown }];
  'performance:profile-completed': [PerformanceProfile];
  'performance:threshold-exceeded': [{ metric: string; value: number; threshold: number }];
  'config:changed': [{ section: string; oldValue: unknown; newValue: unknown }];
  'workspace:changed': [
    { type: 'file' | 'directory'; path: string; action: 'added' | 'modified' | 'deleted' },
  ];
}

export interface ErrorEvent {
  type: 'error:detected' | 'error:analyzed' | 'error:resolved';
  timestamp: Date;
  data: DetectedError | ErrorAnalysis | { errorId: string; resolution: string };
  source: string;
  sessionId?: string;
}

export interface DebugEvent {
  type:
    | 'debug:session-started'
    | 'debug:session-ended'
    | 'debug:breakpoint-hit'
    | 'debug:step'
    | 'debug:pause'
    | 'debug:continue';
  timestamp: Date;
  sessionId: string;
  data?: unknown;
}

export interface PerformanceEvent {
  type:
    | 'performance:profile-started'
    | 'performance:profile-completed'
    | 'performance:threshold-exceeded'
    | 'performance:optimization-suggested';
  timestamp: Date;
  data: unknown;
  sessionId?: string;
}

export interface ConfigEvent {
  type: 'config:changed' | 'config:validated' | 'config:error';
  timestamp: Date;
  section: string;
  data: unknown;
}

export interface WorkspaceEvent {
  type:
    | 'workspace:file-changed'
    | 'workspace:directory-changed'
    | 'workspace:project-loaded'
    | 'workspace:project-unloaded';
  timestamp: Date;
  path: string;
  action?: 'added' | 'modified' | 'deleted';
  data?: unknown;
}

export interface SystemEvent {
  type:
    | 'system:memory-warning'
    | 'system:cpu-warning'
    | 'system:disk-warning'
    | 'system:network-error';
  timestamp: Date;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  data?: unknown;
}

export type AnyEvent =
  | ErrorEvent
  | DebugEvent
  | PerformanceEvent
  | ConfigEvent
  | WorkspaceEvent
  | SystemEvent;

export interface EventFilter {
  types?: string[];
  sources?: string[];
  severities?: string[];
  timeRange?: {
    start: Date;
    end: Date;
  };
  sessionId?: string;
}

export interface EventSubscription {
  id: string;
  filter: EventFilter;
  callback: (event: AnyEvent) => void;
  active: boolean;
}

export interface EventStore {
  store(event: AnyEvent): Promise<void>;
  query(filter: EventFilter): Promise<AnyEvent[]>;
  count(filter: EventFilter): Promise<number>;
  clear(filter?: EventFilter): Promise<void>;
  subscribe(filter: EventFilter, callback: (event: AnyEvent) => void): EventSubscription;
  unsubscribe(subscriptionId: string): void;
}

export interface EventMetrics {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsBySource: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  eventsPerHour: number;
  averageProcessingTime: number;
  errorRate: number;
}

export interface EventProcessingOptions {
  batchSize?: number;
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
  enableDeduplication?: boolean;
  enableCompression?: boolean;
}
