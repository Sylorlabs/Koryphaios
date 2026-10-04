import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteProvider } from '../remote-provider';
import { relayGuestClient } from '../../collaboration/relay-guest-client';
import type { ProviderEvent, StreamRequest } from '../types';
import type { RemoteInferenceRequestPayload } from '@koryphaios/shared';
import { toRemoteStreamRequest } from '../../collaboration/remote-provider-host';

// Prove the sync-back loop: a host `file_edit` event (path relative to the host
// sandbox) is written to the CLIENT's own project directory.
describe('RemoteProvider agentic write-back', () => {
  let root: string;
  const original = {
    isConnected: Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(relayGuestClient),
      'isConnected',
    ),
    requestInference: relayGuestClient.requestInference,
  };

  afterEach(async () => {
    if (original.isConnected) {
      Object.defineProperty(
        Object.getPrototypeOf(relayGuestClient),
        'isConnected',
        original.isConnected,
      );
    }
    relayGuestClient.requestInference = original.requestInference;
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('a host file_edit lands on the client filesystem', async () => {
    root = await mkdtemp(join(tmpdir(), 'ra-client-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'existing.ts'), 'old');

    // Stub the transport: always connected; the "host" edits src/new.ts.
    Object.defineProperty(Object.getPrototypeOf(relayGuestClient), 'isConnected', {
      configurable: true,
      get: () => true,
    });
    relayGuestClient.requestInference = async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: 'content_delta', content: 'writing files' };
      yield {
        type: 'file_edit',
        filePath: 'src/new.ts', // sandbox-relative, as the host rebases it
        fileContent: 'export const created = true;',
        fileOperation: 'create',
      };
      yield { type: 'complete', finishReason: 'end_turn' };
    } as never;

    const provider = new RemoteProvider({
      id: 'remote-claude',
      label: "Micah's PC · Claude Code (runs on host)",
      hostProvider: 'claude',
      agentic: true,
      models: [
        {
          id: 'claude-sonnet-5',
          name: 'Claude Sonnet 5',
          provider: 'remote-claude' as never,
          contextWindow: 200_000,
          maxOutputTokens: 64_000,
        },
      ],
    });

    const request: StreamRequest = {
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'add a file' }],
      systemPrompt: '',
      workingDirectory: root,
    };

    const events: ProviderEvent[] = [];
    for await (const ev of provider.streamResponse(request)) events.push(ev);

    // The edited file exists on the CLIENT with the host's content.
    const written = await readFile(join(root, 'src', 'new.ts'), 'utf-8');
    expect(written).toBe('export const created = true;');
    // The file_edit event is still surfaced for the UI.
    expect(events.some((e) => e.type === 'file_edit' && e.filePath === 'src/new.ts')).toBe(true);
  });

  test.each([false, true])(
    'preserves route-scoped image confirmation across the relay (agentic=%s)',
    async (agentic) => {
      root = await mkdtemp(join(tmpdir(), 'ra-images-'));
      Object.defineProperty(Object.getPrototypeOf(relayGuestClient), 'isConnected', {
        configurable: true,
        get: () => true,
      });
      let payload: RemoteInferenceRequestPayload | undefined;
      relayGuestClient.requestInference = async function* (input) {
        payload = input;
        yield { type: 'complete', finishReason: 'end_turn' } as ProviderEvent;
      };
      const provider = new RemoteProvider({
        id: 'remote-custom-vision',
        hostProvider: 'custom:vision',
        label: 'Host vision',
        agentic,
        models: [],
      });
      const request: StreamRequest = {
        model: 'vision:latest',
        systemPrompt: '',
        workingDirectory: root,
        imageInputOverride: { provider: provider.name, model: 'vision:latest' },
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', imageData: 'cGl4ZWxz', imageMimeType: 'image/png' }],
          },
        ],
      };
      for await (const _event of provider.streamResponse(request)) {
      }
      expect(payload?.imageInputOverride).toEqual({
        provider: 'custom:vision',
        model: 'vision:latest',
      });
      const hostRequest = toRemoteStreamRequest(
        payload!,
        new AbortController().signal,
        agentic ? '/host/sandbox' : undefined,
      );
      expect(hostRequest.imageInputOverride).toEqual(payload?.imageInputOverride);
      expect(hostRequest.messages).toEqual(request.messages);
      expect(hostRequest.workingDirectory).toBe(agentic ? '/host/sandbox' : undefined);
    },
  );

  test('the host drops an image override that names a different route', () => {
    const payload: RemoteInferenceRequestPayload = {
      provider: 'google',
      model: 'gemini',
      systemPrompt: '',
      messages: [],
      imageInputOverride: { provider: 'anthropic', model: 'gemini' },
    };
    expect(
      toRemoteStreamRequest(payload, new AbortController().signal).imageInputOverride,
    ).toBeUndefined();
    payload.imageInputOverride = { provider: 'google', model: 'different' };
    expect(
      toRemoteStreamRequest(payload, new AbortController().signal).imageInputOverride,
    ).toBeUndefined();
  });
});
