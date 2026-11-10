import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceService } from './service';
import { WorkspaceNavigationStore } from '../stores/workspace-navigation-store';
import { getDb } from '../db';

let root = '';
let service: DeviceService;
const previous = process.env.KORYPHAIOS_REMOTE_WORKSPACE;
afterEach(() => {
  service?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.KORYPHAIOS_REMOTE_WORKSPACE;
  else process.env.KORYPHAIOS_REMOTE_WORKSPACE = previous;
  new WorkspaceNavigationStore(getDb()).clear();
});
test('workspace IDs are device-bound and symlink escapes and foreign OS paths never become filesystem authority', async () => {
  root = mkdtempSync(join(tmpdir(), 'device-paths-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'private');
  mkdirSync(workspace);
  mkdirSync(outside);
  mkdirSync(join(workspace, 'project'));
  symlinkSync(outside, join(workspace, 'escape'), 'dir');
  process.env.KORYPHAIOS_REMOTE_WORKSPACE = workspace;
  service = new DeviceService(join(root, 'state'), '');
  await service.initialize();
  const roots = service.workspaces();
  expect(roots).toHaveLength(1);
  expect(roots[0]?.id).not.toContain(workspace);
  const other = new DeviceService(join(root, 'other-state'), '');
  await other.initialize();
  expect(other.workspaces()[0]?.id).not.toBe(roots[0]?.id);
  other.stop();
  const folders = await service.execute(
    null,
    'folders',
    { workspaceId: roots[0]!.id },
    'user',
    crypto.randomUUID(),
  );
  expect(folders.map((folder: any) => folder.name)).toEqual(['project']);
  await expect(
    service.execute(
      null,
      'folders',
      { workspaceId: 'C:\\Users\\Other\\project' },
      'user',
      crypto.randomUUID(),
    ),
  ).rejects.toThrow('unavailable');
  await expect(
    service.execute(null, 'folders', { workspaceId: '../../private' }, 'user', crypto.randomUUID()),
  ).rejects.toThrow('unavailable');
  await expect(
    service.execute(null, 'workspaces', {}, 'agent', crypto.randomUUID()),
  ).rejects.toThrow('remote-agent access');
});
