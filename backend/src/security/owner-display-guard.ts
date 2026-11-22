import { execFileSync } from 'node:child_process';

/**
 * Some work belongs to a virtual machine, never to the display its owner is using. A window that
 * announces itself as Koryphaios operations work is that kind of work: it exists so an evaluation can
 * be watched, and the machine to watch it on is the isolated guest, not this one.
 *
 * The rule is a name, deliberately. It is what the window calls itself, so it matches whether the
 * window came from this build, an older one, or a helper someone started by hand. Killing is the
 * remedy because the alternative is a window that keeps taking focus from the person using the Mac.
 */
export const OWNER_DISPLAY_FORBIDDEN = [/kory[\s_.-]*operations/iu] as const;

/** The reason recorded everywhere a process is reported as stopped by this guard. */
export const OWNER_DISPLAY_REASON =
  'Kory operations belongs on the isolated evaluation virtual machine, not the owner\'s Mac';

export function ownerDisplayRefusal(label: string): string | null {
  return OWNER_DISPLAY_FORBIDDEN.some((pattern) => pattern.test(label)) ? OWNER_DISPLAY_REASON : null;
}

export interface StoppedProcess {
  pid: number;
  command: string;
  reason: string;
}

/**
 * Find and stop every process whose command names Kory operations work. The listing is read from the
 * process table rather than from window server state, so it works whether or not the guard can see
 * windows, and a match is a process that is running on this machine when it should not be.
 */
export function killOwnerDisplayProcesses(now: () => number = Date.now): StoppedProcess[] {
  const stopped: StoppedProcess[] = [];
  const listing = (() => {
    try {
      return execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', maxBuffer: 4_000_000 });
    } catch {
      return '';
    }
  })();
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]!.trim();
    if (!command || pid === process.pid) continue;
    // The guard's own command line contains the pattern it searches for.
    if (command.includes('owner-display-guard')) continue;
    const reason = ownerDisplayRefusal(command);
    if (!reason) continue;
    try {
      process.kill(pid, 'SIGKILL');
      stopped.push({ pid, command: command.slice(0, 240), reason });
    } catch {
      // A process that already exited is not a failure to stop it.
    }
  }
  if (stopped.length && typeof now === 'function') now();
  return stopped;
}