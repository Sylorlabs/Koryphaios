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

async function prepare(id: string) {
  const root = mkdtempSync(join(tmpdir(), 'kory-transport-regression-'));
  roots.push(root);
  const materializer = BACKEND_STATE_SKILL_EVAL_MATERIALIZERS.find((m) =>
    m.matches({ id } as never),
  );
  if (!materializer) throw new Error('Missing fixture for ' + id);
  await materializer.materialize(root, { id } as never);
  return root;
}

async function evaluate(id: string, workingDirectory: string) {
  const scorer = BACKEND_STATE_SKILL_EVAL_SCORERS.find((s) => s.scenarioIds.includes(id));
  if (!scorer) throw new Error('Missing scorer for ' + id);
  return { id: scorer.id, result: await scorer.score({ workingDirectory } as never) };
}

test('network drain qualification requires a test that catches immediate request loss', async () => {
  const scenario = 'network-service-backend-full-task-2-individual';
  const root = await prepare(scenario);
  const original = readFixtureText(root, 'src/daemon.ts');
  const repaired = original.replace(
    '// BUG: immediately closes every active connection/request boundary.\nthis.active.clear()}deadline()',
    '// Keep admitted requests alive until they complete or the deadline.\n}deadline()',
  );
  expect(repaired).not.toBe(original);
  writeFixtureFile(root, 'src/daemon.ts', repaired);
  const tests =
    [
      "import { expect, test } from 'bun:test';",
      "import { Daemon } from '../src/daemon';",
      "test('graceful shutdown drain preserves streaming tls and non-idempotent requests until deadline',()=>{",
      '  const d=new Daemon();',
      "  for(const [id,kind] of [['idle','idle'],['stream','streaming'],['work','non-idempotent'],['tls','tls-handshake']] as const)expect(d.admit(id,kind)).toBe(true);",
      '  d.beginDrain();',
      "  expect(d.admit('later','idle')).toBe(false);",
      "  for(const id of ['idle','stream','work','tls'])expect(d.status(id)?.done).toBe(false);",
      "  expect(d.commit('work')).toBe(true);",
      "  expect(d.commit('work')).toBe(false);",
      "  expect(d.effects.has('work')).toBe(true);",
      "  d.finish('work');",
      "  expect(d.status('work')?.done).toBe(true);",
      '  d.deadline();',
      "  expect(d.status('stream')).toBeUndefined();",
      '});',
    ].join('\n') + '\n';
  writeFixtureFile(root, 'tests/daemon.test.ts', tests);
  writeFixtureFile(
    root,
    '.kory-eval/network-drain.json',
    JSON.stringify({
      admission: 'no new requests after drain begins',
      deadline: 'force close remaining TLS/stream connections',
      runtime: 'network-service-backend',
    }),
  );
  const accepted = await evaluate(scenario, root);
  expect(accepted.id).toEndWith('@2');
  expect(accepted.result.passed, accepted.result.evidence.join('\n')).toBe(true);
  expect(accepted.result.evidence).toContain('candidate tests reject the original defect: yes');

  writeFixtureFile(
    root,
    'tests/daemon.test.ts',
    "import { expect, test } from 'bun:test';\ntest('drain shutdown deadline stream tls non-idempotent',()=>expect(true).toBe(true));\n",
  );
  const weak = await evaluate(scenario, root);
  expect(weak.result.passed).toBe(false);
  expect(weak.result.verification).toBe(0);
  expect(weak.result.evidence).toContain('candidate tests reject the original defect: no');
  expect(readFixtureText(root, 'src/daemon.ts')).toBe(repaired);
});

test('WebSocket resume qualification accepts ordered gap recovery and extra resume metadata', async () => {
  const scenario = 'realtime-systems-full-task-1-individual';
  const root = await prepare(scenario);
  const original = readFixtureText(root, 'src/realtime.ts');
  const repaired = original
    .replace('export class FeedClient{', 'export class FeedClient{pending=new Map<number,Event>();')
    .replace(
      'this.rendered.push(e.id);this.seen.add(e.id);this.lastSequence=e.sequence;',
      'if(e.sequence<=this.lastSequence)continue;this.pending.set(e.sequence,e);while(this.pending.has(this.lastSequence+1)){const next=this.pending.get(this.lastSequence+1)!;this.pending.delete(++this.lastSequence);if(!this.seen.has(next.id)){this.rendered.push(next.id);this.seen.add(next.id);}}',
    )
    .replace(
      'return{events:this.events.filter(e=>e.sequence>after),resync:false}',
      'return{events:this.events.filter(e=>e.sequence>after),resync:false,nextSequence:5}',
    );
  expect(repaired).not.toBe(original);
  writeFixtureFile(root, 'src/realtime.ts', repaired);
  const tests =
    [
      "import { expect, test } from 'bun:test';",
      "import { Feed,FeedClient } from '../src/realtime';",
      "test('disconnect reconnect duplicate reordered replay cursor and restart slow-client backpressure policy',()=>{",
      '  const c=new FeedClient();',
      "  const values=[1,2,3,4].map(n=>({id:'e'+n,sequence:n,body:String(n)}));",
      '  c.receive(values.slice(0,2));',
      '  c.receive([values[1],values[3],values[2],values[3]]);',
      "  expect(c.rendered).toEqual(['e1','e2','e3','e4']);",
      '  expect(c.lastSequence).toBe(4);',
      '  c.receive(values);',
      '  expect(c.rendered).toHaveLength(4);',
      '  expect(c.lastSequence).toBe(4);',
      '  const restarted=new Feed(values,3);',
      '  expect(restarted.resume(1).resync).toBe(true);',
      "  expect(restarted.resume(2).events.map(e=>e.id)).toEqual(['e3','e4']);",
      '});',
    ].join('\n') + '\n';
  writeFixtureFile(root, 'tests/realtime.test.ts', tests);
  writeFixtureFile(
    root,
    '.kory-eval/realtime-websocket.json',
    JSON.stringify({
      retention: 'bounded event history and full resync',
      cursor: 'monotonic deduplicated resume',
      connection: 'auth heartbeat retry backoff and bounded queue for slow clients',
      neighboringSkill: 'network-service-backend and edge-cdn',
    }),
  );
  const accepted = await evaluate(scenario, root);
  expect(accepted.id).toEndWith('@3');
  expect(accepted.result.passed, accepted.result.evidence.join('\n')).toBe(true);
  expect(accepted.result.evidence).toContain('candidate tests reject the original defect: yes');

  // This formerly passed the scorer: a later live event moves the cursor past
  // a gap, so a disconnect before the missing event arrives loses it forever.
  const maxObserved = original.replace(
    'this.rendered.push(e.id);this.seen.add(e.id);this.lastSequence=e.sequence;',
    'if(this.seen.has(e.id))continue;this.rendered.push(e.id);this.seen.add(e.id);this.lastSequence=Math.max(this.lastSequence,e.sequence);',
  );
  writeFixtureFile(root, 'src/realtime.ts', maxObserved);
  writeFixtureFile(
    root,
    'tests/realtime.test.ts',
    tests.replace("['e1','e2','e3','e4']", "['e1','e2','e4','e3']"),
  );
  const unsafe = await evaluate(scenario, root);
  expect(unsafe.result.passed).toBe(false);
  expect(unsafe.result.evidence).toContain('resume/dedup behavior: fail');
  expect(unsafe.result.evidence).toContain('candidate tests pass the repair: yes');
  writeFixtureFile(root, 'src/realtime.ts', repaired);

  writeFixtureFile(
    root,
    'tests/realtime.test.ts',
    "import { expect, test } from 'bun:test';\ntest('disconnect reconnect duplicate reorder slow restart cursor',()=>expect(true).toBe(true));\n",
  );
  const weak = await evaluate(scenario, root);
  expect(weak.result.passed).toBe(false);
  expect(weak.result.verification).toBe(0);
  expect(weak.result.evidence).toContain('candidate tests reject the original defect: no');
  expect(readFixtureText(root, 'src/realtime.ts')).toBe(repaired);
});
