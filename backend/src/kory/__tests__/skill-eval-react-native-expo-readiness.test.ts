import { describe, expect, test } from 'bun:test';
import { inspectReactNativeExpoReadiness } from '../skill-eval-react-native-expo-readiness';

const locate = (binary: string) => `/tools/${binary}`;

describe('React Native/Expo evaluator readiness diagnostics', () => {
  test('reports missing iOS and Android host tooling without claiming app behavior', () => {
    const diagnostics = inspectReactNativeExpoReadiness(
      () => {
        throw new Error('missing tools must not be invoked');
      },
      () => null,
    );
    expect(diagnostics).toEqual([
      'iOS simulator tooling unavailable: xcrun was not found on PATH.',
      'Android device/emulator tooling unavailable: adb was not found on PATH.',
    ]);
  });

  test('separates tool probes from app-level evidence', () => {
    const diagnostics = inspectReactNativeExpoReadiness((executable, args) => {
      if (executable.endsWith('/xcrun')) {
        expect(args).toEqual(['simctl', 'list', '-j', 'devices', 'booted']);
        return { status: 0, stdout: '{"devices":{}}', stderr: '' };
      }
      expect(executable.endsWith('/adb')).toBe(true);
      expect(args).toEqual(['devices', '-l']);
      return { status: 0, stdout: 'List of devices attached\n\n', stderr: '' };
    }, locate);
    expect(diagnostics).toEqual([
      'iOS simulator readiness unavailable: simctl reported no available booted iOS simulator.',
      'Android device/emulator readiness unavailable: adb reported no device in the device state.',
    ]);
    expect(diagnostics.join(' ')).not.toMatch(/AppState|safe-area|keyboard|lifecycle/u);
  });

  test('preserves missing simctl and timeout failures rather than reporting an empty device list', () => {
    const diagnostics = inspectReactNativeExpoReadiness(
      (executable) =>
        executable.endsWith('/xcrun')
          ? { status: 1, stdout: '', stderr: 'xcrun: unable to find utility "simctl"' }
          : { status: null, stdout: '', stderr: '', error: 'spawnSync adb ETIMEDOUT' },
      locate,
    );
    expect(diagnostics[0]).toContain('unable to find utility "simctl"');
    expect(diagnostics[1]).toContain('ETIMEDOUT');
    expect(diagnostics.every((value) => value.includes('probe unavailable'))).toBe(true);
  });

  test('rejects malformed successful command output instead of asserting no devices exist', () => {
    for (const stdout of ['not JSON', '{}', '{"devices":null}', '{"devices":{"ios":null}}']) {
      const diagnostics = inspectReactNativeExpoReadiness(
        () => ({ status: 0, stdout, stderr: '' }),
        locate,
      );
      expect(diagnostics[0]).toContain('invalid simctl device enumeration');
      expect(diagnostics[1]).toContain('invalid adb device enumeration');
    }
  });

  test('does not treat tvOS, unavailable simulators, or unauthorized/offline adb targets as ready', () => {
    const diagnostics = inspectReactNativeExpoReadiness(
      (executable) => ({
        status: 0,
        stderr: '',
        stdout: executable.endsWith('/xcrun')
          ? JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.tvOS-27-0': [
                  { state: 'Booted', isAvailable: true },
                ],
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                  { state: 'Booted', isAvailable: false },
                ],
              },
            })
          : 'List of devices attached\nserial-1 unauthorized\nemulator-5554 offline\n',
      }),
      locate,
    );
    expect(diagnostics.every((value) => value.includes('readiness unavailable'))).toBe(true);
  });

  test('reports available host targets only, without claiming the Expo application ran', () => {
    const diagnostics = inspectReactNativeExpoReadiness(
      (executable) => ({
        status: 0,
        stderr: '',
        stdout: executable.endsWith('/xcrun')
          ? JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                  { state: 'Booted', isAvailable: true },
                ],
              },
            })
          : 'List of devices attached\nemulator-5554 device product:example\n',
      }),
      locate,
    );
    expect(diagnostics[0]).toContain('available booted iOS simulator');
    expect(diagnostics[1]).toContain('at least one connected device');
    expect(diagnostics.join(' ')).not.toMatch(/AppState|safe-area|keyboard|lifecycle|passed/u);
  });
});
