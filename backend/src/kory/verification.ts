import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { QualityGateReport } from './prompts';

export interface VerificationCheck {
  command: string;
  source: string;
  reason: string;
}

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

function packageManagerCommand(root: string): string {
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun run';
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  return 'npm run';
}

/** Resolve deterministic checks from repository-owned configuration, never a universal command. */
export function discoverVerificationChecks(root: string): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    const scripts = (pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<
      string,
      unknown
    >;
    const runner = packageManagerCommand(root);
    const selected = ['typecheck:ci', 'check', 'typecheck', 'test:core', 'test'].filter(
      (name, index, names) =>
        typeof scripts[name] === 'string' &&
        !(
          name === 'typecheck' &&
          names
            .slice(0, index)
            .some((other) => other === 'typecheck:ci' && typeof scripts[other] === 'string')
        ) &&
        !(
          name === 'test' &&
          names
            .slice(0, index)
            .some((other) => other === 'test:core' && typeof scripts[other] === 'string')
        ),
    );
    for (const name of selected) {
      checks.push({
        command: `${runner} ${name}`,
        source: pkgPath,
        reason: `repository script ${name}`,
      });
    }
  }

  const conventional: Array<[string, string, string]> = [
    ['Cargo.toml', 'cargo test', 'Rust manifest'],
    ['go.mod', 'go test ./...', 'Go module'],
    ['pyproject.toml', 'python -m pytest', 'Python project'],
    ['pytest.ini', 'python -m pytest', 'Pytest configuration'],
  ];
  for (const [marker, command, reason] of conventional) {
    if (existsSync(join(root, marker)) && !checks.some((check) => check.command === command)) {
      checks.push({ command, source: join(root, marker), reason });
    }
  }
  if (existsSync(join(root, 'Makefile'))) {
    const makefile = readFileSync(join(root, 'Makefile'), 'utf8');
    for (const target of ['check', 'test']) {
      if (new RegExp(`^${target}:`, 'm').test(makefile)) {
        checks.push({
          command: `make ${target}`,
          source: join(root, 'Makefile'),
          reason: `Make target ${target}`,
        });
      }
    }
  }

  const workflows = join(root, '.github', 'workflows');
  if (existsSync(workflows)) {
    for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
      const content = readFileSync(join(workflows, file), 'utf8');
      for (const line of content.split('\n')) {
        const match = line.match(/^\s*run:\s*(.+?)\s*$/);
        if (!match) continue;
        const command = match[1].replace(/^['"]|['"]$/g, '');
        if (
          /^(bun|npm|pnpm|yarn|cargo|go|python|pytest|make)\b/.test(command) &&
          /\b(test|check|typecheck|lint)\b/.test(command) &&
          !checks.some((check) => check.command === command)
        ) {
          checks.push({
            command,
            source: join(workflows, file),
            reason: `CI workflow ${basename(file)}`,
          });
        }
      }
    }
  }
  return checks;
}

export function emptyQualityGateReport(reason: string): QualityGateReport {
  return {
    verdict: 'unverified',
    checks: [],
    artifacts: [],
    criticFindings: [],
    unmetCriteria: [],
    reasons: [reason],
  };
}
