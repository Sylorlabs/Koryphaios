import {
  webDeviceCryptography,
  type DeviceCryptography,
  type DeviceIdentity,
  type DeviceEnvelope,
  type LinkedDevice,
  DEVICE_WIRE_LIMIT,
  DEVICE_PAIR_TTL,
  decode64,
  encode64,
  validateDeviceRelayUrl,
} from './devices';
import { createDevicePairingLink } from './device-pairing-link';

export type DeviceBody = { type: string; [key: string]: unknown };
const DEVICE_CHUNK_BYTES = 512 * 1024;
const DEVICE_MAX_LOGICAL_BYTES = 1536 * 1024 * 1024;
const DEVICE_MAX_CHUNKS = Math.ceil(DEVICE_MAX_LOGICAL_BYTES / DEVICE_CHUNK_BYTES);
const DEVICE_CHUNK_TTL = 2 * 60_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
export interface DeviceClientOptions {
  cryptography?: DeviceCryptography;
  relayUrl: string;
  identity: DeviceIdentity;
  privateKey: JsonWebKey;
  peers: () => LinkedDevice[];
  onPairRequest: (request: {
    id: string;
    identity: DeviceIdentity;
    check: string;
    expiresAt: number;
  }) => void;
  onPaired: (identity: DeviceIdentity) => Promise<void>;
  onRequest: (
    from: LinkedDevice,
    operation: string,
    input: Record<string, unknown>,
    actor: 'user' | 'agent',
    requestId: string,
  ) => Promise<unknown>;
  onEvent?: (from: DeviceIdentity, body: DeviceBody) => void;
  onConnection?: (connected: boolean) => void;
}
export class DeviceClient {
  private get cryptography() {
    return this.options.cryptography ?? webDeviceCryptography;
  }
  private socket: WebSocket | null = null;
  private token = '';
  private seen = new Map<string, number>();
  private pending = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout> | null;
      peerId: string;
    }
  >();
  private candidates = new Map<
    string,
    {
      identity: DeviceIdentity;
      nonce: string;
      code: string;
      check: string;
      expiresAt: number;
      incoming: boolean;
      hostNonce?: string;
      resolveCheck?: (check: string) => void;
    }
  >();
  private invitation: { code: string; expiresAt: number } | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private connecting: Promise<void> | null = null;
  private generation = 0;
  private incoming = Promise.resolve();
  private outgoing = Promise.resolve();
  private queued = 0;
  private outboundQueued = 0;
  private incomingChunks = new Map<
    string,
    {
      peerId: string;
      parts: Array<Uint8Array<ArrayBuffer> | undefined>;
      receivedParts: number;
      receivedBytes: number;
      expiresAt: number;
    }
  >();
  private pendingChunkAcks = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(readonly options: DeviceClientOptions) {
    validateDeviceRelayUrl(options.relayUrl);
  }
  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  private async fetch(path: string, body: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${this.options.relayUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': this.options.identity.id,
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Device relay unavailable');
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
  connect(): Promise<void> {
    this.stopped = false;
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (this.retry) clearTimeout(this.retry);
    const generation = this.generation;
    const connecting = this.connectOnce(generation)
      .catch((error) => {
        if (!this.stopped && this.generation === generation) this.scheduleRetry();
        throw error;
      })
      .finally(() => {
        if (this.connecting === connecting) this.connecting = null;
      });
    this.connecting = connecting;
    return connecting;
  }
  private async connectOnce(generation: number): Promise<void> {
    const { nonce } = await this.fetch('/devices/challenge', {});
    const signature = await this.cryptography.deviceSign(
      this.options.privateKey,
      JSON.stringify([nonce, this.options.identity]),
    );
    const registration = await this.fetch('/devices/register', {
      identity: this.options.identity,
      nonce,
      signature,
    });
    if (this.stopped || this.generation !== generation) throw new Error('Device disconnected');
    this.token = registration.token;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(
        `${this.options.relayUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/devices/ws`,
        ['kory-device', this.options.identity.id, this.token],
      );
      this.socket = socket;
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Device relay connection timed out'));
      }, 15_000);
      socket.onopen = () => {
        clearTimeout(timeout);
        this.options.onConnection?.(true);
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => {
          if (this.connected) socket.send(JSON.stringify({ type: 'ping' }));
        }, 25_000);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Could not reach the device relay'));
      };
      socket.onmessage = (event) => {
        if (this.queued >= 256) return;
        this.queued++;
        this.incoming = this.incoming
          .then(() => this.receive(String(event.data)))
          .catch(() => {
            /* Reject unauthenticated or malformed frames silently. */
          })
          .finally(() => {
            this.queued--;
          });
      };
      socket.onclose = () => {
        clearTimeout(timeout);
        reject(new Error('Device connection interrupted'));
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.ping) clearInterval(this.ping);
        this.options.onConnection?.(false);
        for (const request of this.pending.values()) {
          if (request.timer) clearTimeout(request.timer);
          request.reject(new Error('Device connection interrupted'));
        }
        this.pending.clear();
        this.failChunkAcks(new Error('Device connection interrupted'));
        if (!this.stopped)
          this.retry = setTimeout(() => {
            void this.connect().catch(() => this.scheduleRetry());
          }, 5000);
      };
    });
  }
  private scheduleRetry() {
    if (this.retry) clearTimeout(this.retry);
    if (!this.stopped)
      this.retry = setTimeout(() => {
        void this.connect().catch(() => this.scheduleRetry());
      }, 5000);
  }
  stop() {
    this.stopped = true;
    this.generation++;
    this.connecting = null;
    if (this.retry) clearTimeout(this.retry);
    if (this.ping) clearInterval(this.ping);
    this.socket?.close();
    this.socket = null;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error('Device disconnected'));
    }
    this.pending.clear();
    this.failChunkAcks(new Error('Device disconnected'));
  }
  async invite() {
    if (!this.connected) await this.connect();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(
      this.cryptography.randomBytes(20),
      (value) => alphabet[value & 31],
    ).join('');
    await this.fetch('/devices/pair/start', { hash: await this.cryptography.pairingHash(code) });
    this.invitation = { code, expiresAt: Date.now() + DEVICE_PAIR_TTL };
    return {
      code: code.match(/.{1,5}/g)!.join('-'),
      expiresAt: this.invitation.expiresAt,
      qrUrl: createDevicePairingLink({
        relayUrl: this.options.relayUrl,
        code,
        hostId: this.options.identity.id,
      }),
    };
  }
  async stopInvite() {
    this.invitation = null;
    for (const [id, candidate] of this.candidates)
      if (candidate.incoming) this.candidates.delete(id);
    await this.fetch('/devices/pair/stop', {});
  }
  async pair(code: string, pinnedId?: string) {
    if (!this.connected) await this.connect();
    const identity = (
      await this.fetch('/devices/pair/lookup', { hash: await this.cryptography.pairingHash(code) })
    ).identity as DeviceIdentity;
    if (
      (await this.cryptography.deviceKeyId(identity.publicKey)) !== identity.id ||
      (pinnedId && pinnedId !== identity.id) ||
      identity.id === this.options.identity.id
    )
      throw new Error('Device identity does not match the pairing code');
    const nonce = encodeNonce(this.cryptography);
    const check = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.candidates.delete(identity.id);
        reject(new Error('The desktop did not answer the pairing request'));
      }, 15_000);
      this.candidates.set(identity.id, {
        identity,
        nonce,
        code,
        check: '',
        incoming: false,
        expiresAt: Date.now() + DEVICE_PAIR_TTL,
        resolveCheck: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      void this.cryptography
        .deviceDigest(nonce)
        .then((commit) =>
          this.send(identity, {
            type: 'pair-request',
            identity: this.options.identity,
            code,
            commit,
          }),
        )
        .catch((error) => {
          clearTimeout(timer);
          this.candidates.delete(identity.id);
          reject(error);
        });
    });
    return { identity: this.candidates.get(identity.id)?.identity ?? identity, check };
  }
  async decidePair(id: string, approved: boolean) {
    const candidate = this.candidates.get(id);
    if (
      !candidate?.incoming ||
      !candidate.check ||
      candidate.expiresAt < Date.now() ||
      !this.invitation ||
      this.invitation.expiresAt < Date.now()
    )
      throw new Error('Pairing request expired or verification is incomplete');
    this.candidates.delete(id);
    if (approved) {
      await this.options.onPaired(candidate.identity);
      await this.send(candidate.identity, { type: 'pair-approved', nonce: candidate.nonce });
      await this.stopInvite();
    } else await this.send(candidate.identity, { type: 'pair-rejected', nonce: candidate.nonce });
  }
  async send(peer: DeviceIdentity, body: DeviceBody) {
    if (!this.connected) throw new Error('Device relay is offline');
    if (this.outboundQueued >= 512) throw new Error('Device connection is busy');
    this.outboundQueued++;
    const socket = this.socket!;
    const payload = JSON.parse(JSON.stringify(body));
    const encoded = textEncoder.encode(JSON.stringify(payload));
    if (encoded.byteLength > DEVICE_MAX_LOGICAL_BYTES) {
      this.outboundQueued--;
      throw new Error('Device message is too large');
    }
    const total = Math.ceil(encoded.byteLength / DEVICE_CHUNK_BYTES);
    const transferId = this.cryptography.randomUUID();
    const sendFrame = async (frame: DeviceBody) => {
      const envelope = await this.cryptography.sealDeviceMessage(
        this.options.privateKey,
        peer,
        this.options.identity.id,
        frame,
      );
      if (this.socket !== socket || !this.connected)
        throw new Error('Device connection interrupted');
      socket.send(JSON.stringify({ type: 'envelope', envelope }));
    };
    const send = this.outgoing
      .then(async () => {
        if (encoded.byteLength <= DEVICE_WIRE_LIMIT / 2) {
          await sendFrame(payload);
          return;
        }
        for (let index = 0; index < total; index++) {
          const start = index * DEVICE_CHUNK_BYTES;
          const ack = this.waitForChunkAck(peer.id, transferId, index);
          try {
            await sendFrame({
              type: 'chunk',
              transferId,
              index,
              total,
              data: encode64(
                encoded.slice(start, Math.min(encoded.byteLength, start + DEVICE_CHUNK_BYTES)),
              ),
            });
            await ack;
          } catch (error) {
            this.cancelChunkAck(peer.id, transferId, index);
            throw error;
          }
        }
      })
      .finally(() => {
        this.outboundQueued--;
      });
    this.outgoing = send.catch(() => undefined);
    return send;
  }
  async rpc(
    peerId: string,
    operation: string,
    input: Record<string, unknown> = {},
    actor: 'user' | 'agent' = 'user',
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<any> {
    const peer = this.options.peers().find((p) => p.id === peerId);
    if (!peer) throw new Error('Device is not linked');
    if (signal?.aborted) throw new Error('Device request cancelled');
    const requestId = this.cryptography.randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new Error('Device request cancelled'));
      };
      this.pending.set(requestId, {
        peerId,
        timer: null,
        resolve: (result) => {
          signal?.removeEventListener('abort', cancel);
          resolve(result);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', cancel);
          reject(error);
        },
      });
      signal?.addEventListener('abort', cancel, { once: true });
      void this.send(peer, { type: 'request', requestId, operation, input, actor })
        .then(() => {
          const pending = this.pending.get(requestId);
          if (!pending) return;
          pending.timer = setTimeout(() => {
            this.pending.delete(requestId);
            signal?.removeEventListener('abort', cancel);
            reject(new Error('Device is offline or did not respond'));
          }, Math.max(250, timeoutMs));
        })
        .catch((error) => {
          const pending = this.pending.get(requestId);
          if (pending?.timer) clearTimeout(pending.timer);
          this.pending.delete(requestId);
          signal?.removeEventListener('abort', cancel);
          reject(error);
        });
    });
  }
  private chunkAckKey(peerId: string, transferId: string, index: number) {
    return `${peerId}:${transferId}:${index}`;
  }
  private waitForChunkAck(peerId: string, transferId: string, index: number): Promise<void> {
    const key = this.chunkAckKey(peerId, transferId, index);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingChunkAcks.delete(key);
        reject(new Error('Device transfer stalled'));
      }, 15_000);
      this.pendingChunkAcks.set(key, { resolve, reject, timer });
    });
  }
  private cancelChunkAck(peerId: string, transferId: string, index: number) {
    const key = this.chunkAckKey(peerId, transferId, index);
    const pending = this.pendingChunkAcks.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingChunkAcks.delete(key);
  }
  private resolveChunkAck(peerId: string, transferId: string, index: number) {
    const key = this.chunkAckKey(peerId, transferId, index);
    const pending = this.pendingChunkAcks.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingChunkAcks.delete(key);
    pending.resolve();
  }
  private failChunkAcks(error: Error) {
    for (const pending of this.pendingChunkAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingChunkAcks.clear();
  }
  private async sendChunkAck(peer: DeviceIdentity, transferId: string, index: number) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const envelope = await this.cryptography.sealDeviceMessage(
      this.options.privateKey,
      peer,
      this.options.identity.id,
      { type: 'chunk-ack', transferId, index },
    );
    if (this.socket !== socket || !this.connected) return;
    socket.send(JSON.stringify({ type: 'envelope', envelope }));
  }
  private acceptChunk(peerId: string, body: DeviceBody, now: number): { accepted: boolean; restored: DeviceBody | null } {
    const transferId = typeof body.transferId === 'string' ? body.transferId : '';
    const index = Number(body.index);
    const total = Number(body.total);
    const data = typeof body.data === 'string' ? body.data : '';
    if (
      !/^[a-f0-9-]{36}$/i.test(transferId) ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(total) ||
      total < 1 ||
      total > DEVICE_MAX_CHUNKS ||
      index < 0 ||
      index >= total ||
      !data ||
      data.length > DEVICE_WIRE_LIMIT
    )
      return { accepted: false, restored: null };

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = decode64(data);
    } catch {
      return { accepted: false, restored: null };
    }
    if (bytes.byteLength > DEVICE_CHUNK_BYTES) return { accepted: false, restored: null };

    const key = `${peerId}:${transferId}`;
    let transfer = this.incomingChunks.get(key);
    if (!transfer) {
      transfer = {
        peerId,
        parts: new Array(total),
        receivedParts: 0,
        receivedBytes: 0,
        expiresAt: now + DEVICE_CHUNK_TTL,
      };
      this.incomingChunks.set(key, transfer);
    }
    if (transfer.peerId !== peerId || transfer.parts.length !== total) {
      this.incomingChunks.delete(key);
      return { accepted: false, restored: null };
    }
    if (transfer.parts[index]) return { accepted: true, restored: null };
    transfer.parts[index] = bytes;
    transfer.receivedParts++;
    transfer.receivedBytes += bytes.byteLength;
    transfer.expiresAt = now + DEVICE_CHUNK_TTL;
    if (transfer.receivedBytes > DEVICE_MAX_LOGICAL_BYTES) {
      this.incomingChunks.delete(key);
      return { accepted: false, restored: null };
    }
    if (transfer.receivedParts < transfer.parts.length) return { accepted: true, restored: null };

    this.incomingChunks.delete(key);
    const combined = new Uint8Array(transfer.receivedBytes);
    let offset = 0;
    for (const part of transfer.parts) {
      combined.set(part!, offset);
      offset += part!.byteLength;
    }
    try {
      const parsed = JSON.parse(textDecoder.decode(combined)) as DeviceBody;
      return parsed && typeof parsed === 'object' && typeof parsed.type === 'string'
        ? { accepted: true, restored: parsed }
        : { accepted: false, restored: null };
    } catch {
      return { accepted: false, restored: null };
    }
  }
  private async receive(raw: string) {
    if (raw.length > DEVICE_WIRE_LIMIT) return;
    const message = JSON.parse(raw);
    if (message.type !== 'envelope') return;
    const envelope = message.envelope as DeviceEnvelope;
    const identity = message.identity as DeviceIdentity;
    if (
      (await this.cryptography.deviceKeyId(identity.publicKey)) !== identity.id ||
      identity.id !== envelope.from
    )
      return;
    const trusted = this.options.peers().find((p) => p.id === identity.id);
    const candidate = this.candidates.get(identity.id);
    if (!trusted && !candidate && (!this.invitation || this.invitation.expiresAt < Date.now()))
      return;
    let body = (await this.cryptography.openDeviceMessage(
      this.options.privateKey,
      trusted ?? candidate?.identity ?? identity,
      this.options.identity.id,
      envelope,
    )) as DeviceBody;
    const now = Date.now();
    for (const [key, timestamp] of this.seen) if (now - timestamp > 120_000) this.seen.delete(key);
    for (const [key, transfer] of this.incomingChunks)
      if (transfer.expiresAt < now) this.incomingChunks.delete(key);
    if (this.seen.has(envelope.id) || this.seen.size >= 10_000) return;
    this.seen.set(envelope.id, now);
    for (const [key, pending] of this.candidates)
      if (pending.expiresAt < now) this.candidates.delete(key);
    if (body.type === 'pair-request') {
      if (
        !this.invitation ||
        this.invitation.expiresAt < now ||
        this.candidates.size >= 5 ||
        typeof body.code !== 'string' ||
        typeof body.commit !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.commit) ||
        (await this.cryptography.pairingHash(body.code)) !==
          (await this.cryptography.pairingHash(this.invitation.code))
      )
        return;
      const signedIdentity = body.identity as DeviceIdentity;
      if (
        !signedIdentity ||
        signedIdentity.id !== identity.id ||
        (await this.cryptography.deviceKeyId(signedIdentity.publicKey)) !== identity.id ||
        typeof signedIdentity.name !== 'string' ||
        signedIdentity.name.length > 80 ||
        typeof signedIdentity.os !== 'string' ||
        signedIdentity.os.length > 40 ||
        !['desktop', 'mobile'].includes(signedIdentity.kind)
      )
        return;
      const hostNonce = encodeNonce(this.cryptography);
      this.candidates.set(identity.id, {
        identity: signedIdentity,
        nonce: body.commit,
        code: body.code,
        check: '',
        hostNonce,
        incoming: true,
        expiresAt: this.invitation.expiresAt,
      });
      await this.send(signedIdentity, {
        type: 'pair-challenge',
        commit: body.commit,
        hostNonce,
        identity: this.options.identity,
      });
      return;
    }
    if (body.type === 'pair-challenge') {
      if (
        !candidate ||
        candidate.incoming ||
        typeof body.hostNonce !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.hostNonce) ||
        body.commit !== (await this.cryptography.deviceDigest(candidate.nonce))
      )
        return;
      const host = body.identity as DeviceIdentity;
      if (
        !host ||
        host.id !== candidate.identity.id ||
        (await this.cryptography.deviceKeyId(host.publicKey)) !== host.id ||
        typeof host.name !== 'string' ||
        !host.name.trim() ||
        host.name.length > 80 ||
        typeof host.os !== 'string' ||
        host.os.length > 40 ||
        host.kind !== 'desktop'
      )
        return;
      candidate.identity = host;
      candidate.hostNonce = body.hostNonce;
      candidate.check = await this.cryptography.pairingCheck(
        candidate.code,
        identity.id,
        this.options.identity.id,
        `${candidate.nonce}:${body.hostNonce}`,
      );
      await this.send(identity, {
        type: 'pair-reveal',
        nonce: candidate.nonce,
        hostNonce: body.hostNonce,
      });
      candidate.resolveCheck?.(candidate.check);
      delete candidate.resolveCheck;
      return;
    }
    if (body.type === 'pair-reveal') {
      if (
        !candidate?.incoming ||
        typeof body.nonce !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.nonce) ||
        body.hostNonce !== candidate.hostNonce ||
        (await this.cryptography.deviceDigest(body.nonce)) !== candidate.nonce
      )
        return;
      candidate.nonce = body.nonce;
      candidate.check = await this.cryptography.pairingCheck(
        candidate.code,
        identity.id,
        this.options.identity.id,
        `${body.nonce}:${candidate.hostNonce}`,
      );
      this.options.onPairRequest({
        id: identity.id,
        identity: candidate.identity,
        check: candidate.check,
        expiresAt: candidate.expiresAt,
      });
      return;
    }
    if (body.type === 'pair-approved' || body.type === 'pair-rejected') {
      if (!candidate || candidate.incoming || body.nonce !== candidate.nonce) return;
      this.candidates.delete(identity.id);
      if (body.type === 'pair-approved') await this.options.onPaired(candidate.identity);
      this.options.onEvent?.(identity, body);
      return;
    }
    if (!trusted) return;
    if (body.type === 'chunk-ack') {
      if (typeof body.transferId === 'string' && Number.isSafeInteger(body.index))
        this.resolveChunkAck(identity.id, body.transferId, Number(body.index));
      return;
    }
    if (body.type === 'chunk') {
      const result = this.acceptChunk(identity.id, body, now);
      if (!result.accepted) return;
      await this.sendChunkAck(identity, String(body.transferId), Number(body.index));
      if (!result.restored) return;
      body = result.restored;
    }
    if (body.type === 'response' && typeof body.requestId === 'string') {
      const pending = this.pending.get(body.requestId);
      if (!pending || pending.peerId !== identity.id) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(body.requestId);
      if (typeof body.error === 'string') pending.reject(new Error(body.error));
      else pending.resolve(body.data);
    } else if (
      body.type === 'request' &&
      typeof body.requestId === 'string' &&
      /^[a-f0-9-]{36}$/.test(body.requestId) &&
      typeof body.operation === 'string' &&
      body.operation.length < 80 &&
      body.input &&
      typeof body.input === 'object' &&
      !Array.isArray(body.input)
    ) {
      // Dispatch independently: a mobile gateway RPC must be able to receive
      // its target's response while this request is still running.
      const operation = body.operation;
      const requestId = body.requestId;
      void Promise.resolve()
        .then(() =>
          this.options.onRequest(
            trusted,
            operation,
            body.input as Record<string, unknown>,
            body.actor === 'agent' ? 'agent' : 'user',
            requestId,
          ),
        )
        .then((data) => this.send(trusted, { type: 'response', requestId: body.requestId, data }))
        .catch((error) =>
          this.send(trusted, {
            type: 'response',
            requestId: body.requestId,
            error: error instanceof Error ? error.message.slice(0, 500) : 'Device request failed',
          }).catch(() => undefined),
        );
    } else this.options.onEvent?.(trusted, body);
  }
}
function encodeNonce(cryptography: DeviceCryptography) {
  return Array.from(cryptography.randomBytes(32), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function makeDeviceIdentity(
  name: string,
  os: string,
  kind: DeviceIdentity['kind'],
  cryptography = webDeviceCryptography,
) {
  const keys = await cryptography.createDeviceKeys();
  return {
    identity: {
      id: await cryptography.deviceKeyId(keys.publicKey),
      name,
      os,
      kind,
      publicKey: keys.publicKey,
    },
    privateKey: keys.privateKey,
  };
}
