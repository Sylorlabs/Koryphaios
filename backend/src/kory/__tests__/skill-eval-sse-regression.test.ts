import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKEND_STATE_SKILL_EVAL_MATERIALIZERS,
  BACKEND_STATE_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-backend-state-fixtures';
import { readFixtureText, writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('SSE qualification requires tests that catch stale-token reconnect loops', async () => {
  const id = 'realtime-systems-full-task-2-individual';
  const root = mkdtempSync(join(tmpdir(), 'kory-sse-regression-'));
  roots.push(root);
  const materializer = BACKEND_STATE_SKILL_EVAL_MATERIALIZERS.find((m) =>
    m.matches({ id } as never),
  )!;
  await materializer.materialize(root, { id } as never);
  const scorer = BACKEND_STATE_SKILL_EVAL_SCORERS.find((s) => s.scenarioIds.includes(id))!;

  const original = readFixtureText(root, 'src/realtime.ts');
  const repaired = original.replace(
    'return{...state,attempts:state.attempts+1};',
    [
      'if(state.terminal)return state;',
      'const attempts=state.attempts+1;',
      'if(!state.authValid){',
      'const result=refresh();',
      'if(!result.ok||!result.token)return{...state,attempts,terminal:true};',
      'return{...state,attempts,authValid:true,authToken:result.token,terminal:false};',
      '}',
      'return{...state,attempts,terminal:attempts>=maxAttempts};',
    ].join(''),
  );
  expect(repaired).not.toBe(original);
  writeFixtureFile(root, 'src/realtime.ts', repaired);
  const authored =
    [
      "import { expect, test } from 'bun:test';",
      "import { onSseDisconnect, type SseState } from '../src/realtime';",
      "test('expired auth refresh token succeeds with last-event-id and bounded reconnect backoff',()=>{",
      "  const state:SseState={lastEventId:'42',authToken:'expired',authValid:false,attempts:0,terminal:false};",
      '  let calls=0;',
      "  const refreshed=onSseDisconnect(state,()=>{calls++;return{ok:true,token:'fresh'}},4);",
      '  expect(calls).toBe(1);',
      "  expect(refreshed.authToken).toBe('fresh');",
      '  expect(refreshed.authValid).toBe(true);',
      "  expect(refreshed.lastEventId).toBe('42');",
      '  expect(refreshed.terminal).toBe(false);',
      "  const next=onSseDisconnect({...refreshed,attempts:3},()=>{throw new Error('unexpected refresh')},4);",
      '  expect(next.terminal).toBe(true);',
      '});',
      "test('failed auth refresh is terminal rather than replaying same token',()=>{",
      "  const state:SseState={lastEventId:'9',authToken:'old',authValid:false,attempts:1,terminal:false};",
      '  let calls=0;',
      '  const failure=onSseDisconnect(state,()=>{calls++;return{ok:false}},4);',
      '  expect(calls).toBe(1);',
      '  expect(failure.terminal).toBe(true);',
      "  expect(failure.lastEventId).toBe('9');",
      "  expect(failure.authToken).toBe('old');",
      '});',
    ].join('\n') + '\n';
  writeFixtureFile(root, 'tests/realtime.test.ts', authored);
  writeFixtureFile(
    root,
    '.kory-eval/sse-policy.json',
    JSON.stringify({
      retries: 'bounded exponential backoff with jitter',
      cursor: 'Last-Event-ID persistence',
      recovery: 'proxy idle-close, browser refresh, duplicate replay',
    }),
  );
  const input = { workingDirectory: root } as never;
  const accepted = await scorer.score(input);
  expect(scorer.id).toEndWith('@2');
  expect(accepted.passed, accepted.evidence.join('\n')).toBe(true);
  expect(accepted.evidence).toContain('candidate tests reject the original defect: yes');

  writeFixtureFile(
    root,
    'tests/realtime.test.ts',
    "import { expect, test } from 'bun:test';\ntest('token refresh backoff last event id replay',()=>expect(true).toBe(true));\n",
  );
  const weak = await scorer.score(input);
  expect(weak.passed).toBe(false);
  expect(weak.verification).toBe(0);
  expect(weak.evidence).toContain('candidate tests reject the original defect: no');
  expect(readFixtureText(root, 'src/realtime.ts')).toBe(repaired);
});
