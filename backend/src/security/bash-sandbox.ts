// Bash command sandboxing - Comprehensive security validation
// Blocks command injection, shell escapes, and dangerous operations

import { toolLog } from '../logger';

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
  // Shell
  'bash',
  'sh',
  'zsh',
  'source',
  '.',
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
  requiresNetwork?: boolean;
  requiresUnsandboxed?: boolean;
}

/**
 * Comprehensive bash command validation
 * Blocks command injection, shell escapes, and dangerous operations
 */
export function validateBashCommand(
  command: string,
  options: {
    isSandboxed?: boolean;
    allowNetwork?: boolean;
  } = {},
): BashValidationResult {
  const { isSandboxed = true, allowNetwork = false } = options;
  const trimmed = command.trim();

  // Check exact dangerous commands
  if (DANGEROUS_COMMANDS.has(trimmed)) {
    return { safe: false, reason: 'Blocked: known dangerous command' };
  }

  // Check dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        safe: false,
        reason: `Blocked: command matches dangerous pattern`,
      };
    }
  }

  // Check for shell metacharacters (command injection vectors)
  if (SHELL_META_REGEX.test(trimmed)) {
    // Allow specific safe patterns
    const safePatterns = [
      /^git\s+(status|log|diff|show|branch|remote|config)/, // Git pipes are usually safe
      /^npm\s+(list|outdated)/,
    ];

    const isSafePattern = safePatterns.some((p) => p.test(trimmed));
    if (!isSafePattern && isSandboxed) {
      return {
        safe: false,
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
      reason: `Blocked: privilege escalation command '${blockedPriv}' is not allowed`,
    };
  }

  // Check for container tools (blocked in sandboxed mode only)
  const containerTool = baseCommands.find((cmd) => CONTAINER_TOOLS.has(cmd));
  if (containerTool && isSandboxed) {
    return {
      safe: false,
      reason: `Blocked: container command '${containerTool}' requires unsandboxed mode. The Manager agent can run Docker commands with full permissions.`,
      requiresUnsandboxed: true,
    };
  }

  // Check for blocked network tools
  const blockedNet = baseCommands.find((cmd) => BLOCKED_NETWORK_TOOLS.has(cmd));
  if (blockedNet) {
    return {
      safe: false,
      reason: `Blocked: network tool '${blockedNet}' is not allowed`,
    };
  }

  // Check for network commands
  const networkCmd = baseCommands.find((cmd) => NETWORK_CMDS.has(cmd));
  if (networkCmd && isSandboxed && !allowNetwork) {
    return {
      safe: false,
      reason: `Blocked: network command '${networkCmd}' requires unsandboxed mode or explicit network permission`,
      requiresNetwork: true,
      requiresUnsandboxed: true,
    };
  }

  // In sandboxed mode, all base commands must be whitelisted
  if (isSandboxed) {
    const disallowed = baseCommands.find((cmd) => !SANDBOX_CMD_WHITELIST.has(cmd));
    if (disallowed) {
      return {
        safe: false,
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

/**
 * Sanitize a command for logging (remove potential secrets)
 */
export function sanitizeCommandForLogging(command: string): string {
  let sanitized = command;

  // Remove potential API keys/tokens from logs
  sanitized = sanitized
    .replace(/(\b\w+_API_KEY\s*=\s*)[^\s&|]*/gi, '$1***')
    .replace(/(\b\w+_TOKEN\s*=\s*)[^\s&|]*/gi, '$1***')
    .replace(/(\bpassword\s*=\s*)[^\s&|]*/gi, '$1***')
    .replace(/(\bsecret\s*=\s*)[^\s&|]*/gi, '$1***')
    // Authorization headers
    .replace(/(Authorization:\s*(Bearer|Basic|Token)\s+)[^\s'"]+/gi, '$1***')
    .replace(/(-H\s+['"]Authorization:\s*(Bearer|Basic|Token)\s+)[^\s'"]+/gi, '$1***');

  // Truncate long commands
  if (sanitized.length > 200) {
    sanitized = sanitized.slice(0, 200) + '... [truncated]';
  }

  return sanitized;
}

/**
 * Audit log a bash command execution
 */
export function auditBashCommand(
  command: string,
  context: {
    sessionId?: string;
    agentId?: string;
    userId?: string;
    isSandboxed: boolean;
    allowed: boolean;
    reason?: string;
  },
): void {
  const sanitizedCmd = sanitizeCommandForLogging(command);

  if (context.allowed) {
    toolLog.info(
      {
        command: sanitizedCmd,
        sessionId: context.sessionId,
        agentId: context.agentId,
        sandboxed: context.isSandboxed,
      },
      'Bash command allowed',
    );
  } else {
    toolLog.warn(
      {
        command: sanitizedCmd,
        sessionId: context.sessionId,
        agentId: context.agentId,
        sandboxed: context.isSandboxed,
        reason: context.reason,
      },
      'Bash command blocked',
    );
  }
}
