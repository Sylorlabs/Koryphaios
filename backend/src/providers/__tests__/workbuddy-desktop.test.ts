// Offline contract tests for the WorkBuddy Desktop adapter.
// Deliberately subprocess-free: no app runtime is started. The catalog
// helpers take pure inputs, and discovery/availability are exercised through
// the WORKBUDDY_DESKTOP_APP_PATH override so no real install is required.
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  locateWorkBuddyDesktopApp,
  modelsFromWorkBuddyProductJson,
  resolveWorkBuddyDesktopRuntime,
  sidecarRuntimeDir,
  findRunningDesktopSidecar,
} from '../workbuddy-desktop-runtime';
import { getKoryphaiosWorkBuddyHome, WorkBuddyDesktopProvider } from '../workbuddy-desktop';
import { canAutoEnable, cliAutoEnableCreds } from '../cli-detection';
import { isWorkBuddyDesktopAuthMarker } from '../auth-utils';
import { getCliBridge } from '../cli-bridges';
import { createKoryBridgeGrantLease } from '../bridge-grant';
import type { ProviderConfig } from '@koryphaios/shared';
import { hostOS } from '../../runtime/platform';

const ORIGINAL_APP_PATH = process.env.WORKBUDDY_DESKTOP_APP_PATH;
const ORIGINAL_CONFIG_DIR = process.env.WORKBUDDY_CONFIG_DIR;

afterEach(() => {
  if (ORIGINAL_APP_PATH === undefined) delete process.env.WORKBUDDY_DESKTOP_APP_PATH;
  else process.env.WORKBUDDY_DESKTOP_APP_PATH = ORIGINAL_APP_PATH;
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
  else process.env.WORKBUDDY_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
});

/** Build a fake host-shaped WorkBuddy AI install in a temp dir. */
function makeFakeApp(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-desktop-test-'));
  const mac = hostOS() === 'darwin';
  const app = mac ? join(root, 'WorkBuddy AI.app') : join(root, 'WorkBuddy AI');
  const resources = mac ? join(app, 'Contents', 'Resources') : join(app, 'resources');
  const cliDir = join(resources, 'app.asar.unpacked', 'cli');
  if (mac) {
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'MacOS', 'Electron'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      '<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>5.8.4</string></dict></plist>',
    );
  } else {
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'workbuddy-ai'), '#!/bin/sh\n', { mode: 0o755 });
  }
  mkdirSync(join(cliDir, 'bin'), { recursive: true });
  writeFileSync(join(cliDir, 'bin', 'codebuddy'), '#!/usr/bin/env node\n', { mode: 0o755 });
  writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ version: '5.8.4' }));
  writeFileSync(
    join(cliDir, 'product.json'),
    JSON.stringify({
      productName: 'WorkBuddy AI',
      platform: 'CLI',
      models: [
        {
          id: 'default-model',
          name: 'Default',
          maxInputTokens: 176000,
          maxOutputTokens: 24000,
          supportsToolCall: true,
          isDefault: true,
        },
        { id: 'fast-model', name: 'Fast', maxInputTokens: 200000, supportsReasoning: true },
        { id: 'deep-model', name: 'Deep', maxInputTokens: 176000 },
      ],
    }),
  );
  return app;
}

describe('workbuddy-desktop adapter offline contracts', () => {
  it('models come from the app bundle product catalog with context from maxInputTokens', () => {
    const models = modelsFromWorkBuddyProductJson({
      models: [
        {
          id: 'default-model',
          name: 'Default',
          maxInputTokens: 176000,
          maxOutputTokens: 24000,
          supportsToolCall: true,
          isDefault: true,
        },
        { id: 'fast-model', name: 'Fast', maxInputTokens: 200000, supportsReasoning: true },
      ],
    });
    expect(models.map((m) => m.apiModelId)).toEqual(['default-model', 'fast-model']);
    const def = models.find((m) => m.apiModelId === 'default-model')!;
    expect(def.contextWindow).toBe(176000);
    expect(def.contextVerified).toBe(true);
    expect(def.provider).toBe('workbuddy-desktop');
    expect(def.name.startsWith('Default')).toBe(true); // default suffix
    expect(def.canReason).toBe(false); // supportsReasoning absent
    const fast = models.find((m) => m.apiModelId === 'fast-model')!;
    expect(fast.canReason).toBe(true);
  });

  it('never offers two identically named models; the app’s own price and id distinguish them', () => {
    // Real shape from WorkBuddy AI 5.9.4 cli/product.json: two
    // "Deepseek-V4.1-Flash" entries, one free and one at x0.03 credits.
    const models = modelsFromWorkBuddyProductJson({
      models: [
        {
          id: 'deepseek-v4.1-flash',
          name: 'Deepseek-V4.1-Flash',
          credits: 'x0.00 credits',
          maxInputTokens: 1000000,
          maxOutputTokens: 128000,
          supportsImages: true,
          supportsToolCall: true,
        },
        {
          id: 'deepseek-v4.1-flash-sg',
          name: 'Deepseek-V4.1-Flash',
          credits: 'x0.03 credits',
          maxInputTokens: 1000000,
          maxOutputTokens: 128000,
          supportsImages: true,
          supportsToolCall: true,
        },
        { id: 'fast-model', name: 'Fast', maxInputTokens: 200000 },
      ],
    });
    expect(new Set(models.map((m) => m.name)).size).toBe(models.length);
    expect(models.map((m) => m.name)).toEqual([
      'Deepseek-V4.1-Flash (free)',
      'Deepseek-V4.1-Flash (0.03x)',
      'Fast',
    ]);
    expect(models.map((m) => m.id)).toEqual([
      'workbuddy-desktop-deepseek-v4.1-flash',
      'workbuddy-desktop-deepseek-v4.1-flash-sg',
      'workbuddy-desktop-fast-model',
    ]);
    expect(models[0].creditsLabel).toBe('free');
    expect(models[1].creditsLabel).toBe('0.03x');
  });

  it('shows the app’s real context tiers instead of hiding its smaller default', () => {
    const models = modelsFromWorkBuddyProductJson({
      models: [
        {
          id: 'deepseek-v4.1-flash',
          name: 'Deepseek-V4.1-Flash',
          maxInputTokens: 1000000,
          contextWindow: { supportedLengths: [300000, 1000000], defaultLength: 300000 },
        },
        { id: 'fast-model', name: 'Fast', maxInputTokens: 200000 },
      ],
    });
    expect(models[0].contextWindow).toBe(1000000);
    expect(models[0].contextWindowOptions).toEqual([300000, 1000000]);
    expect(models[0].contextWindowVendorDefault).toBe(300000);
    expect(models[1].contextWindowOptions).toBeUndefined();
  });

  it('reasoning ladders come from the runtime per-model data, never invented', () => {
    const models = modelsFromWorkBuddyProductJson({
      models: [
        {
          id: 'gpt-6-astra',
          name: 'GPT-6-Astra',
          maxInputTokens: 1000000,
          supportsReasoning: true,
          reasoning: {
            defaultEffort: 'high',
            supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            canDisableThinking: true,
          },
        },
        {
          id: 'fixed-effort-model',
          name: 'Fixed',
          maxInputTokens: 100000,
          supportsReasoning: true,
          reasoning: { effort: 'medium' }, // no ladder → no picker
        },
        {
          id: 'no-off-model',
          name: 'NoOff',
          maxInputTokens: 100000,
          supportsReasoning: true,
          reasoning: {
            supportedEfforts: ['low', 'high'],
            canDisableThinking: false, // thinking cannot be disabled
          },
        },
      ],
    });
    const astra = models.find((m) => m.apiModelId === 'gpt-6-astra')!;
    expect(astra.reasoningLevels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
    const fixed = models.find((m) => m.apiModelId === 'fixed-effort-model')!;
    expect(fixed.reasoningLevels).toBeUndefined();
    const noOff = models.find((m) => m.apiModelId === 'no-off-model')!;
    expect(noOff.reasoningLevels).toEqual(['low', 'high']);
  });

  it('locates an app install via WORKBUDDY_DESKTOP_APP_PATH and resolves its runtime', () => {
    const app = makeFakeApp();
    try {
      process.env.WORKBUDDY_DESKTOP_APP_PATH = app;
      const located = locateWorkBuddyDesktopApp();
      expect(located).not.toBeNull();
      expect(located!.appPath).toBe(app);
      const runtime = resolveWorkBuddyDesktopRuntime(located!);
      expect(runtime).not.toBeNull();
      expect(runtime!.electronBin).toBe(
        hostOS() === 'darwin'
          ? join(app, 'Contents', 'MacOS', 'Electron')
          : join(app, 'workbuddy-ai'),
      );
      expect(runtime!.cliBin).toContain('codebuddy');
      expect(runtime!.version).toBe('5.8.4');
      // Models resolve from the bundled product.json.
      expect(runtime!.cliDir).toContain('app.asar.unpacked');
    } finally {
      rmSync(join(app, '..'), { recursive: true, force: true });
    }
  });

  it('isAvailable is false when no app install is discoverable', () => {
    const empty = mkdtempSync(join(tmpdir(), 'wb-desktop-empty-'));
    try {
      process.env.WORKBUDDY_DESKTOP_APP_PATH = empty; // exists but has no runtime
      const provider = new WorkBuddyDesktopProvider({
        name: 'workbuddy-desktop',
        disabled: false,
      } as ProviderConfig);
      expect(provider.isAvailable()).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('isAvailable is true with an install and disabled config blocks it', () => {
    const app = makeFakeApp();
    try {
      process.env.WORKBUDDY_DESKTOP_APP_PATH = app;
      const enabled = new WorkBuddyDesktopProvider({
        name: 'workbuddy-desktop',
        disabled: false,
      } as ProviderConfig);
      expect(enabled.isAvailable()).toBe(true);
      const disabled = new WorkBuddyDesktopProvider({
        name: 'workbuddy-desktop',
        disabled: true,
      } as ProviderConfig);
      expect(disabled.isAvailable()).toBe(false);
    } finally {
      rmSync(join(app, '..'), { recursive: true, force: true });
    }
  });

  it('stages WorkBuddy auth files from the desktop config directory', () => {
    const source = mkdtempSync(join(tmpdir(), 'wb-desktop-auth-source-'));
    const homeRoot = mkdtempSync(join(tmpdir(), 'wb-desktop-auth-home-'));
    const files = ['settings.json', '.credentials.json', 'auth.json'];
    try {
      for (const file of files) writeFileSync(join(source, file), `${file}-contents`);

      const staged = getKoryphaiosWorkBuddyHome(source, homeRoot);

      for (const file of files) {
        expect(readlinkSync(join(staged, file))).toBe(join(source, file));
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(homeRoot, { recursive: true, force: true });
    }
  });

  it('the sidecar runtime dir matches the protocol layout (instance token hash)', () => {
    const dir = sidecarRuntimeDir('/Users/test/.workbuddy-ai');
    // instanceToken = sha1(configDir)[0:12]
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const token = createHash('sha1').update('/Users/test/.workbuddy-ai').digest('hex').slice(0, 12);
    expect(dir.endsWith(token)).toBe(true);
    // No sidecar running in a fresh dir.
    process.env.WORKBUDDY_CONFIG_DIR = '/tmp/wb-desktop-test-no-sidecar';
    expect(findRunningDesktopSidecar('/tmp/wb-desktop-test-no-sidecar')).toBeNull();
  });

  it('discovers a running sidecar from its JSON PID record (attach mode)', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'wb-sidecar-'));
    const runtimeDir = sidecarRuntimeDir(configDir);
    mkdirSync(runtimeDir, { recursive: true });
    // Real WorkBuddy writes a JSON record, not a bare integer. The parent
    // process is alive and is not this process, so liveness passes without
    // spawning a sidecar.
    writeFileSync(
      join(runtimeDir, 'sidecar.pid'),
      JSON.stringify({ pid: process.ppid, token: 't', version: 6, controlPipeUuid: 'abcd1234' }),
    );
    writeFileSync(join(runtimeDir, 'sidecar-abcd1234.sock'), '');
    try {
      const sidecar = findRunningDesktopSidecar(configDir);
      expect(sidecar).not.toBeNull();
      expect(sidecar!.pid).toBe(process.ppid);
      expect(sidecar!.controlSocketPath).toBe(join(runtimeDir, 'sidecar-abcd1234.sock'));
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('the CLI bridge injects the kory MCP server config', () => {
    const bridge = getCliBridge('workbuddy-desktop');
    expect(bridge).not.toBeNull();
    expect(bridge!.preferredTransport).toBe('acp');
    const caps = bridge!.getCapabilities();
    expect(caps.supportsAcp).toBe(true);
    expect(caps.supportsMcp).toBe(true);
    const lease = createKoryBridgeGrantLease('test-session-wb-desktop', 'manager');
    try {
      const ctx = {
        provider: 'workbuddy-desktop' as const,
        role: 'manager' as const,
        sandbox: undefined,
        workingDirectory: process.cwd(),
        sessionId: 'test-session-wb-desktop',
        systemPrompt: 'test',
        tools: [],
        bridgeGrantLease: lease,
      };
      const mcp = bridge!.buildMcpConfig(ctx);
      expect(mcp).not.toBeNull();
      expect(mcp!.length).toBe(1);
      expect(mcp![0].name).toBe('kory');
      expect(mcp![0].transport).toBe('stdio');
      // The kory bridge script is the arg, the grant file is in env.
      expect(mcp![0].args.some((a) => a.includes('kory-mcp-bridge'))).toBe(true);
      expect(mcp![0].env?.KORY_BRIDGE_AUTH_FILE).toBeTruthy();
    } finally {
      lease.cleanup();
    }
  });

  it('builtin CLI commands are surfaced', () => {
    const provider = new WorkBuddyDesktopProvider({
      name: 'workbuddy-desktop',
      disabled: false,
    } as ProviderConfig);
    const commands = provider.getCliCommands!();
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((c) => c.category === 'builtin')).toBe(true);
  });

  it('zero-config: an installed app auto-enables with no token', () => {
    const app = makeFakeApp();
    // The isolated runner disables CLI autodetect globally; this test is
    // specifically about the autodetect contract, so opt back in for its
    // duration and restore the harness value afterwards.
    const previousAutodetect = process.env.KORY_DISABLE_CLI_AUTODETECT;
    delete process.env.KORY_DISABLE_CLI_AUTODETECT;
    try {
      process.env.WORKBUDDY_DESKTOP_APP_PATH = app;
      // Installing the app is the whole configuration: detection succeeds and
      // the marker (never a real credential) says "use the desktop runtime".
      expect(canAutoEnable('workbuddy-desktop')).toBe(true);
      const marker = cliAutoEnableCreds('workbuddy-desktop');
      expect(marker?.authToken).toContain('workbuddy-desktop:installed:');
      expect(isWorkBuddyDesktopAuthMarker(marker?.authToken)).toBe(true);
    } finally {
      if (previousAutodetect === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
      else process.env.KORY_DISABLE_CLI_AUTODETECT = previousAutodetect;
      rmSync(join(app, '..'), { recursive: true, force: true });
    }
    // Not installed → no auto-enable, nothing to enter.
    const empty = mkdtempSync(join(tmpdir(), 'wb-desktop-none-'));
    delete process.env.KORY_DISABLE_CLI_AUTODETECT;
    try {
      process.env.WORKBUDDY_DESKTOP_APP_PATH = empty;
      expect(canAutoEnable('workbuddy-desktop')).toBe(false);
      expect(cliAutoEnableCreds('workbuddy-desktop')).toBeNull();
    } finally {
      if (previousAutodetect === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
      else process.env.KORY_DISABLE_CLI_AUTODETECT = previousAutodetect;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
