#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { parseAdminArgs, runAdminCli } from './admin-cli';
import { validateDeviceRelayUrl } from '../shared/src/devices';

async function serve(args: string[]) {
  const { words, flags, json } = parseAdminArgs(args);
  if (words.length !== 1 || flags.url || flags.project || json)
    throw new Error(
      'Usage: koryphaios serve --data-dir PATH [--port PORT] [--runtime-dir PATH] [--relay URL] [--workspace PATH] [--bun PATH]',
    );
  for (const key of Object.keys(flags))
    if (!['data-dir', 'port', 'runtime-dir', 'relay', 'workspace', 'bun'].includes(key))
      throw new Error(`--${key} is not valid for serve`);
  if (!flags['data-dir'])
    throw new Error('Supply --data-dir for this headless instance’s persistent state');
  if (flags.relay) validateDeviceRelayUrl(flags.relay);
  const runtime = resolve(
    flags['runtime-dir'] ??
      process.env.KORYPHAIOS_INSTALL_DIR ??
      (import.meta.dir.startsWith('/$bunfs') ? '/opt/koryphaios' : join(import.meta.dir, '..')),
  );
  const entry = join(runtime, 'backend', 'src', 'server.ts');
  if (!existsSync(entry)) throw new Error('Backend runtime not found; supply --runtime-dir PATH');
  const executable =
    flags.bun ??
    process.env.KORYPHAIOS_BUN ??
    (existsSync(join(homedir(), '.bun/bin/bun')) ? join(homedir(), '.bun/bin/bun') : 'bun');
  const child = spawn(executable, ['run', entry], {
    cwd: runtime,
    stdio: 'inherit',
    env: {
      ...process.env,
      KORYPHAIOS_HOST: '127.0.0.1',
      KORYPHAIOS_PORT: flags.port ?? '3001',
      KORYPHAIOS_DATA_DIR: resolve(flags['data-dir']),
      ...(flags.relay !== undefined ? { RELAY_URL: flags.relay } : {}),
      ...(flags.workspace ? { KORYPHAIOS_REMOTE_WORKSPACE: resolve(flags.workspace) } : {}),
    },
  });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const code = await new Promise<number>((res, rej) => {
    child.once('error', rej);
    child.once('exit', (code, signal) => res(code ?? (signal ? 1 : 0)));
  });
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  process.exitCode = code;
}
try {
  const args = process.argv.slice(2);
  const parsed = parseAdminArgs(args);
  if (parsed.words[0] === 'serve' && !parsed.help) await serve(args);
  else await runAdminCli(args);
} catch (error) {
  console.error(`koryphaios: ${error instanceof Error ? error.message : 'Command failed'}`);
  process.exitCode = 1;
}
