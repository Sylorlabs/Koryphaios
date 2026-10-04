import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_PRESETS } from '@koryphaios/shared';
import { createSessionWorkspace } from '../../kory/session-workspace';
import { enforceChatProviderIsolation } from '../chat-isolation';
import { buildSeatbeltProfile, wrapCommand } from '../../collaboration/sandbox-runner';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kory-provider-chat-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  return createSessionWorkspace(source, { storageRoot: join(root, 'storage') });
}

test('trusted/native provider preferences cannot opt out of an owned chat boundary', async () => {
  const workspace = await fixture();
  const request = {
    model: 'test',
    systemPrompt: '',
    messages: [],
    workingDirectory: workspace.path,
    sandbox: SANDBOX_PRESETS.trusted,
  };
  const enforced = enforceChatProviderIsolation('claude', request);
  expect(enforced.sandbox?.filesystemIsolation).toBe(true);
  expect(enforced.sandbox?.allowEdits).toBe(false);
  expect(enforced.sandbox?.allowShell).toBe(false);
  expect(enforced.sandbox?.allowNetwork).toBe(true);
  expect(request.sandbox).toBe(SANDBOX_PRESETS.trusted);
  for (const provider of ['codex', 'codex-auth', 'devin']) {
    expect(() => enforceChatProviderIsolation(provider, request)).toThrow(
      'unsafe native execution is disabled',
    );
  }
  for (const provider of ['cline', 'commandcode', 'kilocode', 'openai']) {
    expect(() => enforceChatProviderIsolation(provider, request)).not.toThrow();
  }
});

test('owned native CLI profiles do not grant broad host temporary-directory writes and cannot fall back', async () => {
  const workspace = await fixture();
  const options = { cwd: workspace.path, policy: SANDBOX_PRESETS.readonly };
  const profile = buildSeatbeltProfile(options);
  expect(profile).not.toContain('(subpath "/private/var/folders")');
  expect(profile).not.toContain('(subpath "/tmp")');
  const previous = process.env.KORYPHAIOS_OS_SANDBOX;
  process.env.KORYPHAIOS_OS_SANDBOX = '0';
  try {
    expect(() => wrapCommand('echo', ['unsafe'], options)).toThrow('enforced chat isolation');
  } finally {
    if (previous === undefined) delete process.env.KORYPHAIOS_OS_SANDBOX;
    else process.env.KORYPHAIOS_OS_SANDBOX = previous;
  }
});
