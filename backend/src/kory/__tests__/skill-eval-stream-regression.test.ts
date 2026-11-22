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
  const root = mkdtempSync(join(tmpdir(), 'kory-stream-regression-'));
  roots.push(root);
  const materializer = BACKEND_STATE_SKILL_EVAL_MATERIALIZERS.find((m) =>
    m.matches({ id } as never),
  );
  if (!materializer) throw new Error('Missing fixture for ' + id);
  await materializer.materialize(root, { id } as never);
  return root;
}

async function evaluate(id: string, workingDirectory: string) {
  const scorer = BACKEND_STATE_SKILL_EVAL_SCORERS.find((s) =>
    s.scenarioIds.includes(id),
  );
  if (!scorer) throw new Error('Missing scorer for ' + id);
  return { id: scorer.id, result: await scorer.score({ workingDirectory } as never) };
}

test('stream window qualification requires tests that detect arrival-time and dedup defects', async () => {
  const scenario = 'stream-processing-full-task-1-individual';
  const root = await prepare(scenario);
  const original = readFixtureText(root, 'src/stream.ts');
  const broken = "if(event.eventTimeMs<watermarkMs)return'too-late';const bucket=Math.floor(watermarkMs/this.windowMs)*this.windowMs;this.counts.set(bucket,(this.counts.get(bucket)??0)+event.value);return'applied'";
  const repaired = original.replace(broken, [
    'const cutoff=watermarkMs-this.allowedLatenessMs;',
    'for(const [id,ts] of this.seen)if(ts<cutoff)this.seen.delete(id);',
    'for(const [bucket] of this.counts)if(bucket+this.windowMs<=cutoff)this.counts.delete(bucket);',
    "if(event.eventTimeMs<cutoff)return'too-late';",
    "if(this.seen.has(event.id))return'duplicate';",
    'const bucket=Math.floor(event.eventTimeMs/this.windowMs)*this.windowMs;',
    'this.seen.set(event.id,event.eventTimeMs);',
    "this.counts.set(bucket,(this.counts.get(bucket)??0)+event.value);return'applied'",
  ].join(''));
  expect(repaired).not.toBe(original);
  writeFixtureFile(root, 'src/stream.ts', repaired);
  const tests = [
    "import { expect, test } from 'bun:test';",
    "import { WindowCounter } from '../src/stream';",
    "test('event-time watermark lateness dedup duplicate checkpoint restart and eviction',()=>{",
    '  const m=60000;',
    '  const counter=new WindowCounter(m,12*m);',
    "  const a={id:'a',key:'k',eventTimeMs:2*m+1,value:3};",
    "  expect(counter.ingest(a,10*m)).toBe('applied');",
    "  expect(counter.ingest(a,10*m)).toBe('duplicate');",
    '  expect(counter.count(2*m)).toBe(3);',
    "  expect(counter.ingest({id:'late',key:'k',eventTimeMs:m,value:2},14*m)).toBe('too-late');",
    '  const checkpoint=counter.checkpoint();',
    '  const recovered=new WindowCounter(m,12*m);',
    '  recovered.restore(checkpoint);',
    "  expect(recovered.ingest(a,14*m)).toBe('duplicate');",
    "  expect(recovered.ingest({id:'new',key:'k',eventTimeMs:25*m,value:5},25*m)).toBe('applied');",
    '  expect(recovered.count(2*m)).toBe(0);',
    '  expect(recovered.retainedIds()).toBeLessThanOrEqual(1);',
    '});',
  ].join('\n') + '\n';
  writeFixtureFile(root, 'tests/stream.test.ts', tests);
  writeFixtureFile(root, '.kory-eval/stream-window.json', JSON.stringify({
    eventTime: 'window bucket is calculated from event time, allowed lateness from watermark',
    deduplication: 'event id map survives checkpoint and bounded eviction',
    architecture: 'analytics-engineering and stream-processing',
  }));
  const accepted = await evaluate(scenario, root);
  expect(accepted.id).toEndWith('@3');
  expect(accepted.result.passed, accepted.result.evidence.join('\n')).toBe(true);
  expect(accepted.result.evidence).toContain('candidate tests reject the original defect: yes');
  writeFixtureFile(root, 'tests/stream.test.ts',
    "import { expect, test } from 'bun:test';\ntest('late watermark event-time duplicate checkpoint restart',()=>expect(true).toBe(true));\n");
  const weak = await evaluate(scenario, root);
  expect(weak.result.passed).toBe(false);
  expect(weak.result.verification).toBe(0);
  expect(weak.result.evidence).toContain('candidate tests reject the original defect: no');
  expect(readFixtureText(root, 'src/stream.ts')).toBe(repaired);
});

test('checkpoint recovery qualification requires tests that detect duplicate sink effects', async () => {
  const scenario = 'stream-processing-full-task-2-individual';
  const root = await prepare(scenario);
  const original = readFixtureText(root, 'src/stream.ts');
  const broken = 'this.sink.effects.set(event.id,(this.sink.effects.get(event.id)??0)+event.delta);';
  const repaired = original
    .replace(broken, 'const duplicate=this.sink.effects.has(event.id);if(!duplicate)this.sink.effects.set(event.id,event.delta);')
    .replace('this.offset=event.offset} }', "this.offset=Math.max(this.offset,event.offset);return duplicate?'duplicate':'applied'} }");
  expect(repaired).not.toBe(original);
  writeFixtureFile(root, 'src/stream.ts', repaired);
  const tests = [
    "import { expect, test } from 'bun:test';",
    "import { CheckpointProcessor } from '../src/stream';",
    "test('checkpoint replay idempotent duplicate and partial crash after sink before checkpoint',()=>{",
    '  const sink={effects:new Map<string,number>()};',
    '  const initial=new CheckpointProcessor(sink);',
    "  const event={id:'one',offset:1,delta:4};",
    "  expect(()=>initial.process(event,'before-sink')).toThrow();",
    '  expect(initial.offset).toBe(0);',
    '  expect(sink.effects.size).toBe(0);',
    "  expect(()=>initial.process(event,'after-sink-before-checkpoint')).toThrow();",
    '  expect(initial.offset).toBe(0);',
    "  expect(sink.effects.get('one')).toBe(4);",
    '  const recovered=new CheckpointProcessor(sink);',
    "  expect(recovered.process(event)).toBe('duplicate');",
    "  expect(sink.effects.get('one')).toBe(4);",
    '  expect(recovered.offset).toBe(1);',
    "  expect(recovered.process({id:'two',offset:2,delta:3})).toBe('applied');",
    "  expect(sink.effects.get('two')).toBe(3);",
    '});',
  ].join('\n') + '\n';
  writeFixtureFile(root, 'tests/stream.test.ts', tests);
  writeFixtureFile(root, '.kory-eval/stream-checkpoint.json', JSON.stringify({
    logicalExactlyOnceEffects: true,
    transportExactlyOnce: false,
    boundary: 'at least once source, idempotent sink, durable checkpoint after sink',
    replayEvidence: 'crash after sink followed by duplicate replay',
  }));
  const accepted = await evaluate(scenario, root);
  expect(accepted.id).toEndWith('@3');
  expect(accepted.result.passed, accepted.result.evidence.join('\n')).toBe(true);
  expect(accepted.result.evidence).toContain('candidate tests reject the original defect: yes');
  writeFixtureFile(root, 'tests/stream.test.ts',
    "import { expect, test } from 'bun:test';\ntest('crash after sink checkpoint replay partial duplicate idempotent',()=>expect(true).toBe(true));\n");
  const weak = await evaluate(scenario, root);
  expect(weak.result.passed).toBe(false);
  expect(weak.result.verification).toBe(0);
  expect(weak.result.evidence).toContain('candidate tests reject the original defect: no');
  expect(readFixtureText(root, 'src/stream.ts')).toBe(repaired);
});
