#!/usr/bin/env bun
// Installs the pinned official native Linux build without modifying shell files.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const VERSION = '1.2.17';
const URL = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.17-6683332533157888/linux-x64/cli_linux_x64.tar.gz';
const SHA512 = 'd0ebe612f7cfc21c8de9e7a7a62964b2245d89ddb570d5e27e83e61a2cc76cb38e80b6eb3bdd71bef683eba027c4a97dcce4ced81f47f827763234d0cd3ec592';
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This qualified runtime is Linux x86_64 only.');
const destination = resolve(process.argv[2] ?? '/usr/local/bin');
if (!existsSync(destination)) throw new Error('Create the intended installation directory first.');
const stage = mkdtempSync(join(tmpdir(), 'kory-agy-install-'));
try {
  const response = await fetch(URL, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Official Antigravity download failed (HTTP ${response.status}).`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha512').update(data).digest('hex') !== SHA512) throw new Error('Antigravity checksum mismatch.');
  const archive = join(stage, 'runtime.tar.gz');
  await Bun.write(archive, data);
  const extraction = Bun.spawn(['tar', '-xzf', archive, '-C', stage, 'antigravity'], { stdout: 'ignore', stderr: 'pipe' });
  if (await extraction.exited) throw new Error('Could not extract the official Antigravity runtime.');
  const installed = join(destination, `.agy-${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(installed, Bun.file(join(stage, 'antigravity')));
    chmodSync(installed, 0o755);
    const probe = Bun.spawn([installed, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const version = (await new Response(probe.stdout).text()).trim();
    if (await probe.exited || version !== VERSION) throw new Error('Antigravity runtime version did not match the qualified build.');
    renameSync(installed, join(destination, 'agy'));
  } finally { rmSync(installed, { force: true }); }
  console.log(`Installed Antigravity ${VERSION} in ${destination}`);
} finally { rmSync(stage, { recursive: true, force: true }); }
