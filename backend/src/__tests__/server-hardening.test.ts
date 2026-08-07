// Tests for the server hardening changes: CORS, XFF, rate limiting.
// These verify the security defaults that close the production anti-patterns.

import { describe, it, expect } from 'bun:test';
import { isPrivateIPv6 } from '../security';

// We test the helper functions directly since they're pure logic.
// The server itself is integration-tested via the smoke tests.

// Re-implement the helpers here to test the logic without spinning up
// the server. The server.ts versions must stay in sync.
function isLoopbackIp(ip: string): boolean {
  if (ip === '::1') return true;
  if (ip.startsWith('127.')) return true;
  if (ip === '::ffff:127.0.0.1') return true;
  return false;
}

function isIpInTrustedProxies(ip: string, proxies: string[]): boolean {
  if (proxies.length === 0) return false;
  for (const entry of proxies) {
    if (entry === ip) return true;
    if (entry.includes('/')) {
      // CIDR check
      const [base, prefixStr] = entry.split('/');
      if (!base || !prefixStr) continue;
      const prefix = Number(prefixStr);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue;
      const ipParts = ip.split('.').map(Number);
      const baseParts = base.split('.').map(Number);
      if (ipParts.length !== 4 || baseParts.length !== 4) continue;
      if (ipParts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) continue;
      if (baseParts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) continue;
      const ipNum = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
      const baseNum = ((baseParts[0] << 24) | (baseParts[1] << 16) | (baseParts[2] << 8) | baseParts[3]) >>> 0;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      if ((ipNum & mask) === (baseNum & mask)) return true;
    }
  }
  return false;
}

describe('server hardening — rate limit helpers', () => {
  describe('isLoopbackIp', () => {
    it('recognizes 127.0.0.1', () => {
      expect(isLoopbackIp('127.0.0.1')).toBe(true);
    });

    it('recognizes 127.x.x.x (entire /8)', () => {
      expect(isLoopbackIp('127.255.255.255')).toBe(true);
    });

    it('recognizes ::1', () => {
      expect(isLoopbackIp('::1')).toBe(true);
    });

    it('recognizes IPv4-mapped IPv6 loopback', () => {
      expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
    });

    it('rejects non-loopback addresses', () => {
      expect(isLoopbackIp('10.0.0.1')).toBe(false);
      expect(isLoopbackIp('192.168.1.1')).toBe(false);
      expect(isLoopbackIp('8.8.8.8')).toBe(false);
    });
  });

  describe('isIpInTrustedProxies', () => {
    it('returns false when no proxies are configured', () => {
      expect(isIpInTrustedProxies('10.0.0.1', [])).toBe(false);
    });

    it('matches an exact IP', () => {
      expect(isIpInTrustedProxies('10.0.0.1', ['10.0.0.1'])).toBe(true);
    });

    it('does not match an unlisted IP', () => {
      expect(isIpInTrustedProxies('10.0.0.2', ['10.0.0.1'])).toBe(false);
    });

    it('matches within a /24 CIDR', () => {
      expect(isIpInTrustedProxies('10.0.0.50', ['10.0.0.0/24'])).toBe(true);
    });

    it('does not match outside a /24 CIDR', () => {
      expect(isIpInTrustedProxies('10.0.1.1', ['10.0.0.0/24'])).toBe(false);
    });

    it('matches within a /16 CIDR', () => {
      expect(isIpInTrustedProxies('10.0.255.255', ['10.0.0.0/16'])).toBe(true);
    });

    it('matches within a /8 CIDR', () => {
      expect(isIpInTrustedProxies('10.255.255.255', ['10.0.0.0/8'])).toBe(true);
    });

    it('handles multiple proxy entries', () => {
      expect(isIpInTrustedProxies('172.16.0.1', ['10.0.0.0/8', '172.16.0.0/12'])).toBe(true);
    });

    it('matches /0 (all addresses)', () => {
      expect(isIpInTrustedProxies('8.8.8.8', ['0.0.0.0/0'])).toBe(true);
      expect(isIpInTrustedProxies('192.168.1.1', ['0.0.0.0/0'])).toBe(true);
    });

    it('matches /32 (single host)', () => {
      expect(isIpInTrustedProxies('10.0.0.1', ['10.0.0.1/32'])).toBe(true);
      expect(isIpInTrustedProxies('10.0.0.2', ['10.0.0.1/32'])).toBe(false);
    });

    it('rejects invalid CIDR prefixes', () => {
      expect(isIpInTrustedProxies('10.0.0.1', ['10.0.0.0/33'])).toBe(false);
      expect(isIpInTrustedProxies('10.0.0.1', ['10.0.0.0/-1'])).toBe(false);
      expect(isIpInTrustedProxies('10.0.0.1', ['10.0.0.0/abc'])).toBe(false);
    });
  });
});

describe('server hardening — isPrivateIPv6', () => {
  it('blocks fc00::/7 (unique local)', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fd12:3456:7890::1')).toBe(true);
  });

  it('blocks fe80::/10 (link-local)', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('fe90::1')).toBe(true);
    expect(isPrivateIPv6('fea0::1')).toBe(true);
    expect(isPrivateIPv6('feb0::1')).toBe(true);
  });

  it('does NOT block fec0:: (deprecated site-local, not in fe80::/10)', () => {
    // The old code matched `fe` broadly, which swept in fec0::.
    // The fixed code only matches fe8x/fe9x/feax/febx.
    expect(isPrivateIPv6('fec0::1')).toBe(false);
  });

  it('does NOT block fe00:: (not link-local)', () => {
    expect(isPrivateIPv6('fe00::1')).toBe(false);
  });

  it('blocks ::1 (loopback)', () => {
    expect(isPrivateIPv6('::1')).toBe(true);
  });

  it('blocks ff00::/8 (multicast)', () => {
    expect(isPrivateIPv6('ff02::1')).toBe(true);
  });

  it('blocks IPv4-mapped addresses', () => {
    expect(isPrivateIPv6('::ffff:10.0.0.1')).toBe(true);
  });

  it('blocks documentation prefix 2001:db8::/32', () => {
    expect(isPrivateIPv6('2001:db8::1')).toBe(true);
  });

  it('allows public IPv6 addresses', () => {
    expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
  });
});
