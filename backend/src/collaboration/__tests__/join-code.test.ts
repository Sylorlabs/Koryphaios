import { afterAll, describe, expect, test } from 'bun:test';
import { RelayJoinError, resolveTeamJoinCode } from '../join-code';

let lookups: string[] = [];
const relay = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    lookups.push(path);
    if (path === '/code/ABCDEFGH')
      return Response.json({
        ok: true,
        sessionId: 'team-1',
        sessionName: 'Live team',
        tierId: 'viewer',
        inviteUrl: 'https://relay.example/join?token=signed-invite',
      });
    if (path === '/code/ZZZZZZZZ') return new Response('Unavailable', { status: 503 });
    if (path === '/code/BBBBBBBB') return Response.json({ ok: true });
    if (path === '/code/CCCCCCCC') return Response.json({ ok: false }, { status: 429 });
    return Response.json({ ok: false, error: 'Invalid or inactive join code' }, { status: 404 });
  },
});
const relayUrl = `http://127.0.0.1:${relay.port}`;
afterAll(() => relay.stop(true));

describe('live team join-code exchange', () => {
  test('rejects malformed codes before contacting the relay', async () => {
    const before = lookups.length;
    for (const code of ['', 'short', 'AAAAAAAAA', 'ABCDEF01', '../ABCDE']) {
      await expect(resolveTeamJoinCode(code, relayUrl)).rejects.toMatchObject({
        statusCode: 400, code: 'INVALID_JOIN_CODE', message: expect.stringContaining('Not a valid code'),
      });
    }
    expect(lookups.length).toBe(before);
  });

  test('checks well-formed unknown codes against the relay', async () => {
    await expect(resolveTeamJoinCode('XXXXXXXX', relayUrl)).rejects.toMatchObject({
      statusCode: 400, code: 'INVALID_JOIN_CODE',
    });
    expect(lookups).toContain('/code/XXXXXXXX');
  });

  test('normalizes valid codes and returns the actual signed invitation', async () => {
    expect(await resolveTeamJoinCode(' abcdefgh ', relayUrl)).toMatchObject({
      sessionId: 'team-1', tierId: 'viewer', inviteUrl: expect.stringContaining('token=signed-invite'),
    });
  });

  test('distinguishes relay outages and broken responses from invalid codes', async () => {
    await expect(resolveTeamJoinCode('ZZZZZZZZ', relayUrl)).rejects.toMatchObject({
      statusCode: 503, code: 'RELAY_UNAVAILABLE',
    });
    await expect(resolveTeamJoinCode('BBBBBBBB', relayUrl)).rejects.toMatchObject({
      statusCode: 502, code: 'RELAY_INVALID_RESPONSE',
    });
    await expect(resolveTeamJoinCode('ABCDEFGH', null)).rejects.toBeInstanceOf(RelayJoinError);
    await expect(resolveTeamJoinCode('CCCCCCCC', relayUrl)).rejects.toMatchObject({ statusCode: 429, code: 'JOIN_CODE_RATE_LIMITED' });
  });
});
