import { describe, expect, test } from 'bun:test';
import { configuredSecretValues, protectRemoteEvents } from '../remote-output';
import type { ProviderEvent } from '../../providers/types';

async function collect(events: ProviderEvent[], secrets: string[]) {
  const result: ProviderEvent[] = [];
  async function* source() {
    for (const event of events) yield event;
  }
  for await (const event of protectRemoteEvents(source(), secrets)) result.push(event);
  return result;
}

describe('remote inference credential boundary', () => {
  test('holds long login tokens across output boundaries without emitting a prefix', async () => {
    const token = 'a'.repeat(5000);
    const events: ProviderEvent[] = [];
    const text = `Normal output. Bearer ${token}`;
    for (let offset = 0; offset < text.length; offset += 73)
      events.push({ type: 'content_delta', content: text.slice(offset, offset + 73) });
    events.push({ type: 'complete' });
    const result = await collect(events, []);
    expect(result.map((event) => event.content || '').join('')).toBe('Normal output. [redacted]');
  });
  test('redacts host keys and header values split across streamed deltas', async () => {
    const key = 'host-opaque-api-credential-12345';
    const auth = 'host-opaque-login-credential-54321';
    const secrets = configuredSecretValues({
      openai: { apiKey: key, headers: { 'x-custom-auth': auth } },
    });
    const result = await collect(
      [
        { type: 'content_delta', content: `Reply ${key.slice(0, 14)}` },
        { type: 'usage_update', tokensIn: 42, accountId: 'host-private-account' },
        { type: 'content_delta', content: `${key.slice(14)} and ${auth}` },
        { type: 'complete', finishReason: 'end_turn' },
      ],
      secrets,
    );
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(auth);
    expect(JSON.stringify(result)).not.toContain('host-private-account');
    expect(
      result
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.content)
        .join(''),
    ).toBe('Reply [redacted] and [redacted]');
  });

  test('drops arbitrary auth/config fields and raw provider errors while retaining useful output', async () => {
    const result = await collect(
      [
        {
          type: 'content_delta',
          content: 'A useful answer.',
          apiKey: 'extra-secret',
          credentials: { token: 'hidden' },
        } as ProviderEvent,
        { type: 'error', error: 'Login failed with password=provider-secret' },
        { type: 'cli_commands', cliCommands: [{ name: 'login', description: 'token=cli-secret' }] },
      ],
      [],
    );
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain('extra-secret');
    expect(encoded).not.toContain('hidden');
    expect(encoded).not.toContain('provider-secret');
    expect(encoded).not.toContain('cli-secret');
    expect(encoded).toContain('A useful answer.');
    expect(encoded).toContain('host can check');
  });

  test('does not leak recognized login tokens when streamed in small pieces', async () => {
    const text = 'Bearer abcdef1234567890-private-login-token';
    const events: ProviderEvent[] = [...text].map((content) => ({
      type: 'content_delta',
      content,
    }));
    events.push({ type: 'complete' });
    const result = await collect(events, []);
    const content = result.map((event) => event.content || '').join('');
    expect(content).toBe('[redacted]');
  });
});
