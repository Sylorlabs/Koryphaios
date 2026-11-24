import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

import { watch, type FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorDetectorManager } from '@/detectors/error-detector-manager.js';
import { ProactiveMonitoringCoordinator } from '@/monitoring/proactive-monitoring-coordinator.js';

describe.each(['build', 'compilation'] as const)('%s config watch semantics', mode => {
  let tempDir: string;
  let workspaceRoot: string;
  let parentWatcher: FSWatcher;
  let coordinator: ProactiveMonitoringCoordinator;
  let packageChanged: ReturnType<typeof vi.fn>;
  let dependencyChanged: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'config-watch-test-'));
    workspaceRoot = tempDir;

    // Match the coordinator's startup order: its general watcher already owns
    // the canonical parent before the missing literal config watch is installed.
    // Keep tmpdir's original spelling for the coordinator (/var on macOS).
    parentWatcher = watch(await fs.realpath(workspaceRoot), { ignoreInitial: true });
    await new Promise<void>((resolve, reject) => {
      parentWatcher.once('ready', resolve);
      parentWatcher.once('error', reject);
    });

    const manager = new ErrorDetectorManager({
      workspaceRoot,
      config: {
        enabled: true,
        realTime: false,
        sources: {
          console: false,
          runtime: false,
          build: false,
          test: false,
          linter: false,
          staticAnalysis: false,
          ide: false,
        },
        filters: { categories: [], severities: [], excludeFiles: [], excludePatterns: [] },
        polling: { interval: 1000, maxRetries: 3 },
        bufferSize: 100,
        maxErrorsPerSession: 50,
      },
    });
    coordinator = new ProactiveMonitoringCoordinator(manager, {
      enabled: true,
      workspaceRoot,
      // Isolate the dedicated watcher: a source/config fallback must not mask a
      // missed event when only build or compilation monitoring is enabled.
      fileWatching: { enabled: false, debounceMs: 100, watchPatterns: [], ignorePatterns: [] },
      buildProcessMonitoring: {
        enabled: mode === 'build',
        buildCommands: [],
        watchConfigFiles: true,
        autoRestartBuilds: false,
      },
      compilationMonitoring: {
        enabled: mode === 'compilation',
        languages: [],
        watchTsConfig: true,
        watchPackageJson: true,
      },
      realTimeAnalysis: { enabled: false, analysisDelay: 100, maxConcurrentAnalysis: 1 },
    });
    packageChanged = vi.fn();
    dependencyChanged = vi.fn();
    coordinator.on('package-json-changed', packageChanged);
    coordinator.on('dependency-change-detected', dependencyChanged);
  });

  afterEach(async () => {
    await coordinator?.stop();
    await parentWatcher?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function expectPackageChange(): Promise<void> {
    await vi.waitFor(
      () => {
        expect(packageChanged).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            type: 'config-changed',
            category: 'config',
            path: join(workspaceRoot, 'package.json'),
            relativePath: 'package.json',
          })
        );
        expect(dependencyChanged).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000, interval: 25 }
    );
  }

  it.each(['immediately', 'after another config event'])(
    'detects a missing package.json created %s after start',
    async timing => {
      const parentAdded = vi.fn();
      parentWatcher.on('add', path => parentAdded(basename(path)));
      await coordinator.start();
      if (timing === 'after another config event') {
        await fs.writeFile(join(workspaceRoot, 'tsconfig.json'), '{"compilerOptions":{}}');
        await vi.waitFor(() => expect(parentAdded).toHaveBeenCalledWith('tsconfig.json'));
      }
      await Promise.all([
        fs.writeFile(join(workspaceRoot, 'tsconfig.json'), '{"compilerOptions":{}}'),
        fs.writeFile(join(workspaceRoot, 'package.json'), '{"name":"created"}'),
        fs.writeFile(join(workspaceRoot, '.eslintrc.json'), '{}'),
      ]);

      await expectPackageChange();
    }
  );

  it('ignores the initial package.json and detects its first edit after start', async () => {
    const packagePath = join(workspaceRoot, 'package.json');
    await fs.writeFile(packagePath, '{"name":"initial"}');
    await coordinator.start();
    expect(packageChanged).not.toHaveBeenCalled();
    expect(dependencyChanged).not.toHaveBeenCalled();

    await fs.writeFile(packagePath, '{"name":"modified","version":"1.0.0"}');
    await expectPackageChange();
  });

  it('keeps the package watch exact and workspace-root scoped', async () => {
    await fs.mkdir(join(workspaceRoot, 'nested'));
    await coordinator.start();
    await Promise.all([
      fs.writeFile(join(workspaceRoot, 'package.json.backup'), '{}'),
      fs.writeFile(join(workspaceRoot, 'other-package.json'), '{}'),
      fs.writeFile(join(workspaceRoot, 'nested', 'package.json'), '{}'),
      fs.writeFile(join(workspaceRoot, 'package.json'), '{"name":"root"}'),
    ]);
    await expectPackageChange();

    await coordinator.stop();
    await fs.writeFile(join(workspaceRoot, 'package.json'), '{"name":"after-stop"}');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(packageChanged).toHaveBeenCalledTimes(1);
    expect(dependencyChanged).toHaveBeenCalledTimes(1);
  });
});
