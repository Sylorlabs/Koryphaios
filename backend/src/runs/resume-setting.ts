import { loadAgentSettings } from '../agent-settings';
import { serverLog } from '../logger';

/** The user's `resumeInterruptedRuns` choice. Any read failure keeps the default (on). */
export function resumeInterruptedRunsEnabled(projectRoot: string): boolean {
  try {
    return loadAgentSettings(projectRoot).resumeInterruptedRuns !== false;
  } catch (error: unknown) {
    serverLog.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Could not read resumeInterruptedRuns; defaulting to on',
    );
    return true;
  }
}
