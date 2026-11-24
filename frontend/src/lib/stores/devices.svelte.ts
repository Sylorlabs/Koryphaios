import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { sessionStore } from './sessions.svelte';
import { wsStore } from './websocket.svelte';
import { deviceRouting, deviceSessionKey, mapDeviceSessionIds } from './device-routing.svelte';
import type { KoryAskUserPayload, KorySessionChangesPayload } from '@koryphaios/shared';
import {
  readReview,
  readQuestion,
  isReviewResolution,
  isQuestionResolution,
  reviewResolutionMatches,
  questionResolutionMatches,
} from '$lib/utils/review-protocol';
import type {
  DeviceIdentity,
  LinkedDevice,
  DeviceWorkspace,
  DeviceChat,
  DeviceFolderListing,
} from '@koryphaios/shared/src/devices';

export interface DeviceStatus {
  local: DeviceIdentity | null;
  osName: string;
  connected: boolean;
  relayUrl: string | null;
  error: string | null;
  accountWideDeviceAccess: boolean;
  peers: Array<LinkedDevice & { agentRouting: boolean }>;
  requests: Array<{ id: string; identity: DeviceIdentity; check: string; expiresAt: number }>;
  pendingPairIds: string[];
}
export interface RemoteSnapshot {
  chat: DeviceChat;
  messages: Array<{ id: string; role: string; content: string; createdAt: number }>;
  run: { phase: string; status: string; revision?: number } | null;
  question: KoryAskUserPayload | null;
  review: KorySessionChangesPayload | null;
}
export interface DeviceChatSelection {
  chat: DeviceChat;
  generation: number;
  routingGeneration: number;
  selectionGeneration: number;
  origin: string;
}
interface SnapshotTicket {
  owner: DeviceChatSelection;
  request: number;
  question: number;
  review: number;
  run: number;
  output: number;
}
let status = $state<DeviceStatus | null>(null);
let activeChat = $state<DeviceChat | null>(null);
let snapshot = $state.raw<RemoteSnapshot | null>(null);
let question = $state.raw<KoryAskUserPayload | null>(null);
let currentRun = $state.raw<RemoteSnapshot['run']>(null);
let drafts = $state<Record<string, string>>({});
let error = $state('');
let createOpen = $state(false);
export type CreatorMode = 'chat' | 'project' | 'workspace';
let creatorMode = $state<CreatorMode>('chat');
let generation = $state(0);
let listening = false;
let latestRunRevision = -1;
let chats = $state<DeviceChat[]>([]);
let previousLocalSessionId = '';
let questionEvents = 0;
let reviewEvents = 0;
let runEvents = 0;
let outputEvents = 0;
let snapshotRequest = 0;
let appliedSnapshot = 0;
let composerDrafts = $state<Map<string, { text: string; revision: number }>>(new Map());
let actions = $state<Map<string, object>>(new Map());
let answerResponses = $state<
  Map<
    string,
    {
      questionId?: string;
      phase: 'submitting' | 'awaiting_confirmation' | 'uncertain';
      error?: string;
    }
  >
>(new Map());

function chatKey(owner: DeviceChatSelection): string {
  return JSON.stringify([owner.origin, owner.chat.deviceId, owner.chat.id]);
}
function captureChat(): DeviceChatSelection | null {
  return activeChat
    ? {
        chat: { ...activeChat },
        generation,
        routingGeneration: deviceRouting.generation,
        selectionGeneration: sessionStore.selectionGeneration,
        origin: apiUrl('/api'),
      }
    : null;
}
function ownsChat(owner: DeviceChatSelection | null): owner is DeviceChatSelection {
  return (
    !!owner &&
    owner.generation === generation &&
    owner.routingGeneration === deviceRouting.generation &&
    owner.selectionGeneration === sessionStore.selectionGeneration &&
    owner.origin === apiUrl('/api') &&
    activeChat?.deviceId === owner.chat.deviceId &&
    activeChat?.id === owner.chat.id &&
    sessionStore.activeSessionId === deviceSessionKey(owner.chat)
  );
}
function ticket(owner: DeviceChatSelection): SnapshotTicket {
  return {
    owner,
    request: ++snapshotRequest,
    question: questionEvents,
    review: reviewEvents,
    run: runEvents,
    output: outputEvents,
  };
}
function setQuestion(value: KoryAskUserPayload | null, fromSnapshot = false) {
  const owner = captureChat();
  if (!owner) return;
  if (!fromSnapshot || JSON.stringify(question) !== JSON.stringify(value)) question = value;
  const key = chatKey(owner);
  const response = answerResponses.get(key);
  if (response && (!value || response.questionId !== value.questionId)) {
    const next = new Map(answerResponses);
    next.delete(key);
    answerResponses = next;
  }
}
function applySnapshot(result: any, request: SnapshotTicket): boolean {
  if (
    !ownsChat(request.owner) ||
    request.request < appliedSnapshot ||
    !result ||
    typeof result !== 'object'
  )
    return false;
  const chat = request.owner.chat;
  if (result.chat && (result.chat.id !== chat.id || result.chat.deviceId !== chat.deviceId))
    return false;
  appliedSnapshot = request.request;
  const run = result.run;
  let acceptedRun = false;
  if (
    run &&
    typeof run.phase === 'string' &&
    typeof run.status === 'string' &&
    Number.isSafeInteger(run.revision) &&
    run.revision >= latestRunRevision
  ) {
    latestRunRevision = run.revision;
    currentRun = run;
    acceptedRun = true;
  } else if (
    request.run === runEvents &&
    latestRunRevision < 0 &&
    (run === null ||
      (run &&
        typeof run.phase === 'string' &&
        typeof run.status === 'string' &&
        !('revision' in run)))
  ) {
    currentRun = run;
    acceptedRun = true;
  }
  if (request.question === questionEvents) {
    const parsed = readQuestion(result.question);
    if (result.question === null || parsed) {
      setQuestion(parsed, true);
      wsStore.ingestLinkedMessage({
        type: parsed ? 'kory.ask_user' : 'kory.ask_user_resolved',
        sessionId: deviceSessionKey(chat),
        timestamp: Date.now(),
        payload: parsed ?? { status: 'not_pending' },
      });
    }
  }
  if (request.review === reviewEvents) {
    const key = deviceSessionKey(chat);
    if (result.review === null) wsStore.resolveReview(key, { status: 'not_pending' });
    else if (readReview(result.review)) wsStore.publishReview(key, result.review, true);
  }
  snapshot = {
    chat,
    messages: Array.isArray(result.messages) ? result.messages : (snapshot?.messages ?? []),
    run: currentRun,
    question,
    review: wsStore.sessionReviews.get(deviceSessionKey(chat)) ?? null,
  };
  if (acceptedRun && currentRun)
    wsStore.ingestLinkedMessage({
      type: 'run.state',
      sessionId: deviceSessionKey(chat),
      timestamp: Date.now(),
      payload: { snapshot: mapDeviceSessionIds(currentRun, chat, true), transition: null },
    });
  if (
    acceptedRun &&
    request.output === outputEvents &&
    (currentRun?.status === 'terminal' || currentRun?.status === 'idle')
  )
    drafts = {};
  error = '';
  return true;
}
async function request(path = '', method = 'GET', body?: unknown): Promise<any> {
  const response = await apiFetch(
    apiUrl(`/api/devices${path}`),
    {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    },
    40_000,
  );
  const result = await parseJsonResponse(response);
  if (!response.ok || !result.ok) throw new Error(result.error || 'Device request failed');
  return result.data;
}
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('kory:device-event', ((event: CustomEvent) => {
    const data = event.detail;
    if (!activeChat || data.deviceId !== activeChat.deviceId || data.sessionId !== activeChat.id)
      return;
    const message = data.event;
    if (message?.sessionId !== activeChat.id) return;
    const currentReview = wsStore.sessionReviews.get(deviceSessionKey(activeChat));
    wsStore.ingestLinkedMessage(mapDeviceSessionIds(message, activeChat, true));
    const payload = message?.payload;
    if (!payload) return;
    if (message.type === 'stream.delta') {
      outputEvents += 1;
      drafts[payload.agentId] = (drafts[payload.agentId] ?? '') + (payload.content ?? '');
    }
    if (message.type === 'stream.clear_content') {
      outputEvents += 1;
      delete drafts[payload.agentId];
    }
    if (
      message.type === 'run.state' &&
      Number.isSafeInteger(payload.snapshot?.revision) &&
      payload.snapshot.revision > latestRunRevision
    ) {
      runEvents += 1;
      latestRunRevision = payload.snapshot.revision;
      currentRun = payload.snapshot;
      if (payload.snapshot.status === 'terminal' || payload.snapshot.status === 'waiting')
        void deviceStore.refreshChat();
    }
    if (message.type === 'kory.ask_user' && readQuestion(payload)) {
      questionEvents += 1;
      setQuestion(payload);
    }
    if (
      message.type === 'kory.ask_user_resolved' &&
      isQuestionResolution(payload) &&
      (!question || questionResolutionMatches(question, payload))
    ) {
      questionEvents += 1;
      setQuestion(null);
    }
    if (message.type === 'session.changes' && readReview(payload)) reviewEvents += 1;
    if (
      message.type === 'session.changes_resolved' &&
      isReviewResolution(payload) &&
      (!currentReview || reviewResolutionMatches(currentReview, payload))
    )
      reviewEvents += 1;
    if (message.type === 'system.error')
      error = payload.error ?? payload.message ?? 'Remote request failed';
  }) as EventListener);
}
export const deviceStore = {
  get status() {
    return status;
  },
  get activeChat() {
    return activeChat;
  },
  get snapshot() {
    return snapshot && activeChat
      ? {
          ...snapshot,
          run: currentRun,
          question,
          review: wsStore.sessionReviews.get(deviceSessionKey(activeChat)) ?? null,
        }
      : null;
  },
  get drafts() {
    return drafts;
  },
  get error() {
    return error;
  },
  get generation() {
    return generation;
  },
  captureChat,
  ownsChat,
  get composerText() {
    const owner = captureChat();
    return owner ? (composerDrafts.get(chatKey(owner))?.text ?? '') : '';
  },
  get actionPending() {
    const owner = captureChat();
    return !!owner && actions.has(chatKey(owner));
  },
  get answerResponse() {
    const owner = captureChat();
    return owner ? answerResponses.get(chatKey(owner)) : undefined;
  },
  setComposerDraft(owner: DeviceChatSelection, text: string) {
    if (!ownsChat(owner)) return;
    const key = chatKey(owner);
    const prior = composerDrafts.get(key);
    composerDrafts = new Map(composerDrafts).set(key, {
      text,
      revision: (prior?.revision ?? 0) + 1,
    });
  },
  get createOpen() {
    return createOpen;
  },
  get creatorMode() {
    return creatorMode;
  },
  get chats() {
    return chats;
  },
  openCreator(mode: CreatorMode = 'chat') {
    creatorMode = mode;
    createOpen = true;
    void this.load();
  },
  closeCreator() {
    createOpen = false;
    creatorMode = 'chat';
  },
  async load() {
    listen();
    try {
      status = await request();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not load devices';
    }
  },
  async rename(name: string) {
    status = await request('/name', 'PATCH', { name });
  },
  async configureRelay(url: string) {
    status = await request('/relay', 'PATCH', { url });
  },
  async configureAccountWideDeviceAccess(enabled: boolean) {
    status = await request('/access', 'PATCH', { enabled });
  },
  invite() {
    return request('/pairing', 'POST');
  },
  stopInvite() {
    return request('/pairing', 'DELETE');
  },
  pair(code: string) {
    return request('/pair', 'POST', { code });
  },
  async decide(id: string, approved: boolean) {
    status = await request('/decision', 'POST', { id, approved });
  },
  async unlink(id: string) {
    await request(`/${id}`, 'DELETE');
    if (activeChat?.deviceId === id) this.closeChat();
    await this.load();
  },
  async grants(id: string, allowAgents: boolean, agentRouting: boolean) {
    status = await request(`/${id}/grants`, 'PATCH', { allowAgents, agentRouting });
  },
  rpc(id: string, operation: string, input: Record<string, unknown> = {}) {
    return request(`/${id}/rpc`, 'POST', { operation, input });
  },
  workspaces(id: string): Promise<DeviceWorkspace[]> {
    return this.rpc(id, 'workspaces');
  },
  folders(id: string, workspaceId: string): Promise<DeviceWorkspace[]> {
    return this.rpc(id, 'folders', { workspaceId });
  },
  browseFolders(id: string, workspaceId?: string): Promise<DeviceFolderListing> {
    return this.rpc(id, 'browse_folders', workspaceId ? { workspaceId } : {});
  },
  async openChat(chat: DeviceChat) {
    if (activeChat)
      void this.rpc(activeChat.deviceId, 'close_chat', { sessionId: activeChat.id }).catch(
        () => undefined,
      );
    const own = ++generation;
    if (!activeChat) previousLocalSessionId = sessionStore.activeSessionId;
    activeChat = chat;
    deviceRouting.setChat(chat);
    sessionStore.activeSessionId = deviceSessionKey(chat);
    chats = [...chats.filter((c) => c.id !== chat.id || c.deviceId !== chat.deviceId), chat].slice(
      -100,
    );
    snapshot = null;
    question = null;
    currentRun = null;
    drafts = {};
    error = '';
    latestRunRevision = -1;
    questionEvents = reviewEvents = runEvents = outputEvents = 0;
    appliedSnapshot = 0;
    const owner = captureChat()!;
    const pending = ticket(owner);
    listen();
    try {
      const result = await this.rpc(chat.deviceId, 'open_chat', { sessionId: chat.id });
      if (own === generation && applySnapshot(result, pending)) {
        if (result.session) {
          sessionStore.attachDeviceSession(mapDeviceSessionIds(result.session, chat, true));
          sessionStore.activeSessionId = deviceSessionKey(chat);
        }
      }
    } catch (e) {
      if (ownsChat(owner)) error = e instanceof Error ? e.message : 'Could not open remote chat';
    }
  },
  async refreshChat(
    owner: DeviceChatSelection | null = captureChat(),
    operation: 'snapshot' | 'open_chat' = 'snapshot',
  ): Promise<boolean> {
    if (!ownsChat(owner)) return false;
    const chat = owner.chat;
    const pending = ticket(owner);
    try {
      const result = await this.rpc(chat.deviceId, operation, { sessionId: chat.id });
      return applySnapshot(result, pending);
    } catch (e) {
      if (ownsChat(owner) && pending.request === snapshotRequest)
        error = e instanceof Error ? e.message : 'Device connection interrupted';
      return false;
    }
  },
  closeChat() {
    if (activeChat)
      void this.rpc(activeChat.deviceId, 'close_chat', { sessionId: activeChat.id }).catch(
        () => undefined,
      );
    ++generation;
    const oldKey = activeChat ? deviceSessionKey(activeChat) : '';
    activeChat = null;
    deviceRouting.setChat(null);
    if (sessionStore.activeSessionId === oldKey)
      sessionStore.activeSessionId = previousLocalSessionId;
    snapshot = null;
    question = null;
    currentRun = null;
    drafts = {};
    error = '';
  },
  async send(content: string, owner: DeviceChatSelection | null = captureChat()): Promise<boolean> {
    if (!ownsChat(owner) || !content.trim()) return false;
    const key = chatKey(owner);
    if (actions.has(key)) return false;
    const attempt = {};
    const draft = composerDrafts.get(key);
    actions = new Map(actions).set(key, attempt);
    error = '';
    try {
      const result = await this.rpc(owner.chat.deviceId, 'prompt', {
        sessionId: owner.chat.id,
        content,
      });
      if (!result.accepted)
        throw new Error('The remote chat is busy. Try again when its current run finishes.');
      if (ownsChat(owner)) {
        if (draft && composerDrafts.get(key) === draft && draft.text === content)
          this.setComposerDraft(owner, '');
        await this.refreshChat(owner);
      }
      return true;
    } catch (e) {
      if (ownsChat(owner)) error = e instanceof Error ? e.message : 'Could not send prompt';
      return false;
    } finally {
      if (actions.get(key) === attempt) {
        const next = new Map(actions);
        next.delete(key);
        actions = next;
      }
    }
  },
  async cancel(owner: DeviceChatSelection): Promise<void> {
    if (!ownsChat(owner)) return;
    const key = chatKey(owner);
    if (actions.has(key)) return;
    const attempt = {};
    actions = new Map(actions).set(key, attempt);
    try {
      const result = await this.rpc(owner.chat.deviceId, 'cancel', { sessionId: owner.chat.id });
      if (!result.cancelled) throw new Error('The host did not confirm the stop request.');
      if (ownsChat(owner)) await this.refreshChat(owner);
    } catch (e) {
      if (ownsChat(owner))
        error = e instanceof Error ? e.message : 'Could not stop remote response';
    } finally {
      if (actions.get(key) === attempt) {
        const next = new Map(actions);
        next.delete(key);
        actions = next;
      }
    }
  },
  async answer(
    owner: DeviceChatSelection,
    expected: KoryAskUserPayload,
    selection: string,
  ): Promise<void> {
    if (!ownsChat(owner) || question !== expected || !expected.questionId) return;
    const key = chatKey(owner);
    if (answerResponses.has(key)) return;
    let attempt: NonNullable<ReturnType<typeof answerResponses.get>> = {
      questionId: expected.questionId,
      phase: 'submitting',
    };
    answerResponses = new Map(answerResponses).set(key, attempt);
    try {
      const result = await this.rpc(owner.chat.deviceId, 'answer', {
        sessionId: owner.chat.id,
        questionId: expected.questionId,
        selection,
      });
      if (!result.answered) throw new Error('The host did not confirm receipt of this answer.');
      if (answerResponses.get(key) === attempt) {
        attempt = { ...attempt, phase: 'awaiting_confirmation' };
        answerResponses = new Map(answerResponses).set(key, attempt);
      }
      if (ownsChat(owner)) await this.refreshChat(owner);
    } catch (e) {
      if (answerResponses.get(key) === attempt)
        answerResponses = new Map(answerResponses).set(key, {
          ...attempt,
          phase: 'uncertain',
          error: e instanceof Error ? e.message : 'Answer could not be confirmed.',
        });
    }
  },
};
