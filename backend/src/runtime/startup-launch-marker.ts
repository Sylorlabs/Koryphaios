// Writes the 'launching' startup marker as a module side effect. This must be
// the first import of server.ts so the desktop sees progress while the rest of
// the import graph evaluates, before bootstrap() runs.

import { reportStartupPhase } from './startup-status';

reportStartupPhase('launching', 'Loading the backend');
