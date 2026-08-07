import { PROJECT_ROOT } from './runtime/paths';
import { getSocketPath } from './server/socket-server';
import { serverLog } from './logger';

serverLog.info({ PROJECT_ROOT }, 'PROJECT_ROOT');
serverLog.info({ type: typeof PROJECT_ROOT }, 'Type');

const socketInfo = getSocketPath(PROJECT_ROOT);
serverLog.info({ socketInfo }, 'Socket info');
