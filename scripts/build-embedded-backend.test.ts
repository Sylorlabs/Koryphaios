import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { collectCurrentV5SkillEvaluationContracts } from '../backend/scripts/build-current-v5-contracts';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
import {
  compileEmbeddedBackend,
  detectHostTarget,
  embeddedBackendBuildConfig,
} from './build-embedded-backend';

const PROJECT_ROOT = resolve(import.meta.dir, '..');

function runSmoke(executable: string, cwd: string, input: unknown) {
  // This executable imports only the current-contract helper/null stub: no
  // server, execution registry, inference, credentials, or ledger initializer.
  const result = spawnSync(executable, [], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

describe('desktop embedded backend build', () => {
  test('preserves the host target triples, executable suffixes, and Linux resource compression', () => {
    const cases = [
      ['win32', 'x64', 'x86_64-pc-windows-msvc', 'bun-windows-x64', '.exe', false],
      ['win32', 'arm64', 'aarch64-pc-windows-msvc', 'bun-windows-arm64', '.exe', false],
      ['darwin', 'x64', 'x86_64-apple-darwin', 'bun-darwin-x64', '', false],
      ['darwin', 'arm64', 'aarch64-apple-darwin', 'bun-darwin-arm64', '', false],
      ['linux', 'x64', 'x86_64-unknown-linux-gnu', 'bun-linux-x64', '', true],
      ['linux', 'arm64', 'aarch64-unknown-linux-gnu', 'bun-linux-arm64', '', true],
    ] as const;
    for (const [platform, arch, rustTarget, bunTarget, suffix, compressResource] of cases) {
      expect(detectHostTarget(platform, arch)).toEqual({
        rustTarget,
        bunTarget,
        suffix,
        compressResource,
      });
    }
    expect(() => detectHostTarget('freebsd', 'x64')).toThrow('Unsupported platform');
    expect(() => detectHostTarget('linux', 'ia32')).toThrow('Unsupported linux arch');
  });

  test('uses Bun native compile options with the shared fresh-source plugin and an escaped relay define', () => {
    const options = {
      entrypoint: join(PROJECT_ROOT, 'backend/src/server.ts'),
      outfile: join(tmpdir(), 'unused-embedded-backend'),
      bunTarget: detectHostTarget().bunTarget,
      relayUrl: 'https://relay.example.test/path?value="quoted"\\tail',
    };
    const config = embeddedBackendBuildConfig(options);
    expect(config.entrypoints).toEqual([options.entrypoint]);
    expect(config.target).toBe('bun');
    expect(config.compile).toEqual({ target: options.bunTarget, outfile: options.outfile });
    expect(config.define).toEqual({ 'process.env.RELAY_URL': JSON.stringify(options.relayUrl) });
    expect(config.plugins?.map((plugin) => plugin.name)).toEqual([
      'current-v5-skill-evaluation-contracts',
    ]);
    expect(config.external).toBeUndefined();
    expect(embeddedBackendBuildConfig({ ...options, relayUrl: undefined }).define).toBeUndefined();
  });

  test('bakes the backend build hash define only when a bundle hash is given', () => {
    const options = {
      entrypoint: join(PROJECT_ROOT, 'backend/src/server.ts'),
      outfile: join(tmpdir(), 'unused-embedded-backend'),
      bunTarget: detectHostTarget().bunTarget,
      relayUrl: 'https://relay.example.test',
      bundleHash: 'abc123def456',
    };
    expect(embeddedBackendBuildConfig(options).define).toEqual({
      'process.env.RELAY_URL': JSON.stringify(options.relayUrl),
      'process.env.KORYPHAIOS_BACKEND_BUILD_HASH': JSON.stringify(options.bundleHash),
    });
    // No relay URL still carries the build hash on its own.
    expect(
      embeddedBackendBuildConfig({ ...options, relayUrl: undefined }).define,
    ).toEqual({
      'process.env.KORYPHAIOS_BACKEND_BUILD_HASH': JSON.stringify(options.bundleHash),
    });
    expect(
      embeddedBackendBuildConfig({ ...options, bundleHash: undefined }).define,
    ).toEqual({ 'process.env.RELAY_URL': JSON.stringify(options.relayUrl) });
  });

  test('genuine host compile embeds immutable current helper contracts; raw compile stays fail-closed', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'kory-desktop-contract-compile-'));
    try {
      const catalog = loadV5SkillPackages(join(PROJECT_ROOT, 'skills-v5'));
      expect(catalog.errors).toEqual([]);
      const metadata = collectCurrentV5SkillEvaluationContracts();
      expect(metadata.packages.some((pkg) => pkg.tasks.length > 0)).toBe(true);
      const entrypoint = join(scratch, 'current-contract-smoke.ts');
      writeFileSync(
        entrypoint,
        `
import { currentV5SkillEvaluationContracts } from ${JSON.stringify(join(PROJECT_ROOT, 'backend/src/eval/skills/skill-eval-current-contract.ts'))};
import { EMBEDDED_CURRENT_V5_SKILL_EVALUATION_CONTRACTS as embedded } from ${JSON.stringify(join(PROJECT_ROOT, 'backend/src/eval/skills/skill-eval-embedded-contracts.ts'))};
const { packages, contractVersion } = JSON.parse(await Bun.stdin.text());
const rows = packages.map((pkg) => ({
  packageName: pkg.sidecar.name,
  contracts: [...currentV5SkillEvaluationContracts(pkg, contractVersion)],
  stalePackageCount: currentV5SkillEvaluationContracts({ ...pkg, sidecar: { ...pkg.sidecar, version: pkg.sidecar.version + '-stale' } }, contractVersion).size,
  staleEpochCount: currentV5SkillEvaluationContracts(pkg, contractVersion + 1).size,
}));
function frozen(value) {
  return !value || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(frozen));
}
console.log(JSON.stringify({ rows, metadata: embedded, frozen: frozen(embedded), relayUrl: process.env.RELAY_URL }));
`,
      );
      const target = detectHostTarget();
      const outfile = join(scratch, `with-contracts${target.suffix}`);
      const relayUrl = 'https://relay.example.test/path?value="quoted"\\tail';
      await compileEmbeddedBackend({ entrypoint, outfile, bunTarget: target.bunTarget, relayUrl });
      expect(statSync(outfile).size).toBeGreaterThan(0);
      const input = { packages: catalog.packages, contractVersion: metadata.contractVersion };
      const compiled = runSmoke(outfile, scratch, input);
      expect(compiled.metadata).toEqual(metadata);
      expect(compiled.frozen).toBe(true);
      expect(compiled.relayUrl).toBe(relayUrl);
      const expected = metadata.packages.map((pkg) => ({
        packageName: pkg.packageName,
        contracts: pkg.tasks.map((task) => [
          task.taskId,
          {
            evaluationContractVersion: metadata.contractVersion,
            evaluationContractHash: task.evaluationContractHash,
            materializerIds: task.materializerIds,
            scorerIds: task.scorerIds,
          },
        ]),
        stalePackageCount: 0,
        staleEpochCount: 0,
      }));
      expect(compiled.rows).toEqual(expected);

      // Same real entry/compile API without generation: the null source stub
      // cannot grant full-task contracts merely because a standalone exists.
      const rawOutfile = join(scratch, `without-contracts${target.suffix}`);
      const rawConfig = embeddedBackendBuildConfig({
        entrypoint,
        outfile: rawOutfile,
        bunTarget: target.bunTarget,
      });
      rawConfig.plugins = [];
      const rawBuild = await Bun.build(rawConfig);
      if (!rawBuild.success) throw new AggregateError(rawBuild.logs, 'Raw compile smoke failed');
      const raw = runSmoke(rawOutfile, scratch, input);
      expect(raw.metadata).toBeNull();
      expect(raw.rows.every((row: { contracts: unknown[] }) => row.contracts.length === 0)).toBe(
        true,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
