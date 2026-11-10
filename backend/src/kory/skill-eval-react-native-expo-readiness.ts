import { spawnSync } from 'node:child_process';
import { findExecutableOnPath } from '../runtime/platform';

export interface ReactNativeExpoProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type ReactNativeExpoCommandRunner = (
  executable: string,
  args: readonly string[],
) => ReactNativeExpoProbeResult;

export type ReactNativeExpoExecutableLocator = (binary: string) => string | null;

const defaultRunner: ReactNativeExpoCommandRunner = (executable, args) => {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    shell: false,
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 200_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    ...(result.error ? { error: result.error.message } : {}),
  };
};

function concise(result: ReactNativeExpoProbeResult): string {
  return ((result.error ?? result.stderr.trim()) || result.stdout.trim() || 'no output')
    .replace(/\s+/gu, ' ')
    .slice(-240);
}

function hasConnectedAndroidDevice(output: string): boolean {
  return output.split(/\r?\n/u).some((line) => /^\S+\s+device(?:\s|$)/u.test(line.trim()));
}

function hasBootedIOSSimulator(output: string): boolean {
  const parsed = JSON.parse(output);
  if (!parsed?.devices || typeof parsed.devices !== 'object' || Array.isArray(parsed.devices)) {
    throw new Error('missing devices map');
  }
  let booted = false;
  for (const [runtime, devices] of Object.entries(parsed.devices)) {
    if (!Array.isArray(devices)) throw new Error('invalid devices list');
    for (const device of devices) {
      if (!device || typeof device.state !== 'string') throw new Error('invalid device state');
      if (
        runtime.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-') &&
        device.state === 'Booted' &&
        device.isAvailable === true
      )
        booted = true;
    }
  }
  return booted;
}

/**
 * Probe only host tooling and boot/readiness state. This deliberately does not
 * infer React Native behavior, Expo compatibility, or app-level lifecycle
 * results from the presence of a simulator or device.
 */
export function inspectReactNativeExpoReadiness(
  run: ReactNativeExpoCommandRunner = defaultRunner,
  locate: ReactNativeExpoExecutableLocator = findExecutableOnPath,
): string[] {
  const diagnostics: string[] = [];
  const xcrun = locate('xcrun');
  if (!xcrun) {
    diagnostics.push('iOS simulator tooling unavailable: xcrun was not found on PATH.');
  } else {
    const result = run(xcrun, ['simctl', 'list', '-j', 'devices', 'booted']);
    if (result.status !== 0 || result.error) {
      diagnostics.push(`iOS simulator probe unavailable: ${concise(result)}.`);
    } else {
      try {
        diagnostics.push(
          hasBootedIOSSimulator(result.stdout)
            ? 'iOS simulator probe found at least one available booted iOS simulator.'
            : 'iOS simulator readiness unavailable: simctl reported no available booted iOS simulator.',
        );
      } catch {
        diagnostics.push('iOS simulator probe unavailable: invalid simctl device enumeration.');
      }
    }
  }

  const adb = locate('adb');
  if (!adb) {
    diagnostics.push('Android device/emulator tooling unavailable: adb was not found on PATH.');
  } else {
    const result = run(adb, ['devices', '-l']);
    if (result.status !== 0 || result.error) {
      diagnostics.push(`Android device/emulator probe unavailable: ${concise(result)}.`);
    } else if (
      !result.stdout.split(/\r?\n/u).some((line) => line.trim() === 'List of devices attached')
    ) {
      diagnostics.push(
        'Android device/emulator probe unavailable: invalid adb device enumeration.',
      );
    } else if (!hasConnectedAndroidDevice(result.stdout)) {
      diagnostics.push(
        'Android device/emulator readiness unavailable: adb reported no device in the device state.',
      );
    } else {
      diagnostics.push('Android device/emulator probe found at least one connected device.');
    }
  }
  return diagnostics;
}

export function reactNativeExpoEnvironmentBlocker(): string {
  return [
    'Requires an actual React Native/Expo device or simulator runtime for AppState, safe-area, keyboard, lifecycle, and rendered interaction evidence.',
    'No executable Expo app fixture or native interaction evaluator is registered for either scenario; both remain blocked regardless of host-tool availability.',
    'Readiness probes are tool-level only and do not certify app behavior.',
    ...inspectReactNativeExpoReadiness(),
  ].join(' ');
}

// Explicit invocation avoids spawning device tools during unrelated catalog imports.
if (import.meta.main) console.log(reactNativeExpoEnvironmentBlocker());
