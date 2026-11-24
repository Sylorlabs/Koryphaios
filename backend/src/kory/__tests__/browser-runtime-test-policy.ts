import { expect, test } from 'bun:test';

/** An explicit asset selection is a provisioning assertion, never a skip request. */
export function shouldSkipBrowserControl(
  blockers: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicitlyProvisioned = ['BUN_INSTALL_CACHE_DIR', 'PLAYWRIGHT_BROWSERS_PATH'].some(
    (name) => env[name] !== undefined,
  );
  return blockers.length > 0 && !explicitlyProvisioned;
}

/** Only real-runtime controls use this gate. Unit/registration/integrity tests use test(). */
export function browserControlTest(label: string, blockers: readonly string[]) {
  const skip = shouldSkipBrowserControl(blockers);
  if (skip)
    console.warn(`${label} controls unavailable (not browser evidence): ${blockers.join('; ')}`);
  return (name: string, run: () => unknown | Promise<unknown>, timeout?: number) => {
    test.skipIf(skip)(
      name,
      async () => {
        expect(blockers, `${label} provisioning`).toEqual([]);
        await run();
      },
      timeout,
    );
  };
}
