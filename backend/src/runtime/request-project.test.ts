import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getRequestProjectRoot } from './request-project';
import { PROJECT_ROOT } from './paths';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function requestFor(project?: string): Request {
  return new Request('http://local.test', {
    headers: project ? { 'x-koryphaios-project': project } : undefined,
  });
}

describe('request project resolution', () => {
  test('uses the launch root only when no project was explicitly supplied', () => {
    expect(getRequestProjectRoot(requestFor())).toBe(PROJECT_ROOT);
  });

  test('returns an explicitly selected existing directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-request-project-'));
    temporaryRoots.push(root);

    expect(getRequestProjectRoot(requestFor(root))).toBe(resolve(root));
  });

  test('rejects relative, missing, and non-directory project selections', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-request-project-'));
    temporaryRoots.push(root);
    const file = join(root, 'not-a-project');
    writeFileSync(file, 'file');

    expect(() => getRequestProjectRoot(requestFor('relative/project'))).toThrow('must be absolute');
    expect(() => getRequestProjectRoot(requestFor(join(root, 'missing')))).toThrow(
      'directory is unavailable',
    );
    expect(() => getRequestProjectRoot(requestFor(file))).toThrow('directory is unavailable');
  });
});
