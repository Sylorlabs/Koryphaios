/**
 * Stop anything named Kory operations on this Mac.
 *
 * The evaluation VM is where that work runs, so a process on the owner's display is a stray: it is
 * killed and the reason is reported, never left to keep taking focus.
 */
import {
  OWNER_DISPLAY_REASON,
  killOwnerDisplayProcesses,
} from '../backend/src/security/owner-display-guard';

const stopped = killOwnerDisplayProcesses();
if (!stopped.length) {
  console.log('nothing named Kory operations is running');
} else {
  for (const entry of stopped)
    console.log(`stopped ${entry.pid}: ${entry.command}\n  ${OWNER_DISPLAY_REASON}`);
}
