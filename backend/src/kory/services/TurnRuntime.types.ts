import type { AgentStatus, ProviderName, WSMessage } from '@koryphaios/shared';
import type { ProviderEvent, StreamRequest } from '../../providers/types';
import type { ManagerRunHandle, ManagerRunLifecycle } from './ManagerRunLifecycle';

export interface CompletedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TurnStreamUsage {
  tokensIn: number;
  tokensOut: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  usageKnown: boolean;
  estimated: boolean;
}

/** Capabilities needed to stream a turn; no manager or session-store access. */
export interface TurnRuntimeDependencies {
  providers: {
    executeWithRetry(request: StreamRequest, provider?: ProviderName): AsyncIterable<ProviderEvent>;
  };
  lifecycle: Pick<ManagerRunLifecycle, 'phase'>;
  /** Throws unless this exact run still owns active execution. Never reads UI state. */
  assertActive(handle: ManagerRunHandle): void;
  archive?: {
    record(
      sessionId: string,
      kind: 'file_edit' | 'tool_result',
      label: string,
      content: string,
      isError?: boolean,
    ): Promise<string>;
  } | null;
  processes: {
    registerExternal(options: {
      name: string;
      command: string;
      sessionId: string;
      outputFile?: string;
    }): Promise<string>;
  };
}

/** Output sinks are bound to one turn's context by the caller. */
export interface TurnStreamEffects {
  emit(type: string, payload: WSMessage['payload']): void;
  heartbeat(phase: AgentStatus): void;
  fileEdit(path: string, content: string, operation: 'create' | 'edit', oldContent?: string): void;
  usage(usage: TurnStreamUsage): void;
}

export interface TurnStreamInput {
  request: StreamRequest;
  provider: ProviderName;
  handle: ManagerRunHandle;
  agentId: string;
  effects: TurnStreamEffects;
}

export interface TurnStreamResult {
  content: string;
  completedToolCalls: CompletedToolCall[];
  observedNativeTool: boolean;
  usage: TurnStreamUsage;
}

/** Ownership loss must never be treated as a publishable partial turn. */
export class TurnOwnershipLostError extends Error {
  constructor() {
    super('Provider turn no longer owns the active session run');
    this.name = 'TurnOwnershipLostError';
  }
}

/** The session already holds a run claim (a turn, a deletion, or a recovery).
 *
 * This is a *deferral*, never a compaction failure. Automatic compaction used
 * to raise a plain Error here, so the retry policy burned all three attempts on
 * a condition no retry can fix, then started a five-minute failure cooldown and
 * showed the user an "Automatic compaction failed" banner — even though the
 * compactor had never been given a chance to run. Distinguishing it lets the
 * scheduler skip quietly and re-arm on the next turn. */
export class SessionBusyError extends Error {
  constructor(message = 'This session is already running or applying a Time Travel recovery') {
    super(message);
    this.name = 'SessionBusyError';
  }
}

/** Partial transcript data is deliberately non-enumerable: logging an error
 * must not serialize conversation content or tool arguments. */
export class TurnStreamFailure extends Error {
  declare readonly partial: TurnStreamResult;
  constructor(message: string, partial: TurnStreamResult) {
    super(message);
    this.name = 'TurnStreamFailure';
    Object.defineProperty(this, 'partial', { value: partial, enumerable: false });
  }
}
