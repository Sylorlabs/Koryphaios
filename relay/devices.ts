import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  deviceKeyId,
  deviceVerify,
  DEVICE_PAIR_TTL,
  DEVICE_WIRE_LIMIT,
  type DeviceIdentity,
} from '../shared/src/devices';

type Registration = { identity: DeviceIdentity; token: string; socket?: any; touched: number };
export class DeviceRelay {
  private devices = new Map<string, Registration>();
  private invites = new Map<string, { deviceId: string; expiresAt: number }>();
  private windows = new Map<string, { count: number; started: number }>();
  private challenges = new Map<string, { nonce: string; expiresAt: number }>();
  private traffic = new Map<string, { bytes: number; started: number }>();
  private rate(address: string, route: string, limit = 20): boolean {
    const now = Date.now();
    for (const [key, item] of this.windows)
      if (now - item.started > 60_000) this.windows.delete(key);
    if (this.windows.size > 10_000) return false;
    const key = `${address}:${route}`;
    const window = this.windows.get(key) ?? { count: 0, started: now };
    this.windows.set(key, window);
    return ++window.count <= limit;
  }
  private authorized(req: Request): Registration | undefined {
    const id = req.headers.get('x-device-id') ?? '';
    const registration = this.devices.get(id);
    const token = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (
      !/^[a-f0-9]{64}$/.test(token) ||
      !registration ||
      token.length !== registration.token.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(registration.token))
    )
      return;
    return registration;
  }
  async fetch(req: Request, server: any): Promise<Response | undefined | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/devices/')) return null;
    const json = (data: unknown, status = 200) =>
      Response.json(data, {
        status,
        headers: {
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'content-type, authorization, x-device-id',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        },
      });
    if (req.method === 'OPTIONS') return json({}, 200);
    const address = server.requestIP(req)?.address ?? 'unknown';
    const route = [
      '/devices/challenge',
      '/devices/register',
      '/devices/pair/lookup',
      '/devices/ws',
      '/devices/pair/start',
      '/devices/pair/stop',
    ].includes(url.pathname)
      ? url.pathname
      : 'unknown';
    if (!this.rate(address, route, url.pathname === '/devices/pair/lookup' ? 10 : 60))
      return json({ error: 'Too many requests. Try again in a minute.' }, 429);
    const readInput = async (): Promise<any> => {
      const reader = req.body?.getReader();
      if (!reader) return null;
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8192) {
            await reader.cancel();
            throw new Error('Too large');
          }
          chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return null;
      }
    };
    const now = Date.now();
    for (const [key, challenge] of this.challenges)
      if (challenge.expiresAt < now) this.challenges.delete(key);
    for (const [key, invite] of this.invites) if (invite.expiresAt < now) this.invites.delete(key);
    for (const [key, device] of this.devices)
      if (!device.socket && now - device.touched > 24 * 60 * 60_000) this.devices.delete(key);
    if (url.pathname === '/devices/challenge' && req.method === 'POST') {
      if (this.challenges.size > 5000) return json({ error: 'Relay busy' }, 503);
      const nonce = randomBytes(32).toString('hex');
      this.challenges.set(nonce, { nonce, expiresAt: Date.now() + 30_000 });
      for (const [key, value] of this.challenges)
        if (value.expiresAt < Date.now()) this.challenges.delete(key);
      return json({ nonce });
    }
    if (url.pathname === '/devices/register' && req.method === 'POST') {
      if (Number(req.headers.get('content-length') ?? 0) > 8192)
        return json({ error: 'Too large' }, 413);
      const input = await readInput();
      const identity = input?.identity as DeviceIdentity;
      const challenge = this.challenges.get(input?.nonce);
      if (!challenge || challenge.expiresAt < Date.now())
        return json({ error: 'Challenge expired' }, 401);
      this.challenges.delete(input.nonce);
      try {
        if (
          (await deviceKeyId(identity.publicKey)) !== identity.id ||
          !(await deviceVerify(
            identity.publicKey,
            JSON.stringify([input.nonce, identity]),
            input.signature,
          ))
        )
          throw new Error();
        if (
          !['desktop', 'mobile'].includes(identity.kind) ||
          typeof identity.name !== 'string' ||
          !identity.name.trim() ||
          identity.name.length > 80 ||
          typeof identity.os !== 'string' ||
          identity.os.length > 40
        )
          throw new Error();
      } catch {
        return json({ error: 'Device identity rejected' }, 401);
      }
      if (this.devices.size >= 5000 && !this.devices.has(identity.id))
        return json({ error: 'Relay busy' }, 503);
      this.devices.get(identity.id)?.socket?.close(4001, 'Device reconnected');
      const registration = {
        identity,
        token: randomBytes(32).toString('hex'),
        touched: Date.now(),
      };
      this.devices.set(identity.id, registration);
      return json({ token: registration.token });
    }
    if (url.pathname === '/devices/pair/lookup' && req.method === 'POST') {
      const input = await readInput();
      if (!/^[a-f0-9]{64}$/.test(input?.hash ?? ''))
        return json({ error: 'Invalid device code' }, 400);
      const invite = this.invites.get(input.hash);
      const host = invite && this.devices.get(invite.deviceId);
      if (!invite || invite.expiresAt < Date.now() || !host?.socket)
        return json({ error: 'Device code expired or device offline' }, 404);
      return json({ identity: host.identity });
    }
    if (url.pathname === '/devices/ws') {
      // Browsers use a subprotocol, keeping connection credentials out of URLs.
      const protocols =
        req.headers
          .get('sec-websocket-protocol')
          ?.split(',')
          .map((s) => s.trim()) ?? [];
      const id = protocols[1] ?? req.headers.get('x-device-id') ?? '';
      const headers = new Headers(req.headers);
      if (protocols[2]) headers.set('authorization', `Bearer ${protocols[2]}`);
      headers.set('x-device-id', id);
      if (!this.authorized(new Request(req, { headers })))
        return json({ error: 'Unauthorized' }, 401);
      if (
        server.upgrade(req, {
          headers: { 'Sec-WebSocket-Protocol': 'kory-device' },
          data: { role: 'device', deviceId: id },
        })
      )
        return undefined;
      return json({ error: 'Upgrade failed' }, 400);
    }
    const registration = this.authorized(req);
    if (!registration) return json({ error: 'Unauthorized' }, 401);
    if (url.pathname === '/devices/pair/start' && req.method === 'POST') {
      const input = await readInput();
      if (!/^[a-f0-9]{64}$/.test(input?.hash ?? ''))
        return json({ error: 'Invalid code hash' }, 400);
      for (const [key, invite] of this.invites)
        if (invite.deviceId === registration.identity.id || invite.expiresAt < Date.now())
          this.invites.delete(key);
      this.invites.set(input.hash, {
        deviceId: registration.identity.id,
        expiresAt: Date.now() + DEVICE_PAIR_TTL,
      });
      return json({ ok: true });
    }
    if (url.pathname === '/devices/pair/stop' && req.method === 'POST') {
      for (const [key, invite] of this.invites)
        if (invite.deviceId === registration.identity.id) this.invites.delete(key);
      return json({ ok: true });
    }
    return json({ error: 'Not found' }, 404);
  }
  open(ws: any) {
    const device = this.devices.get(ws.data.deviceId);
    if (!device) return ws.close(4001, 'Unknown device');
    device.socket = ws;
    ws.send(JSON.stringify({ type: 'ready' }));
  }
  message(ws: any, raw: unknown) {
    if (String(raw).length > DEVICE_WIRE_LIMIT) return ws.close(1009, 'Too large');
    if (!this.rate(ws.data.deviceId, 'frames', 6000)) return;
    const now = Date.now();
    const traffic = this.traffic.get(ws.data.deviceId);
    const budget = traffic && now - traffic.started < 60_000 ? traffic : { bytes: 0, started: now };
    budget.bytes += Buffer.byteLength(String(raw));
    this.traffic.set(ws.data.deviceId, budget);
    if (budget.bytes > 32 * 1024 * 1024) return;
    let input: any;
    try {
      input = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (input.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
    const envelope = input.envelope;
    if (!envelope || envelope.from !== ws.data.deviceId || typeof envelope.to !== 'string') return;
    const sender = this.devices.get(ws.data.deviceId);
    if (!sender || sender.socket !== ws) return;
    sender.touched = Date.now();
    const destination = this.devices.get(envelope.to);
    if (destination?.socket) {
      if (destination.socket.getBufferedAmount() > DEVICE_WIRE_LIMIT) return;
      destination.socket.send(
        JSON.stringify({ type: 'envelope', envelope, identity: sender.identity }),
      );
    }
  }
  close(ws: any) {
    const device = this.devices.get(ws.data.deviceId);
    if (device && device.socket === ws) {
      delete device.socket;
      device.touched = Date.now();
      this.traffic.delete(ws.data.deviceId);
    }
    for (const [id, item] of this.devices)
      if (!item.socket && Date.now() - item.touched > 24 * 60 * 60_000) this.devices.delete(id);
  }
}
export const deviceRelay = new DeviceRelay();
