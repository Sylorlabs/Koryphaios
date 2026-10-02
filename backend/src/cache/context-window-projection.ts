import { createHash } from 'node:crypto';

const DEFAULT_SAFETY_RATIO = 0.9;
const DEFAULT_RECENT_TAIL_RATIO = 0.62;
const TOKEN_CHARS = 4;

export interface ProjectableContextMessage {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: unknown;
}

export interface ContextWindowProjectionPlan<T extends ProjectableContextMessage> {
  required: boolean;
  sourceContextKey: string;
  sourceHash: string;
  sourceTokens: number;
  sourceMessageCount: number;
  targetModel: string;
  targetWindow: number;
  reservedOutputTokens: number;
  stableOverheadTokens: number;
  safetyRatio: number;
  targetInputBudget: number;
  checkpointBudgetTokens: number;
  checkpointSourceTokens: number;
  checkpointSourceMessageCount: number;
  recentTailTokens: number;
  recentTailMessageCount: number;
  checkpointKey: string;
  projectionHash: string;
  checkpointSource: T[];
  recentTail: T[];
}

export interface PlanContextWindowProjectionInput<T extends ProjectableContextMessage> {
  sourceContextKey: string;
  messages: readonly T[];
  targetModel: string;
  targetWindow: number;
  reservedOutputTokens: number;
  stableOverheadTokens: number;
  safetyRatio?: number;
  recentTailRatio?: number;
  universalContextKey?: string;
}

function hash(parts: readonly string[]): string {
  const digest = createHash('sha256');
  for (const part of parts) {
    digest.update(part);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function finiteRatio(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(0.98, Math.max(0.5, value));
}

function tokenUpperBoundFromChars(chars: number): number {
  return Math.max(1, Math.ceil(Math.max(0, chars) / TOKEN_CHARS));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export function projectionMessageTokenUpperBound(message: ProjectableContextMessage): number {
  const content = typeof message.content === 'string' ? message.content : safeJson(message.content);
  const toolCalls = message.tool_calls === undefined ? '' : safeJson(message.tool_calls);
  const toolId = message.tool_call_id ?? '';
  return tokenUpperBoundFromChars(
    message.role.length + content.length + toolCalls.length + toolId.length + 24,
  );
}

export function projectionMessagesTokenUpperBound(
  messages: readonly ProjectableContextMessage[],
): number {
  return messages.reduce((total, message) => total + projectionMessageTokenUpperBound(message), 0);
}

function fingerprintMessages(messages: readonly ProjectableContextMessage[]): string {
  return hash(
    messages.map((message) =>
      safeJson({
        role: message.role,
        content: message.content,
        tool_call_id: message.tool_call_id ?? null,
        tool_calls: message.tool_calls ?? null,
      }),
    ),
  );
}

export function planContextWindowProjection<T extends ProjectableContextMessage>(
  input: PlanContextWindowProjectionInput<T>,
): ContextWindowProjectionPlan<T> {
  const targetWindow = Math.max(1, Math.floor(input.targetWindow));
  const reservedOutputTokens = Math.max(0, Math.floor(input.reservedOutputTokens));
  const stableOverheadTokens = Math.max(0, Math.floor(input.stableOverheadTokens));
  const safetyRatio = finiteRatio(input.safetyRatio, DEFAULT_SAFETY_RATIO);
  const recentTailRatio = finiteRatio(input.recentTailRatio, DEFAULT_RECENT_TAIL_RATIO);
  const sourceTokens = projectionMessagesTokenUpperBound(input.messages);
  const sourceHash = fingerprintMessages(input.messages);
  const dispatchBudget = Math.max(1, Math.floor(targetWindow * safetyRatio));
  const targetInputBudget = Math.max(
    1,
    dispatchBudget - reservedOutputTokens - stableOverheadTokens,
  );

  if (sourceTokens <= targetInputBudget) {
    const checkpointKey = hash([
      'context-window-projection-checkpoint-v1',
      input.universalContextKey ?? '',
      'empty',
      String(targetInputBudget),
    ]);
    return {
      required: false,
      sourceContextKey: input.sourceContextKey,
      sourceHash,
      sourceTokens,
      sourceMessageCount: input.messages.length,
      targetModel: input.targetModel,
      targetWindow,
      reservedOutputTokens,
      stableOverheadTokens,
      safetyRatio,
      targetInputBudget,
      checkpointBudgetTokens: 0,
      checkpointSourceTokens: 0,
      checkpointSourceMessageCount: 0,
      recentTailTokens: sourceTokens,
      recentTailMessageCount: input.messages.length,
      checkpointKey,
      projectionHash: hash([
        'context-window-projection-v1',
        input.sourceContextKey,
        sourceHash,
        String(targetWindow),
        String(targetInputBudget),
        checkpointKey,
      ]),
      checkpointSource: [],
      recentTail: [...input.messages],
    };
  }

  const desiredTailBudget = Math.max(1, Math.floor(targetInputBudget * recentTailRatio));
  const checkpointBudgetTokens = Math.max(1, targetInputBudget - desiredTailBudget);
  let tailStart = input.messages.length;
  let recentTailTokens = 0;
  for (let index = input.messages.length - 1; index >= 0; index--) {
    const tokens = projectionMessageTokenUpperBound(input.messages[index]!);
    if (tailStart < input.messages.length && recentTailTokens + tokens > desiredTailBudget) break;
    tailStart = index;
    recentTailTokens += tokens;
  }

  while (tailStart < input.messages.length && input.messages[tailStart]?.role === 'tool') {
    recentTailTokens -= projectionMessageTokenUpperBound(input.messages[tailStart]!);
    tailStart++;
  }
  if (tailStart >= input.messages.length && input.messages.length > 0) {
    tailStart = input.messages.length - 1;
    recentTailTokens = projectionMessageTokenUpperBound(input.messages[tailStart]!);
  }

  const checkpointSource = input.messages.slice(0, tailStart);
  const recentTail = input.messages.slice(tailStart);
  const checkpointSourceTokens = projectionMessagesTokenUpperBound(checkpointSource);
  recentTailTokens = projectionMessagesTokenUpperBound(recentTail);
  const checkpointSourceHash = fingerprintMessages(checkpointSource);
  const checkpointKey = hash([
    'context-window-projection-checkpoint-v1',
    input.universalContextKey ?? '',
    checkpointSourceHash,
    String(checkpointBudgetTokens),
  ]);

  return {
    required: true,
    sourceContextKey: input.sourceContextKey,
    sourceHash,
    sourceTokens,
    sourceMessageCount: input.messages.length,
    targetModel: input.targetModel,
    targetWindow,
    reservedOutputTokens,
    stableOverheadTokens,
    safetyRatio,
    targetInputBudget,
    checkpointBudgetTokens,
    checkpointSourceTokens,
    checkpointSourceMessageCount: checkpointSource.length,
    recentTailTokens,
    recentTailMessageCount: recentTail.length,
    checkpointKey,
    projectionHash: hash([
      'context-window-projection-v1',
      input.sourceContextKey,
      sourceHash,
      String(targetWindow),
      String(targetInputBudget),
      checkpointKey,
    ]),
    checkpointSource: [...checkpointSource],
    recentTail: [...recentTail],
  };
}

export function chunkProjectionMessages<T extends ProjectableContextMessage>(
  messages: readonly T[],
  maxTokens: number,
): T[][] {
  const budget = Math.max(1, Math.floor(maxTokens));
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;
  for (const message of messages) {
    const messageTokens = projectionMessageTokenUpperBound(message);
    if (current.length > 0 && currentTokens + messageTokens > budget) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function projectionContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return safeJson(content);
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return safeJson(block);
      const value = block as Record<string, unknown>;
      if (value.type === 'text' && typeof value.text === 'string') return value.text;
      if (value.type === 'image') {
        const mime = typeof value.imageMimeType === 'string' ? value.imageMimeType : 'image';
        return `[${mime} attachment retained in canonical history]`;
      }
      return safeJson(value);
    })
    .join('\n');
}

export function renderProjectionTranscript(messages: readonly ProjectableContextMessage[]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${projectionContentText(message.content)}`)
    .join('\n\n');
}

export function chunkProjectionTranscript(
  messages: readonly ProjectableContextMessage[],
  maxTokens: number,
): string[] {
  const transcript = renderProjectionTranscript(messages);
  if (!transcript) return [];
  const maxChars = Math.max(1, Math.floor(maxTokens)) * TOKEN_CHARS;
  const chunks: string[] = [];
  let offset = 0;
  while (offset < transcript.length) {
    const hardEnd = Math.min(transcript.length, offset + maxChars);
    let end = hardEnd;
    if (hardEnd < transcript.length) {
      const softEnd = transcript.lastIndexOf('\n\n', hardEnd);
      if (softEnd > offset + Math.floor(maxChars / 2)) end = softEnd;
    }
    if (end <= offset) end = hardEnd;
    chunks.push(transcript.slice(offset, end));
    offset = end;
    while (transcript.startsWith('\n', offset)) offset++;
  }
  return chunks;
}

export function buildProjectionCheckpointMessage(
  plan: ContextWindowProjectionPlan<ProjectableContextMessage>,
  checkpoint: string,
): ProjectableContextMessage {
  return {
    role: 'system',
    content:
      `[KORY_CONTEXT_PROJECTION v1]\n` +
      `This is an authoritative, non-destructive projection of earlier conversation state for a smaller context window. ` +
      `The canonical full conversation remains preserved. Checkpoint ${plan.checkpointKey.slice(0, 16)}; ` +
      `${plan.checkpointSourceMessageCount} earlier messages / ~${plan.checkpointSourceTokens} tokens were compacted.\n\n` +
      checkpoint,
  };
}
