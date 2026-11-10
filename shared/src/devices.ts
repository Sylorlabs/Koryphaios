export interface DeviceIdentity {
  id: string;
  name: string;
  os: string;
  kind: 'desktop' | 'mobile';
  publicKey: JsonWebKey;
}
export interface LinkedDevice extends DeviceIdentity {
  online: boolean;
  linkedAt: number;
  allowAgents: boolean;
}
export interface DeviceWorkspace {
  id: string;
  name: string;
  /** Display only: the receiver must never interpret another device's path. */
  displayPath: string;
}
export interface DeviceChat {
  id: string;
  title: string;
  deviceId: string;
  deviceName: string;
  workspaceName: string;
}
export interface DeviceFolderListing {
  current: DeviceWorkspace;
  parent: DeviceWorkspace | null;
  folders: DeviceWorkspace[];
}
export interface DeviceEnvelope {
  version: 1;
  from: string;
  to: string;
  id: string;
  timestamp: number;
  iv: string;
  ciphertext: string;
  signature: string;
}
export const DEVICE_WIRE_LIMIT = 2 * 1024 * 1024;
export const DEVICE_PAIR_TTL = 10 * 60_000;
export function validateDeviceRelayUrl(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Device linking requires HTTPS, or loopback for testing');
  return url.toString().replace(/\/$/, '');
}
const encoder = new TextEncoder();
export function encode64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
export function decode64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
export async function deviceKeyId(key: JsonWebKey): Promise<string> {
  if (key.kty !== 'EC' || key.crv !== 'P-256' || !key.x || !key.y || key.d)
    throw new Error('Invalid device public key');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${key.crv}:${key.x}:${key.y}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function createDeviceKeys(): Promise<{
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return {
    publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey),
  };
}
function signingKey(key: JsonWebKey, privateKey: boolean) {
  return crypto.subtle.importKey(
    'jwk',
    { ...key, key_ops: privateKey ? ['sign'] : ['verify'] },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    privateKey ? ['sign'] : ['verify'],
  );
}
export async function deviceSign(privateKey: JsonWebKey, text: string): Promise<string> {
  return encode64(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        await signingKey(privateKey, true),
        encoder.encode(text),
      ),
    ),
  );
}
export async function deviceVerify(
  publicKey: JsonWebKey,
  text: string,
  signature: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await signingKey(publicKey, false),
      decode64(signature),
      encoder.encode(text),
    );
  } catch {
    return false;
  }
}
async function encryptionKey(
  privateKey: JsonWebKey,
  publicKey: JsonWebKey,
  from: string,
  to: string,
) {
  const own = await crypto.subtle.importKey(
    'jwk',
    { ...privateKey, key_ops: ['deriveBits'] },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const peer = await crypto.subtle.importKey(
    'jwk',
    { ...publicKey, key_ops: [] },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, own, 256);
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('kory-device-v1'),
      info: encoder.encode([from, to].sort().join(':')),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
function header(envelope: Omit<DeviceEnvelope, 'signature' | 'ciphertext'>): string {
  return JSON.stringify([
    envelope.version,
    envelope.from,
    envelope.to,
    envelope.id,
    envelope.timestamp,
    envelope.iv,
  ]);
}
export async function sealDeviceMessage(
  privateKey: JsonWebKey,
  peer: DeviceIdentity,
  from: string,
  body: unknown,
): Promise<DeviceEnvelope> {
  const envelope = {
    version: 1 as const,
    from,
    to: peer.id,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    iv: encode64(crypto.getRandomValues(new Uint8Array(12))),
  };
  const plaintext = encoder.encode(JSON.stringify(body));
  if (plaintext.length > DEVICE_WIRE_LIMIT / 2) throw new Error('Device message is too large');
  const ciphertext = encode64(
    new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: decode64(envelope.iv),
          additionalData: encoder.encode(header(envelope)),
        },
        await encryptionKey(privateKey, peer.publicKey, from, peer.id),
        plaintext,
      ),
    ),
  );
  return {
    ...envelope,
    ciphertext,
    signature: await deviceSign(privateKey, `${header(envelope)}:${ciphertext}`),
  };
}
export async function openDeviceMessage(
  privateKey: JsonWebKey,
  peer: DeviceIdentity,
  ownId: string,
  envelope: DeviceEnvelope,
  now = Date.now(),
): Promise<unknown> {
  if (
    envelope.version !== 1 ||
    envelope.to !== ownId ||
    envelope.from !== peer.id ||
    !Number.isFinite(envelope.timestamp) ||
    Math.abs(now - envelope.timestamp) > 120_000 ||
    typeof envelope.id !== 'string' ||
    envelope.id.length > 64 ||
    typeof envelope.ciphertext !== 'string' ||
    envelope.ciphertext.length > DEVICE_WIRE_LIMIT ||
    decode64(envelope.iv).length !== 12
  )
    throw new Error('Invalid or expired device message');
  if (
    !(await deviceVerify(
      peer.publicKey,
      `${header(envelope)}:${envelope.ciphertext}`,
      envelope.signature,
    ))
  )
    throw new Error('Device signature rejected');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decode64(envelope.iv),
      additionalData: encoder.encode(header(envelope)),
    },
    await encryptionKey(privateKey, peer.publicKey, envelope.from, envelope.to),
    decode64(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
export async function pairingHash(code: string): Promise<string> {
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{20}$/.test(normalized))
    throw new Error('Enter the 20-character device code');
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(normalized))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function deviceDigest(text: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function pairingCheck(
  code: string,
  a: string,
  b: string,
  nonce: string,
): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode([await pairingHash(code), ...[a, b].sort(), nonce].join(':')),
  );
  const digits = (new DataView(hash).getUint32(0) % 1_000_000).toString().padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** Native clients supply equivalent primitives without a browser WebCrypto global. */
export interface DeviceCryptography {
  createDeviceKeys: typeof createDeviceKeys;
  deviceKeyId: typeof deviceKeyId;
  deviceSign: typeof deviceSign;
  openDeviceMessage: typeof openDeviceMessage;
  sealDeviceMessage: typeof sealDeviceMessage;
  pairingHash: typeof pairingHash;
  pairingCheck: typeof pairingCheck;
  deviceDigest: typeof deviceDigest;
  randomBytes: (length: number) => Uint8Array;
  randomUUID: () => string;
}

export const webDeviceCryptography: DeviceCryptography = {
  createDeviceKeys,
  deviceKeyId,
  deviceSign,
  openDeviceMessage,
  sealDeviceMessage,
  pairingHash,
  pairingCheck,
  deviceDigest,
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  randomUUID: () => crypto.randomUUID(),
};
