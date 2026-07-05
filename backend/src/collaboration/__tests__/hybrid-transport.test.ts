import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { RelayClient } from '../relay-client';
import { DEFAULT_COLLABORATION_POLICY } from '@koryphaios/shared';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';

const port = 18_180;
const relayUrl = `http://127.0.0.1:${port}`;
const hostSecret = 'hybrid-test-host-secret';
let relay: ReturnType<typeof Bun.spawn>;

async function waitFor(check: () => boolean, timeoutMs = 10_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for hybrid transport');
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  relay = Bun.spawn(['bun', 'run', resolve(import.meta.dir, '../../../../relay/server.ts')], {
    env: { ...process.env, PORT: String(port), HOST_SECRET: hostSecret, JWT_SECRET: 'hybrid-test-jwt-secret' },
    stdout: 'ignore', stderr: 'ignore',
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${relayUrl}/health`)).ok) return; } catch { /* starting */ }
    await Bun.sleep(25);
  }
  throw new Error('Test relay did not start');
});

afterAll(() => relay?.kill());

describe('WebRTC-first collaboration transport', () => {
  test('uses a direct data channel and retains the relay as signaling/fallback', async () => {
    const host = new RelayClient({ relayUrl, hostSecret });
    await host.startSession('hybrid-test-session');
    await host.updatePolicy({ ...structuredClone(DEFAULT_COLLABORATION_POLICY), joinMode: 'auto', defaultTierId: 'collaborator' });
    const inviteUrl = await host.createInvite('collaborator');
    const token = new URL(inviteUrl).searchParams.get('token');
    expect(token).toBeTruthy();

    const guestWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token!)}&name=HybridTest`);
    const guestPeer = new RTCPeerConnection({ iceServers: [] });
    const channel = guestPeer.createDataChannel('koryphaios');
    let directOpen = false;
    let directHostEvent = '';
    let receivedPrompt: Record<string, unknown> | null = null;
    channel.stateChanged.subscribe(state => { if (state === 'open') directOpen = true; });
    channel.onMessage.subscribe(raw => { directHostEvent = String(raw); });
    guestPeer.onIceCandidate.subscribe(candidate => {
      if (candidate && guestWs.readyState === WebSocket.OPEN) guestWs.send(JSON.stringify({ type: 'rtc-ice', candidate: candidate.toJSON() }));
    });
    host.onMessage(message => { if (message.type === 'guest-prompt') receivedPrompt = message; });

    guestWs.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'init') {
        void (async () => {
          const offer = await guestPeer.createOffer();
          await guestPeer.setLocalDescription(offer);
          guestWs.send(JSON.stringify({ type: 'rtc-offer', description: { type: offer.type, sdp: offer.sdp } }));
        })();
      } else if (message.type === 'rtc-answer') {
        void guestPeer.setRemoteDescription(message.description);
      } else if (message.type === 'rtc-ice' && message.candidate) {
        void guestPeer.addIceCandidate(message.candidate);
      }
    });

    await waitFor(() => directOpen);
    channel.send(JSON.stringify({ type: 'guest-prompt', name: 'HybridTest', content: 'direct hello' }));
    await waitFor(() => receivedPrompt !== null);
    expect(receivedPrompt?.transport).toBe('p2p');
    expect(receivedPrompt?.content).toBe('direct hello');

    host.broadcast({ type: 'chat', from: 'agent', content: 'direct response' });
    await waitFor(() => directHostEvent.includes('direct response'));

    guestWs.close();
    await guestPeer.close();
    await host.disconnect();
  }, 20_000);
});
