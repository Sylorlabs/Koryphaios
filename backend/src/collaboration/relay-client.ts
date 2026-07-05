/**
 * Relay client — manages the outbound WebSocket connection from this
 * Koryphaios backend to the remote relay server.
 *
 * The host never accepts inbound connections; it only connects outbound.
 */

import { serverLog } from '../logger';
import type { CollaborationPolicy } from '@koryphaios/shared';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';

const log = serverLog.child({ module: 'collab-relay' });

interface RelayConfig {
  relayUrl: string;   // e.g. http://158.51.125.29:8080
  hostSecret: string;
}

type EventHandler = (msg: Record<string, unknown>) => void;

class HybridPeerTransport {
  private peers = new Map<string, { pc: RTCPeerConnection; channel?: RTCDataChannel; tierId: string }>();

  constructor(
    private signal: (message: Record<string, unknown>) => void,
    private receive: (message: Record<string, unknown>) => void,
  ) {}

  private createPeer(guestId: string, tierId: string) {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (process.env.TURN_URL) {
      iceServers.push({
        urls: process.env.TURN_URL,
        ...(process.env.TURN_USERNAME ? { username: process.env.TURN_USERNAME } : {}),
        ...(process.env.TURN_CREDENTIAL ? { credential: process.env.TURN_CREDENTIAL } : {}),
      } as never);
    }
    const pc = new RTCPeerConnection({ iceServers });
    const peer = { pc, tierId } as { pc: RTCPeerConnection; channel?: RTCDataChannel; tierId: string };
    this.peers.set(guestId, peer);
    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) this.signal({ type: 'rtc-ice', guestId, candidate: candidate.toJSON() });
    });
    pc.onDataChannel.subscribe((channel) => {
      if (channel.label !== 'koryphaios') return;
      peer.channel = channel;
      channel.onMessage.subscribe((raw) => {
        try {
          const message = JSON.parse(String(raw)) as Record<string, unknown>;
          this.receive({ ...message, guestId, tierId: peer.tierId, transport: 'p2p' });
        } catch { /* ignore malformed peer payloads */ }
      });
    });
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed') void this.closePeer(guestId);
    });
    return peer;
  }

  async handle(message: Record<string, unknown>) {
    const guestId = String(message.guestId || '');
    if (!guestId) return;
    let peer = this.peers.get(guestId);
    if (message.type === 'rtc-offer') {
      if (peer) await this.closePeer(guestId);
      peer = this.createPeer(guestId, String(message.tierId || 'viewer'));
      const offer = message.description as { type: 'offer'; sdp: string };
      await peer.pc.setRemoteDescription(offer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.signal({ type: 'rtc-answer', guestId, description: { type: answer.type, sdp: answer.sdp } });
    } else if (message.type === 'rtc-ice' && peer && message.candidate) {
      await peer.pc.addIceCandidate(message.candidate as never);
    }
  }

  broadcast(message: Record<string, unknown>): string[] {
    const delivered: string[] = [];
    const encoded = JSON.stringify(message);
    for (const [guestId, peer] of this.peers) {
      if (peer.channel?.readyState !== 'open') continue;
      try { peer.channel.send(encoded); delivered.push(guestId); } catch { /* relay fallback handles it */ }
    }
    return delivered;
  }

  async closePeer(guestId: string) {
    const peer = this.peers.get(guestId);
    this.peers.delete(guestId);
    if (peer) await peer.pc.close().catch(() => {});
  }

  async closeAll() {
    await Promise.all([...this.peers.keys()].map((id) => this.closePeer(id)));
  }
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private sessionToken: string | null = null;
  private handlers: EventHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private activePolicy: CollaborationPolicy | null = null;
  private readonly peerTransport = new HybridPeerTransport(
    (message) => this.sendRelay(message),
    (message) => this.handlePeerMessage(message),
  );

  private handlePeerMessage(message: Record<string, unknown>) {
    if (message.type !== 'guest-prompt' || !this.activePolicy) return;
    const tier = this.activePolicy.accessTiers.find((item) => item.id === message.tierId);
    if (!tier?.permissions.submitPrompts) return;
    const requestedModel = String(message.model || '');
    const model = requestedModel && (tier.allowedModels.includes('*') || tier.allowedModels.includes(requestedModel)) ? requestedModel : '';
    const requestedReasoning = String(message.reasoningLevel || '');
    const allowedReasoning = model ? (tier.reasoningByModel?.[model] || []) : [];
    this.dispatch({
      type: 'guest-prompt',
      guestId: message.guestId,
      name: String(message.name || 'Guest').slice(0, 40),
      role: tier.id,
      tierId: tier.id,
      autoExecute: tier.permissions.autoExecutePrompts && tier.permissions.fullSystemAccess,
      content: String(message.content || '').slice(0, 4000),
      model,
      reasoningLevel: requestedReasoning && allowedReasoning.includes(requestedReasoning) ? requestedReasoning : '',
      commandAllowlist: tier.permissions.commandAllowlist || [],
      commandBlocklist: tier.permissions.commandBlocklist || [],
      transport: 'p2p',
    });
  }

  constructor(private config: RelayConfig) {}

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  onMessage(fn: EventHandler) {
    this.handlers.push(fn);
    return () => { this.handlers = this.handlers.filter(h => h !== fn); };
  }

  private dispatch(msg: Record<string, unknown>) {
    this.handlers.forEach(h => { try { h(msg); } catch {} });
  }

  /** Create or re-attach to a relay session, then open the host WS. */
  async startSession(sessionId?: string): Promise<{ sessionId: string; inviteBase: string; joinCode: string }> {
    const httpBase = this.config.relayUrl;
    const wsBase = httpBase.replace(/^http/, 'ws');

    // Create / resume session on relay
    const res = await fetch(`${httpBase}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-secret': this.config.hostSecret,
      },
      body: JSON.stringify({ sessionId }),
    });

    if (!res.ok) throw new Error(`Relay rejected session create: ${res.status}`);
    const data = await res.json() as any;
    if (!data.ok) throw new Error(data.error || 'Relay error');

    this.sessionId = data.sessionId;
    this.sessionToken = data.sessionToken;

    // Open host WebSocket
    await this.connect(wsBase, data.sessionToken);

    return {
      sessionId: data.sessionId,
      inviteBase: httpBase,
      joinCode: data.joinCode,
    };
  }

  /** Create a signed invite link for a given role. */
  async createInvite(tierId = 'viewer'): Promise<string> {
    if (!this.sessionId) throw new Error('No active relay session');
    const res = await fetch(`${this.config.relayUrl}/session/${this.sessionId}/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-secret': this.config.hostSecret,
      },
      body: JSON.stringify({ tierId }),
    });
    if (!res.ok) throw new Error(`Failed to create invite: ${res.status}`);
    const data = await res.json() as any;
    if (!data.ok) throw new Error(data.error || 'Relay error');
    return data.inviteUrl as string;
  }

  decideJoin(guestId: string, approved: boolean, tierId?: string) {
    this.broadcast({ type: 'join-decision', guestId, approved, tierId });
  }

  assignTier(guestId: string, tierId: string) {
    this.broadcast({ type: 'assign-tier', guestId, tierId });
  }

  async updatePolicy(policy: CollaborationPolicy): Promise<void> {
    if (!this.sessionId) throw new Error('No active relay session');
    const res = await fetch(`${this.config.relayUrl}/session/${this.sessionId}/policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-secret': this.config.hostSecret },
      body: JSON.stringify(policy),
    });
    if (!res.ok) throw new Error(`Failed to update team policy: ${res.status}`);
    this.activePolicy = policy;
  }

  async resolveJoinCode(joinCode: string) {
    const res = await fetch(`${this.config.relayUrl}/code/${encodeURIComponent(joinCode)}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'Invalid or inactive join code' : 'Relay join failed');
    return await res.json() as { ok: true; inviteUrl: string; sessionId: string; role: string };
  }

  /** Broadcast an event to all connected guests via the relay. */
  broadcast(msg: Record<string, unknown>) {
    if (!this.isConnected) return;
    const excludeGuestIds = this.peerTransport.broadcast(msg);
    this.sendRelay(excludeGuestIds.length ? { ...msg, excludeGuestIds } : msg);
  }

  private sendRelay(msg: Record<string, unknown>) {
    if (!this.isConnected) return;
    try { this.ws!.send(JSON.stringify(msg)); }
    catch (err) { log.warn({ err }, 'Failed to send to relay'); }
  }

  /** Approve or reject a guest prompt. */
  approveGuestPrompt(guestId: string, approved: boolean) {
    this.broadcast({ type: 'approval-result', guestId, approved });
  }

  async disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.sessionId = null;
    this.sessionToken = null;
    this.activePolicy = null;
    await this.peerTransport.closeAll();
  }

  private async connect(wsBase: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${wsBase}/ws?token=${encodeURIComponent(token)}`;
      this.intentionalClose = false;

      const ws = new WebSocket(url);
      this.ws = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Relay WS connection timed out'));
      }, 10_000);

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        log.info({ sessionId: this.sessionId }, 'Connected to relay as host');
        resolve();
      });

      ws.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'rtc-offer' || msg.type === 'rtc-ice') {
            void this.peerTransport.handle(msg).catch((err) => log.warn({ err }, 'WebRTC signaling failed'));
            return;
          }
          if (msg.type === 'guest-left' && msg.guestId) void this.peerTransport.closePeer(String(msg.guestId));
          this.dispatch(msg);
        } catch {}
      });

      ws.addEventListener('close', (e) => {
        clearTimeout(timeout);
        this.ws = null;
        if (!this.intentionalClose && this.sessionToken) {
          log.warn({ code: e.code }, 'Relay WS closed, reconnecting in 5s');
          this.reconnectTimer = setTimeout(async () => {
            try { await this.connect(wsBase, this.sessionToken!); } catch (err) {
              log.error({ err }, 'Relay reconnect failed');
            }
          }, 5_000);
        }
      });

      ws.addEventListener('error', (e) => {
        clearTimeout(timeout);
        log.error({ err: String(e) }, 'Relay WS error');
        reject(new Error('Relay WS error'));
      });
    });
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

function getRelayConfig(): RelayConfig | null {
  const relayUrl = process.env.RELAY_URL;
  const hostSecret = process.env.RELAY_HOST_SECRET;
  if (!relayUrl || !hostSecret) return null;
  return { relayUrl: relayUrl.replace(/\/$/, ''), hostSecret };
}

const publicRelayUrl = process.env.RELAY_URL?.replace(/\/$/, '') ?? null;

export async function resolveRelayJoinCode(joinCode: string) {
  if (!publicRelayUrl) throw new Error('Internet relay URL is not configured on this Koryphaios installation');
  const res = await fetch(`${publicRelayUrl}/code/${encodeURIComponent(joinCode)}`);
  if (!res.ok) throw new Error(res.status === 404 ? 'Invalid or inactive join code' : 'Relay join failed');
  return await res.json() as { ok: true; inviteUrl: string; sessionId: string; sessionName: string; tierId: string };
}

const _config = getRelayConfig();
export const relayClient = _config ? new RelayClient(_config) : null;
export const relayEnabled = _config !== null;
export const relayAvailable = publicRelayUrl !== null;
