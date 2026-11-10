import type { ExecutionTarget } from './remote-target';

export const REMOTE_PROTOCOL_VERSION = 2 as const;

export type RemoteCommandKind = 'request' | 'cancel' | 'resume' | 'answer' | 'approve' | 'review';

export type RemoteProtocolOperationState =
  | 'queued'
  | 'sent'
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_uncertain'
  | 'expired'
  | 'rejected';

export interface RemoteCommandEnvelope<T = unknown> {
  protocol: typeof REMOTE_PROTOCOL_VERSION;
  commandId: string;
  operationId: string;
  kind: RemoteCommandKind;
  target: ExecutionTarget;
  payload: T;
  issuedAt: number;
  attempt: number;
}

export interface RemoteOperationReceipt {
  protocol: typeof REMOTE_PROTOCOL_VERSION;
  commandId: string;
  operationId: string;
  target: ExecutionTarget;
  state: RemoteProtocolOperationState;
  cursor: string;
  acceptedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface RemoteReplayCursor {
  sessionId: string;
  cursor: string;
  epoch: number;
}

export interface RemoteReconnectRequest {
  protocol: typeof REMOTE_PROTOCOL_VERSION;
  target: ExecutionTarget;
  cursor?: RemoteReplayCursor;
  operations: Array<Pick<RemoteOperationReceipt, 'commandId' | 'operationId' | 'state'>>;
}

export function isRemoteOperationTerminal(state: RemoteProtocolOperationState): boolean {
  return ['completed', 'failed', 'cancelled', 'expired', 'rejected'].includes(state);
}

export function isRemoteOperationRetryable(state: RemoteProtocolOperationState): boolean {
  return state === 'outcome_uncertain';
}
