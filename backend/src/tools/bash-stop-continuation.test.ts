import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BashTool } from './bash';

const IS_WIN = process.platform === 'win32';
const roots: string[] = [];

function makeRoot(): string {
  const root = join(
    tmpdir(),
    `kory-bash-stop-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

describe('Bash stop semantics', () => {
  test('returns immediately and leaves an already-running command alive', async () => {
    if (IS_WIN) return; // BashTool's shell path is POSIX in this fixture.
    const root = makeRoot();
    const marker = join(root, 'finished.txt');
    const controller = new AbortController();
    const startedAt = Date.now();

    const pending = new BashTool().run(
      {
        sessionId: 'bash-stop-session',
        workingDirectory: root,
        isSandboxed: false,
        approvedToolCallIds: new Set(['bash-stop-call']),
        signal: controller.signal,
      },
      {
        id: 'bash-stop-call',
        name: 'bash',
        input: {
          command: `sleep 0.8; printf done > ${JSON.stringify(marker)}`,
          timeout: 5,
        },
      },
    );

    setTimeout(() => controller.abort(new DOMException('Stopped by user', 'AbortError')), 150);

    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(700);
    expect(result.output).toContain('left running');

    // The turn is over, but the command the user started is not killed.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(existsSync(marker)).toBe(true);
  });
});
