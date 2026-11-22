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

const cacheRepair = [
    'export interface Entry<T>{value:T;expiresAt:number;staleUntil:number}',
    'type Flight<T>={promise:Promise<T>;controller:AbortController;waiters:number}',
    'export class MetadataCache<T> {',
    '  private entries=new Map<string,Entry<T>>();',
    '  private flights=new Map<string,Flight<T>>();',
    '  constructor(private readonly maxEntries:number,private readonly now:()=>number){}',
    '  async get(key:string,loader:(signal:AbortSignal)=>Promise<T>,ttlMs:number,staleMs:number,signal:AbortSignal,allowStaleOnError=false):Promise<T>{',
    "    if(signal.aborted)throw new Error('cancelled');",
    '    const existing=this.entries.get(key);',
    '    if(existing&&existing.expiresAt>this.now())return existing.value;',
    '    let flight=this.flights.get(key);',
    '    if(!flight){',
    '      const controller=new AbortController();',
    '      const owned:Flight<T>={promise:Promise.resolve(undefined as T),controller,waiters:0};',
    '      owned.promise=Promise.resolve().then(()=>loader(controller.signal)).then(value=>{',
    '        if(this.flights.get(key)===owned && this.maxEntries>0){',
    '          this.entries.delete(key);',
    '          this.entries.set(key,{value,expiresAt:this.now()+ttlMs,staleUntil:this.now()+ttlMs+staleMs});',
    '          while(this.entries.size>this.maxEntries){',
    '            const oldest=this.entries.keys().next().value;',
    '            if(oldest===undefined)break;',
    '            this.entries.delete(oldest);',
    '          }',
    '        }',
    '        return value;',
    '      }).finally(()=>{if(this.flights.get(key)===owned)this.flights.delete(key);});',
    '      flight=owned;',
    '      this.flights.set(key,owned);',
    '    }',
    '    const owned=flight;',
    '    owned.waiters++;',
    '    return new Promise<T>((resolve,reject)=>{',
    '      let settled=false;',
    '      const clean=()=>{',
    '        if(settled)return false;',
    '        settled=true;',
    "        signal.removeEventListener('abort',onAbort);",
    '        owned.waiters--;',
    '        return true;',
    '      };',
    '      const onAbort=()=>{',
    '        if(!clean())return;',
    '        if(owned.waiters<=0 && this.flights.get(key)===owned){',
    '          this.flights.delete(key);',
    '          owned.controller.abort();',
    '        }',
    "        reject(new Error('aborted'));",
    '      };',
    "      signal.addEventListener('abort',onAbort,{once:true});",
    '      if(signal.aborted){onAbort();return;}',
    '      owned.promise.then(value=>{if(clean())resolve(value);},error=>{',
    '        if(!clean())return;',
    '        if(allowStaleOnError&&existing&&existing.staleUntil>=this.now())resolve(existing.value);',
    '        else reject(error);',
    '      });',
    '    });',
    '  }',
    '  size(){return this.entries.size;}',
    '}',
].join('\n') + '\n';

const authored = [
    "import { expect, test } from 'bun:test';",
    "import { MetadataCache } from '../src/cache';",
    "test('coalesce one-key herd and bounded eviction',async()=>{",
    '  let now=0,calls=0,release!:(v:number)=>void;',
    '  const cache=new MetadataCache<number>(2,()=>now);',
    '  const loader=async()=>{calls++;return await new Promise<number>(r=>release=r)};',
    '  const signal=new AbortController().signal;',
    "  const a=cache.get('x',loader,10,5,signal);",
    "  const b=cache.get('x',loader,10,5,signal);",
    '  await Promise.resolve();',
    '  expect(calls).toBe(1);',
    '  release(7);',
    '  expect(await Promise.all([a,b])).toEqual([7,7]);',
    "  for(const key of ['a','b','c'])await cache.get(key,async()=>9,10,0,signal);",
    '  expect(cache.size()).toBeLessThanOrEqual(2);',
    '});',
    "test('stale-on-error respects expiry and cancelling last waiter releases a hung refresh',async()=>{",
    '  let now=0;',
    '  const cache=new MetadataCache<number>(2,()=>now);',
    '  const signal=new AbortController().signal;',
    "  await cache.get('s',async()=>5,10,5,signal);",
    '  now=11;',
    "  expect(await cache.get('s',async()=>{throw new Error('offline')},10,5,signal,true)).toBe(5);",
    '  now=16;',
    "  await expect(cache.get('s',async()=>{throw new Error('offline')},10,5,signal,true)).rejects.toThrow('offline');",
    '  const controller=new AbortController();',
    "  const stalled=cache.get('z',async()=>new Promise<number>(()=>{}),10,0,controller.signal);",
    '  await Promise.resolve();',
    '  controller.abort();',
    '  const rejected=await Promise.race([',
    '    stalled.then(()=>false,()=>true),',
    '    new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),50)),',
    '  ]);',
    '  expect(rejected).toBe(true);',
    "  expect(await cache.get('z',async()=>9,10,0,signal)).toBe(9);",
    '});',
].join('\n') + '\n';

test('cache scorer requires tests that catch unbounded loads and abandoned refresh ownership', async () => {
  const scenario = 'in-process-backend-full-task-2-individual';
  const root = mkdtempSync(join(tmpdir(), 'kory-cache-regression-'));
  roots.push(root);
  const materializer = BACKEND_STATE_SKILL_EVAL_MATERIALIZERS.find((m) =>
    m.matches({ id: scenario } as never),
  )!;
  await materializer.materialize(root, { id: scenario } as never);
  const scorer = BACKEND_STATE_SKILL_EVAL_SCORERS.find((s) =>
    s.scenarioIds.includes(scenario),
  )!;
  writeFixtureFile(root, 'src/cache.ts', cacheRepair);
  writeFixtureFile(root, 'tests/cache.test.ts', authored);
  writeFixtureFile(
    root,
    '.kory-eval/inprocess-cache.json',
    JSON.stringify({
      lifetime: 'one in-flight refresh per key with cancellation and timeout recovery',
      eviction: 'bounded deterministic process-local map',
      hierarchy: 'backend-engineering compiler-runtime-backend',
    }),
  );
  const input = { workingDirectory: root } as never;
  const accepted = await scorer.score(input);
  expect(scorer.id).toEndWith('@3');
  expect(accepted.passed, accepted.evidence.join('\n')).toBe(true);
  expect(accepted.evidence).toContain('candidate tests reject the original defect: yes');

  writeFixtureFile(
    root,
    'tests/cache.test.ts',
    "import { expect, test } from 'bun:test';\ntest('coalesce herd bounded eviction stale cancel timeout',()=>expect(true).toBe(true));\n",
  );
  const weak = await scorer.score(input);
  expect(weak.passed).toBe(false);
  expect(weak.verification).toBe(0);
  expect(weak.evidence).toContain('candidate tests reject the original defect: no');
  expect(readFixtureText(root, 'src/cache.ts')).toBe(cacheRepair);
});
