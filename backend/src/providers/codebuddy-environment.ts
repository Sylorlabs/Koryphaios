import { lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildSoftJail } from '../collaboration/sandbox-runner';
import {
  canonicalizePath,
  hasHardLinks,
  hasUnexpectedOwner,
  isContainedBy,
} from '../runtime/platform';
import { buildProviderCliEnv } from './cli-environment';
import { ensureManagedCliDirectory, type ManagedCliStorageOptions } from './managed-cli-storage';

// Qualified against @tencent-ai/codebuddy-code 2.168.2:
// FilePathServiceImpl.sharedDataPath + FileAuthenticationStorage.getAuthSavePath.
// These are the CLI's three HOME-relative layouts, NOT CODEBUDDY_CONFIG_DIR.
// Probe only the exact standalone product.json authentication.id in each layout;
// never enumerate the shared auth directory (it also holds other products).
const AUTH_DIRECTORIES = [
  join('Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  join('AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  join('.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
];
const AUTH_FILE = 'Tencent-Cloud.coding-copilot.info';
const AUTH_FILES = [AUTH_FILE, `${AUTH_FILE}.logged-out`];

function removeManagedAuthFile(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if ((!stat.isFile() && !stat.isSymbolicLink()) || hasUnexpectedOwner(stat)) {
    throw new Error('Unexpected CodeBuddy managed auth target');
  }
  // Also discards a private copy created by the CLI's atomic refresh/migration.
  // Each turn must resolve the real CLI login, not resurrect an old staged one.
  unlinkSync(path);
}

/** Stage links using metadata only. Credential contents stay owned by the CLI. */
export function stageCodeBuddyCliAuth(
  home: string,
  sourceHome = homedir(),
  storage: ManagedCliStorageOptions = {},
): string[] {
  if (isContainedBy(resolve(home), resolve(sourceHome))) {
    throw new Error('CodeBuddy requires a separate managed HOME');
  }
  ensureManagedCliDirectory(home, storage);
  const managedHome = canonicalizePath(home);
  const realHome = canonicalizePath(sourceHome);
  if (isContainedBy(managedHome, realHome)) {
    throw new Error('CodeBuddy requires a separate managed HOME');
  }

  // Retire only the links made by the old adapter. settings.json is executable
  // configuration (env/hooks/MCP), not an auth resource. Keep private files.
  for (const file of ['settings.json', '.credentials.json', 'auth.json']) {
    const target = join(home, file);
    if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
    if (resolve(dirname(target), readlinkSync(target)) !== join(sourceHome, '.codebuddy', file)) {
      throw new Error('Unexpected CodeBuddy managed configuration link');
    }
    unlinkSync(target);
  }

  const readonlyFiles: string[] = [];
  for (const directory of AUTH_DIRECTORIES) {
    for (const file of AUTH_FILES) {
      const source = join(realHome, directory, file);
      const target = join(home, directory, file);
      ensureManagedCliDirectory(dirname(target), storage);
      removeManagedAuthFile(target);
      const stat = lstatSync(source, { throwIfNoEntry: false });
      if (!stat) continue; // API-key-only and logged-out installations are valid.
      if (
        !stat.isFile() ||
        hasUnexpectedOwner(stat) ||
        hasHardLinks(stat) ||
        canonicalizePath(source) !== source
      ) {
        throw new Error('Unsafe CodeBuddy CLI auth resource');
      }
      symlinkSync(source, target, 'file');
      // wrapCommand accepts file bind targets too. Never mount Data/Public/auth
      // itself: that would expose sibling logins and credential backups.
      readonlyFiles.push(source);
    }
  }
  return readonlyFiles;
}

export function prepareCodeBuddyCliEnvironment(
  home: string,
  options: {
    filesystemIsolation?: boolean;
    sourceHome?: string;
    sourceEnv?: NodeJS.ProcessEnv;
    storage?: ManagedCliStorageOptions;
  } = {},
): {
  env: NodeJS.ProcessEnv;
  configDirs: string[];
  readonlyConfigDirs: string[];
  cleanup: () => void;
} {
  const readonlyConfigDirs = stageCodeBuddyCliAuth(home, options.sourceHome, options.storage);
  // The upstream international endpoint (www.codebuddy.ai) is banned and its
  // certificate no longer matches, so honoring an explicit "external" selection
  // would produce a TLS hostname-mismatch failure. Force "external" to the
  // reachable internal endpoint; honor other explicit selections (internal,
  // selfhosted, ioa, cloudhosted). Keep in sync with productFileNameForEnv().
  const requestedInternetEnvironment =
    options.sourceEnv?.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT?.trim() ||
    process.env.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT?.trim() ||
    '';
  const internetEnvironment =
    !requestedInternetEnvironment || requestedInternetEnvironment === 'external'
      ? 'internal'
      : requestedInternetEnvironment;
  const env = buildProviderCliEnv(
    'codebuddy',
    {
      CODEBUDDY_CONFIG_DIR: home,
      HOME: home,
      USERPROFILE: home,
      CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT: internetEnvironment,
    },
    options.sourceEnv,
  );
  const soft = options.filesystemIsolation ? buildSoftJail(env) : undefined;
  if (soft) {
    Object.assign(env, soft.env, { HOME: home, USERPROFILE: home });
  }
  // Keep the HOME-relative auth links reachable after soft-jail construction,
  // while retaining and mounting its private TMP/XDG roots on Linux as well.
  return {
    env,
    configDirs: [home, ...(soft?.env.HOME ? [soft.env.HOME] : [])],
    readonlyConfigDirs,
    cleanup: soft?.cleanup ?? (() => {}),
  };
}
