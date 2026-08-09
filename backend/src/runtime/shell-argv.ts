// Shell-argv execution: run a command as an argv array without a shell.
//
// This is the trust boundary for sandboxed command execution. The old path
// (`bash -c <string>`) let agents bypass the regex sandbox with constructs
// like `bash -c 'rm -rf /'`. By tokenizing the command string into an argv
// array and spawning with `shell: false`, no shell interprets the string —
// the program receives its arguments literally.
//
// Pipes (`|`), redirects (`>`), and shell operators (`&&`, `;`) are NOT
// supported in argv-only mode. When a command needs them, the caller must
// either:
//   1. Run unsandboxed (the manager agent), which still uses the shell
//      string path for legitimate pipelines, OR
//   2. Use the OS sandbox (os-sandbox.ts) which confines the shell and its
//      children via namespaces/landlock, so pipes are safe because the
//      whole process tree is contained.
//
// The tokenizer handles:
//   - single and double quotes (with backslash escapes inside double quotes)
//   - backslash escapes outside quotes
//   - leading env assignments (FOO=bar baz=qux cmd args) — preserved as
//     argv elements so the program sees them
//   - comments (#) — stripped
//
// It does NOT handle:
//   - command substitution $(...) or backticks — these are shell features
//     and have no meaning without a shell. They're passed literally.
//   - globbing — the program receives the literal pattern; glob expansion
//     is the program's responsibility (most CLIs glob themselves).
//   - tilde expansion — passed literally (~ stays ~).

import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';

export interface TokenizeResult {
  argv: string[];
  /** True when the command uses shell features the tokenizer can't represent. */
  needsShell: boolean;
  /** The shell features detected, if needsShell is true. */
  shellFeatures?: string[];
}

/**
 * Tokenize a command string into an argv array using POSIX-ish shell quoting
 * rules. Returns `needsShell: true` when the string contains operators
 * (|, ||, &&, ;, >, >>, <, <<, &) that require a shell to interpret.
 *
 * Callers should check `needsShell` and either reject the command (sandboxed
 * mode) or route it through the OS sandbox (which confines the shell).
 */
export function tokenizeCommand(command: string): TokenizeResult {
  const argv: string[] = [];
  const features = new Set<string>();

  let i = 0;
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  const push = () => {
    if (hasToken || current !== '') {
      argv.push(current);
      current = '';
      hasToken = false;
    }
  };

  while (i < command.length) {
    const ch = command[i];

    // Comments: # starts a comment to end of line, but only when at the
    // start of a token (POSIX behavior).
    if (ch === '#' && !inSingle && !inDouble && !hasToken && current === '') {
      // Skip to end of line.
      while (i < command.length && command[i] !== '\n') i++;
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      i++;
      continue;
    }

    if (inDouble) {
      if (ch === '\\') {
        const next = command[i + 1];
        // Inside double quotes, backslash escapes only $, `, ", \, newline.
        if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
          current += next;
          i += 2;
        } else {
          current += ch;
          i++;
        }
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        i++;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    // Not in any quote.
    if (ch === '\\') {
      const next = command[i + 1];
      if (next === '\n') {
        // Line continuation: skip the backslash and newline.
        i += 2;
        continue;
      }
      if (next !== undefined) {
        current += next;
        hasToken = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      i++;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      i++;
      continue;
    }

    // Whitespace: token boundary.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      push();
      i++;
      continue;
    }

    // Shell operators that require a shell to interpret.
    if (ch === '|') {
      if (command[i + 1] === '|') {
        features.add('||');
        i += 2;
      } else {
        features.add('|');
        i++;
      }
      push();
      continue;
    }
    if (ch === '&') {
      if (command[i + 1] === '&') {
        features.add('&&');
        i += 2;
      } else if (command[i + 1] === '>') {
        features.add('&>');
        i += 2;
      } else {
        features.add('&');
        i++;
      }
      push();
      continue;
    }
    if (ch === ';') {
      features.add(';');
      push();
      i++;
      continue;
    }
    if (ch === '>') {
      if (command[i + 1] === '>' && command[i + 2] === '>') {
        features.add('>>>');
        i += 3;
      } else if (command[i + 1] === '>') {
        features.add('>>');
        i += 2;
      } else if (command[i + 1] === '|') {
        features.add('>|');
        i += 2;
      } else if (command[i + 1] === '(') {
        features.add('>(');
        i += 2;
      } else {
        features.add('>');
        i++;
      }
      push();
      continue;
    }
    if (ch === '<') {
      if (command[i + 1] === '<' && command[i + 2] === '<') {
        features.add('<<<');
        i += 3;
      } else if (command[i + 1] === '<') {
        features.add('<<');
        i += 2;
      } else if (command[i + 1] === '(') {
        features.add('<(');
        i += 2;
      } else if (command[i + 1] === '>') {
        features.add('<>');
        i += 2;
      } else {
        features.add('<');
        i++;
      }
      push();
      continue;
    }

    current += ch;
    hasToken = true;
    i++;
  }

  push();

  // Unterminated quote: treat as needsShell so the caller can decide.
  if (inSingle || inDouble) {
    features.add('unterminated-quote');
  }

  const featureList = [...features];
  return {
    argv,
    needsShell: featureList.length > 0,
    shellFeatures: featureList,
  };
}

/**
 * Resolve a bare command name (e.g. "git") to an absolute path on PATH,
 * mirroring what a shell would do. Returns null when not found.
 *
 * Unlike runtime/shell.ts's `which`, this does NOT cache — the sandboxed
 * path is hot but not THAT hot, and a stale cache after a tool install
 * would be confusing.
 */
export function resolveCommandPath(command: string): string | null {
  // Absolute or relative path: use as-is after normalization.
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    return command;
  }
  const PATH = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, command + ext);
      try {
        // existsSync is fine; we don't need to stat for executability here
        // because the OS will fail with EACCES if it's not executable.
        if (existsSync(full)) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}
