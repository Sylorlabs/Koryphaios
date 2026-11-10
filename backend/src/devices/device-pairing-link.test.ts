import { expect, test } from 'bun:test';
import {
  createDevicePairingLink,
  parseDevicePairingLink,
} from '@koryphaios/shared/src/device-pairing-link';

const input = {
  relayUrl: 'https://relay.example.com',
  code: 'ABCDE-FGHJK-LMNPQ-RSTUV',
  hostId: 'a'.repeat(64),
};
test('device QR opens the installed mobile app and roundtrips the relay, code and pinned desktop', () => {
  const link = createDevicePairingLink(input);
  expect(link).toStartWith('koryphaios://link-device?');
  expect(link).not.toContain('/link-device#');
  expect(parseDevicePairingLink(link)).toEqual({ ...input, code: input.code.replace(/-/g, '') });
});
test('pairing links reject web routes, unsafe relay URLs, duplicate parameters and missing host identities', () => {
  const link = createDevicePairingLink(input);
  for (const invalid of [
    link.replace('koryphaios:', 'https:'),
    `${link}&host=${input.hostId}`,
    link.replace('v=1', 'v=2'),
    link.replace(`host=${input.hostId}`, 'host='),
    link.replace('https%3A%2F%2Frelay.example.com', 'http%3A%2F%2Funtrusted.example.com'),
    link.replace('code=ABCDEFGHJKLMNPQRSTUV', 'code=invalid'),
    `${link}#browser-fallback`,
  ])
    expect(() => parseDevicePairingLink(invalid)).toThrow();
});
