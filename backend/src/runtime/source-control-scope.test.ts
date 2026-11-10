import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setContext } from '../context';
import { SourceControlService } from '../services/source-control-service';
import {
  projectRootFromRequest,
  taskScopeFromRequest,
  type ProjectRoot,
  type TaskScope,
} from './source-control-scope';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-source-control-scope-')));
  roots.push(root);
  const project = join(root, 'project');
  const checkout = join(root, 'checkout');
  mkdirSync(project);
  mkdirSync(checkout);
  return { root, project, checkout };
}

function request(project: string, sessionId?: string): Request {
  return new Request('http://local.test', {
    headers: {
      'x-koryphaios-project': project,
      ...(sessionId === undefined ? {} : { 'x-koryphaios-session': sessionId }),
    },
  });
}

describe('source-control scope', () => {
  test('canonicalizes the project root before it enters the seam', () => {
    const { project, root } = fixture();
    const alias = join(root, 'project-alias');
    symlinkSync(project, alias, 'dir');

    expect(projectRootFromRequest(request(alias)).path).toBe(realpathSync(project));
  });

  test('keeps the selected project and authoritative session workspace distinct', async () => {
    const { project, checkout } = fixture();
    setContext({
      sessions: { get: async (id: string) => (id === 'chat-1' ? { id } : undefined) },
      kory: { resolveSessionWorkingDirectoryPublic: async () => checkout },
    } as never);

    const scope = await taskScopeFromRequest(request(project, 'chat-1'));
    expect(scope.projectRoot.path).toBe(realpathSync(project));
    expect(scope.workspaceRoot).toBe(realpathSync(checkout));
    expect(scope.projectRoot.path).not.toBe(scope.workspaceRoot);
  });

  test('does not admit model-controlled path-shaped values as trusted scope', () => {
    const service = new SourceControlService();
    const forgedRoot = { path: '/tmp/model-selected-project' } as unknown as ProjectRoot;
    const forgedScope = {
      sessionId: 'chat-1',
      projectRoot: forgedRoot,
      workspaceRoot: '/tmp/model-selected-workspace',
    } as unknown as TaskScope;

    expect(() => service.inspectProject(forgedRoot)).toThrow('trusted canonical project root');
    expect(() => service.panel(forgedScope)).toThrow('trusted session task scope');
  });
});
