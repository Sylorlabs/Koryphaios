/**
 * Relay client — manages the outbound WebSocket connection from this
 * Koryphaios backend to the remote relay server.
 *
 * The host never accepts inbound connections; it only connects outbound.
 */

import { serverLog } from '../logger';

const log = serverLog.child({ module: 'collab-relay' });

interface RelayConfig {
  relayUrl: string;   // e.g. http://158.51.125.29:8080
  hostSecret: string;
}

type EventHandler = (msg: Record<string, unknown>) => void;

export class RelayClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private sessionToken: string | null = null;
  private handlers: EventHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

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
  async startSession(sessionId?: string): Promise<{ sessionId: string; inviteBase: string }> {
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
    };
  }

  /** Create a signed invite link for a given role. */
  async createInvite(role: 'viewer' | 'collaborator' | 'copilot' = 'viewer'): Promise<string> {
    if (!this.sessionId) throw new Error('No active relay session');
    const res = await fetch(`${this.config.relayUrl}/session/${this.sessionId}/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-secret': this.config.hostSecret,
      },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) throw new Error(`Failed to create invite: ${res.status}`);
    const data = await res.json() as any;
    if (!data.ok) throw new Error(data.error || 'Relay error');
    return data.inviteUrl as string;
  }

  /** Broadcast an event to all connected guests via the relay. */
  broadcast(msg: Record<string, unknown>) {
    if (!this.isConnected) return;
    try {
      this.ws!.send(JSON.stringify(msg));
    } catch (err) {
      log.warn({ err }, 'Failed to broadcast to relay');
    }
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

const _config = getRelayConfig();
export const relayClient = _config ? new RelayClient(_config) : null;
export const relayEnabled = _config !== null;
