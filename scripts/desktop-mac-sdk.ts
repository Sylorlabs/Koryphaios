/**
 * macOS SDK selection for the native (Tauri) shell build.
 *
 * macOS beta SDKs can ship `.tbd` stubs that declare targets the installed
 * Rust linker's tapi does not understand. MacOSX27.0, for example, lists
 * `arm64e.x1-macos`, which fails the desktop link with
 * "unknown architecture … tapi error: malformed file". When the default SDK
 * is unusable, pin SDKROOT to the newest installed SDK whose stubs the linker
 * can parse so the native shell keeps building without hand-set environment.
 *
 * Shared by every launcher that spawns `tauri dev`/`tauri build` (desktop dev
 * and the stable user install) — a launcher that omits this silently fails to
 * compile the shell on affected toolchains.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SDK_ROOT = '/Library/Developer/CommandLineTools/SDKs';
const PROBE = 'System/Library/Frameworks/CoreFoundation.framework/CoreFoundation.tbd';
const UNSUPPORTED_TARGET = 'arm64e.x1';

function readProbe(sdkPath: string): string | null {
  try {
    return readFileSync(join(sdkPath, PROBE), 'utf-8');
  } catch {
    return null;
  }
}

export function resolveCompatibleMacSdk(): { sdkPath: string; reason: string } | null {
  if (process.platform !== 'darwin') return null;
  let defaultSdk: string | null = null;
  try {
    defaultSdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf-8' }).trim();
  } catch {
    /* xcrun unavailable — nothing to pin */
  }
  const defaultProbe = defaultSdk ? readProbe(defaultSdk) : null;
  // Only intervene when the default SDK actually declares a target the linker
  // rejects; a healthy toolchain is left untouched.
  if (!defaultProbe || !defaultProbe.includes(UNSUPPORTED_TARGET)) return null;
  let candidates: string[] = [];
  try {
    candidates = readdirSync(SDK_ROOT)
      .filter((entry) => /^MacOSX[\d.]+\.sdk$/.test(entry))
      .sort((a, b) => {
        const version = (name: string) => name.match(/\d+/g)?.map(Number) ?? [];
        const va = version(a);
        const vb = version(b);
        for (let i = 0; i < Math.max(va.length, vb.length); i++) {
          const diff = (vb[i] ?? 0) - (va[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });
  } catch {
    return null;
  }
  for (const entry of candidates) {
    const sdkPath = join(SDK_ROOT, entry);
    if (sdkPath === defaultSdk) continue;
    const probe = readProbe(sdkPath);
    if (!probe || probe.includes(UNSUPPORTED_TARGET)) continue;
    return {
      sdkPath,
      reason: `default SDK declares ${UNSUPPORTED_TARGET}, which the Rust linker rejects`,
    };
  }
  return null;
}
