export interface DisplayMessageAttachment {
  type: 'image' | 'file';
  data: string;
  name: string;
  mimeType?: string;
}

/** Message shape returned by the display-history endpoint. `isActive` marks
 * membership in the durable active lineage; sibling variants remain present
 * for preview without being mistaken for the conversation branch. */
export interface DisplayMessage {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  model?: string;
  provider?: string;
  cost?: number;
  variantGroupId?: string;
  variantIndex?: number;
  attachments?: DisplayMessageAttachment[];
  isActive?: boolean;
}

export interface MessageDisplayBoundary {
  activeMessageId: string | null;
  conversationRevision: number | null;
  providerConversationRevision: number | null;
  /** False for the legacy array response or a malformed partial projection.
   * Callers may display it, but must not perform a branch CAS from it. */
  authoritative: boolean;
}

export interface MessageDisplayProjection {
  messages: DisplayMessage[];
  boundary: MessageDisplayBoundary;
}

export interface VariantChoice {
  representative: DisplayMessage;
  activeVariantId: string | null;
  authoritative: boolean;
  variants: DisplayMessage[];
}

export type ObservedRunOutcome =
  | { kind: 'pending' }
  | { kind: 'complete' }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseAttachment(value: unknown): DisplayMessageAttachment | null {
  if (!isRecord(value) || (value.type !== 'image' && value.type !== 'file')) return null;
  if (
    typeof value.data !== 'string' ||
    typeof value.name !== 'string' ||
    (value.mimeType !== undefined && typeof value.mimeType !== 'string')
  ) {
    return null;
  }
  return {
    type: value.type,
    data: value.data,
    name: value.name,
    mimeType: value.mimeType,
  };
}

function parseMessage(value: unknown, activeLineageIds: ReadonlySet<string>): DisplayMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.role !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.createdAt !== 'number'
  ) {
    throw new Error('Chat history contained an invalid message.');
  }
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(parseAttachment).filter((item) => item !== null)
    : undefined;
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    createdAt: value.createdAt,
    model: optionalString(value.model),
    provider: optionalString(value.provider),
    cost: typeof value.cost === 'number' ? value.cost : undefined,
    variantGroupId: optionalString(value.variantGroupId),
    variantIndex: typeof value.variantIndex === 'number' ? value.variantIndex : undefined,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    isActive:
      value.isActive === true || value.isActiveBranch === true || activeLineageIds.has(value.id),
  };
}

/** Accept both the authoritative structured response and the old message
 * array. Legacy data remains readable, but its boundary is intentionally
 * non-authoritative so branch activation fails closed. */
export function parseMessageDisplayProjection(value: unknown): MessageDisplayProjection {
  if (Array.isArray(value)) {
    return {
      messages: value.map((message) => parseMessage(message, new Set())),
      boundary: {
        activeMessageId: null,
        conversationRevision: null,
        providerConversationRevision: null,
        authoritative: false,
      },
    };
  }
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error('Chat history was not returned by the backend.');
  }

  const hasActiveHead =
    Object.prototype.hasOwnProperty.call(value, 'activeMessageId') &&
    (value.activeMessageId === null || typeof value.activeMessageId === 'string');
  const conversationRevision =
    typeof value.conversationRevision === 'number' ? value.conversationRevision : null;
  const providerConversationRevision =
    typeof value.providerConversationRevision === 'number'
      ? value.providerConversationRevision
      : null;
  const authoritative =
    hasActiveHead && conversationRevision !== null && providerConversationRevision !== null;
  const activeMessageId = hasActiveHead ? (value.activeMessageId as string | null) : null;
  const activeLineageIds = new Set(
    Array.isArray(value.activeMessageIds)
      ? value.activeMessageIds.filter((id): id is string => typeof id === 'string')
      : [],
  );
  if (activeMessageId) activeLineageIds.add(activeMessageId);

  return {
    messages: value.messages.map((message) => parseMessage(message, activeLineageIds)),
    boundary: {
      activeMessageId,
      conversationRevision,
      providerConversationRevision,
      authoritative,
    },
  };
}

export function sortResponseVariants(messages: readonly DisplayMessage[]): DisplayMessage[] {
  return [...messages].sort(
    (left, right) =>
      (left.variantIndex ?? 0) - (right.variantIndex ?? 0) ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id),
  );
}

/** Pick the active-lineage sibling. Falling back to the first stable sibling
 * is display-only and deliberately does not manufacture active authority. */
export function chooseVariantRepresentative(
  messages: readonly DisplayMessage[],
  boundary: MessageDisplayBoundary,
): VariantChoice {
  const variants = sortResponseVariants(messages);
  if (variants.length === 0) throw new Error('A response variant group cannot be empty.');
  const active =
    variants.find((message) => message.isActive === true) ??
    variants.find((message) => message.id === boundary.activeMessageId);
  return {
    representative: active ?? variants[0]!,
    activeVariantId: active?.id ?? null,
    authoritative: boundary.authoritative && !!active,
    variants,
  };
}

/** Provider identity is part of a response variant. Passing only the model can
 * silently route a regenerated response through another provider. */
export function exactModelSelection(provider?: string, model?: string): string | undefined {
  if (!model) return undefined;
  if (!provider || model.startsWith(`${provider}:`)) return model;
  return `${provider}:${model}`;
}

export function observedRunOutcome(
  state: { runId?: string | null; phase?: string; terminalReason?: string | null } | undefined,
  expectedRunId: string,
): ObservedRunOutcome {
  if (!state || state.runId !== expectedRunId) return { kind: 'pending' };
  if (state.phase === 'done') return { kind: 'complete' };
  if (state.phase === 'error') {
    return { kind: 'failed', reason: state.terminalReason || 'Regeneration failed.' };
  }
  if (state.phase === 'cancelled') {
    return { kind: 'cancelled', reason: state.terminalReason || 'Regeneration was cancelled.' };
  }
  return { kind: 'pending' };
}
