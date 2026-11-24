import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNativeInspectorBinaries } from '../kory/native-macos-document-inspector/qualification';
import { isMac } from '../runtime/platform';
import { createComputerPlatformAdapter } from './platform';
import { stopComputerUse } from './control';
import type { ComputerPlatformStatus, ComputerTarget } from '@koryphaios/shared';

interface Receipt {
  platform: string;
  status: ComputerPlatformStatus;
  target: unknown;
  elementCount: number;
  focused: boolean;
  observed: boolean;
  failures: string[];
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Native fixture did not become ready: ${output}`)), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output = (output + chunk).slice(-4000);
      if (/READY 0\n/u.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main(): Promise<void> {
  if (!isMac()) throw new Error('macOS computer-use qualification requires macOS');
  const output = mkdtempSync(join(tmpdir(), 'kory-computer-use-macos-'));
  const build = buildNativeInspectorBinaries(output);
  const child = spawn(build.binaries.healthy, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const adapter = createComputerPlatformAdapter();
  const failures: string[] = [];
  let target: ComputerTarget | undefined;
  let elements = 0;
  let focused = false;
  let observed = false;
  try {
    try {
      await waitForReady(child);
      const status = await adapter.status();
      for (let attempt = 0; attempt < 10 && !target; attempt++) {
        const discovered = await adapter.execute({ kind: 'discover' });
        target = discovered.targets?.find((item) => item.pid === child.pid);
        if (!target) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!target) failures.push(`Fixture PID ${child.pid} was not exposed as an authorized target`);
      if (target) {
        const listed = await adapter.execute({ kind: 'listElements', target });
        elements = listed.elements?.length ?? 0;
        if (!elements) failures.push('Accessibility element discovery returned no elements');
        const focus = await adapter.execute({ kind: 'focus', target });
        focused = !('error' in focus);
        if (!focused) failures.push('Authorized target focus failed');
        if (status.capabilities.includes('observe')) {
          const image = await adapter.execute({ kind: 'observe', target });
          observed = Boolean(image.imageBase64);
          if (!observed) failures.push('Observation returned no PNG');
        }
      }
      const receipt: Receipt = { platform: status.platform, status, target, elementCount: elements, focused, observed, failures };
      console.log(JSON.stringify({ output, ...receipt }, null, 2));
      if (failures.length) process.exitCode = 1;
    } catch (error) {
      failures.push(`Qualification action failed closed: ${String(error).slice(0, 1200)}`);
      const status = await adapter.status();
      console.log(JSON.stringify({ output, platform: status.platform, status, target, elementCount: elements, focused, observed, failures }, null, 2));
      process.exitCode = 1;
    }
  } finally {
    stopComputerUse('macOS computer-use qualification finished');
    child.kill('SIGTERM');
  }
}

if (import.meta.main) await main();
