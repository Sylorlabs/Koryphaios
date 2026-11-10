import { validateDeviceRelayUrl } from './devices';

export interface DevicePairingLink {
  relayUrl: string;
  code: string;
  hostId: string;
}

export function validateDevicePairingLink(input: DevicePairingLink): DevicePairingLink {
  const relayUrl = validateDeviceRelayUrl(input.relayUrl);
  const code = input.code.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{20}$/.test(code)) throw new Error('Invalid device pairing code');
  if (!/^[a-f0-9]{64}$/.test(input.hostId)) throw new Error('Invalid desktop identity');
  return { relayUrl, code, hostId: input.hostId };
}

/** Native app route. Never encode a web page or a desktop API bearer token. */
export function createDevicePairingLink(input: DevicePairingLink): string {
  const { relayUrl, code, hostId } = validateDevicePairingLink(input);
  const query = new URLSearchParams({ v: '1', relay: relayUrl, code, host: hostId });
  return `koryphaios://link-device?${query}`;
}

export function parseDevicePairingLink(value: string): DevicePairingLink {
  if (value.length > 4096) throw new Error('Invalid device pairing link');
  const url = new URL(value);
  if (
    url.protocol !== 'koryphaios:' ||
    url.hostname !== 'link-device' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.searchParams.get('v') !== '1'
  )
    throw new Error('Open a Koryphaios app pairing QR code');
  for (const key of ['v', 'relay', 'code', 'host'])
    if (url.searchParams.getAll(key).length !== 1) throw new Error('Invalid device pairing link');
  return validateDevicePairingLink({
    relayUrl: url.searchParams.get('relay') ?? '',
    code: url.searchParams.get('code') ?? '',
    hostId: url.searchParams.get('host') ?? '',
  });
}
