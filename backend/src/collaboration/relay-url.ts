import { RelayJoinError } from './join-code';

/** Sharing capabilities and prompts use TLS outside the local test transport. */
export function modelSharingRelayUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new RelayJoinError('Enter a valid model-sharing relay URL.', 'INVALID_RELAY_URL', 400);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password ||
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')))
    throw new RelayJoinError('Model sharing requires an HTTPS relay. Plain HTTP is supported only on loopback.', 'INSECURE_RELAY_URL', 400);
  return url;
}
