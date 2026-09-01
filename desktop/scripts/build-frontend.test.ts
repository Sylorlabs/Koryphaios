import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  PACKAGED_FRONTEND_DIST,
  assertPackagedFrontendArtifact,
  createPackagedFrontendEnvironment,
} from './build-frontend';

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kory-packaged-frontend-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('packaged frontend contract', () => {
  test('forces the static production adapter regardless of ambient build mode', () => {
    const env = createPackagedFrontendEnvironment({
      BUILD_MODE: 'server',
      NODE_ENV: 'development',
      PRESERVED_VALUE: 'yes',
    });

    expect(env.BUILD_MODE).toBe('static');
    expect(env.NODE_ENV).toBe('production');
    expect(env.PRESERVED_VALUE).toBe('yes');
  });

  test('accepts only a packaged distribution with an index.html file', () => {
    const frontendDist = makeTemporaryDirectory();
    expect(() => assertPackagedFrontendArtifact(frontendDist)).toThrow(
      'The Tauri build must use the Svelte static adapter',
    );

    const directoryNamedIndex = join(frontendDist, 'index.html');
    mkdirSync(directoryNamedIndex);
    expect(() => assertPackagedFrontendArtifact(frontendDist)).toThrow(
      'The Tauri build must use the Svelte static adapter',
    );

    rmSync(directoryNamedIndex, { recursive: true });
    writeFileSync(directoryNamedIndex, '<!doctype html><title>Koryphaios</title>');
    expect(() => assertPackagedFrontendArtifact(frontendDist)).not.toThrow();
  });

  test('keeps CI, Tauri, and the backend resource on the same static artifact', () => {
    const projectRoot = resolve(import.meta.dir, '..', '..');
    const rootPackage = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const tauriConfigPath = join(projectRoot, 'desktop', 'src-tauri', 'tauri.conf.json');
    const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8')) as {
      build: { frontendDist: string };
      bundle: { resources: Record<string, string> };
    };
    const tauriConfigDirectory = resolve(tauriConfigPath, '..');
    const backendFrontendResource = Object.entries(tauriConfig.bundle.resources).find(
      ([, destination]) => destination === 'frontend',
    )?.[0];

    expect(rootPackage.scripts['build:frontend:static']).toBe(
      'bun run desktop/scripts/build-frontend.ts',
    );
    expect(rootPackage.scripts['build:ci']).toContain('bun run build:frontend:static');
    expect(resolve(tauriConfigDirectory, tauriConfig.build.frontendDist)).toBe(
      PACKAGED_FRONTEND_DIST,
    );
    expect(backendFrontendResource).toBeDefined();
    expect(resolve(tauriConfigDirectory, backendFrontendResource!)).toBe(
      PACKAGED_FRONTEND_DIST,
    );
  });
});
