import { BlockList, isIP } from 'node:net';

// Transport metadata is attached to the Request object, never to a header that
// a caller could forge. The Bun server delegates to Elysia.handle(), so Elysia's
// own server property is not available in that path.
const peers = new WeakMap<Request, string | null>();

export function recordRequestPeer(request: Request, address: string | null): void {
  peers.set(request, address);
}

export function requestPeer(request: Request): string | null {
  return peers.get(request) ?? null;
}

function normalizeIp(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4 ? lower.slice(7) : lower;
}

function trustedProxy(address: string, entries: string[]): boolean {
  const ip = normalizeIp(address);
  const family = isIP(ip);
  if (!family) return false;
  return entries.some((entry) => {
    const [base, prefix] = entry.split('/');
    if (prefix === undefined) return normalizeIp(base) === ip;
    const bits = Number(prefix);
    if (
      isIP(base) !== family ||
      !Number.isInteger(bits) ||
      bits < 0 ||
      bits > (family === 4 ? 32 : 128)
    )
      return false;
    const block = new BlockList();
    block.addSubnet(base, bits, family === 4 ? 'ipv4' : 'ipv6');
    return block.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  });
}

export function canBootstrapLocalSession(request: Request, peer: string | null): boolean {
  if (!peer) {
    // Elysia's in-process app.handle() has no transport peer. Keep that seam
    // usable for route tests while the real Bun fetch path always records one.
    const host = new URL(request.url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  }
  if (!isIP(normalizeIp(peer))) return false;
  const proxies = (process.env.KORYPHAIOS_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let client = normalizeIp(peer);
  if (trustedProxy(client, proxies)) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (!forwarded) return false;
    // Walk inward from the socket peer. An untrusted client cannot prepend a
    // fake local address to an otherwise valid forwarded chain.
    for (const hop of forwarded.split(',').reverse()) {
      if (!trustedProxy(client, proxies)) break;
      client = normalizeIp(hop.trim());
      if (!isIP(client)) return false;
    }
  }
  if (client === '::1') return true;
  if (isIP(client) !== 4) return false;
  const [a, b] = client.split('.').map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
