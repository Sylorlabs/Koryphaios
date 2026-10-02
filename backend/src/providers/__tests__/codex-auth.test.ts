import { afterAll, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createCliAttachmentScope } from '../cli-attachments';
import { codexJsonEvents, isTransientCodexFailure } from '../codex-cli';
import { getKoryphaiosCodexHome } from '../cli-bridges';

// Codex auth tests involve provider instantiation that can be slow under
// parallel test load.
setDefaultTimeout(30000);
import type { KoryphaiosConfig } from '@koryphaios/shared';

const account = mock(async () => ({
  account: { type: 'chatgpt', planType: 'pro' },
  requiresOpenaiAuth: true,
}));
const listModels = mock(async () => [
  {
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    isDefault: true,
    inputModalities: ['text', 'image'],
  },
]);

// A successful browser callback reaches setCredentials before a provider
// instance exists. This mock proves the registry validates that path directly
// against the managed app-server and then creates the provider.
mock.module('../codex-app-server', () => ({
  getManagedCodexAppServer: () => ({ account, listModels }),
}));

const { ProviderRegistry } = await import('../registry');
const { CODEX_MANAGED_AUTH_MARKER, buildCodexAuthPrompt } = await import('../codex-auth');

function config(): KoryphaiosConfig {
  return {
    providers: {},
    agents: {
      manager: { model: 'gpt-5.6-sol' },
      coder: { model: 'gpt-5.6-sol' },
      task: { model: 'gpt-5.6-sol' },
    },
    server: { port: 3000, host: 'localhost' },
    dataDirectory: '.koryphaios-test',
  };
}

describe('OpenAI Codex managed ChatGPT auth', () => {
  it('rejects API keys because it is not the OpenAI API provider', async () => {
    const registry = new ProviderRegistry(config());
    const result = await registry.setCredentials('codex-auth', { apiKey: 'sk-not-accepted' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('account auth only');
  });

  it('activates a fresh provider from app-server ChatGPT state without raw OAuth tokens', async () => {
    const registry = new ProviderRegistry(config());
    const result = await registry.setCredentials('codex-auth', {
      authToken: CODEX_MANAGED_AUTH_MARKER,
    });

    expect(result).toEqual({ success: true });
    expect(account).toHaveBeenCalledWith(true);
    expect(registry.get('codex-auth')?.isAvailable()).toBe(true);
    expect(
      registry
        .get('codex-auth')
        ?.listModels()
        .map((model) => model.apiModelId),
    ).toEqual(['gpt-5.6-sol']);
    expect(registry.get('codex-auth')?.listModels()[0]?.supportsAttachments).toBe(true);
  });

  it('keeps screenshot bytes out of the managed-auth prompt while materializing a private input', () => {
    const scope = createCliAttachmentScope();
    const imageData = Buffer.from('managed-auth-screenshot').toString('base64');
    let imagePath = '';
    try {
      const prompt = buildCodexAuthPrompt(
        '',
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect this screen.' },
              { type: 'image', imageData, imageMimeType: 'image/png' },
            ],
          },
        ],
        scope,
      );
      imagePath = scope.artifacts[0]!.path;
      expect(prompt).toContain(imagePath);
      expect(prompt).not.toContain(imageData);
      expect(existsSync(imagePath)).toBe(true);
    } finally {
      scope.cleanup();
    }
    expect(existsSync(imagePath)).toBe(false);
  });

  it('passes tools into the prompt with the KORY_TOOL_CALL envelope and harness note', () => {
    const scope = createCliAttachmentScope();
    try {
      const prompt = buildCodexAuthPrompt(
        'Be helpful.',
        [{ role: 'user', content: 'Read the file.' }],
        scope,
        [{ name: 'kory__read_file', description: 'read', inputSchema: {} }],
        'manager',
      );
      expect(prompt).toContain('kory__read_file');
      expect(prompt).toContain('<KORY_TOOL_CALL>');
      expect(prompt).toContain('Koryphaios');
      expect(prompt).toContain('kory MCP');
    } finally {
      scope.cleanup();
    }
  });

  it('emits tool_use events from the KORY_TOOL_CALL envelope via shared codexJsonEvents', () => {
    const { events, completed } = codexJsonEvents(
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'Working <KORY_TOOL_CALL>{"name":"kory__read_file","input":{"path":"/tmp/x"}}</KORY_TOOL_CALL>',
        },
      },
      ['kory__read_file'],
    );
    expect(completed).toBe(false);
    expect(events.some((e) => e.type === 'tool_use_start')).toBe(true);
    expect(events.some((e) => e.type === 'tool_use_delta')).toBe(true);
    expect(events.some((e) => e.type === 'tool_use_stop')).toBe(true);
    const start = events.find((e) => e.type === 'tool_use_start');
    expect(start?.toolName).toBe('kory__read_file');
  });

  it('surfaces turn.failed as an error via shared codexJsonEvents', () => {
    const { events, completed } = codexJsonEvents(
      { type: 'turn.failed', error: { message: 'boom-failed' } },
      [],
    );
    expect(completed).toBe(true);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(err?.error).toContain('boom-failed');
  });

  it('wires the Kory MCP profile and streams tool_use through the fake codex CLI', async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), 'kory-fake-codex-'));
    const originalPath = process.env.PATH ?? '';
    try {
      const fakeBin = join(fakeDir, 'codex');
      writeFileSync(
        fakeBin,
        [
          '#!/bin/sh',
          'dir="$(dirname "$0")"',
          'printf \'%s\\n\' "$@" > "$dir/args.txt"',
          'cat > "$dir/stdin.txt"',
          'if [ -f "$dir/mode-failed" ]; then',
          '  printf \'%s\\n\' \'{"type":"turn.failed","error":{"message":"boom-failed"}}\'',
          'else',
          '  printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"Working <KORY_TOOL_CALL>{\\"name\\":\\"kory__read_file\\",\\"input\\":{\\"path\\":\\"/tmp/x\\"}} </KORY_TOOL_CALL>"}}\'',
          '  printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10,"cached_input_tokens":20}}\'',
          'fi',
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);
      process.env.PATH = `${fakeDir}${delimiter}${originalPath}`;

      const registry = new ProviderRegistry(config());
      const result = await registry.setCredentials('codex-auth', {
        authToken: CODEX_MANAGED_AUTH_MARKER,
      });
      expect(result).toEqual({ success: true });
      const provider = registry.get('codex-auth');
      expect(provider).toBeDefined();

      const events: Array<{ type: string; [k: string]: unknown }> = [];
      for await (const event of provider!.streamResponse({
        model: 'gpt-5.6-sol',
        systemPrompt: 'Be helpful.',
        messages: [{ role: 'user', content: 'Read the file.' }],
        tools: [{ name: 'kory__read_file', description: 'read', inputSchema: {} }],
        harnessRole: 'manager',
        sessionId: 'test-session-codex-auth',
      } as never)) {
        events.push(event as never);
      }

      // Tool envelope from the fake CLI surfaces as tool_use_* (manager executes).
      expect(events.some((e) => e.type === 'tool_use_start')).toBe(true);
      expect(events.some((e) => e.type === 'tool_use_stop')).toBe(true);
      // Usage keeps the estimated + billing contract.
      const usage = events.find((e) => e.type === 'usage_update') as
        { estimated?: boolean; billingTokensIn?: number } | undefined;
      expect(usage?.estimated).toBe(true);
      expect(usage?.billingTokensIn).toBe(100);
      expect(events.some((e) => e.type === 'complete')).toBe(true);

      // Prompt sent over stdin carries the tool protocol.
      const stdin = readFileSync(join(fakeDir, 'stdin.txt'), 'utf8');
      expect(stdin).toContain('kory__read_file');
      expect(stdin).toContain('<KORY_TOOL_CALL>');

      // MCP profile is layered via --profile kory; sandbox stays read-only.
      const argv = readFileSync(join(fakeDir, 'args.txt'), 'utf8');
      expect(argv).toContain('--profile');
      expect(argv).toContain('--sandbox');
      expect(argv).toContain('read-only');
      expect(argv).toContain('--ask-for-approval');
      expect(argv).not.toContain('mcp_servers={}');

      const codexHome = getKoryphaiosCodexHome();
      const profilePath = join(codexHome, 'kory.config.toml');
      expect(existsSync(profilePath)).toBe(true);
      expect(readFileSync(profilePath, 'utf8')).toContain('[mcp_servers.kory]');
    } finally {
      process.env.PATH = originalPath;
      rmSync(fakeDir, { recursive: true, force: true });
      try {
        const codexHome = getKoryphaiosCodexHome();
        rmSync(join(codexHome, 'kory.config.toml'), { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('keeps third-party MCP servers out when no tools are requested', async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), 'kory-fake-codex-'));
    const originalPath = process.env.PATH ?? '';
    try {
      const fakeBin = join(fakeDir, 'codex');
      writeFileSync(
        fakeBin,
        [
          '#!/bin/sh',
          'dir="$(dirname "$0")"',
          'printf \'%s\\n\' "$@" > "$dir/args.txt"',
          'cat > "$dir/stdin.txt"',
          'printf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}\'',
          'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\'',
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);
      process.env.PATH = `${fakeDir}${delimiter}${originalPath}`;

      const registry = new ProviderRegistry(config());
      await registry.setCredentials('codex-auth', { authToken: CODEX_MANAGED_AUTH_MARKER });
      const provider = registry.get('codex-auth');
      expect(provider).toBeDefined();

      const events: unknown[] = [];
      for await (const event of provider!.streamResponse({
        model: 'gpt-5.6-sol',
        systemPrompt: 'Be helpful.',
        messages: [{ role: 'user', content: 'Hi.' }],
        sessionId: 'test-session-codex-auth-no-tools',
      } as never)) {
        events.push(event);
      }
      const argv = readFileSync(join(fakeDir, 'args.txt'), 'utf8');
      expect(argv).toContain('mcp_servers={}');
      expect(argv).not.toContain('--profile');
    } finally {
      process.env.PATH = originalPath;
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('surfaces turn.failed from the managed-auth child as an error event', async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), 'kory-fake-codex-'));
    const originalPath = process.env.PATH ?? '';
    try {
      const fakeBin = join(fakeDir, 'codex');
      writeFileSync(
        fakeBin,
        [
          '#!/bin/sh',
          'dir="$(dirname "$0")"',
          'printf \'%s\\n\' "$@" > "$dir/args.txt"',
          'cat > "$dir/stdin.txt"',
          'printf \'%s\\n\' \'{"type":"turn.failed","error":{"message":"boom-failed"}}\'',
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);
      writeFileSync(join(fakeDir, 'mode-failed'), '1');
      process.env.PATH = `${fakeDir}${delimiter}${originalPath}`;

      const registry = new ProviderRegistry(config());
      await registry.setCredentials('codex-auth', { authToken: CODEX_MANAGED_AUTH_MARKER });
      const provider = registry.get('codex-auth');
      expect(provider).toBeDefined();

      const events: Array<{ type: string; error?: string }> = [];
      for await (const event of provider!.streamResponse({
        model: 'gpt-5.6-sol',
        systemPrompt: 'Be helpful.',
        messages: [{ role: 'user', content: 'Hi.' }],
        tools: [{ name: 'kory__read_file', description: 'read', inputSchema: {} }],
        sessionId: 'test-session-codex-auth-failed',
      } as never)) {
        events.push(event as never);
      }
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
      expect(err?.error).toContain('boom-failed');
    } finally {
      process.env.PATH = originalPath;
      rmSync(fakeDir, { recursive: true, force: true });
      try {
        const codexHome = getKoryphaiosCodexHome();
        rmSync(join(codexHome, 'kory.config.toml'), { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('shares the transient classification with the CLI-backed provider', () => {
    expect(
      isTransientCodexFailure(
        "Reconnecting... 1/5 (stream disconnected before completion: ChatGPT ended the turn with 'Something went wrong'. Retry the turn.)",
      ),
    ).toBe(true);
    expect(isTransientCodexFailure('Not logged in - please run codex login')).toBe(false);
    expect(isTransientCodexFailure('turn token is invalid, expired, or revoked')).toBe(true);
  });

  it('maps a transient nonzero exit to the honest banner without leaking stderr', async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), 'kory-fake-codex-'));
    const originalPath = process.env.PATH ?? '';
    try {
      const fakeBin = join(fakeDir, 'codex');
      writeFileSync(
        fakeBin,
        [
          '#!/bin/sh',
          'cat > /dev/null',
          "printf '%s\\n' \"Reconnecting... 1/5 (stream disconnected before completion: ChatGPT ended the turn with 'Something went wrong'. Retry the turn.)\" >&2",
          'exit 1',
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);
      process.env.PATH = `${fakeDir}${delimiter}${originalPath}`;

      const registry = new ProviderRegistry(config());
      await registry.setCredentials('codex-auth', { authToken: CODEX_MANAGED_AUTH_MARKER });
      const provider = registry.get('codex-auth');
      expect(provider).toBeDefined();

      const events: Array<{ type: string; error?: string }> = [];
      for await (const event of provider!.streamResponse({
        model: 'gpt-5.6-sol',
        systemPrompt: 'Be helpful.',
        messages: [{ role: 'user', content: 'Hi.' }],
        sessionId: 'test-session-codex-auth-transient',
      } as never)) {
        events.push(event as never);
      }
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
      expect(err?.error).toContain('transient ChatGPT disconnect');
      expect(err?.error).toContain('Nothing was lost');
      expect(err?.error).not.toContain('provider said');
      expect(err?.error).not.toContain('Reconnecting');
    } finally {
      process.env.PATH = originalPath;
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('keeps auth nonzero exits fail-closed with the authentication banner', async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), 'kory-fake-codex-'));
    const originalPath = process.env.PATH ?? '';
    try {
      const fakeBin = join(fakeDir, 'codex');
      writeFileSync(
        fakeBin,
        [
          '#!/bin/sh',
          'cat > /dev/null',
          "printf '%s\\n' 'error: not logged in, please run codex login' >&2",
          'exit 1',
          '',
        ].join('\n'),
      );
      chmodSync(fakeBin, 0o755);
      process.env.PATH = `${fakeDir}${delimiter}${originalPath}`;

      const registry = new ProviderRegistry(config());
      await registry.setCredentials('codex-auth', { authToken: CODEX_MANAGED_AUTH_MARKER });
      const provider = registry.get('codex-auth');
      expect(provider).toBeDefined();

      const events: Array<{ type: string; error?: string }> = [];
      for await (const event of provider!.streamResponse({
        model: 'gpt-5.6-sol',
        systemPrompt: 'Be helpful.',
        messages: [{ role: 'user', content: 'Hi.' }],
        sessionId: 'test-session-codex-auth-denied',
      } as never)) {
        events.push(event as never);
      }
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
      expect(err?.error).toContain('authentication failed');
      expect(err?.error).not.toContain('transient');
    } finally {
      process.env.PATH = originalPath;
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });
});

afterAll(() => mock.restore());
