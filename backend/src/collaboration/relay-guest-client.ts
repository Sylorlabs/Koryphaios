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
import { RelayJoinError } from './join-code';
import { modelSharingRelayUrl } from './relay-url';
import { parseSharedProviderCatalog } from './inference-input';
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
  private connectedReject: ((error: Error) => void) | null = null;
  private admitted = false;
  private requireModelOnly = false;

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
  async connect(codeOrUrl: string, displayName: string, requireModelOnly = false): Promise<void> {
    this.admitted = false;
    this.requireModelOnly = requireModelOnly;
    let inviteUrl: URL;
    if (codeOrUrl.includes('://')) {
      inviteUrl = modelSharingRelayUrl(codeOrUrl.trim());
    } else {
      this.requireModelOnly = true;
      if (process.env.RELAY_URL) modelSharingRelayUrl(process.env.RELAY_URL);
      const resolved = await resolveRelayJoinCode(codeOrUrl.trim());
      if (resolved.tierId !== 'models')
        throw new RelayJoinError(
          'This is a team-session code. Enter a model-sharing code instead.',
          'WRONG_SHARING_CODE',
          400,
        );
      inviteUrl = modelSharingRelayUrl(resolved.inviteUrl);
    }
    const token =
      inviteUrl.searchParams.get('token') || inviteUrl.hash.replace(/^#?token=/, '') || '';
    if (!token || token.length > 8192)
      throw new RelayJoinError(
        'Not a valid model-sharing invitation.',
        'INVALID_MODEL_INVITE',
        400,
      );
    const wsBase = `${inviteUrl.origin.replace(/^http/, 'ws')}/ws`;
    const url = `${wsBase}?token=${encodeURIComponent(token)}&name=${encodeURIComponent(displayName)}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      this.connectedResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.connectedReject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Relay guest connection timed out'));
      }, 10_000);

      ws.addEventListener('open', () => {
        log.info('Connected to host relay as provider client');
      });
      ws.addEventListener('message', (e) => {
        if (this.ws === ws) this.handleMessage(String(e.data));
      });
      ws.addEventListener('error', () => {
        if (this.ws !== ws) return;
        clearTimeout(timeout);
        reject(new Error('Relay guest WS error'));
      });
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        clearTimeout(timeout);
        this.connectedReject?.(new Error('The shared-model connection was closed'));
        // Fail any in-flight streams so callers don't hang.
        for (const stream of this.streams.values()) stream.fail('Host connection closed');
        this.streams.clear();
        if (this.ws === ws) this.ws = null;
        this.admitted = false;
        this.catalog = null;
      });
    });
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch (err: unknown) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Malformed relay guest frame; skipping',
      );
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    switch (msg.type) {
      case 'provider-catalog': {
        if (!this.admitted) return;
        const catalog = parseSharedProviderCatalog(msg.catalog);
        if (!catalog) {
          this.connectedReject?.(new Error('The host returned an invalid model catalog'));
          this.disconnect();
          return;
        }
        this.catalog = catalog;
        if (this.requireModelOnly && this.catalog?.providers)
          this.catalog = {
            hostName: this.catalog.hostName,
            providers: this.catalog.providers.filter((provider) => !provider.agentic),
          };
        for (const fn of this.catalogListeners) {
          try {
            fn(this.catalog);
          } catch (err: unknown) {
            // A single misbehaving catalog listener must not break fan-out.
            log.debug(
              { err: err instanceof Error ? err.message : String(err) },
              'Catalog listener threw; continuing',
            );
          }
        }
        return;
      }
      case 'init': {
        const tier = msg.tier as
          { id?: string; permissions?: { useRemoteProviders?: boolean } } | undefined;
        if (
          this.requireModelOnly &&
          (tier?.id !== 'models' || tier.permissions?.useRemoteProviders !== true)
        ) {
          this.connectedReject?.(
            new RelayJoinError(
              'This invitation does not grant model-only access.',
              'WRONG_MODEL_INVITE',
              400,
            ),
          );
          this.disconnect();
          return;
        }
        this.admitted = true;
        this.connectedResolve?.();
        return;
      }
      case 'inference-event': {
        const stream = this.streams.get(String(msg.requestId));
        const event = msg.event as ProviderEvent | undefined;
        if (
          this.requireModelOnly &&
          event &&
          ['file_edit', 'tool_executed', 'cli_commands'].includes(event.type)
        ) {
          stream?.fail('The remote host sent a host-tool event on an inference-only connection.');
          return;
        }
        if (stream && event) stream.push(event);
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
      case 'host-disconnected': {
        for (const stream of this.streams.values())
          stream.fail('The model-sharing host disconnected.');
        this.streams.clear();
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
    if (signal?.aborted) throw new Error('Cancelled');
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
      } catch (err: unknown) {
        // Connection already closed; the cancel can't be delivered.
        log.debug(
          { err: err instanceof Error ? err.message : String(err), requestId },
          'Inference cancel send failed; connection already gone',
        );
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
      // An agent loop may stop consuming before the host completes. Release
      // the host's request slot and quota work rather than leaving it running.
      if (!finished) {
        try {
          this.send({ type: 'inference-cancel', requestId });
        } catch {
          // A disconnected transport cannot deliver cancellation.
        }
      }
    }
  }

  disconnect(): void {
    this.connectedReject?.(new Error('Shared-model connection ended'));
    this.admitted = false;
    this.connectedResolve = null;
    this.connectedReject = null;
    this.ws?.close();
    this.ws = null;
    this.catalog = null;
    for (const stream of this.streams.values()) stream.fail('Shared-model connection ended');
    this.streams.clear();
  }
}

// A single connected host per client for now (one "my friend's PC" at a time).
export const relayGuestClient = new RelayGuestClient();
