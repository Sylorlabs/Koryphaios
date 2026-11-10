import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWindows } from '../../runtime/platform';
import { createIsolatedCodexSkillEvalExecutor } from '../skill-eval-codex';
import { reactBrowserReadiness } from '../skill-eval-react-browser-fixtures';
import { browserControlTest } from './browser-runtime-test-policy';

const browserTest = isWindows() ? test.skip : browserControlTest('React executor', reactBrowserReadiness());

// A local stub tests the Codex CLI invocation and the live inspector handshake.
// It does not represent a model-driven qualification or a scorer verdict.
browserTest('React executor retains workspace-write and serves Chromium to the isolated CLI workspace', async () => {
  // The subprocess stub is a POSIX shell fixture; Windows is explicitly skipped.
  const root = mkdtempSync(join(tmpdir(), 'kory-react-browser-executor-'));
  const sourceAuth = join(root, 'source-auth');
  const fakeCLI = join(root, 'fake-codex.sh');
  const configured = {
    KORY_SKILL_EVAL_CODEX_BINARY: process.env.KORY_SKILL_EVAL_CODEX_BINARY,
    KORY_SKILL_EVAL_SOURCE_CODEX_HOME: process.env.KORY_SKILL_EVAL_SOURCE_CODEX_HOME,
    KORY_SKILL_EVAL_OPENAI_BASE_URL: process.env.KORY_SKILL_EVAL_OPENAI_BASE_URL,
  };
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'verification'));
    mkdirSync(sourceAuth);
    writeFileSync(join(sourceAuth, 'auth.json'), '{}\n');
    writeFileSync(join(root, 'design.css'), 'body{color:inherit}');
    writeFileSync(
      join(root, 'src', 'main.jsx'),
      [
        "import React from 'react';",
        "import { createRoot } from 'react-dom/client';",
        "createRoot(document.getElementById('root')).render(<p id='rendered'>Chromium observed</p>);",
      ].join('\n'),
    );
    writeFileSync(
      fakeCLI,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-fixture 1.0\\n'
  exit 0
fi
printf '%s\\n' "$@" > verification/codex-arguments.txt
cat > verification/codex-prompt.txt
printf '%s\\n' '{"requestId":"executor-smoke","actions":[{"type":"wait","selector":"#rendered"},{"type":"text","selector":"#rendered"}]}' > verification/react-browser-request.json
i=0
while [ "$i" -lt 80 ]; do
  if grep -q '"scoring": "unscored;' verification/react-browser-response.json; then break; fi
  sleep 0.1
  i=$((i+1))
done
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output-last-message' ]; then output="$2"; break; fi
  shift
done
if [ -n "$output" ]; then printf 'stub completed\\n' > "$output"; fi
`,
    );
    chmodSync(fakeCLI, 0o700);
    process.env.KORY_SKILL_EVAL_CODEX_BINARY = fakeCLI;
    process.env.KORY_SKILL_EVAL_SOURCE_CODEX_HOME = sourceAuth;
    delete process.env.KORY_SKILL_EVAL_OPENAI_BASE_URL;

    const executor = createIsolatedCodexSkillEvalExecutor({ wallClockMs: 15_000 });
    const observation = await executor.execute({
      experiment: {} as never,
      scenario: {
        id: 'react-engineering-full-task-1-individual',
        environment: { kind: 'browser', startingState: 'fixture', requirements: [] },
      } as never,
      workingDirectory: root,
      taskPrompt: 'Inspect the rendered component.',
      skillContext: null,
    });
    expect(observation.infrastructureFailure).toBeUndefined();
    expect(observation.taskFailure).toBeUndefined();
    expect(observation.output).toBe('stub completed');
    const args = readFileSync(join(root, 'verification', 'codex-arguments.txt'), 'utf8').split(
      '\n',
    );
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(args).not.toContain('danger-full-access');
    expect(readFileSync(join(root, 'verification', 'codex-prompt.txt'), 'utf8')).toContain(
      'evaluator-owned, limited real Chromium inspector',
    );
    const response = JSON.parse(
      readFileSync(join(root, 'verification', 'react-browser-response.json'), 'utf8'),
    );
    expect(response).toMatchObject({
      requestId: 'executor-smoke',
      status: 'ok',
      scoring: 'unscored; independent evaluator runs separately',
    });
    expect(response.browser).toMatch(/^Chromium \d/u);
    expect(response.observations[1].value).toBe('Chromium observed');
  } finally {
    for (const [key, value] of Object.entries(configured)) {
      if (value === undefined) delete process.env[key as keyof typeof configured];
      else process.env[key as keyof typeof configured] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
