import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import {
  DESKTOP_RUNTIME_SCENARIOS,
  DESKTOP_SKILL_EVAL_MATERIALIZERS,
  DESKTOP_SKILL_EVAL_SCORERS,
  desktopRuntimeReadiness,
  materializeDesktopFixture,
  runDesktopRuntime,
} from '../skill-eval-desktop-runtime';

const { electron, tauri } = DESKTOP_RUNTIME_SCENARIOS;
const roots: string[] = [];
const originalEnvironment = {
  electron: process.env.KORY_SKILL_EVAL_ELECTRON_BINARY,
  tauriCli: process.env.KORY_SKILL_EVAL_TAURI_CLI,
  tauriDriver: process.env.KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER,
};
const electronBlockers = desktopRuntimeReadiness(electron);
const tauriBlockers = desktopRuntimeReadiness(tauri);

function workspace(prefix = 'kory-native-desktop-v5-'): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnvironment('KORY_SKILL_EVAL_ELECTRON_BINARY', originalEnvironment.electron);
  restoreEnvironment('KORY_SKILL_EVAL_TAURI_CLI', originalEnvironment.tauriCli);
  restoreEnvironment('KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER', originalEnvironment.tauriDriver);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// This executable announces an Electron-looking version but cannot start a
// BrowserWindow. It is used only for negative tests, never as runtime proof.
function versionOnlyLauncher(): string {
  const dir = workspace('kory-negative-electron-launcher-');
  const path = join(dir, 'version-only');
  writeFileSync(path, [
    '#!/usr/bin/env bun',
    'if (process.argv.includes("--version")) {',
    '  console.log("v42.9.0");',
    '  process.exit(0);',
    '}',
    'console.error("Version-only stub: no Electron application was started");',
    'process.exit(91);',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function scenario(id: string) {
  const name = id === electron ? 'scenario-1.json' : 'scenario-2.json';
  const source = join(import.meta.dir, '../../../../skills-v5/desktop-electron-tauri/evals/tasks', name);
  return JSON.parse(readFileSync(source, 'utf8')) as {
    id: string;
    prompt: string;
    environment: { kind: string; requirements: string[]; startingState: string };
  };
}

async function score(root: string, id: typeof electron | typeof tauri) {
  const scorer = DESKTOP_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(id));
  expect(scorer).toBeDefined();
  return scorer!.score({
    workingDirectory: root,
    scenario: scenario(id) as never,
    experiment: {} as never,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });
}

const hasExecutableScriptSupport = existsSync('/usr/bin/env');
const cargoReady = !tauriBlockers.some((item) => item.startsWith('Rust cargo unavailable'));

function fakeTauriPrerequisites(): { cli: string; driver: string } {
  const dir = workspace('kory-negative-tauri-toolchain-');
  const cli = join(dir, 'tauri');
  const driver = join(dir, 'native-driver');
  writeFileSync(cli, [
    '#!/usr/bin/env bun',
    'if (process.argv.includes("--version")) {',
    '  console.log("tauri-cli 2.0.0");',
    '  process.exit(0);',
    '}',
    'console.error("Stub Tauri CLI cannot produce a native application bundle");',
    'process.exit(89);',
    '',
  ].join('\n'), { mode: 0o700 });
  writeFileSync(driver, '#!/usr/bin/env bun\nprocess.exit(88);\n', { mode: 0o700 });
  chmodSync(cli, 0o700);
  chmodSync(driver, 0o700);
  process.env.KORY_SKILL_EVAL_TAURI_CLI = cli;
  process.env.KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER = driver;
  return { cli, driver };
}

// Only runs when a real Electron binary is available. The repaired candidate
// is exercised through the exact same native Electron probe as the red fixture.
const REPAIRED_ELECTRON_MAIN = `
const { BrowserWindow, ipcMain } = require('electron');
const { join } = require('node:path');
function openSettingsWindow(onSave) {
  const win = new BrowserWindow({
    width: 520, height: 360, show: false,
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, preload: join(__dirname, 'preload.cjs') },
  });
  const onMessage = (event, settings) => {
    if (win.isDestroyed() || event.sender !== win.webContents) return;
    onSave(settings);
    win.webContents.send('settings:saved', { ok: true });
  };
  ipcMain.on('settings:save', onMessage);
  win.once('closed', () => ipcMain.removeListener('settings:save', onMessage));
  void win.loadFile(join(__dirname, 'settings.html'));
  return win;
}
module.exports = { openSettingsWindow };
`;

describe('desktop-electron-tauri native V5 evaluation fixture', () => {
  test('uses the two declared device full-task scenarios without absorbing adjacent skills', () => {
    const first = scenario(electron);
    const second = scenario(tauri);
    expect(first.id).toBe(electron);
    expect(second.id).toBe(tauri);
    expect(first.environment.kind).toBe('device');
    expect(second.environment.kind).toBe('device');
    expect(first.environment.startingState).toContain('electron-window-ipc-lifecycle');
    expect(second.environment.startingState).toContain('tauri-file-dialog-command-boundary');
    expect(first.prompt).toContain('destroyed BrowserWindow');
    expect(second.prompt).toContain('Symlink changes');
    expect(DESKTOP_SKILL_EVAL_MATERIALIZERS.map((item) => item.realRuntime)).toEqual([true, true]);
    for (const [index, id] of [electron, tauri].entries()) {
      expect(DESKTOP_SKILL_EVAL_MATERIALIZERS[index]!.matches({ id } as never)).toBe(true);
      expect(DESKTOP_SKILL_EVAL_SCORERS[index]!.scenarioIds).toEqual([id]);
    }
    expect(DESKTOP_SKILL_EVAL_MATERIALIZERS[0]!.matches({ id: tauri } as never)).toBe(false);
    expect(DESKTOP_SKILL_EVAL_MATERIALIZERS[1]!.matches({ id: electron } as never)).toBe(false);
  });

  test('unavailable Electron cannot be materialized or scored green', async () => {
    const root = workspace();
    process.env.KORY_SKILL_EVAL_ELECTRON_BINARY = join(root, 'nonexistent-electron');
    const blockers = desktopRuntimeReadiness(electron);
    expect(blockers.some((item) => /Electron desktop runtime is unavailable/u.test(item))).toBe(true);
    expect(() => materializeDesktopFixture(root, electron)).toThrow('Native desktop runtime unavailable');
    expect(runDesktopRuntime(root, electron).passed).toBe(false);
    const scored = await score(root, electron);
    expect(scored.passed).toBe(false);
    expect(scored.quality).toBe(0);
    expect(scored.verification).toBe(0);
  });

  test('Tauri requires v2 tooling, a trusted native driver and real OS dialogs', async () => {
    const root = workspace();
    process.env.KORY_SKILL_EVAL_TAURI_CLI = join(root, 'nonexistent-tauri');
    process.env.KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER = join(root, 'nonexistent-driver');
    const blockers = desktopRuntimeReadiness(tauri);
    expect(blockers.some((item) => item.includes('Tauri v2 CLI unavailable'))).toBe(true);
    expect(blockers.some((item) => item.includes('Native Tauri window/dialog automation'))).toBe(true);
    expect(() => materializeDesktopFixture(root, tauri)).toThrow('Native desktop runtime unavailable');
    const scored = await score(root, tauri);
    expect(scored.passed).toBe(false);
    expect(scored.quality).toBe(0);
    expect(scored.verification).toBe(0);
  });

  test.skipIf(!hasExecutableScriptSupport)(
    'a version-only script cannot qualify as a native Electron runtime',
    async () => {
      const launcher = versionOnlyLauncher();
      process.env.KORY_SKILL_EVAL_ELECTRON_BINARY = launcher;
      const root = workspace();
      expect(desktopRuntimeReadiness(electron)).toContain(
        'A callable pinned Electron desktop runtime is unavailable: ' +
        'set KORY_SKILL_EVAL_ELECTRON_BINARY to the absolute path of a native executable');
      expect(() => materializeDesktopFixture(root, electron)).toThrow('Native desktop runtime unavailable');
      const executed = runDesktopRuntime(root, electron);
      expect(executed.passed).toBe(false);
      expect(executed.nativeVersion).toBeNull();
      expect(executed.checks).toEqual([]);
      expect(executed.blockers.some((item) => item.includes('fixture identity'))).toBe(true);
      const scored = await score(root, electron);
      expect(scored.passed).toBe(false);
      expect(scored.verification).toBe(0);
    },
  );

  test.skipIf(electronBlockers.length > 0)(
    'altered immutable fixture contract fails integrity before native launch',
    async () => {
      const root = workspace();
      materializeDesktopFixture(root, electron);
      const contractFile = '.kory-eval/desktop-fixture.json';
      const contract = JSON.parse(readFileSync(join(root, contractFile), 'utf8'));
      writeFixtureFile(root, contractFile, JSON.stringify({ ...contract, nearNeighbor: 'other-skill' }));
      const result = runDesktopRuntime(root, electron);
      expect(result.passed).toBe(false);
      expect(result.blockers).toContain('Native fixture identity or immutable contract has been altered');
      expect((await score(root, electron)).integrityFailure).toBe(true);
    },
  );

  test.skipIf(electronBlockers.length > 0)(
    'symlinked renderer/preload source is rejected before executing Electron',
    async () => {
      const root = workspace();
      materializeDesktopFixture(root, electron);
      const preload = join(root, 'app/preload.cjs');
      unlinkSync(preload);
      symlinkSync('main.cjs', preload);
      const outcome = runDesktopRuntime(root, electron);
      expect(outcome.passed).toBe(false);
      expect(outcome.blockers.some((item) => item.includes('symlink'))).toBe(true);
      expect((await score(root, electron)).integrityFailure).toBe(true);
    },
  );

  test.skipIf(electronBlockers.length > 0 || !hasExecutableScriptSupport)(
    'a valid fixture cannot switch to a version-spoofing launcher to score green',
    async () => {
      const root = workspace();
      materializeDesktopFixture(root, electron);
      process.env.KORY_SKILL_EVAL_ELECTRON_BINARY = versionOnlyLauncher();
      const outcome = runDesktopRuntime(root, electron);
      expect(outcome.passed).toBe(false);
      expect(outcome.checks).toEqual([]);
      expect(outcome.nativeVersion).toBeNull();
      expect(outcome.blockers.some((item) => item.includes('native executable'))).toBe(true);
      expect((await score(root, electron)).verification).toBe(0);
    },
  );

  test.skipIf(!hasExecutableScriptSupport || !cargoReady)(
    'Tauri source provides a real Rust plugin, narrow capability and retargetable filesystem roots',
    async () => {
      fakeTauriPrerequisites();
      const root = workspace();
      expect(desktopRuntimeReadiness(tauri)).toEqual([]);
      materializeDesktopFixture(root, tauri);
      const rust = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8');
      const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
      const capabilities = JSON.parse(readFileSync(join(root, 'src-tauri/capabilities/default.json'), 'utf8'));
      const contract = JSON.parse(readFileSync(join(root, '.kory-eval/desktop-fixture.json'), 'utf8'));
      expect(contract.nearNeighbor).toBe('ios-swiftui');
      expect(contract.cannotSubstitute).toContain('headless-browser');
      expect(config.app.withGlobalTauri).toBe(true);
      expect(config.bundle.active).toBe(true);
      expect(config.app.security.csp).toContain('connect-src ipc: http://ipc.localhost');
      expect(config.app.security.csp).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(capabilities.windows).toEqual(['main']);
      expect(capabilities.permissions).toEqual(['core:default', 'dialog:allow-open']);
      expect(rust).toContain('blocking_pick_folder');
      expect(rust).toContain('tauri::generate_handler![read_workspace, choose_workspace]');
      expect(readFileSync(join(root, 'ui/index.html'), 'utf8')).toContain('src="renderer.js"');
      expect(readFileSync(join(root, 'ui/renderer.js'), 'utf8')).toContain("invoke('choose_workspace')");
      const fixtureLink = join(root, 'safe-workspace', 'selected-link');
      expect(lstatSync(fixtureLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(fixtureLink)).toBe('inside');
      expect(readFileSync(join(fixtureLink, 'workspace.txt'), 'utf8')).toContain('contained workspace');
      expect(readFileSync(join(root, 'outside-workspace/workspace.txt'), 'utf8')).toContain('MUST NEVER READ');
      const execution = runDesktopRuntime(root, tauri);
      expect(execution.passed).toBe(false);
      expect(execution.nativeVersion).toBeNull();
      expect(execution.blockers.some((item) => item.includes('Real Tauri package build failed'))).toBe(true);
      expect((await score(root, tauri)).verification).toBe(0);
    },
  );

  test.skipIf(!hasExecutableScriptSupport || !cargoReady)(
    'Tauri cannot delegate native verification to an executable controlled by the candidate',
    () => {
      fakeTauriPrerequisites();
      const root = workspace();
      materializeDesktopFixture(root, tauri);
      const candidateDriver = join(root, 'candidate-driver');
      writeFileSync(candidateDriver, '#!/usr/bin/env bun\nprocess.exit(0);\n', { mode: 0o700 });
      chmodSync(candidateDriver, 0o700);
      process.env.KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER = candidateDriver;
      const result = runDesktopRuntime(root, tauri);
      expect(result.passed).toBe(false);
      expect(result.blockers).toContain('Tauri verifier must be outside the candidate fixture');
      expect(result.nativeVersion).toBeNull();
    },
  );

  test.skipIf(electronBlockers.length > 0)(
    `live Electron open/close, reload, concurrency, IPC denial, quit and capture: ${electronBlockers.join('; ') || 'available'}`,
    async () => {
      const root = workspace();
      materializeDesktopFixture(root, electron);
      const contract = JSON.parse(readFileSync(join(root, '.kory-eval/desktop-fixture.json'), 'utf8'));
      expect(contract.nearNeighbor).toBe('android-compose');
      expect(contract.broader).toBe('native-interface');
      expect(contract.cannotSubstitute).toContain('synthetic-screenshot');
      expect(readFileSync(join(root, 'app/main.cjs'), 'utf8')).toContain("ipcMain.on('settings:save'");
      expect(readFileSync(join(root, 'app/preload.cjs'), 'utf8')).toContain('contextBridge');
      expect(readFileSync(join(root, 'app/settings.d.ts'), 'utf8')).toContain('onSaved(callback:');
      const red = runDesktopRuntime(root, electron);
      expect(red.nativeVersion, red.blockers.join('; ')).not.toBeNull();
      expect(red.passed).toBe(false);
      expect(red.checks.find((item) => item.id === 'first-save-once')?.passed).toBe(true);
      expect(red.checks.find((item) => item.id === 'second-save-once')?.passed).toBe(false);
      expect(red.checks.find((item) => item.id === 'real-window-capture')?.passed).toBe(true);
      writeFixtureFile(root, 'app/main.cjs', REPAIRED_ELECTRON_MAIN);
      const green = runDesktopRuntime(root, electron);
      expect(green.passed, green.evidence.join('\n')).toBe(true);
      expect(green.checks.every((item) => item.passed)).toBe(true);
      const scored = await score(root, electron);
      expect(scored.passed, scored.evidence.join('\n')).toBe(true);
      expect(scored.quality).toBe(1);
      expect(scored.verification).toBe(1);
      if (process.env.KORY_SKILL_EVAL_PRINT_NATIVE_SMOKE === '1') {
        console.info('ELECTRON_NATIVE_SMOKE ' + JSON.stringify({
          nativeVersion: green.nativeVersion,
          passed: green.passed,
          checks: green.checks,
          evidence: green.evidence,
        }));
      }
      const preload = readFileSync(join(root, 'app/preload.cjs'), 'utf8');
      writeFixtureFile(root, 'app/preload.cjs', preload.replace(
        '  save: (settings) =>',
        '  invoke: (channel) => ipcRenderer.send(channel),\n  save: (settings) =>',
      ));
      const exposed = runDesktopRuntime(root, electron);
      expect(exposed.passed).toBe(false);
      expect(exposed.checks.find((item) => item.id === 'unexposed-ipc-denied')?.passed).toBe(false);
    },
    160_000,
  );

  test.skipIf(tauriBlockers.length > 0)(
    `live Tauri packaged app, dialogs, link swap, restart and native capture: ${tauriBlockers.join('; ') || 'available'}`,
    () => {
      const root = workspace();
      materializeDesktopFixture(root, tauri);
      const fixtureLink = join(root, 'safe-workspace', 'selected-link');
      expect(lstatSync(fixtureLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(fixtureLink)).toBe('inside');
      expect(readFileSync(join(fixtureLink, 'workspace.txt'), 'utf8')).toContain('contained');
      expect(readFileSync(join(root, 'outside-workspace/workspace.txt'), 'utf8')).toContain('MUST NEVER READ');
      const contract = JSON.parse(readFileSync(join(root, '.kory-eval/desktop-fixture.json'), 'utf8'));
      expect(contract.nearNeighbor).toBe('ios-swiftui');
      const red = runDesktopRuntime(root, tauri);
      expect(red.nativeVersion, red.blockers.join('; ')).not.toBeNull();
      expect(red.passed).toBe(false);
      expect(red.checks.find((item) => item.id === 'native-folder-dialog-opened')).toBeDefined();
    },
    180_000,
  );
});
