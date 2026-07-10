/**
 * Relay guest client — the CLIENT side of "use a host's shared models".
 *
 * Connects OUTBOUND to the relay as a guest (using a join code / invite token),
 * receives the host's shared-provider catalog, and exposes a streaming
 * `requestInference()` that sends `inference-request` and yields the host's
 * ProviderEvents until done. Unlike the collaboration guest (a read-only view
 * of the host's session), this client keeps its own workspace — it only borrows
 * the host's providers for model inference.
 */

import { serverLog } from '../logger';
import { resolveRelayJoinCode } from './relay-client';
import type { SharedProviderCatalog } from '@koryphaios/shared';
import type { ProviderEvent } from '../providers/types';

const log = serverLog.child({ module: 'relay-guest' });

interface PendingStream {
  push: (event: ProviderEvent) => void;
  done: () => void;
  fail: (error: string) => void;
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `rq-${Date.now()}-${requestCounter}`;
}

export class RelayGuestClient {
  private ws: WebSocket | null = null;
  private catalog: SharedProviderCatalog | null = null;
  private readonly streams = new Map<string, PendingStream>();
  private catalogListeners = new Set<(c: SharedProviderCatalog) => void>();
  private connectedResolve: (() => void) | null = null;

  get hostCatalog(): SharedProviderCatalog | null {
    return this.catalog;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onCatalog(fn: (c: SharedProviderCatalog) => void): () => void {
    this.catalogListeners.add(fn);
    if (this.catalog) fn(this.catalog);
    return () => this.catalogListeners.delete(fn);
  }

  /** Connect to a host. Accepts EITHER an 8-char join code (uses the host's
   *  default tier) OR a full invite URL (carries a specific tier — the host
   *  shares a Collaborator/YOLO link to grant remote-provider access, since
   *  the default Viewer tier can't use shared providers). Resolves once the WS
   *  is open; the catalog arrives shortly after via `onCatalog`. */
  async connect(codeOrUrl: string, displayName: string): Promise<void> {
    let inviteUrl: URL;
    if (codeOrUrl.includes('://')) {
      inviteUrl = new URL(codeOrUrl.trim());
    } else {
      const resolved = await resolveRelayJoinCode(codeOrUrl.trim());
      inviteUrl = new URL(resolved.inviteUrl);
    }
    const token =
      inviteUrl.searchParams.get('token') || inviteUrl.hash.replace(/^#?token=/, '') || '';
    if (!token) throw new Error('Invite did not yield a token');
    const wsBase = `${inviteUrl.origin.replace(/^http/, 'ws')}/ws`;
    const url = `${wsBase}?token=${encodeURIComponent(token)}&name=${encodeURIComponent(displayName)}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      this.connectedResolve = resolve;
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Relay guest connection timed out'));
      }, 10_000);

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        log.info('Connected to host relay as provider client');
        resolve();
      });
      ws.addEventListener('message', (e) => this.handleMessage(String(e.data)));
      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Relay guest WS error'));
      });
      ws.addEventListener('close', () => {
        // Fail any in-flight streams so callers don't hang.
        for (const stream of this.streams.values()) stream.fail('Host connection closed');
        this.streams.clear();
        this.ws = null;
      });
    });
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'provider-catalog': {
        this.catalog = msg.catalog as SharedProviderCatalog;
        for (const fn of this.catalogListeners) {
          try {
            fn(this.catalog);
          } catch {
            /* listener error is not fatal */
          }
        }
        return;
      }
      case 'init': {
        // Some hosts send the catalog inside init.policy; ignore otherwise.
        this.connectedResolve?.();
        return;
      }
      case 'inference-event': {
        const stream = this.streams.get(String(msg.requestId));
        if (stream && msg.event) stream.push(msg.event as ProviderEvent);
        return;
      }
      case 'inference-done': {
        const stream = this.streams.get(String(msg.requestId));
        stream?.done();
        return;
      }
      case 'inference-error': {
        const stream = this.streams.get(String(msg.requestId));
        stream?.fail(String(msg.error ?? 'Remote inference failed'));
        return;
      }
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.isConnected) throw new Error('Not connected to a host');
    this.ws!.send(JSON.stringify(msg));
  }

  /** Stream inference from the host. Yields ProviderEvents; throws on host
   *  error. Honors an AbortSignal by sending inference-cancel. */
  async *requestInference(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    const requestId = nextRequestId();
    const queue: ProviderEvent[] = [];
    let finished = false;
    let failure: string | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };

    this.streams.set(requestId, {
      push: (event) => {
        queue.push(event);
        notify();
      },
      done: () => {
        finished = true;
        notify();
      },
      fail: (error) => {
        failure = error;
        finished = true;
        notify();
      },
    });

    const onAbort = () => {
      try {
        this.send({ type: 'inference-cancel', requestId });
      } catch {
        /* already gone */
      }
      failure = 'Cancelled';
      finished = true;
      notify();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      this.send({ type: 'inference-request', requestId, payload });
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (failure) throw new Error(failure);
        if (finished) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.streams.delete(requestId);
    }
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.catalog = null;
    this.streams.clear();
  }
}

// A single connected host per client for now (one "my friend's PC" at a time).
export const relayGuestClient = new RelayGuestClient();
