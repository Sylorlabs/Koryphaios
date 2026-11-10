import { DeviceClient, makeDeviceIdentity } from '../shared/src/device-client';
import type {
  DeviceIdentity,
  LinkedDevice,
  DeviceWorkspace,
  DeviceChat,
} from '../shared/src/devices';

const view = document.getElementById('view')!;
const error = document.getElementById('error')!;
const params = new URLSearchParams(location.hash.slice(1));
const initialCode = params.get('code') ?? '';
const pin = params.get('host') ?? undefined;
history.replaceState(null, '', location.pathname);
type State = { identity: DeviceIdentity; privateKey: JsonWebKey; peers: LinkedDevice[] };
let state: State;
let client: DeviceClient;
let gateway: string;
let target: string;
let chat: DeviceChat | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let database: IDBDatabase;
let refreshInFlight = false;
const drafts = new Map<string, string>();
function liveTranscript() {
  const area = document.getElementById('live-transcript');
  if (!area) return;
  area.replaceChildren();
  for (const [agent, content] of drafts) {
    const article = node('article', '', 'message');
    article.append(
      node('small', `${agent === 'kory-manager' ? 'Kory' : agent} · live`),
      node('div', content),
    );
    area.append(article);
  }
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}
function button(text: string, task: () => Promise<unknown> | unknown, className = '') {
  const element = node('button', text, className);
  element.onclick = async () => {
    element.disabled = true;
    error.textContent = '';
    try {
      await task();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : 'Device action failed';
    } finally {
      element.disabled = false;
    }
  };
  return element;
}
function render(...nodes: Node[]) {
  view.replaceChildren(...nodes);
}
function save() {
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('state', 'readwrite');
    transaction.objectStore('state').put(state, 'identity');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
async function initialize() {
  if (!crypto.subtle) throw new Error('Open this controller over HTTPS to link securely.');
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('koryphaios-mobile-device', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  state = await new Promise((resolve, reject) => {
    const request = database.transaction('state').objectStore('state').get('identity');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!state) {
    const os = /Android/i.test(navigator.userAgent)
      ? 'Android'
      : /iPhone|iPad/i.test(navigator.userAgent)
        ? 'iOS'
        : 'Mobile';
    state = { ...(await makeDeviceIdentity(`${os} controller`, os, 'mobile')), peers: [] };
    await save();
  }
  client = new DeviceClient({
    relayUrl: location.origin,
    identity: state.identity,
    privateKey: state.privateKey,
    peers: () => state.peers,
    onPairRequest: () => {},
    onPaired: async (identity) => {
      if (!state.peers.some((p) => p.id === identity.id))
        state.peers.push({ ...identity, linkedAt: Date.now(), online: true, allowAgents: false });
      await save();
      gateway = identity.id;
      void showDevices().catch((e) => {
        error.textContent = e instanceof Error ? e.message : 'Could not load desktops';
      });
    },
    onRequest: async () => {
      throw new Error('Mobile controllers do not host workspaces');
    },
    onEvent: (peer, body) => {
      if (
        body.type === 'event' &&
        chat &&
        body.sessionId === chat.id &&
        (peer.id === target || (peer.id === gateway && body.targetDeviceId === target))
      ) {
        const event = body.event as { type: string; payload: any };
        const payload = event?.payload;
        if (event?.type === 'stream.delta' && typeof payload?.content === 'string') {
          const id = String(payload.agentId);
          drafts.set(id, ((drafts.get(id) ?? '') + payload.content).slice(-160_000));
          liveTranscript();
        }
        if (event?.type === 'stream.clear_content') {
          drafts.delete(String(payload?.agentId));
          liveTranscript();
        }
        if (event?.type === 'run.state' && payload?.snapshot?.status !== 'active')
          void refreshTranscript().catch(() => undefined);
        if (event?.type === 'system.error')
          error.textContent = String(payload?.error ?? payload?.message ?? 'Remote request failed');
      }
      if (body.type === 'unlinked') {
        state.peers = state.peers.filter((p) => p.id !== peer.id);
        void save();
        chat = null;
        pairScreen();
      }
      if (body.type === 'pair-rejected') {
        error.textContent = 'The desktop declined this link. Create a new code to try again.';
        pairScreen();
      }
    },
  });
  await client.connect();
  if (initialCode || !state.peers.length) pairScreen();
  else {
    gateway = state.peers[0]!.id;
    await showDevices();
  }
}
function pairScreen() {
  if (refreshTimer) clearInterval(refreshTimer);
  chat = null;
  const input = node('input');
  input.placeholder = 'XXXXX-XXXXX-XXXXX-XXXXX';
  input.value = initialCode;
  input.maxLength = 30;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Desktop pairing code');
  const explanation = node(
    'p',
    'On your desktop, open Link device and create a pairing code. Scan its QR code or enter the code here.',
  );
  render(
    node('h2', 'Link your desktop'),
    explanation,
    input,
    button(
      'Connect desktop',
      async () => {
        const result = await client.pair(input.value, pin);
        render(
          node('h2', `Check ${result.identity.name}`),
          node('div', result.check, 'check'),
          node(
            'p',
            'Compare these numbers with the desktop’s Link device screen, then approve there. This phone can steer that desktop and its linked desktops.',
          ),
          button('Back', () => pairScreen()),
        );
      },
      'primary',
    ),
  );
}
async function call(operation: string, input: Record<string, unknown> = {}) {
  return target === gateway
    ? client.rpc(gateway, operation, input)
    : client.rpc(gateway, 'forward', { deviceId: target, operation, input });
}
async function showDevices() {
  if (chat) void call('close_chat', { sessionId: chat.id }).catch(() => undefined);
  if (refreshTimer) clearInterval(refreshTimer);
  chat = null;
  const stack = node('div', '', 'stack');
  const listed = new Map<string, DeviceIdentity & { online?: boolean }>();
  for (const paired of state.peers) {
    try {
      const devices = await client.rpc(paired.id, 'devices');
      for (const device of devices)
        if (device.kind === 'desktop') listed.set(device.id, { ...device, gateway: paired.id });
    } catch {
      listed.set(paired.id, { ...paired, online: false });
    }
  }
  for (const device of listed.values()) {
    const element = button(
      device.name,
      async () => {
        target = device.id;
        gateway = (device as any).gateway ?? device.id;
        await showWorkspaces();
      },
      'device',
    );
    element.append(
      node('span', `${device.os} · ${device.online === false ? 'Offline' : 'Connected'}`),
    );
    element.disabled = device.online === false;
    stack.append(element);
  }
  render(
    node('h2', 'Your desktops'),
    node('p', 'Choose where to work. You can steer each linked desktop from here.'),
    stack,
    button('+ Link another desktop', () => pairScreen()),
  );
}
async function showWorkspaces() {
  if (chat) void call('close_chat', { sessionId: chat.id }).catch(() => undefined);
  if (refreshTimer) clearInterval(refreshTimer);
  chat = null;
  drafts.clear();
  const workspaces: DeviceWorkspace[] = await call('workspaces');
  const chats: DeviceChat[] = await call('sessions');
  const stack = node('div', '', 'stack');
  for (const workspace of workspaces)
    stack.append(button(workspace.name, () => showFolders(workspace), 'device'));
  const recent = node('div', '', 'stack');
  for (const item of chats.slice(-10).reverse())
    recent.append(button(`${item.title} · ${item.workspaceName}`, () => openChat(item), 'device'));
  render(
    button('← Desktops', showDevices),
    node('h2', 'Choose a workspace'),
    stack,
    ...(!workspaces.length
      ? [
          node(
            'p',
            'Open a workspace on this desktop first. Its local paths never need to be entered on your phone.',
          ),
        ]
      : []),
    node('h3', 'Recent chats'),
    recent,
  );
}
async function showFolders(workspace: DeviceWorkspace) {
  const folders: DeviceWorkspace[] = await call('folders', { workspaceId: workspace.id });
  const stack = node('div', '', 'stack');
  const create = async (folder: DeviceWorkspace) =>
    openChat(await call('create_chat', { workspaceId: folder.id }));
  for (const folder of folders) stack.append(button(folder.name, () => create(folder), 'device'));
  render(
    button('← Workspaces', showWorkspaces),
    node('h2', workspace.name),
    button(`New chat in ${workspace.name}`, () => create(workspace), 'primary'),
    node('h3', 'Project folders'),
    stack,
  );
}
async function openChat(item: DeviceChat) {
  drafts.clear();
  chat = item;
  await call('open_chat', { sessionId: item.id });
  await drawChat();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(
    () =>
      void refreshTranscript().catch(() => {
        error.textContent = 'Desktop connection interrupted. Reconnect to continue.';
      }),
    3000,
  );
}
async function refreshTranscript() {
  if (!chat || refreshInFlight) return;
  refreshInFlight = true;
  const current = chat;
  const currentTarget = target;
  try {
    const snapshot = await call('snapshot', { sessionId: chat.id });
    if (chat !== current || target !== currentTarget) return;
    if (snapshot.run?.status === 'terminal' || snapshot.run?.status === 'idle') {
      drafts.clear();
      liveTranscript();
    }
    const area = document.getElementById('transcript');
    if (!area) return;
    area.replaceChildren();
    for (const message of snapshot.messages) {
      const element = node('article', '', 'message');
      element.append(
        node('small', message.role === 'user' ? 'You' : 'Kory'),
        node('div', message.content),
      );
      area.append(element);
    }
    const status = document.getElementById('run-status');
    if (status) status.textContent = snapshot.run?.phase ?? 'Connected';
    const decisions = document.getElementById('decisions');
    if (!decisions) return;
    decisions.replaceChildren();
    if (snapshot.question) {
      decisions.append(node('h3', snapshot.question.question));
      for (const option of snapshot.question.options)
        decisions.append(
          button(option, async () => {
            await call('answer', {
              sessionId: chat!.id,
              questionId: snapshot.question.questionId,
              selection: option,
            });
            await refreshTranscript();
          }),
        );
    }
    if (snapshot.review) {
      decisions.append(node('h3', 'Review desktop changes'));
      for (const change of snapshot.review.changes)
        decisions.append(
          node('p', `${change.path} · +${change.linesAdded} / −${change.linesDeleted}`),
        );
      for (const accept of [true, false])
        decisions.append(
          button(accept ? 'Keep changes' : 'Reject changes', async () => {
            await call('review', {
              sessionId: chat!.id,
              reviewId: snapshot.review.reviewId,
              accept,
            });
            await refreshTranscript();
          }),
        );
    }
  } finally {
    refreshInFlight = false;
  }
}
async function drawChat() {
  const transcript = node('div');
  transcript.id = 'transcript';
  const decisions = node('div', '', 'row');
  const live = node('div');
  live.id = 'live-transcript';
  decisions.id = 'decisions';
  const input = node('textarea');
  input.placeholder = `Message ${chat!.deviceName}`;
  input.setAttribute('aria-label', 'Message desktop');
  const composer = node('div', '', 'composer');
  composer.append(
    input,
    button(
      'Send',
      async () => {
        if (!input.value.trim()) return;
        const result = await call('prompt', { sessionId: chat!.id, content: input.value });
        if (!result.accepted) throw new Error('This chat is busy. Wait or stop its current task.');
        input.value = '';
        input.blur();
        await refreshTranscript();
      },
      'primary',
    ),
    button('Stop', () => call('cancel', { sessionId: chat!.id })),
  );
  const status = node('span', '', 'muted');
  status.id = 'run-status';
  render(
    button('← Workspaces', showWorkspaces),
    node('h2', chat!.deviceName),
    node('p', chat!.workspaceName),
    status,
    transcript,
    live,
    decisions,
    composer,
  );
  await refreshTranscript();
}
void initialize().catch((e) => {
  error.textContent = e instanceof Error ? e.message : 'Could not load mobile controller';
  render(node('h2', 'Unable to connect'), node('p', 'Check your connection and reload this page.'));
});
