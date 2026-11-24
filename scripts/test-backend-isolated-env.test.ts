import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizePath } from '../backend/src/runtime/platform';
import { createIsolatedTestEnvironment } from './test-backend-isolated';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('isolated backend tests preserve an explicitly selected macOS SDK for native Swift fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-test-sdkroot-'));
  roots.push(root);
  const sdk = join(root, 'MacOSX26.5.sdk');
  mkdirSync(sdk);
  writeFileSync(join(sdk, 'SDKSettings.json'), '{}');

  const env = createIsolatedTestEnvironment(
    { SDKROOT: sdk, OPENAI_API_KEY: 'must-not-cross' },
    join(root, 'home'),
  );
  expect(env.SDKROOT).toBe(canonicalizePath(sdk));
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(createIsolatedTestEnvironment({}, join(root, 'home')).SDKROOT).toBeUndefined();
});

test('isolated backend tests reject an SDK selector without the macOS SDK identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-test-sdkroot-'));
  roots.push(root);
  const sdk = join(root, 'MacOSX26.5.sdk');
  mkdirSync(sdk);
  const home = join(root, 'home');

  expect(() => createIsolatedTestEnvironment({ SDKROOT: sdk }, home)).toThrow(
    'SDKROOT must name an existing directory',
  );
  writeFileSync(join(sdk, 'SDKSettings.json'), '{}');
  expect(() => createIsolatedTestEnvironment({ SDKROOT: root }, home)).toThrow(
    'SDKROOT must name an existing directory',
  );
});

test('isolated backend tests forward only explicitly selected iOS simulator devices', () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-test-simulator-'));
  roots.push(root);
  const iphone = '4ADB02EE-1CC6-4433-909A-1B1F247FA068';
  const ipad = '331D33CB-8128-48E8-AC93-76D36ED2123B';
  const env = createIsolatedTestEnvironment(
    {
      KORY_IOS_EVAL_IPHONE_UDID: iphone,
      KORY_IOS_EVAL_IPAD_UDID: ipad,
      KORY_IOS_EVAL_NATIVE_TESTS: '1',
      KORY_IOS_EVAL_DEVELOPER_DIR: '/untrusted/developer/directory',
    },
    join(root, 'home'),
  );
  expect(env.KORY_IOS_EVAL_IPHONE_UDID).toBe(iphone);
  expect(env.KORY_IOS_EVAL_IPAD_UDID).toBe(ipad);
  expect(env.KORY_IOS_EVAL_NATIVE_TESTS).toBe('1');
  expect(env.KORY_IOS_EVAL_DEVELOPER_DIR).toBeUndefined();
  expect(() =>
    createIsolatedTestEnvironment({ KORY_IOS_EVAL_IPHONE_UDID: 'not-a-udid' }, join(root, 'home')),
  ).toThrow('KORY_IOS_EVAL_IPHONE_UDID must be a valid explicit simulator UDID');
  expect(
    createIsolatedTestEnvironment({}, join(root, 'home')).KORY_IOS_EVAL_IPHONE_UDID,
  ).toBeUndefined();
  expect(
    createIsolatedTestEnvironment({}, join(root, 'home')).KORY_IOS_EVAL_NATIVE_TESTS,
  ).toBeUndefined();
  expect(() =>
    createIsolatedTestEnvironment({ KORY_IOS_EVAL_NATIVE_TESTS: 'yes' }, join(root, 'home')),
  ).toThrow('KORY_IOS_EVAL_NATIVE_TESTS must be 0 or 1');
});
