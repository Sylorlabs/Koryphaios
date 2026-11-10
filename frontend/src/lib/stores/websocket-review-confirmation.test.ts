import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { WSMessage } from '@koryphaios/shared';
import type { DeviceChat } from '@koryphaios/shared/src/devices';

const state = vi.hoisted(() => ({
  activeSessionId: '', selectionGeneration: 0, demo: false, origin: '',
  request: null as null | ((path: string, init?: RequestInit) => Promise<any>),
  demoResult: undefined as Promise<void> | undefined,
}));
vi.mock('./sessions.svelte', () => ({ sessionStore: {
  get activeSessionId() { return state.activeSessionId; },
  set activeSessionId(id: string) {
    if (id !== state.activeSessionId) state.selectionGeneration += 1;
    state.activeSessionId = id;
  },
  get selectionGeneration() { return state.selectionGeneration; },
  attachDeviceSession: vi.fn(), getMessageDisplayBoundary: () => undefined,
  fetchSessions: vi.fn(),
} }));
vi.mock('./auth.svelte', () => ({ authStore: { ensureSession: async () => true, token: 'test' } }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => state.origin + path, getWsUrl: () => 'ws://localhost/ws' }));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => state.request ? state.request(path, init) :
    { ok: true, json: async () => ({ ok: true, data: [] }) }),
  parseJsonResponse: async (response: any) => response.json(),
}));
vi.mock('./providers.svelte', () => ({ providersStore: {}, loadProvidersFromApi: vi.fn() }));
vi.mock('./notes.svelte', () => ({ notesStore: {} }));
vi.mock('./goals.svelte', () => ({ goalStore: {} }));
vi.mock('./checklists.svelte', () => ({ checklistStore: {} }));
vi.mock('./toast.svelte', () => ({ toastStore: { error: vi.fn(), success: vi.fn() } }));
vi.mock('./run-state.svelte', () => ({ runStateStore: {
  states: new Map(), applyEvent: () => true, startRun: vi.fn(), markUserStopped: vi.fn(), getAgentStatusForSession: () => 'idle',
  markAgentStopped: vi.fn(),
  isRunning: () => false, isWaiting: () => false, isBusy: () => false,
} }));
vi.mock('$lib/demo-flags', () => ({ get isDemoMode() { return state.demo; } }));
vi.mock('$lib/demo-api', () => ({ resolveDemoReview: vi.fn(() => state.demoResult) }));
vi.mock('$lib/utils/chat-markdown', () => ({ renderChatMarkdown: (text: string) => text }));

import { wsStore } from './websocket.svelte';
import { deviceStore } from './devices.svelte';
import { deviceRouting, deviceSessionKey } from './device-routing.svelte';
import { sessionStore } from './sessions.svelte';
import { apiFetch } from '$lib/api.svelte';
import { toastStore } from './toast.svelte';
import { runStateStore } from './run-state.svelte';
import { resolveDemoReview } from '$lib/demo-api';
import ChangesSummary from '$lib/components/ChangesSummary.svelte';
import DeviceChatView from '$lib/components/DeviceChatView.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(data: unknown, ok = true, status = 200) {
  return { ok: status < 400, json: async () => ({ ok, data, ...(!ok ? { error: 'Target refused the request' } : {}) }) };
}
function review(revision = 'revision-1') {
  return { reviewId: 'review-1', reviewRevision: revision,
    changes: [{ path: 'src/app.ts', operation: 'edit' as const, linesAdded: 2, linesDeleted: 1 }] };
}
function question(id = 'question-1') { return { questionId: id, question: 'Proceed?', options: ['Yes', 'No'] }; }
function emit(type: WSMessage['type'], payload: unknown, sessionId = state.activeSessionId) {
  wsStore.ingestLinkedMessage({ type, payload, sessionId, timestamp: Date.now() });
}
function linkedEvent(chat: DeviceChat, type: WSMessage['type'], payload: unknown) {
  window.dispatchEvent(new CustomEvent('kory:device-event', {
    detail: { deviceId: chat.deviceId, sessionId: chat.id,
      event: { type, sessionId: chat.id, timestamp: Date.now(), payload } },
  }));
}
function chat(id: string, deviceId = 'host-1'): DeviceChat {
  return { id, deviceId, deviceName: deviceId, title: id, workspaceName: 'Workspace' } as DeviceChat;
}
function snapshot(chat: DeviceChat, overrides: Record<string, unknown> = {}) {
  return { chat, messages: [], question: null, review: null,
    run: { phase: 'idle', status: 'idle', revision: 1 }, ...overrides };
}
function rpcBodies() {
  return vi.mocked(apiFetch).mock.calls.flatMap(([, init]) => init?.body ? [JSON.parse(String(init.body))] : []);
}
class TestWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  open() { this.readyState = 1; this.onopen?.(); }
}
async function connect() {
  wsStore.connect();
  await waitFor(() => expect(wsStore.connection).toBeTruthy());
  const socket = wsStore.connection as unknown as TestWebSocket;
  socket.open();
  return socket;
}
let sequence = 0;
beforeEach(() => {
  state.activeSessionId = `review-test-${++sequence}`;
  state.selectionGeneration += 1;
  state.demo = false;
  state.origin = '';
  state.request = null;
  state.demoResult = undefined;
  vi.clearAllMocks();
  vi.stubGlobal('WebSocket', TestWebSocket);
});
afterEach(() => {
  cleanup();
  deviceStore.closeChat();
  wsStore.disconnect();
  wsStore.unsubscribeFromSession(state.activeSessionId);
  vi.unstubAllGlobals();
});

describe('displayed review submission and confirmation', () => {
  it('sends the displayed identity directly, stays pending after socket write and ignores duplicate clicks', async () => {
    const socket = await connect();
    emit('session.changes', review());
    const displayed = wsStore.captureReview(state.activeSessionId)!;
    await wsStore.respondToChanges(state.activeSessionId, true, displayed);
    await wsStore.respondToChanges(state.activeSessionId, false, displayed);
    const commands = socket.send.mock.calls.map(([data]) => JSON.parse(data))
      .filter((data) => ['session.accept_changes', 'session.reject_changes'].includes(data.type));
    expect(commands).toEqual([expect.objectContaining({ type: 'session.accept_changes',
      reviewId: 'review-1', reviewRevision: 'revision-1', sessionId: state.activeSessionId })]);
    expect(wsStore.sessionReviews.get(state.activeSessionId)).toBe(displayed.review);
    expect(wsStore.reviewResponses.get(state.activeSessionId)?.phase).toBe('awaiting_confirmation');
    emit('session.changes_resolved', { reviewId: 'review-1', reviewRevision: 'revision-1', status: 'accepted' });
    expect(wsStore.sessionChanges.has(state.activeSessionId)).toBe(false);
    expect(wsStore.reviewResponses.has(state.activeSessionId)).toBe(false);
  });

  it('keeps a review and a retryable error when disconnected', async () => {
    emit('session.changes', review());
    const displayed = wsStore.captureReview(state.activeSessionId)!;
    await wsStore.respondToChanges(state.activeSessionId, false, displayed);
    expect(wsStore.sessionReviews.get(state.activeSessionId)).toBe(displayed.review);
    expect(wsStore.reviewResponses.get(state.activeSessionId)).toMatchObject({ phase: 'failed', error: expect.stringContaining('Connection lost') });
  });

  it.each([
    { status: 'accepted' }, { status: 'not_pending', reviewId: null },
    { status: 'not_pending', reviewRevision: 'revision-1' },
    { status: 'accepted', reviewId: 'review-1' },
    { status: 'accepted', reviewId: 'review-1', reviewRevision: null },
    { status: 'unknown', reviewId: 'review-1', reviewRevision: 'revision-1' },
    { status: 'accepted', reviewId: 'review-1', reviewRevision: 'old' },
  ])('does not erase an identified review for malformed/stale acknowledgment %j', (ack) => {
    emit('session.changes', review());
    const displayed = wsStore.sessionReviews.get(state.activeSessionId);
    emit('session.changes_resolved', ack);
    emit('session.accept_changes', {});
    expect(wsStore.sessionReviews.get(state.activeSessionId)).toBe(displayed);
  });

  it('accepts explicit authoritative absence without claiming execution', () => {
    emit('session.changes', review());
    emit('session.changes_resolved', { status: 'not_pending' });
    expect(wsStore.sessionReviews.has(state.activeSessionId)).toBe(false);
  });

  it('gives an identical republication a new lock and ignores the old revision acknowledgment', async () => {
    const socket = await connect();
    emit('session.changes', review());
    const old = wsStore.captureReview(state.activeSessionId)!;
    await wsStore.respondToChanges(state.activeSessionId, true, old);
    emit('session.changes', review('revision-2'));
    const current = wsStore.captureReview(state.activeSessionId)!;
    await wsStore.respondToChanges(state.activeSessionId, false, old);
    expect(wsStore.reviewResponses.has(state.activeSessionId)).toBe(false);
    emit('session.changes_resolved', { reviewId: 'review-1', reviewRevision: 'revision-1', status: 'accepted' });
    await wsStore.respondToChanges(state.activeSessionId, false, current);
    expect(socket.send.mock.calls.map(([data]) => JSON.parse(data)).filter((data) => data.reviewRevision).map((data) => data.reviewRevision))
      .toEqual(['revision-1', 'revision-2']);
  });

  it('invalidates callbacks across session A→B→A and host changes', async () => {
    const socket = await connect();
    emit('session.changes', review());
    const old = wsStore.captureReview(state.activeSessionId)!;
    sessionStore.activeSessionId = 'other';
    sessionStore.activeSessionId = old.review.sessionId;
    await wsStore.respondToChanges(state.activeSessionId, true, old);
    const current = wsStore.captureReview(state.activeSessionId)!;
    state.origin = 'https://another-host.example';
    await wsStore.respondToChanges(state.activeSessionId, true, current);
    expect(socket.send.mock.calls.map(([data]) => JSON.parse(data)).filter((data) => data.reviewRevision)).toHaveLength(0);
  });

  it('does not substitute a new publication for a button clicked before Svelte commits it', async () => {
    const socket = await connect();
    emit('session.changes', review());
    const ui = render(ChangesSummary);
    const button = ui.getByRole('button', { name: 'Keep All' });
    emit('session.changes', review('revision-2'));
    button.click();
    await tick();
    expect(socket.send.mock.calls.map(([data]) => JSON.parse(data)).filter((data) => data.reviewRevision)).toHaveLength(0);
    ui.getByRole('button', { name: 'Keep All' }).click();
    await tick();
    expect(socket.send.mock.calls.map(([data]) => JSON.parse(data)).filter((data) => data.reviewRevision)).toEqual([
      expect.objectContaining({ reviewRevision: 'revision-2' }),
    ]);
  });

  it('keeps the submission lock and waiting feedback when the review component remounts', async () => {
    await connect();
    emit('session.changes', review());
    const first = render(ChangesSummary);
    first.getByRole('button', { name: 'Keep All' }).click();
    await tick();
    first.unmount();
    const second = render(ChangesSummary);
    expect(second.getByRole('button', { name: 'Reject All' })).toBeDisabled();
    expect(second.getByRole('status')).toHaveTextContent('Waiting for confirmation');
  });

  it('awaits the demo mutation and refuses a publication replaced during the import', async () => {
    state.demo = true;
    wsStore.setDemoSessionChanges(state.activeSessionId, review().changes);
    const original = wsStore.captureReview(state.activeSessionId)!;
    const stale = wsStore.respondToChanges(state.activeSessionId, true, original);
    wsStore.setDemoSessionChanges(state.activeSessionId, review().changes);
    await stale;
    expect(resolveDemoReview).not.toHaveBeenCalled();
    const pending = deferred<void>();
    state.demoResult = pending.promise;
    const displayed = wsStore.captureReview(state.activeSessionId)!;
    const applying = wsStore.respondToChanges(state.activeSessionId, true, displayed);
    await waitFor(() => expect(resolveDemoReview).toHaveBeenCalledOnce());
    expect(wsStore.sessionReviews.get(state.activeSessionId)).toBe(displayed.review);
    pending.resolve();
    await applying;
    expect(wsStore.sessionReviews.has(state.activeSessionId)).toBe(false);
  });
});

describe('Stop then Send cancellation handoff', () => {
  it('coalesces repeated session stops and holds the next send until cancellation settles', async () => {
    const cancellation = deferred<any>();
    state.request = async (path) => path.includes('/cancel') ? cancellation.promise : response({ messageId: 'message-1' });

    const first = wsStore.cancelSession(state.activeSessionId);
    const second = wsStore.cancelSession(state.activeSessionId);
    const sending = wsStore.sendMessage(state.activeSessionId, 'next turn');

    expect(first).toBe(second);
    expect(wsStore.isCancellationPending(state.activeSessionId)).toBe(true);
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);

    // The terminal projection may make the old run look idle before the HTTP
    // cancel response returns. The captured cancellation still gates sending.
    emit('run.state', { snapshot: { phase: 'done', status: 'terminal', revision: 2 } });
    await Promise.resolve();
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);

    cancellation.resolve(response({ accepted: true }));
    await expect(Promise.all([first, second, sending])).resolves.toEqual([undefined, undefined, true]);
    expect(runStateStore.markUserStopped).toHaveBeenCalledWith(state.activeSessionId);
    expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual([
      `/api/sessions/${state.activeSessionId}/cancel`,
      '/api/messages',
    ]);
    expect(wsStore.isCancellationPending(state.activeSessionId)).toBe(false);
  });

  it('steers by cancelling the active run before admitting the replacement message', async () => {
    const cancellation = deferred<any>();
    state.request = async (path) =>
      path.includes('/cancel') ? cancellation.promise : response({ messageId: 'steer-message' });

    const steering = wsStore.steerMessage(
      state.activeSessionId,
      'Actually, inspect the failing test first.',
      'openai:gpt-5',
      'high',
    );

    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiFetch).mock.calls[0]?.[0]).toBe(
      `/api/sessions/${state.activeSessionId}/cancel`,
    );

    cancellation.resolve(response({ accepted: true }));
    await expect(steering).resolves.toBe(true);
    expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual([
      `/api/sessions/${state.activeSessionId}/cancel`,
      '/api/messages',
    ]);
  });

  it('reports an HTTP or JSON failure and does not optimistically add a message', async () => {
    const cancellation = deferred<any>();
    state.request = async (path) => path.includes('/cancel')
      ? cancellation.promise
      : response({ messageId: 'should-not-send' });
    const before = wsStore.feed.length;

    const stop = wsStore.cancelSession(state.activeSessionId);
    const sending = wsStore.sendMessage(state.activeSessionId, 'draft stays');
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
    cancellation.resolve(response({}, false, 409));
    await expect(stop).rejects.toThrow('Could not stop this session');
    await expect(sending).resolves.toBe(false);
    expect(runStateStore.markUserStopped).not.toHaveBeenCalled();
    expect(toastStore.error).toHaveBeenCalledWith(expect.stringContaining('Could not stop this session'));
    expect(wsStore.feed).toHaveLength(before);
    expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual([
      `/api/sessions/${state.activeSessionId}/cancel`,
    ]);
  });

  it('isolates agent cancellation by session and coalesces only the same agent turn', async () => {
    const cancellation = deferred<any>();
    state.request = async (path) => path.includes('/cancel') ? cancellation.promise : response({ ok: true });

    const stopA = wsStore.cancelAgent('session-a', 'agent-1');
    const repeatA = wsStore.cancelAgent('session-a', 'agent-1');
    const sendB = wsStore.sendAgentMessage('session-b', 'agent-1', 'B turn');

    expect(stopA).toBe(repeatA);
    await expect(sendB).resolves.toBe(true);
    expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual([
      '/api/agent/agent-1/cancel',
      '/api/agent/agent-1/message',
    ]);
    expect(wsStore.isCancellationPending('session-a', 'agent-1')).toBe(true);
    expect(wsStore.isCancellationPending('session-b', 'agent-1')).toBe(false);

    cancellation.resolve(response({ accepted: true }));
    await expect(Promise.all([stopA, repeatA])).resolves.toEqual([undefined, undefined]);
    expect(wsStore.isCancellationPending('session-a', 'agent-1')).toBe(false);
  });
});

describe('linked review execution and snapshot ordering', () => {
  async function open(target = chat(`linked-${sequence}`), data = snapshot(target, { review: review(), question: question() })) {
    state.request = async () => response(data);
    await deviceStore.openChat(target);
    return target;
  }

  it('sends exact linked revision and closes only on an execution acknowledgment for that revision', async () => {
    const target = await open();
    const key = deviceSessionKey(target);
    const displayed = wsStore.captureReview(key)!;
    const pending = deferred<any>();
    state.request = () => pending.promise;
    const submitting = wsStore.respondToChanges(key, false, displayed);
    expect(wsStore.reviewResponses.get(key)?.phase).toBe('submitting');
    await wsStore.respondToChanges(key, true, displayed);
    expect(rpcBodies().filter((body) => body.operation === 'review')).toEqual([
      { operation: 'review', input: { sessionId: target.id, accept: false, reviewId: 'review-1', reviewRevision: 'revision-1' } },
    ]);
    pending.resolve(response({ reviewed: true, reviewId: 'review-1', reviewRevision: 'revision-1', status: 'rejected' }));
    await submitting;
    expect(deviceStore.snapshot?.review).toBeNull();
  });

  it.each([response({}, true), response({ reviewed: true, reviewId: 'review-1', reviewRevision: 'old', status: 'accepted' }), response({}, false)])
    ('preserves a linked review when transport success lacks a valid execution result', async (result) => {
      const target = await open();
      state.request = async () => result;
      const key = deviceSessionKey(target);
      await wsStore.respondToChanges(key, true, wsStore.captureReview(key)!);
      expect(deviceStore.snapshot?.review?.reviewRevision).toBe('revision-1');
      expect(wsStore.reviewResponses.get(key)?.phase).toBe('uncertain');
    });

  it('does not let a late RPC response resolve a same-ID replacement review', async () => {
    const target = await open();
    const key = deviceSessionKey(target);
    const pending = deferred<any>();
    state.request = () => pending.promise;
    const submitting = wsStore.respondToChanges(key, true, wsStore.captureReview(key)!);
    linkedEvent(target, 'session.changes', review('revision-2'));
    pending.resolve(response({ reviewed: true, reviewId: 'review-1', reviewRevision: 'revision-1', status: 'accepted' }));
    await submitting;
    expect(deviceStore.snapshot?.review?.reviewRevision).toBe('revision-2');
    expect(wsStore.reviewResponses.has(key)).toBe(false);
  });

  it('retains per-kind attention events and resolutions received while opening', async () => {
    const target = chat(`opening-${sequence}`);
    const pending = deferred<any>();
    state.request = () => pending.promise;
    const opening = deviceStore.openChat(target);
    linkedEvent(target, 'session.changes', review('newer'));
    linkedEvent(target, 'kory.ask_user_resolved', { questionId: 'question-1', status: 'answered' });
    pending.resolve(response(snapshot(target, { review: review('older'), question: question() })));
    await opening;
    expect(deviceStore.snapshot?.review?.reviewRevision).toBe('newer');
    expect(deviceStore.snapshot?.question).toBeNull();
  });

  it('does not let question or output events suppress the independently loading review', async () => {
    const target = chat(`independent-${sequence}`);
    const pending = deferred<any>();
    state.request = () => pending.promise;
    const opening = deviceStore.openChat(target);
    linkedEvent(target, 'kory.ask_user', question('new-question'));
    linkedEvent(target, 'stream.delta', { agentId: 'kory-manager', content: 'live' });
    pending.resolve(response(snapshot(target, { review: review(), question: null })));
    await opening;
    expect(deviceStore.snapshot?.question?.questionId).toBe('new-question');
    expect(deviceStore.snapshot?.review?.reviewRevision).toBe('revision-1');
    expect(deviceStore.drafts['kory-manager']).toBe('live');
  });

  it('ignores malformed/old resolutions and malformed or missing snapshot attention', async () => {
    const target = await open();
    linkedEvent(target, 'session.changes_resolved', { status: 'accepted', reviewId: 'review-1' });
    linkedEvent(target, 'kory.ask_user_resolved', { status: 'answered', questionId: 'other' });
    state.request = async () => response({ chat: target, review: { changes: null }, question: undefined });
    await deviceStore.refreshChat();
    expect(deviceStore.snapshot?.review?.reviewRevision).toBe('revision-1');
    expect(deviceStore.snapshot?.question?.questionId).toBe('question-1');
    state.request = async () => response(snapshot(target));
    await deviceStore.refreshChat();
    expect(deviceStore.snapshot?.review).toBeNull();
    expect(deviceStore.snapshot?.question).toBeNull();
  });

  it('rejects older refreshes after a newer refresh and keeps run revisions monotonic', async () => {
    const target = await open();
    const older = deferred<any>();
    const newer = deferred<any>();
    let calls = 0;
    state.request = () => (++calls === 1 ? older.promise : newer.promise);
    const first = deviceStore.refreshChat();
    const second = deviceStore.refreshChat();
    newer.resolve(response(snapshot(target, { review: review('newer'), run: { phase: 'working', status: 'active', revision: 20 } })));
    await second;
    linkedEvent(target, 'stream.delta', { agentId: 'kory-manager', content: 'working' });
    older.resolve(response(snapshot(target, { review: null, run: { phase: 'done', status: 'terminal', revision: 2 } })));
    await first;
    linkedEvent(target, 'run.state', { snapshot: { phase: 'done', status: 'terminal', revision: 3 }, transition: null });
    expect(deviceStore.snapshot?.run?.revision).toBe(20);
    expect(deviceStore.snapshot?.review?.reviewRevision).toBe('newer');
    expect(deviceStore.drafts['kory-manager']).toBe('working');
  });

  it('keeps late send completion from clearing a changed draft or refreshing another chat', async () => {
    const target = await open();
    const owner = deviceStore.captureChat()!;
    deviceStore.setComposerDraft(owner, 'original');
    const pending = deferred<any>();
    state.request = () => pending.promise;
    const sending = deviceStore.send('original', owner);
    deviceStore.setComposerDraft(owner, 'new draft');
    const other = chat(`other-${sequence}`);
    state.request = async () => response(snapshot(other));
    await deviceStore.openChat(other);
    const before = rpcBodies().filter((body) => body.operation === 'snapshot').length;
    pending.resolve(response({ accepted: true }));
    await sending;
    expect(rpcBodies().filter((body) => body.operation === 'snapshot')).toHaveLength(before);
    state.request = async () => response(snapshot(target));
    await deviceStore.openChat(target);
    expect(deviceStore.composerText).toBe('new draft');
    expect(deviceStore.ownsChat(owner)).toBe(false);
    await deviceStore.cancel(owner);
    expect(rpcBodies().filter((body) => body.operation === 'cancel')).toHaveLength(0);
  });

  it('rejects linked review and question clicks whose displayed prompt was replaced before commit', async () => {
    const target = await open();
    const ui = render(DeviceChatView);
    const keep = ui.getByRole('button', { name: 'Keep changes' });
    const answer = ui.getByRole('button', { name: 'Yes' });
    linkedEvent(target, 'session.changes', review('revision-2'));
    linkedEvent(target, 'kory.ask_user', question('question-2'));
    keep.click();
    answer.click();
    await tick();
    expect(rpcBodies().filter((body) => ['review', 'answer'].includes(body.operation))).toHaveLength(0);
  });

  it('keeps linked component submission locks after remount and snapshot replay', async () => {
    const target = await open();
    const pending = deferred<any>();
    state.request = () => pending.promise;
    const first = render(DeviceChatView);
    first.getByRole('button', { name: 'Keep changes' }).click();
    await tick();
    first.unmount();
    const second = render(DeviceChatView);
    expect(second.getByRole('button', { name: 'Keep changes' })).toBeDisabled();
    linkedEvent(target, 'session.changes', review());
    await tick();
    expect(second.getByRole('button', { name: 'Reject changes' })).toBeDisabled();
    pending.resolve(response({ reviewed: true, reviewId: 'review-1', reviewRevision: 'revision-1', status: 'accepted' }));
    await waitFor(() => expect(second.queryByRole('button', { name: 'Keep changes' })).toBeNull());
  });

  it('does not allow an old open to overwrite A after navigating A→B→A', async () => {
    const a = chat(`return-a-${sequence}`);
    const b = chat(`return-b-${sequence}`);
    const pending = deferred<any>();
    state.request = () => pending.promise;
    const first = deviceStore.openChat(a);
    state.request = async () => response(snapshot(b));
    await deviceStore.openChat(b);
    state.request = async () => response(snapshot(a, { review: review('newest') }));
    await deviceStore.openChat(a);
    pending.resolve(response(snapshot(a, { review: review('obsolete') })));
    await first;
    expect(deviceStore.snapshot?.review?.reviewRevision).toBe('newest');
  });

  it('does not clear a draft edited back to identical text while its send is pending', async () => {
    const target = await open();
    const owner = deviceStore.captureChat()!;
    deviceStore.setComposerDraft(owner, 'original');
    const pending = deferred<any>();
    state.request = () => pending.promise;
    const sending = deviceStore.send('original', owner);
    deviceStore.setComposerDraft(owner, 'edited');
    deviceStore.setComposerDraft(owner, 'original');
    state.request = async () => response(snapshot(target));
    pending.resolve(response({ accepted: true }));
    await sending;
    expect(deviceStore.composerText).toBe('original');
  });

  it('shares reconnect snapshot guards with live attention events', async () => {
    const target = await open();
    await connect();
    const pending = deferred<any>();
    state.request = () => pending.promise;
    wsStore.subscribeToSession(deviceSessionKey(target));
    await waitFor(() => expect(rpcBodies().filter((body) => body.operation === 'open_chat').length).toBeGreaterThan(1));
    linkedEvent(target, 'session.changes_resolved', { reviewId: 'review-1', reviewRevision: 'revision-1', status: 'accepted' });
    linkedEvent(target, 'kory.ask_user', question('new-question'));
    pending.resolve(response(snapshot(target, { review: review(), question: question('old-question') })));
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deviceStore.snapshot?.review).toBeNull();
    expect(wsStore.sessionReviews.has(deviceSessionKey(target))).toBe(false);
    expect(deviceStore.snapshot?.question?.questionId).toBe('new-question');
    expect(wsStore.pendingQuestion?.questionId).toBe('new-question');
  });

  it('rejects stale question resolution and malformed absence on the main websocket projection', () => {
    emit('kory.ask_user', question());
    emit('kory.ask_user_resolved', { questionId: 'other', status: 'answered' });
    emit('kory.ask_user_resolved', { questionId: null, status: 'not_pending' });
    emit('kory.ask_user_resolved', { status: 'answered' });
    expect(wsStore.pendingQuestion?.questionId).toBe('question-1');
    emit('kory.ask_user_resolved', { status: 'not_pending' });
    expect(wsStore.pendingQuestion).toBeNull();
  });
});
