import { hostname, homedir } from 'node:os';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
  readdirSync,
  lstatSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { join, basename, dirname, parse } from 'node:path';
import { hostOS, isContainedBy, isWindows } from '../runtime/platform';
import { randomUUID, createHash } from 'node:crypto';
import { PROJECT_ROOT } from '../runtime/paths';
import { ensureSecureDir } from '../security/fs-permissions';
import {
  DeviceClient,
  makeDeviceIdentity,
  type DeviceBody,
} from '@koryphaios/shared/src/device-client';
import { openDeviceMessage, sealDeviceMessage } from '@koryphaios/shared/src/devices';
import type { DeviceIdentity, LinkedDevice, DeviceWorkspace } from '@koryphaios/shared/src/devices';
import { validateDeviceRelayUrl } from '@koryphaios/shared/src/devices';
import { getContext } from '../context';
import { normalizeSpeedTier } from '../providers/speed-tiers';
import { getDb } from '../db';
import { WorkspaceNavigationStore } from '../stores/workspace-navigation-store';
import { getPendingQuestion } from '../stores/pending-question-store';
import { getPendingSessionReview } from '../stores/session-review-store';
import { toolApprovalQueue } from '../tools/approval-queue';
import { buildDeviceProviderBundle, stageDeviceProviders } from './provider-bundle';
import { withProviderExecutionScope } from '../providers/execution-scope';
import { executeDeviceWorkbench } from './workbench';
import { getOrderedEventLog, prunedBoundaryAhead } from '../ws/ordered-event-log';
import type { SessionHistoryPrunedPayload, WSMessage } from '@koryphaios/shared';
import { parseDevicePrompt } from './prompt';
import {
  normalizeComputeDelegation,
  type ComputeDelegation,
} from '@koryphaios/shared/src/compute-delegation';
import { exportWorkspaceChanges } from './delegated-work';

type Store = {
  identity: DeviceIdentity;
  privateKey: JsonWebKey;
  peers: LinkedDevice[];
  /** User access across approved links; deliberately independent of agent grants. */
  accountWideDeviceAccess: boolean;
  allowAgentRouting: string[];
  requests?: Record<string, number>;
  relayUrl?: string;
  selectedWorkspaceRoots?: string[];
  /** Per-chat delegation policy. `stay` is the default for a chat created here. */
  delegations?: Record<string, ComputeDelegation>;
};
type PairRequest = { id: string; identity: DeviceIdentity; check: string; expiresAt: number };
const OS_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** Display name for this host, sent to paired devices as the device OS. */
function hostOSName(): string {
  const os = hostOS();
  return OS_NAMES[os] ?? os;
}
export class DeviceService {
  private store: Store | null = null;
  private client: DeviceClient | null = null;
  private ready: Promise<void> | null = null;
  private error: string | null = null;
  private online = new Map<string, number>();
  private pairRequests = new Map<string, PairRequest>();
  private watches = new Map<string, () => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private outboundPending = new Set<string>();
  private gatewayWatches = new Map<string, Set<string>>();
  private providerRuns = new Map<
    string,
    {
      peerId: string;
      staged: ReturnType<typeof stageDeviceProviders>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private folderHandles = new Map<string, { path: string; owner: string; expiresAt: number }>();
  constructor(
    private readonly root = PROJECT_ROOT,
    private readonly configuredRelayUrl?: string,
  ) {}
  private get relayUrl() {
    return this.store?.relayUrl ?? this.configuredRelayUrl ?? process.env.RELAY_URL ?? '';
  }
  private path() {
    return join(this.root, '.koryphaios', 'linked-devices.json');
  }
  private save() {
    ensureSecureDir(join(this.root, '.koryphaios'));
    const path = this.path();
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.store), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  }
  async initialize() {
    if (this.ready) return this.ready;
    this.ready = this.initializeOnce();
    return this.ready;
  }
  private async initializeOnce() {
    ensureSecureDir(join(this.root, '.koryphaios'));
    if (existsSync(this.path())) {
      const file = lstatSync(this.path());
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.nlink !== 1 ||
        (!isWindows() && file.uid !== process.getuid?.())
      )
        throw new Error('Linked-device state must be a private, owned regular file');
      chmodSync(this.path(), 0o600);
      this.store = JSON.parse(readFileSync(this.path(), 'utf8')) as Store;
      if (
        !this.store?.identity ||
        !this.store.privateKey ||
        !Array.isArray(this.store.peers) ||
        !Array.isArray(this.store.allowAgentRouting)
      )
        throw new Error('Linked-device state is unreadable');
      // Older state files predate the account-optional device-network access
      // setting. Preserve their existing links and enable user access by
      // default; agent grants remain separately default-denied.
      this.store.accountWideDeviceAccess = this.store.accountWideDeviceAccess !== false;
    } else {
      this.store = {
        ...(await makeDeviceIdentity(hostname(), hostOSName(), 'desktop')),
        peers: [],
        accountWideDeviceAccess: true,
        allowAgentRouting: [],
      };
      this.save();
    }
    await this.connectRelay();
  }
  private async connectRelay() {
    if (!this.relayUrl) {
      this.error = 'Configure an HTTPS device relay to link devices.';
      return;
    }
    this.client = new DeviceClient({
      relayUrl: this.relayUrl,
      identity: this.store!.identity,
      privateKey: this.store!.privateKey,
      onConnection: (connected) => {
        if (connected) this.error = null;
      },
      peers: () => this.store!.peers,
      onPairRequest: (request) => this.pairRequests.set(request.id, request),
      onPaired: async (identity) => {
        if (!this.store!.peers.some((p) => p.id === identity.id))
          this.store!.peers.push({
            ...identity,
            linkedAt: Date.now(),
            online: true,
            allowAgents: false,
          });
        this.online.set(identity.id, Date.now());
        this.outboundPending.delete(identity.id);
        this.save();
      },
      onRequest: (peer, operation, input, actor, requestId) =>
        this.execute(peer, operation, input, actor, requestId),
      onEvent: (peer, body) => {
        this.online.set(peer.id, Date.now());
        if (body.type === 'unlinked') {
          this.removePeer(peer.id);
          return;
        }
        if (body.type === 'pair-rejected') this.outboundPending.delete(peer.id);
        if (body.type === 'event') {
          getContext().wsManager.broadcast({
            type: 'device.event',
            payload: { deviceId: peer.id, ...body },
            timestamp: Date.now(),
          });
          for (const id of this.gatewayWatches.get(`${peer.id}:${String(body.sessionId)}`) ?? []) {
            const mobile = this.store!.peers.find((p) => p.id === id && p.kind === 'mobile');
            if (mobile)
              void this.client
                ?.send(mobile, { ...body, targetDeviceId: peer.id })
                .catch(() => undefined);
          }
        }
      },
    });
    try {
      await this.client.connect();
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Relay unavailable';
    }
    this.heartbeat = setInterval(() => {
      void this.probePeers();
    }, 15_000);
    this.heartbeat.unref?.();
    void this.probePeers();
  }
  private async probePeers() {
    if (!this.client?.connected) return;
    for (const peer of this.store!.peers) {
      void this.client
        .rpc(peer.id, 'identity')
        .then((identity: DeviceIdentity) => {
          this.online.set(peer.id, Date.now());
          if (identity.name !== peer.name) {
            peer.name = identity.name;
            this.save();
          }
        })
        .catch(() => this.online.delete(peer.id));
    }
  }
  status() {
    const now = Date.now();
    return {
      local: this.store?.identity ?? null,
      workbenchVersion: 1,
      osName: hostname(),
      connected: this.client?.connected ?? false,
      relayUrl: this.relayUrl || null,
      error: this.error,
      accountWideDeviceAccess: this.store?.accountWideDeviceAccess !== false,
      peers: (this.store?.peers ?? []).map((peer) => ({
        ...peer,
        online: (this.online.get(peer.id) ?? 0) > now - 45_000,
        agentRouting: this.store!.allowAgentRouting.includes(peer.id),
      })),
      requests: [...this.pairRequests.values()].filter((r) => r.expiresAt > now),
      pendingPairIds: [...this.outboundPending],
    };
  }
  async rename(name: string) {
    const clean = name.trim();
    if (!clean || clean.length > 80 || /[\x00-\x1f\x7f]/.test(clean))
      throw new Error('Use a device name between 1 and 80 characters');
    this.store!.identity.name = clean;
    this.save();
    // The authenticated registry and subsequent pairings must see the new name.
    this.client?.stop();
    if (this.client) await this.client.connect();
    return this.status();
  }
  async configureRelay(value: string) {
    const relayUrl = value.trim() ? validateDeviceRelayUrl(value.trim()) : '';
    await this.stopInvite().catch(() => undefined);
    this.stop();
    this.client = null;
    this.online.clear();
    this.gatewayWatches.clear();
    this.outboundPending.clear();
    this.store!.relayUrl = relayUrl;
    this.save();
    await this.connectRelay();
    return this.status();
  }
  configureAccountWideDeviceAccess(enabled: boolean) {
    this.store!.accountWideDeviceAccess = enabled;
    this.save();
    return this.status();
  }
  async invite() {
    if (!this.client) throw new Error(this.error ?? 'Relay unavailable');
    return this.client.invite();
  }
  async stopInvite() {
    await this.client?.stopInvite();
    this.pairRequests.clear();
  }
  async pair(code: string) {
    if (!this.client) throw new Error(this.error ?? 'Relay unavailable');
    const result = await this.client.pair(code);
    this.outboundPending.add(result.identity.id);
    return result;
  }
  async decide(id: string, approved: boolean) {
    await this.client!.decidePair(id, approved);
    this.pairRequests.delete(id);
    return this.status();
  }
  private removePeer(id: string) {
    for (const [sessionId, run] of this.providerRuns)
      if (run.peerId === id) {
        void getContext()
          .kory.cancelSessionWorkers(sessionId)
          .catch(() => undefined);
        clearTimeout(run.timer);
        run.staged.cleanup();
        this.providerRuns.delete(sessionId);
      }
    for (const [key, handle] of this.folderHandles)
      if (handle.owner === id) this.folderHandles.delete(key);
    this.store!.peers = this.store!.peers.filter((p) => p.id !== id);
    this.store!.allowAgentRouting = this.store!.allowAgentRouting.filter((p) => p !== id);
    for (const [key, stop] of this.watches)
      if (key.startsWith(`${id}:`)) {
        stop();
        this.watches.delete(key);
      }
    this.online.delete(id);
    for (const [key, watchers] of this.gatewayWatches) {
      watchers.delete(id);
      if (key.startsWith(`${id}:`) || !watchers.size) this.gatewayWatches.delete(key);
    }
    this.save();
  }
  async unlink(id: string) {
    const peer = this.store!.peers.find((p) => p.id === id);
    if (peer) await this.client?.send(peer, { type: 'unlinked' }).catch(() => undefined);
    this.removePeer(id);
  }
  grants(id: string, allowAgents: boolean, agentRouting: boolean) {
    const peer = this.store!.peers.find((p) => p.id === id);
    if (!peer) throw new Error('Device is not linked');
    peer.allowAgents = allowAgents;
    this.store!.allowAgentRouting = this.store!.allowAgentRouting.filter((p) => p !== id);
    if (agentRouting) this.store!.allowAgentRouting.push(id);
    this.save();
    return this.status();
  }
  async rpc(
    deviceId: string,
    operation: string,
    input: Record<string, unknown> = {},
    actor: 'user' | 'agent' = 'user',
    signal?: AbortSignal,
  ): Promise<any> {
    if (actor === 'agent' && !this.store!.allowAgentRouting.includes(deviceId))
      throw new Error('Agent routing to this device has not been enabled by the user');
    if (!this.store!.peers.some((p) => p.id === deviceId)) throw new Error('Device is not linked');
    if (actor === 'user' && !this.store!.accountWideDeviceAccess)
      throw new Error('Access across linked devices is disabled on this desktop');
    if (!this.client) throw new Error('Device relay unavailable');
    if (['prompt', 'workbench'].includes(operation) && input.useLocalProviders === true) {
      if (actor !== 'user')
        throw new Error('Only a user can transfer provider credentials to a device.');
      const target = this.store!.peers.find((peer) => peer.id === deviceId);
      if (!target) throw new Error('Device is not linked');
      const bundle = await buildDeviceProviderBundle(
        getContext().providers,
        typeof input.model === 'string'
          ? input.model
          : typeof (input.body as Record<string, unknown> | undefined)?.model === 'string'
            ? (input.body as { model: string }).model
            : undefined,
        signal,
      );
      // A second, identity-bound seal on top of the device channel. The grant
      // is readable only by this target's private key, expires with the device
      // envelope window, and is never written to config or message storage.
      input = {
        ...input,
        credentialEnvelope: await sealDeviceMessage(
          this.store!.privateKey,
          target,
          this.store!.identity.id,
          bundle,
        ),
      };
      delete input.useLocalProviders;
    }
    return this.client.rpc(deviceId, operation, input, actor, signal);
  }
  private workspaceRoots(): string[] {
    const snapshot = new WorkspaceNavigationStore(getDb()).snapshot();
    const roots = [
      snapshot.workspaceRoot,
      snapshot.selectedProject,
      process.env.KORYPHAIOS_REMOTE_WORKSPACE,
      ...(this.store?.selectedWorkspaceRoots ?? []),
    ];
    return [
      ...new Set(
        roots
          .filter((p): p is string => !!p)
          .flatMap((path) => {
            try {
              return [realpathSync(path)];
            } catch {
              return [];
            }
          }),
      ),
    ];
  }
  private workspaceId(path: string) {
    return createHash('sha256').update(`${this.store!.identity.id}:${path}`).digest('hex');
  }
  workspaces(): DeviceWorkspace[] {
    return this.workspaceRoots().map((path) => ({
      id: this.workspaceId(path),
      name: basename(path),
      displayPath: path,
    }));
  }
  private resolveWorkspace(id: unknown): string {
    if (typeof id !== 'string') throw new Error('Select a workspace on the target device');
    for (const root of this.workspaceRoots()) {
      if (this.workspaceId(root) === id) return root;
      for (const entry of readdirSync(root, { withFileTypes: true }).slice(0, 2000)) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const path = realpathSync(join(root, entry.name));
        if (isContainedBy(root, path) && this.workspaceId(path) === id) return path;
      }
    }
    throw new Error('Workspace is unavailable or is not shared by the target device');
  }
  private folderHandle(path: string, owner: string): DeviceWorkspace {
    const now = Date.now();
    for (const [id, handle] of this.folderHandles) {
      if (handle.expiresAt <= now) this.folderHandles.delete(id);
      else if (handle.path === path && handle.owner === owner) {
        handle.expiresAt = now + 30 * 60_000;
        return { id, name: basename(path) || path, displayPath: path };
      }
    }
    if (this.folderHandles.size >= 10_000)
      throw new Error('Folder browser is busy. Try again later.');
    const id = `browse:${randomUUID()}`;
    this.folderHandles.set(id, { path, owner, expiresAt: now + 30 * 60_000 });
    return { id, name: basename(path) || path, displayPath: path };
  }
  private resolveFolder(id: unknown, owner: string): string {
    const handle = typeof id === 'string' ? this.folderHandles.get(id) : undefined;
    if (!handle || handle.owner !== owner || handle.expiresAt <= Date.now())
      throw new Error('Folder selection expired or is unavailable. Choose the folder again.');
    const path = realpathSync(handle.path);
    if (path !== handle.path || !statSync(path).isDirectory())
      throw new Error('Folder changed. Choose the folder again.');
    return path;
  }
  private async requireChat(id: unknown) {
    if (typeof id !== 'string' || id.length > 200) throw new Error('Invalid chat');
    const chat = await getContext().sessions.getActive(id);
    if (!chat) throw new Error('Chat unavailable');
    const root = chat.workingDirectory;
    if (
      !root ||
      !this.workspaceRoots().some((allowed) => isContainedBy(allowed, realpathSync(root)))
    )
      throw new Error('Chat is outside this device’s shared workspaces');
    return chat;
  }
  async execute(
    peer: LinkedDevice | null,
    operation: string,
    input: Record<string, unknown>,
    actor: 'user' | 'agent',
    requestId: string,
  ): Promise<any> {
    const authorize = () => {
      const current = peer ? this.store!.peers.find((p) => p.id === peer.id) : null;
      if (peer && !current) throw new Error('Device link was revoked');
      if (actor === 'agent' && (!current || !current.allowAgents))
        throw new Error('This device has not granted remote-agent access');
    };
    authorize();
    // Open a source-sealed credential grant into this process's memory only.
    // The plaintext bundle never reaches disk, a tool result, or a chat row.
    if (input.credentialEnvelope !== undefined) {
      if (!peer) throw new Error('Credential grants require a linked device');
      let opened: unknown;
      try {
        opened = await openDeviceMessage(
          this.store!.privateKey,
          peer,
          this.store!.identity.id,
          input.credentialEnvelope as Parameters<typeof openDeviceMessage>[3],
        );
      } catch {
        throw new Error('Credential grant was rejected, expired, or addressed elsewhere');
      }
      input.providerBundle = opened;
      delete input.credentialEnvelope;
    }
    const claim = () => {
      authorize();
      const now = Date.now();
      const requests = (this.store!.requests ??= {});
      for (const [id, time] of Object.entries(requests))
        if (now - time > 300_000) delete requests[id];
      const id = createHash('sha256')
        .update(`${peer?.id ?? 'local'}:${requestId}`)
        .digest('hex');
      if (requests[id])
        throw new Error(
          'This device command was already received; inspect its chat before retrying',
        );
      if (Object.keys(requests).length >= 5000) throw new Error('Device command queue is busy');
      requests[id] = now;
      this.save();
    };
    if (operation === 'identity') return this.store!.identity;
    if (operation === 'devices')
      return [this.store!.identity, ...this.status().peers.filter((p) => p.kind === 'desktop')];
    if (operation === 'forward') {
      if (actor === 'agent' || !peer || peer.kind !== 'mobile')
        throw new Error('Only a linked mobile controller can use this gateway');
      const allowed = [
        'identity',
        'workspaces',
        'folders',
        'browse_folders',
        'sessions',
        'create_chat',
        'open_chat',
        'close_chat',
        'events',
        'snapshot',
        'prompt',
        'cancel',
        'answer',
        'review',
        'permission',
      ];
      if (!allowed.includes(String(input.operation)) || typeof input.deviceId !== 'string')
        throw new Error('Unsupported device operation');
      if (
        ['create_chat', 'prompt', 'cancel', 'answer', 'review', 'permission'].includes(
          String(input.operation),
        )
      )
        claim();
      if (['open_chat', 'prompt'].includes(String(input.operation))) {
        const sessionId = String((input.input as Record<string, unknown>)?.sessionId ?? '');
        if (!sessionId || sessionId.length > 200) throw new Error('Invalid chat');
        const key = `${input.deviceId}:${sessionId}`;
        if (!this.gatewayWatches.has(key) && this.gatewayWatches.size >= 256)
          throw new Error('Too many open remote chats');
        const watchers = this.gatewayWatches.get(key) ?? new Set<string>();
        watchers.add(peer.id);
        this.gatewayWatches.set(key, watchers);
      }
      if (input.operation === 'close_chat') {
        const key = `${input.deviceId}:${String((input.input as Record<string, unknown>)?.sessionId ?? '')}`;
        const watchers = this.gatewayWatches.get(key);
        watchers?.delete(peer.id);
        if (watchers?.size) return { closed: true };
        this.gatewayWatches.delete(key);
      }
      return this.rpc(
        input.deviceId,
        String(input.operation),
        (input.input ?? {}) as Record<string, unknown>,
      );
    }
    if (operation === 'workspaces') return this.workspaces();
    if (operation === 'browse_folders') {
      if (actor !== 'user') throw new Error('Only users can choose a local folder');
      const owner = peer?.id ?? 'local';
      const root =
        input.workspaceId === undefined
          ? realpathSync(homedir())
          : typeof input.workspaceId === 'string' && input.workspaceId.startsWith('browse:')
            ? this.resolveFolder(input.workspaceId, owner)
            : this.resolveWorkspace(input.workspaceId);
      const folders = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .slice(0, 1000)
        .flatMap((entry) => {
          try {
            return [this.folderHandle(realpathSync(join(root, entry.name)), owner)];
          } catch {
            return [];
          }
        });
      return {
        current: this.folderHandle(root, owner),
        parent:
          dirname(root) === root ? null : this.folderHandle(realpathSync(dirname(root)), owner),
        folders,
      };
    }
    if (operation === 'folders') {
      const root = this.resolveWorkspace(input.workspaceId);
      return readdirSync(root, { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            !e.name.startsWith('.') &&
            !['node_modules', 'dist', 'build', 'target'].includes(e.name),
        )
        .slice(0, 200)
        .flatMap((e) => {
          const path = realpathSync(join(root, e.name));
          return isContainedBy(root, path)
            ? [{ id: this.workspaceId(path), name: e.name, displayPath: path }]
            : [];
        });
    }
    const ctx = getContext();
    if (operation === 'sessions') {
      const chats = await ctx.sessions.listActive();
      const results = [];
      for (const chat of chats.slice(0, 200)) {
        try {
          await this.requireChat(chat.id);
          results.push({
            id: chat.id,
            title: chat.title,
            deviceId: this.store!.identity.id,
            deviceName: this.store!.identity.name,
            workspaceName: basename(chat.workingDirectory ?? ''),
          });
        } catch {
          /* Unshared chats never cross the link. */
        }
      }
      return results;
    }
    if (operation === 'create_chat') {
      const picked =
        typeof input.workspaceId === 'string' && input.workspaceId.startsWith('browse:');
      if (picked && actor !== 'user') throw new Error('Only users can choose a local folder');
      const root = picked
        ? this.resolveFolder(input.workspaceId, peer?.id ?? 'local')
        : this.resolveWorkspace(input.workspaceId);
      if (picked && root === parse(root).root)
        throw new Error('Choose a project folder, not the filesystem root');
      const selected = this.store!.selectedWorkspaceRoots ?? [];
      if (picked && !selected.includes(root) && selected.length >= 100)
        throw new Error('Too many selected folders on this desktop');
      claim();
      const { tryAcquireSessionCreationLease } =
        await import('../services/session-erasure-service');
      const lease = tryAcquireSessionCreationLease();
      if (!lease)
        throw new Error('Session creation is temporarily blocked while delete-all is finishing');
      let chat;
      try {
        authorize();
        chat = await ctx.sessions.create(
          'local-user',
          typeof input.title === 'string' ? input.title.slice(0, 80) : 'New chat',
          undefined,
          root,
        );
      } finally {
        lease.release();
      }
      if (picked && !selected.includes(root)) {
        this.store!.selectedWorkspaceRoots = [
          ...new Set([...(this.store!.selectedWorkspaceRoots ?? []), root]),
        ];
      }
      const delegation = normalizeComputeDelegation(input.delegation);
      (this.store!.delegations ??= {})[chat.id] = delegation;
      this.save();
      return {
        id: chat.id,
        title: chat.title,
        deviceId: this.store!.identity.id,
        deviceName: this.store!.identity.name,
        workspaceName: basename(root),
        delegation,
      };
    }
    if (operation === 'workbench' && peer?.kind === 'mobile') {
      if (actor !== 'user') throw new Error('Only a linked user can control the target workbench.');
      if (input.providerBundle !== undefined)
        throw new Error('Mobile workbench requests cannot stage provider credentials.');
      if (String(input.method ?? 'GET').toUpperCase() !== 'GET') claim();
      const sessionId =
        typeof input.sessionId === 'string' && input.sessionId.length <= 200
          ? input.sessionId
          : null;
      return executeDeviceWorkbench(sessionId, input, authorize, 'mobile');
    }
    const chat = await this.requireChat(input.sessionId);
    authorize();
    if (operation === 'events') {
      if (
        !Number.isSafeInteger(input.epoch) ||
        !Number.isSafeInteger(input.sequence) ||
        Number(input.epoch) < 1 ||
        Number(input.sequence) < 0
      )
        throw new Error('Invalid target event cursor.');
      const log = getOrderedEventLog();
      const current = log.getCursor(chat.id);
      const cursor = { epoch: Number(input.epoch), sequence: Number(input.sequence) };
      // Same rule as the WebSocket replay: a cursor below the current-epoch
      // prune mark has lost events. Deliver the marker first (it rides in the
      // RPC array, the only transport this path has) and replay from the mark
      // without rotating the epoch.
      const pruned = prunedBoundaryAhead(log.getPruneMark(chat.id), current, cursor);
      const events = log.getAfter(
        chat.id,
        pruned ? current.epoch : cursor.epoch,
        pruned ? pruned.sequence : cursor.sequence,
        100,
      );
      // Durable history contains resolved attention requests. As in the
      // direct WebSocket replay, preserve their sequence positions without
      // reviving questions or reviews that are no longer pending.
      const [question, review] = await Promise.all([
        getPendingQuestion(chat.id),
        getPendingSessionReview(chat.id),
      ]);
      authorize();
      const replayed = events.map((event) => {
        const payload = event.payload as Record<string, unknown> | null;
        const staleQuestion =
          event.type === 'kory.ask_user' &&
          (!question?.questionId || payload?.questionId !== question.questionId);
        const staleReview =
          event.type === 'session.changes' &&
          (!review?.reviewId ||
            !review?.reviewRevision ||
            payload?.reviewId !== review.reviewId ||
            payload?.reviewRevision !== review.reviewRevision);
        return staleQuestion || staleReview
          ? { ...event, type: 'session.replay_skipped', payload: null, replayed: true }
          : { ...event, replayed: true };
      });
      if (!pruned) return replayed;
      const marker: WSMessage<SessionHistoryPrunedPayload> = {
        type: 'session.history_pruned',
        sessionId: chat.id,
        epoch: pruned.epoch,
        timestamp: Date.now(),
        payload: { epoch: pruned.epoch, throughSequence: pruned.sequence },
      };
      return [marker, ...replayed];
    }
    if (operation === 'workbench') {
      if (actor !== 'user' || peer?.kind !== 'desktop')
        throw new Error('Only a linked desktop user can control the target workbench.');
      if (String(input.method ?? 'GET').toUpperCase() !== 'GET') claim();
      const run = this.providerRuns.get(chat.id);
      if (run && run.peerId !== peer.id)
        throw new Error('This provider run belongs to another linked desktop.');
      const call = () => executeDeviceWorkbench(chat.id, input, authorize, 'desktop');
      if (run) return withProviderExecutionScope(run.staged.scope, call);
      if (input.providerBundle === undefined) return call();
      const staged = stageDeviceProviders(input.providerBundle, chat.id, authorize);
      try {
        const result = await withProviderExecutionScope(staged.scope, call);
        if (result.status >= 200 && result.status < 300)
          this.retainProviderRun(chat.id, peer.id, staged);
        else staged.cleanup();
        return result;
      } catch (error) {
        staged.cleanup();
        throw error;
      }
    }
    if (operation === 'close_chat') {
      const key = `${peer?.id}:${chat.id}`;
      this.watches.get(key)?.();
      this.watches.delete(key);
      return { closed: true };
    }
    if (operation === 'open_chat' || operation === 'snapshot') {
      // Capture the replay boundary before awaiting snapshot reads. Events
      // arriving during those reads must remain eligible for mobile replay.
      const eventCursor = getOrderedEventLog().getCursor(chat.id);
      if (operation === 'open_chat' && peer) this.watch(peer, chat.id);
      let budget = 160_000;
      const messages = (await ctx.messages.getRecent(chat.id, 100))
        .reverse()
        .flatMap((m) => {
          if (budget <= 0) return [];
          const content = m.content.slice(0, Math.min(32_000, budget));
          budget -= content.length;
          return [{ id: m.id, role: m.role, content, createdAt: m.createdAt }];
        })
        .reverse();
      authorize();
      return {
        session: chat,
        chat: {
          id: chat.id,
          title: chat.title,
          deviceId: this.store!.identity.id,
          deviceName: this.store!.identity.name,
          workspaceName: basename(chat.workingDirectory ?? ''),
        },
        messages,
        run: ctx.runs.get(chat.id),
        delegation: this.store!.delegations?.[chat.id] ?? { placement: 'stay', commit: 'none' },
        question: await getPendingQuestion(chat.id),
        review: await getPendingSessionReview(chat.id),
        eventCursor,
      };
    }
    if (operation === 'prompt') {
      const prompt = parseDevicePrompt(input);
      if (peer) this.watch(peer, chat.id);
      if (input.providerBundle !== undefined && (actor !== 'user' || peer?.kind !== 'desktop'))
        throw new Error('Only a linked desktop user can supply a provider login.');
      if (this.providerRuns.has(chat.id) && ctx.runs.get(chat.id)?.status === 'active')
        throw new Error('The remote chat is busy.');
      claim();
      const staged =
        input.providerBundle === undefined
          ? undefined
          : stageDeviceProviders(input.providerBundle, chat.id, authorize);
      const start = () =>
        ctx.kory.startSessionTurn({
          sessionId: chat.id,
          // A remote device prompt is the user's own send, not background
          // automation: it takes the same steer-or-supersede admission as a
          // message typed into the local composer.
          source: 'user',
          sourceCommandId: `device:${peer?.id ?? this.store!.identity.id}:${requestId}`,
          userMessage: prompt.content,
          preferredModel: prompt.model,
          reasoningLevel: prompt.reasoningLevel,
          contextWindow: prompt.contextWindow,
          attachments: prompt.attachments,
          interactionMode: prompt.interactionMode ?? chat.interactionMode ?? 'act',
          imageInputMode: prompt.imageInputMode,
          fastMode: prompt.fastMode,
          speedTier: normalizeSpeedTier(
            prompt.model?.split(':')[0],
            prompt.speedTier,
            prompt.fastMode,
          ),
          modelParameters: prompt.modelParameters,
          fusion: prompt.fusion,
        });
      let submission;
      try {
        submission = staged ? await withProviderExecutionScope(staged.scope, start) : await start();
      } catch (error) {
        staged?.cleanup();
        throw error;
      }
      if (submission.accepted === 'queued') {
        // The prompt parked behind the remote session's live run and will be
        // admitted as its next turn — there is no provider execution to
        // retain on this peer yet.
        staged?.cleanup();
        return { accepted: true, runId: '', steeringCommandId: submission.steeringCommandId };
      }
      if (staged && submission.accepted === true) {
        const previous = this.providerRuns.get(chat.id);
        if (previous) {
          clearTimeout(previous.timer);
          previous.staged.cleanup();
        }
        this.retainProviderRun(chat.id, peer!.id, staged, submission.completion);
      } else staged?.cleanup();
      if (!submission.accepted) return { accepted: false, result: submission.result };
      void submission.completion.catch(() => undefined);
      return { accepted: true, runId: submission.runId };
    }
    if (operation === 'cancel') {
      claim();
      await ctx.goalDriver.pauseForSession(chat.id);
      authorize();
      await ctx.kory.cancelSessionWorkers(chat.id);
      const { cancelLLMJobsForSession } = await import('../queue/workers/llm-worker');
      await cancelLLMJobsForSession(chat.id);
      const run = this.providerRuns.get(chat.id);
      if (run) {
        clearTimeout(run.timer);
        run.staged.cleanup();
        this.providerRuns.delete(chat.id);
      }
      return { cancelled: true };
    }
    if (operation === 'answer') {
      if (actor === 'agent')
        throw new Error('Agents cannot approve another device’s prompts or permission requests');
      if (typeof input.questionId !== 'string' || typeof input.selection !== 'string')
        throw new Error('Select an answer to the current question');
      const pending = await getPendingQuestion(chat.id);
      if (!pending || pending.questionId !== input.questionId)
        throw new Error('This question is no longer pending');
      claim();
      const selection = input.selection;
      const questionId = input.questionId;
      const answer = () =>
        ctx.kory.handleUserInput(
          chat.id,
          selection,
          typeof input.text === 'string' ? input.text.slice(0, 8000) : undefined,
          questionId,
        );
      const run = this.providerRuns.get(chat.id);
      if (run && run.peerId !== peer?.id)
        throw new Error('This provider run belongs to another linked desktop.');
      if (run) await withProviderExecutionScope(run.staged.scope, answer);
      else await answer();
      return { answered: true };
    }
    if (operation === 'permission') {
      if (actor === 'agent') throw new Error('Agents cannot approve remote permissions');
      if (typeof input.permissionId !== 'string' || typeof input.selection !== 'string')
        throw new Error('Select a permission decision');
      const selection = input.selection;
      const permissionId = input.permissionId;
      const pending = toolApprovalQueue
        .list(chat.id)
        .find((request) => request.id === permissionId);
      if (!pending) throw new Error('This permission request is no longer pending');
      const option =
        selection === 'granted'
          ? pending.options?.find((candidate) => /allow|approve|grant/i.test(candidate))
          : selection === 'denied'
            ? pending.options?.find((candidate) => /deny|reject|block/i.test(candidate))
            : pending.options?.includes(selection)
              ? selection
              : undefined;
      if (!option || !toolApprovalQueue.respond(chat.id, permissionId, option))
        throw new Error('This permission request could not be settled');
      return { responded: true, permissionId };
    }
    if (operation === 'export_work') {
      const stored = this.store!.delegations?.[chat.id] ?? {
        placement: 'stay' as const,
        commit: 'none' as const,
      };
      const placement = input.placement === 'return' ? 'return' : stored.placement;
      const commit =
        placement === 'return' && (input.commit === 'local' || stored.commit === 'local')
          ? 'local'
          : 'none';
      const root = chat.workingDirectory;
      if (!root) throw new Error('This chat has no workspace to return work from');
      return exportWorkspaceChanges({
        workspaceRoot: root,
        sessionId: chat.id,
        deviceId: this.store!.identity.id,
        deviceName: this.store!.identity.name,
        workspaceName: basename(root),
        placement,
        commit,
        sourceSessionId: stored.sourceSessionId,
        transferId: typeof input.transferId === 'string' ? input.transferId : stored.transferId,
        summary: typeof input.summary === 'string' ? input.summary : undefined,
      });
    }
    if (operation === 'review') {
      if (actor === 'agent') throw new Error('Agents cannot approve remote changes');
      if (typeof input.accept !== 'boolean') throw new Error('Invalid review decision');
      if (
        typeof input.reviewId !== 'string' ||
        !input.reviewId ||
        typeof input.reviewRevision !== 'string' ||
        !input.reviewRevision
      )
        throw new Error('Missing review identity. Refresh this review before responding.');
      const review = await getPendingSessionReview(chat.id);
      if (
        !review ||
        review.reviewId !== input.reviewId ||
        review.reviewRevision !== input.reviewRevision
      )
        throw new Error('This review is no longer pending');
      claim();
      const resolved = await ctx.kory.handleSessionResponse(
        chat.id,
        input.accept,
        {
          reviewId: input.reviewId,
          reviewRevision: input.reviewRevision,
        },
        (projectRoot) => {
          authorize();
          if (!this.workspaceRoots().some((allowed) => isContainedBy(allowed, projectRoot)))
            throw new Error('Chat is outside this device’s shared workspaces');
        },
      );
      return {
        reviewed: true,
        reviewId: resolved.reviewId,
        reviewRevision: resolved.reviewRevision,
        status: resolved.status,
      };
    }
    throw new Error('Unsupported device operation');
  }
  private retainProviderRun(
    sessionId: string,
    peerId: string,
    staged: ReturnType<typeof stageDeviceProviders>,
    completion: Promise<unknown> = Promise.resolve(),
  ) {
    const ctx = getContext();
    staged.bind();
    // The target owns this turn, so a disconnected origin must not cancel it or
    // revoke its credential scope mid-run. The lease is released only once the
    // turn is quiet; the timer is a stale-grant sweep, never a work deadline.
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    const releaseWhenQuiet = () => {
      if (this.providerRuns.get(sessionId)?.staged !== staged) return;
      const status = ctx.runs.get(sessionId)?.status;
      if (status === 'active' || status === 'waiting') {
        const retry = setTimeout(releaseWhenQuiet, 60_000);
        retry.unref?.();
        return;
      }
      if (leaseTimer) clearTimeout(leaseTimer);
      staged.cleanup();
      this.providerRuns.delete(sessionId);
    };
    leaseTimer = setTimeout(releaseWhenQuiet, 30 * 60_000);
    leaseTimer.unref?.();
    this.providerRuns.set(sessionId, { peerId, staged, timer: leaseTimer });
    void completion
      .finally(() => {
        // Automatic compaction may start just after the turn receipt. Keep the
        // same session-scoped lease through this bounded tail and human waits.
        const tail = setTimeout(releaseWhenQuiet, 60_000);
        tail.unref?.();
      })
      .catch(() => undefined);
  }
  private watch(peer: LinkedDevice, sessionId: string) {
    const key = `${peer.id}:${sessionId}`;
    if (this.watches.has(key)) return;
    if ([...this.watches.keys()].filter((k) => k.startsWith(`${peer.id}:`)).length >= 16)
      throw new Error('Too many open remote chats');
    this.watches.set(
      key,
      getContext().wsManager.onSessionEvent(sessionId, (message) => {
        if (message.sessionId !== sessionId || !this.store!.peers.some((p) => p.id === peer.id))
          return;
        void this.client
          ?.send(peer, { type: 'event', sessionId, event: message })
          .catch(() => undefined);
      }),
    );
  }
  stop() {
    for (const run of this.providerRuns.values()) {
      clearTimeout(run.timer);
      run.staged.cleanup();
    }
    this.providerRuns.clear();
    this.folderHandles.clear();
    this.client?.stop();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const stop of this.watches.values()) stop();
    this.watches.clear();
  }
}
export const deviceService = new DeviceService();
