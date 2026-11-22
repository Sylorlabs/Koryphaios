#!/usr/bin/env bun
/**
 * Live check for the banned-name bouncer, using the real tool implementations and
 * the real `executeTool` pipeline — no mocks. A refusal must leave no artifact on
 * disk (that is what makes it a bouncer rather than a killer), and an ordinary
 * call must still succeed (so the ban is not just blocking everything).
 *
 *   bun run scripts/verify-banned-names.ts
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { BANNED_NAME_REASON } from '../backend/src/security/banned-names';
import {
  BashTool,
  ReadFileTool,
  ToolRegistry,
  WriteFileTool,
  type ToolContext,
} from '../backend/src/tools';

const failures: string[] = [];
let checks = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures.push(label + (detail ? ` — ${detail}` : ''));
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

const root = mkdtempSync(join(tmpdir(), 'kory-bouncer-live-'));
const workspace = join(root, 'workspace');
mkdirSync(workspace, { recursive: true });

const registry = new ToolRegistry();
registry.register(new WriteFileTool());
registry.register(new BashTool());
registry.register(new ReadFileTool());

const ctx: ToolContext = {
  sessionId: 'verify-bouncer',
  workingDirectory: workspace,
};

const bannedPath = join(workspace, 'Native Settings', 'index.html');

console.log('bouncer live check');
console.log(`  workspace: ${relative(process.cwd(), workspace) || workspace}`);

// 1. The exact call the owner is trying to stop.
{
  const result = await registry.execute(ctx, {
    id: 'live-1',
    name: 'write_file',
    input: { path: bannedPath, content: '<title>Native Settings</title>' },
  });
  check(
    'write_file to "Native Settings/index.html" is refused',
    result.isError && result.output === BANNED_NAME_REASON,
    result.output.slice(0, 120),
  );
  check('no directory was created on disk', !existsSync(join(workspace, 'Native Settings')));
  check('workspace is still empty', readdirSync(workspace).length === 0);
}

// 2. A shell launch of an existing bundle carrying the name.
{
  const result = await registry.execute(ctx, {
    id: 'live-2',
    name: 'bash',
    input: { command: 'open "/tmp/Native-Settings.app"' },
  });
  check(
    'bash launch of a banned app name is refused',
    result.isError && result.output === BANNED_NAME_REASON,
    result.output.slice(0, 120),
  );
}

// 3. The name buried in file content rather than the path.
{
  const result = await registry.execute(ctx, {
    id: 'live-3',
    name: 'write_file',
    input: { path: join(workspace, 'plain.html'), content: '<title>Native Settings</title>' },
  });
  check(
    'banned name in content is refused',
    result.isError && result.output === BANNED_NAME_REASON,
    result.output.slice(0, 120),
  );
  check('the plain.html artifact was not written', !existsSync(join(workspace, 'plain.html')));
}

// 4. An ordinary write must still work through the same pipeline.
{
  const result = await registry.execute(ctx, {
    id: 'live-4',
    name: 'write_file',
    input: { path: join(workspace, 'notes.md'), content: '# notes\n' },
  });
  check('an ordinary write_file succeeds', !result.isError, result.output.slice(0, 160));
  check('the ordinary file exists', existsSync(join(workspace, 'notes.md')));
}

// 5. Reading an existing file whose name carries the token is allowed.
{
  const legit = join(workspace, 'native-settings-controls.test.ts');
  writeFileSync(legit, 'export const ok = true;\n');
  const result = await registry.execute(ctx, {
    id: 'live-5',
    name: 'read_file',
    input: { path: legit },
  });
  check(
    'read_file of an existing banned-token filename is allowed',
    !result.isError,
    result.output.slice(0, 160),
  );
  check('the read returned the file content', result.output.includes('export const ok'));
}

// 6. The ban must not turn into a blanket refusal: an ordinary shell command runs.
{
  const result = await registry.execute(ctx, {
    id: 'live-6',
    name: 'bash',
    input: { command: 'pwd' },
  });
  check('an ordinary bash command still runs', !result.isError, result.output.slice(0, 160));
  check(
    'the shell actually executed in the workspace',
    result.output.includes('kory-bouncer-live-'),
  );
}

rmSync(root, { recursive: true, force: true });

console.log('');
if (failures.length === 0) {
  console.log(`PASS — ${checks} checks, the bouncer refuses before anything is written`);
  process.exit(0);
}
console.log(`FAIL — ${failures.length} of ${checks} checks failed:`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(1);
