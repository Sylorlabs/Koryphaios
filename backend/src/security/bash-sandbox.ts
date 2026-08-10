// Bash command sandboxing - Comprehensive security validation
// Blocks command injection, shell escapes, and dangerous operations

import { createHash } from 'node:crypto';

import { serverLog, toolLog } from '../logger';

// Dangerous shell metacharacters that could be used for injection
// These are blocked in sandboxed mode
const SHELL_METACHARACTERS = new Set([
  // Command substitution
  '$(',
  '`',
  // Pipes and redirections that enable chaining
  '|',
  '||',
  '&&',
  ';',
  ';;',
  // Process substitution
  '<(',
  '>(',
  // Background and grouping
  '&',
  '(',
  ')',
  '{',
  '}',
  // Expansion operators
  '$',
  // Here documents/strings
  '<<',
  '<<-',
  // Wildcards in dangerous contexts (checked separately)
]);

// Regex for detecting shell metacharacters
const SHELL_META_REGEX = /[;|&$()`{}[\]<>]/;

// Commands that are never allowed, even in unsandboxed mode
const DANGEROUS_COMMANDS = new Set([
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf ~/',
  ':(){ :|:& };:', // Fork bomb
  'yes | rm -r /',
]);

// Dangerous patterns that indicate malicious intent
const DANGEROUS_PATTERNS = [
  // Root destruction
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/, // rm -rf /
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\w/, // rm -rf /anything at root
  /\bmkfs\.?\w*\b/, // mkfs variants
  /\bdd\s+if=.*of=\/dev\/sd/, // dd to disk
  /\bdd\s+if=.*of=\/dev\/hd/, // dd to disk
  />\s*\/dev\/sd[a-z]/, // write to raw disk
  />\s*\/dev\/hd[a-z]/, // write to raw disk
  // Permission destruction
  /\bchmod\s+(-R\s+)?777\s+\//, // chmod 777 /
  /\bchown\s+(-R\s+)?.*\s+\//, // chown at root
  // System control
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[0-6]\b/,
  /\bsystemctl\s+(stop|disable|mask|poweroff|reboot)\b/,
  // Auth stealing
  /\/etc\/shadow/,
  /\/etc\/passwd.*>>/,
  // Remote code execution
  /\bcurl\b.*\|\s*\bbash\b/, // curl | bash
  /\bwget\b.*\|\s*\bbash\b/, // wget | bash
  /\bcurl\b.*\|\s*\bsh\b/, // curl | sh
  /\bwget\b.*\|\s*\bsh\b/, // wget | sh
  // Command substitution (comprehensive)
  /\$\([^)]*\)/, // $(...)
  /`[^`]*`/, // `...`
  // Eval with substitution
  /\beval\s+.*\$\(/, // eval $(
  /\beval\s+.*`/, // eval `...`
  // Python/Perl/Ruby code execution
  /\bpython[23]?\s+(-c|--command)\s+/, // python -c
  /\bperl\s+-e\b/, // perl -e
  /\bruby\s+-e\b/, // ruby -e
  /\bnode\s+-e\b/, // node -e
  // Network listeners
  /\bnc\s+-[elp]/, // netcat listeners
  /\bncat\s+-[elp]/, // ncat listeners
  /\bsocat\b/, // socat
  /\bpython\s+-m\s+http\.server/, // Python HTTP server
  // Scheduled tasks (persistence)
  /\bcrontab\s+-/, // crontab modification
  /\bat\s+now/, // at command
  // SSH key operations
  /\bssh-keygen\s+-/, // SSH key manipulation
  /\bssh\s+.*-i\s+.*\/\.ssh/, // SSH with private keys
  // AWS/GCP/Cloud credential access
  /\baws\s+configure\b/,
  /\bgcloud\s+auth\b/,
  /\/\.aws\//,
  /\/\.config\/gcloud\//,
  // Auth tokens
  /\bclaude\s+(login|auth)\b/,
  /\bcodex\s+(auth|login)\b/,
  /\bopenai\s+login\b/,
  /\bgh\s+auth\b/,
  // Sandbox escape: /proc filesystem leaks parent process env, cmdline, secrets
  /\/proc\/\d*\b/,
  /\/proc\/self\b/,
  // Sandbox escape: parent directory traversal via ..
  /\.\.\//,
  // Sandbox escape: symlink to absolute path (bypasses path confinement)
  /\bln\s+(-[a-zA-Z]*s[a-zA-Z]*\s+)?\/[^\s]*\s/,
  // Sandbox escape: namespace/chroot operations
  /\bnsenter\b/,
  /\bunshare\b/,
  /\bchroot\b/,
  // Sandbox escape: exec replaces the shell process, bypassing the parser
  /\bexec\s+/,
  // Sandbox escape: source/. executes arbitrary scripts
  /^\s*(source|\.)\s+/,
  // Sandbox escape: eval executes constructed strings
  /\beval\s+/,
  // Sandbox escape: mkfifo creates named pipes for data exfiltration
  /\bmkfifo\b/,
  // Sandbox escape: mount can overlay the filesystem
  /\bmount\b/,
  // Sandbox escape: /dev/tcp and /dev/udp for network exfiltration via bash
  /\/dev\/(tcp|udp)\//,
];

// Safe command whitelist for sandboxed mode
export const SANDBOX_CMD_WHITELIST = new Set([
  // File operations
  'ls',
  'dir',
  'pwd',
  'echo',
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'awk',
  'sed',
  'find',
  'locate',
  'which',
  'whereis',
  'touch',
  'mkdir',
  'rmdir',
  'cp',
  'mv',
  'rm',
  'ln',
  'chmod',
  'chown',
  'stat',
  // Text processing
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'diff',
  'cmp',
  'comm',
  'tee',
  'xargs',
  // Version control
  'git',
  'svn',
  'hg',
  // JavaScript/TypeScript
  'npm',
  'node',
  'npx',
  'bun',
  'yarn',
  'pnpm',
  'tsc',
  'tsx',
  'ts-node',
  'jest',
  'vitest',
  'mocha',
  'cypress',
  'playwright',
  'eslint',
  'prettier',
  'biome',
  // Python
  'python',
  'python3',
  'pip',
  'pip3',
  'pytest',
  'mypy',
  'black',
  'ruff',
  // Go
  'go',
  'gofmt',
  // Rust
  'cargo',
  'rustc',
  'rustfmt',
  'rustup',
  // Java
  'java',
  'javac',
  'mvn',
  'gradle',
  // Ruby
  'ruby',
  'gem',
  'bundle',
  'rake',
  // PHP
  'php',
  'composer',
  // Shell interpreters are intentionally NOT in the sandbox whitelist.
  // Spawning `bash -c '...'` / `sh -c '...'` / `node -e '...'` from inside
  // the sandbox lets an agent bypass the regex layer in one line. Shell
  // features (pipes, redirects) are handled by the OS sandbox
  // (os-sandbox.ts) which confines the whole process tree, or by the
  // unsandboxed manager path.
  // Build tools
  'make',
  'cmake',
  'ninja',
  'meson',
  'gcc',
  'g++',
  'clang',
  'clang++',
  'ld',
  'ar',

  // Utilities
  'tar',
  'gzip',
  'gunzip',
  'zip',
  'unzip',
  'curl',
  'wget', // Allowed in unsandboxed, checked separately for sandboxed
  'jq',
  'yq',
  'base64',
  'md5sum',
  'sha256sum',
  'date',
  'cal',
  'clear',
  'reset',
  'env',
  'export',
  'unset',
  'true',
  'false',
  'yes',
  'no',
  'kill',
  'pkill',
  'pgrep',
  'ps',
  'top',
  'htop',
  'df',
  'du',
  'free',
  'uptime',
  'whoami',
  'id',
  'history',
]);

// Network commands that require explicit permission
const NETWORK_CMDS = new Set(['curl', 'wget', 'http', 'https']);

// Blocked network tools (never allowed in sandbox)
const BLOCKED_NETWORK_TOOLS = new Set([
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'netcat',
  'ncat',
  'socat',
  'telnet',
  'ftp',
  'tftp',
  'ping',
  'traceroute',
  'tracepath',
  'mtr',
  'dig',
  'nslookup',
  'host',
  'whois',
  'nmap',
  'masscan',
  'zmap',
  'tcpdump',
  'wireshark',
  'tshark',
  'openssl',
  'ncat',
]);

// Blocked privilege escalation (always blocked)
const BLOCKED_PRIVILEGE = new Set(['sudo', 'su', 'doas', 'pkexec']);

// Container tools - blocked in sandboxed mode only (allowed for manager)
const CONTAINER_TOOLS = new Set([
  'docker',
  'docker-compose',
  'podman',
  'nerdctl',
  'buildah',
  'skopeo',
]);

export interface BashValidationResult {
  safe: boolean;
  reason?: string;
  code?: BashValidationCode;
  requiresNetwork?: boolean;
  requiresUnsandboxed?: boolean;
}

export type BashValidationCode =
  | 'DANGEROUS_COMMAND'
  | 'SHELL_METACHARACTERS'
  | 'PRIVILEGE_ESCALATION'
  | 'CONTAINER_TOOL'
  | 'BLOCKED_NETWORK_TOOL'
  | 'NETWORK_PERMISSION_REQUIRED'
  | 'EXECUTABLE_NOT_ALLOWED'
  | 'POLICY_BLOCKED';

/** Granular sandbox toggles. Each flag only suppresses its check while
 *  `isSandboxed` is true — none can enable a check when unsandboxed.
 *  Unset/undefined defaults to `true` so callers without explicit settings
 *  preserve the original strict behavior. */
export interface BashSandboxOptions {
  isSandboxed?: boolean;
  allowNetwork?: boolean;
  /** Enforce the static command whitelist (SANDBOX_CMD_WHITELIST). */
  commandWhitelist?: boolean;
  /** Block shell metacharacters (pipes, substitution, grouping, etc.). */
  metacharacters?: boolean;
  /** Block network commands (curl, wget, ssh, etc.). */
  network?: boolean;
  /** Block container tools (docker, podman, etc.). */
  containerTools?: boolean;
}

/**
 * Comprehensive bash command validation
 * Blocks command injection, shell escapes, and dangerous operations
 */
export function validateBashCommand(
  command: string,
  options: BashSandboxOptions = {},
): BashValidationResult {
  const {
    isSandboxed = true,
    allowNetwork = false,
    commandWhitelist = true,
    metacharacters = true,
    network = true,
    containerTools = true,
  } = options;
  const trimmed = command.trim();

  // Check exact dangerous commands
  if (DANGEROUS_COMMANDS.has(trimmed)) {
    return {
      safe: false,
      code: 'DANGEROUS_COMMAND',
      reason: 'Blocked: known dangerous command',
    };
  }

  // Check dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        safe: false,
        code: 'DANGEROUS_COMMAND',
        reason: `Blocked: command matches dangerous pattern`,
      };
    }
  }

  // Check for shell metacharacters (command injection vectors)
  if (metacharacters && SHELL_META_REGEX.test(trimmed)) {
    // Allow specific safe patterns
    const safePatterns = [
      /^git\s+(status|log|diff|show|branch|remote|config)/, // Git pipes are usually safe
      /^npm\s+(list|outdated)/,
    ];

    const isSafePattern = safePatterns.some((p) => p.test(trimmed));
    if (!isSafePattern && isSandboxed) {
      return {
        safe: false,
        code: 'SHELL_METACHARACTERS',
        reason: `Blocked: shell metacharacters detected (pipes, redirects, command substitution, etc.). In sandboxed mode, only simple commands are allowed.`,
        requiresUnsandboxed: true,
      };
    }
  }

  // Parse base commands for whitelist checking
  const baseCommands = extractBaseCommands(trimmed);

  // Check for blocked privilege escalation
  const blockedPriv = baseCommands.find((cmd) => BLOCKED_PRIVILEGE.has(cmd));
  if (blockedPriv) {
    return {
      safe: false,
      code: 'PRIVILEGE_ESCALATION',
      reason: `Blocked: privilege escalation command '${blockedPriv}' is not allowed`,
    };
  }

  // Check for container tools (blocked in sandboxed mode only)
  const containerTool = baseCommands.find((cmd) => CONTAINER_TOOLS.has(cmd));
  if (containerTools && containerTool && isSandboxed) {
    return {
      safe: false,
      code: 'CONTAINER_TOOL',
      reason: `Blocked: container command '${containerTool}' requires unsandboxed mode. The Manager agent can run Docker commands with full permissions.`,
      requiresUnsandboxed: true,
    };
  }

  // Check for blocked network tools
  const blockedNet = baseCommands.find((cmd) => BLOCKED_NETWORK_TOOLS.has(cmd));
  if (blockedNet) {
    return {
      safe: false,
      code: 'BLOCKED_NETWORK_TOOL',
      reason: `Blocked: network tool '${blockedNet}' is not allowed`,
    };
  }

  // Check for network commands
  const networkCmd = baseCommands.find((cmd) => NETWORK_CMDS.has(cmd));
  if (network && networkCmd && isSandboxed && !allowNetwork) {
    return {
      safe: false,
      code: 'NETWORK_PERMISSION_REQUIRED',
      reason: `Blocked: network command '${networkCmd}' requires unsandboxed mode or explicit network permission`,
      requiresNetwork: true,
      requiresUnsandboxed: true,
    };
  }

  // In sandboxed mode, all base commands must be whitelisted
  if (commandWhitelist && isSandboxed) {
    const disallowed = baseCommands.find((cmd) => !SANDBOX_CMD_WHITELIST.has(cmd));
    if (disallowed) {
      return {
        safe: false,
        code: 'EXECUTABLE_NOT_ALLOWED',
        reason: `Blocked: command '${disallowed}' is not in the sandbox whitelist`,
        requiresUnsandboxed: true,
      };
    }
  }

  return { safe: true };
}

/**
 * Extract base command names from a command string
 * Handles basic parsing without executing the command
 */
function extractBaseCommands(command: string): string[] {
  const commands: string[] = [];

  // Split by shell operators (but don't fail on them - just extract commands)
  const segments = command
    .split(/(?:\|\||&&|\||;)/g)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const segment of segments) {
    // Remove leading/trailing whitespace and common prefixes
    const cleaned = segment
      .replace(/^\s*/, '')
      .replace(/^sudo\s+/, '') // Remove sudo prefix for checking
      .replace(/^\.+\//, ''); // Remove ./ prefix

    // Extract first word (the command)
    const match = cleaned.match(/^([a-zA-Z0-9_\-\+\.]+)/);
    if (match) {
      const cmd = match[1].toLowerCase();
      // Handle common aliases/names
      if (cmd === 'python3') commands.push('python');
      else if (cmd === 'pip3') commands.push('pip');
      else commands.push(cmd);
    }
  }

  return [...new Set(commands)]; // Remove duplicates
}

const AUDIT_EXECUTABLE_PATTERN = /^[a-zA-Z0-9_.+-]{1,64}$/;
const SAFE_ERROR_CODES = new Set([
  'ABORT_ERR',
  'E2BIG',
  'EACCES',
  'EADDRINUSE',
  'EAGAIN',
  'EBUSY',
  'ECANCELED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EHOSTUNREACH',
  'EINTR',
  'EINVAL',
  'EIO',
  'EISDIR',
  'EMFILE',
  'ENETUNREACH',
  'ENFILE',
  'ENOENT',
  'ENOMEM',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'ENOTSUP',
  'EPERM',
  'EPIPE',
  'EROFS',
  'ETIMEDOUT',
]);

export interface BashCommandAuditMetadata {
  executable: string;
  category:
    | 'container'
    | 'filesystem'
    | 'language-runtime'
    | 'network'
    | 'package-build'
    | 'privilege'
    | 'shell'
    | 'version-control'
    | 'other'
    | 'unknown';
  argCount: number;
  commandBytes: number;
  commandDigest: string;
}

export interface ToolErrorAuditMetadata {
  errorClass: string;
  errorCode: string;
  errorFingerprint: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function firstAuditCommand(command: string): { executable: string; leadingTokenCount: number } {
  const firstSegment =
    command
      .slice(0, 4_096)
      .split(/(?:\|\||&&|[|;\n])/u, 1)[0]
      ?.trim() ?? '';
  const tokens = firstSegment.split(/\s+/u).filter(Boolean);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index])) index += 1;
  if (tokens[index] === 'env' && index + 1 < tokens.length) {
    let candidate = index + 1;
    while (candidate < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[candidate])) {
      candidate += 1;
    }
    if (candidate < tokens.length) index = candidate;
  }
  const raw = (tokens[index] ?? '').replace(/^[('"`]+|[)'"`]+$/gu, '');
  const basename = raw.split(/[\\/]/u).filter(Boolean).at(-1)?.toLowerCase() ?? '';
  return AUDIT_EXECUTABLE_PATTERN.test(basename)
    ? { executable: basename, leadingTokenCount: index + 1 }
    : { executable: 'unknown', leadingTokenCount: 0 };
}

function countWhitespaceTokens(value: string): number {
  let count = 0;
  let inToken = false;
  for (const character of value) {
    if (/\s/u.test(character)) {
      inToken = false;
    } else if (!inToken) {
      inToken = true;
      count += 1;
    }
  }
  return count;
}

function commandCategory(executable: string): BashCommandAuditMetadata['category'] {
  if (BLOCKED_PRIVILEGE.has(executable)) return 'privilege';
  if (CONTAINER_TOOLS.has(executable)) return 'container';
  if (NETWORK_CMDS.has(executable) || BLOCKED_NETWORK_TOOLS.has(executable)) return 'network';
  if (['git', 'hg', 'svn'].includes(executable)) return 'version-control';
  if (
    ['bun', 'cargo', 'cmake', 'gradle', 'make', 'mvn', 'npm', 'npx', 'pnpm', 'yarn'].includes(
      executable,
    )
  ) {
    return 'package-build';
  }
  if (['deno', 'java', 'node', 'perl', 'php', 'python', 'python3', 'ruby'].includes(executable)) {
    return 'language-runtime';
  }
  if (['bash', 'dash', 'fish', 'sh', 'zsh'].includes(executable)) return 'shell';
  if (
    [
      'cat',
      'chmod',
      'chown',
      'cp',
      'find',
      'ln',
      'ls',
      'mkdir',
      'mv',
      'rm',
      'rmdir',
      'stat',
      'touch',
    ].includes(executable)
  ) {
    return 'filesystem';
  }
  return executable === 'unknown' ? 'unknown' : 'other';
}

/** Content-free command identity for persistent audit logs. */
export function summarizeBashCommandForAudit(command: string): BashCommandAuditMetadata {
  const { executable, leadingTokenCount } = firstAuditCommand(command);
  const tokenCount = countWhitespaceTokens(command);
  return {
    executable,
    category: commandCategory(executable),
    argCount: Math.max(0, tokenCount - leadingTokenCount),
    commandBytes: Buffer.byteLength(command, 'utf8'),
    commandDigest: sha256(command),
  };
}

function ownString(error: object, key: string): string {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : '';
  } catch {
    return '';
  }
}

function safeErrorClass(error: unknown): string {
  if (error === null) return 'null';
  const builtins: ReadonlyArray<readonly [string, new (...args: never[]) => Error]> = [
    ['EvalError', EvalError],
    ['RangeError', RangeError],
    ['ReferenceError', ReferenceError],
    ['SyntaxError', SyntaxError],
    ['TypeError', TypeError],
    ['URIError', URIError],
  ];
  for (const [name, constructor] of builtins) {
    try {
      if (error instanceof constructor) return name;
    } catch {
      return 'unknown';
    }
  }
  try {
    return error instanceof Error ? 'Error' : typeof error;
  } catch {
    return 'unknown';
  }
}

/** Content-free error identity for logs and bounded UI references. */
export function summarizeToolErrorForAudit(error: unknown): ToolErrorAuditMetadata {
  const errorClass = safeErrorClass(error);
  let message = typeof error === 'string' ? error : '';
  let candidateCode = '';
  if (error && typeof error === 'object') {
    message = ownString(error, 'message');
    candidateCode = ownString(error, 'code');
  }
  const errorCode = SAFE_ERROR_CODES.has(candidateCode) ? candidateCode : 'UNKNOWN';
  return {
    errorClass,
    errorCode,
    errorFingerprint: sha256(`${errorClass}\0${errorCode}\0${message}`),
  };
}

export function bashValidationUserMessage(result: BashValidationResult): string {
  switch (result.code) {
    case 'DANGEROUS_COMMAND':
      return 'Command blocked by the dangerous-command safety policy.';
    case 'SHELL_METACHARACTERS':
      return 'Command blocked because shell composition requires a stronger execution boundary.';
    case 'PRIVILEGE_ESCALATION':
      return 'Command blocked because privilege escalation is not allowed.';
    case 'CONTAINER_TOOL':
      return 'Command blocked because container tools require an explicitly authorized unsandboxed session.';
    case 'BLOCKED_NETWORK_TOOL':
      return 'Command blocked because this network tool is not allowed.';
    case 'NETWORK_PERMISSION_REQUIRED':
      return 'Command blocked because network access requires explicit permission.';
    case 'EXECUTABLE_NOT_ALLOWED':
      return 'Command blocked because its executable is not permitted by the sandbox policy.';
    case 'POLICY_BLOCKED':
      return 'Command blocked by the execution safety policy.';
    default:
      return result.safe ? 'Command allowed.' : 'Command blocked by the execution safety policy.';
  }
}

/** @deprecated Use `summarizeBashCommandForAudit` for structured logs. This
 * compatibility formatter is also content-free and never returns command text. */
export function sanitizeCommandForLogging(command: string): string {
  const audit = summarizeBashCommandForAudit(command);
  return `${audit.executable} [category=${audit.category}; args=${audit.argCount}; bytes=${audit.commandBytes}; sha256=${audit.commandDigest}]`;
}

/**
 * Audit log a bash command execution
 */
export function auditBashCommand(
  command: string,
  context: {
    cwd?: string;
    toolCallId?: string;
    sessionId?: string;
    isSandboxed: boolean;
    allowed: boolean;
    decisionCode?: BashValidationCode;
  },
): void {
  const commandAudit = summarizeBashCommandForAudit(command);

  if (context.allowed) {
    toolLog.info(
      {
        ...commandAudit,
        cwd: context.cwd,
        toolCallId: context.toolCallId,
        sessionId: context.sessionId,
        decision: 'allowed',
      },
      'Bash command allowed',
    );
  } else {
    toolLog.warn(
      {
        ...commandAudit,
        cwd: context.cwd,
        toolCallId: context.toolCallId,
        sessionId: context.sessionId,
        decision: 'blocked',
        decisionCode: context.decisionCode ?? 'POLICY_BLOCKED',
      },
      'Bash command blocked',
    );
  }
}

export function logBashExecutionAudit(
  command: string,
  context: {
    cwd: string;
    phase: 'background_start' | 'foreground_start';
    toolCallId: string;
    sessionId: string;
  },
): void {
  toolLog.info(
    {
      ...summarizeBashCommandForAudit(command),
      cwd: context.cwd,
      decision: context.phase,
      toolCallId: context.toolCallId,
      sessionId: context.sessionId,
    },
    context.phase === 'background_start'
      ? 'Starting supervised background process'
      : 'Executing bash command',
  );
}

export function logBackgroundRegistrationFailure(context: {
  command?: string;
  cwd?: string;
  error: unknown;
  phase: 'input_invalid' | 'registration_failed';
  sessionId: string;
  toolCallId?: string;
}): void {
  serverLog.debug(
    {
      ...(context.command ? summarizeBashCommandForAudit(context.command) : {}),
      ...summarizeToolErrorForAudit(context.error),
      cwd: context.cwd,
      decision:
        context.phase === 'input_invalid'
          ? 'background_registration_input_invalid'
          : 'background_registration_failed',
      sessionId: context.sessionId,
      toolCallId: context.toolCallId,
    },
    context.phase === 'input_invalid'
      ? 'Failed to parse background command tool input, keeping tool name'
      : 'Background process registration failed (non-critical)',
  );
}
