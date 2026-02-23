import { existsSync } from "node:fs";
import { join } from "node:path";

export function detectProjectRoot(): string {
  const cwd = process.cwd();
  const candidates = [cwd, join(cwd, ".."), join(cwd, "..", "..")] as const;
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "koryphaios.json"))) {
      return candidate;
    }
  }
  return cwd;
}

export const PROJECT_ROOT = detectProjectRoot();

export const BACKEND_ROOT = existsSync(join(PROJECT_ROOT, "backend", "src"))
  ? join(PROJECT_ROOT, "backend")
  : PROJECT_ROOT;
