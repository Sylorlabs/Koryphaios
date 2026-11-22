import { expect, test } from 'bun:test';
import { ProviderRegistry } from '../providers/registry';
import { currentProviderExecutionScope, withProviderExecutionScope, withSessionProviderExecutionScope } from '../providers/execution-scope';
import { parseDeviceProviderBundle, stageDeviceProviders } from './provider-bundle';
import { makeDeviceIdentity } from '@koryphaios/shared/src/device-client';
import { openDeviceMessage, sealDeviceMessage } from '@koryphaios/shared/src/devices';
import { ensureManagedCliDirectory } from '../providers/managed-cli-storage';
import { stageAntigravityCredential } from '../providers/antigravity-credentials';
import { join } from 'node:path';

function bundle(label: string) {
  return { version: 1, providers: [{ config: { name: 'custom:portable', label,
    baseUrl: 'https://example.invalid/v1', apiKey: `synthetic-${label}`, hooks: { unsafe: true } },
    models: [{ id: 'portable-model', name: 'Portable', contextWindow: 8192, maxOutputTokens: 1024 }] }] };
}
test('concurrent device runs resolve their own credentials and never persist them in the registry', async () => {
  const registry = new ProviderRegistry();
  const first = stageDeviceProviders(bundle('first'), 'first-chat', () => {});
  const second = stageDeviceProviders(bundle('second'), 'second-chat', () => {});
  try {
    await Promise.all([first, second].map((staged) => withProviderExecutionScope(staged.scope, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const provider = registry.resolveProvider('portable-model', 'custom:portable');
      expect(provider?.config.label).toBe(staged === first ? 'first' : 'second');
      expect(registry.resolveProvider('unadvertised', 'custom:portable')).toBeUndefined();
      expect(registry.getStatus().map((entry) => entry.name)).toEqual(['custom:portable']);
      expect(currentProviderExecutionScope()?.sessionId).toBe(staged.scope.sessionId);
    })));
    expect(currentProviderExecutionScope()).toBeUndefined();
    expect(registry.getConfigs()).not.toHaveProperty('custom:portable');
  } finally { first.cleanup(); second.cleanup(); }
});
test('credential scopes reject other sessions and revoked links before contacting the endpoint', async () => {
  let authorized = true;
  const staged = stageDeviceProviders(bundle('private'), 'owning-chat', () => { if (!authorized) throw new Error('revoked'); });
  try {
    const provider = staged.scope.providers.get('custom:portable')!;
    await expect(provider.streamResponse({ model: 'portable-model', sessionId: 'other-chat', messages: [], systemPrompt: '' }).next()).rejects.toThrow('another chat');
    authorized = false;
    expect(() => withProviderExecutionScope(staged.scope, () => provider.listModels())).toThrow('revoked');
  } finally { staged.cleanup(); }
});
test('a selected provider is staged under its own name with its endpoint', () => {
  const parsed = parseDeviceProviderBundle({
    version: 1,
    providers: [{
      config: { name: 'logfare', label: 'Logfare', baseUrl: 'https://logfare.ai/v1', apiKey: 'synthetic' },
      models: [{ id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek', contextWindow: 128000, maxOutputTokens: 8192 }],
    }],
  });
  const staged = stageDeviceProviders(parsed, 'shared-chat', () => {});
  try {
    expect(staged.scope.providers.has('logfare')).toBe(true);
    expect(staged.scope.providers.get('logfare')?.listModels()[0]?.provider).toBe('logfare');
  } finally { staged.cleanup(); }
});

test('credential grants are sealed to the target identity and refuse another device', async () => {
  const source = await makeDeviceIdentity('source', 'macOS', 'desktop');
  const target = await makeDeviceIdentity('target', 'Linux', 'desktop');
  const other = await makeDeviceIdentity('other', 'Linux', 'desktop');
  const envelope = await sealDeviceMessage(source.privateKey, target.identity, source.identity.id, bundle('grant'));
  const opened = await openDeviceMessage(target.privateKey, source.identity, target.identity.id, envelope) as any;
  expect(opened.providers[0].config.apiKey).toBe('synthetic-grant');
  await expect(
    openDeviceMessage(target.privateKey, other.identity, target.identity.id, envelope),
  ).rejects.toThrow();
});

test('portable configuration cannot install hooks, local paths or unknown providers', () => {
  expect(parseDeviceProviderBundle(bundle('safe')).providers[0]!.config).not.toHaveProperty('hooks');
  expect(() => parseDeviceProviderBundle({ ...bundle('safe'), providers: [{ config: { name: 'codex' }, models: [] }] })).toThrow('Invalid device');
  const bad = bundle('bad'); bad.providers[0]!.config.baseUrl = 'file:///etc/passwd';
  expect(() => parseDeviceProviderBundle(bad)).toThrow('endpoint');
});

test('independently arriving bridge callbacks inherit only the bound session and cleanup cannot unbind its replacement', () => {
  const first = stageDeviceProviders(bundle('first'), 'callback-chat', () => {});
  const replacement = stageDeviceProviders(bundle('replacement'), 'callback-chat', () => {});
  try {
    first.bind();
    withSessionProviderExecutionScope('callback-chat', () => expect(currentProviderExecutionScope()).toBe(first.scope));
    withSessionProviderExecutionScope('other-chat', () => expect(currentProviderExecutionScope()).toBeUndefined());
    replacement.bind(); first.cleanup();
    withSessionProviderExecutionScope('callback-chat', () => expect(currentProviderExecutionScope()).toBe(replacement.scope));
  } finally { first.cleanup(); replacement.cleanup(); }
  withSessionProviderExecutionScope('callback-chat', () => expect(currentProviderExecutionScope()).toBeUndefined());
});
test('managed CLI writes admit only the host-created credential home within its active run', () => {
  const home = stageAntigravityCredential(JSON.stringify({ token: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expiry: '2027-01-01T00:00:00Z' } }));
  const staged = stageDeviceProviders(bundle('scope'), 'chat', () => {});
  staged.scope.antigravityHome = home.home;
  try {
    expect(() => ensureManagedCliDirectory(join(home.home, 'config'))).toThrow('escaped');
    withProviderExecutionScope(staged.scope, () => {
      expect(ensureManagedCliDirectory(join(home.home, 'config'))).toBe(join(home.home, 'config'));
      expect(() => ensureManagedCliDirectory(`${home.home}-other/config`)).toThrow('escaped');
    });
  } finally { staged.cleanup(); home.cleanup(); }
});
