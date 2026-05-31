import { PROJECT_ROOT } from './runtime/paths';
import { getSocketPath } from './server/socket-server';

console.log('PROJECT_ROOT:', PROJECT_ROOT);
console.log('Type:', typeof PROJECT_ROOT);

const socketInfo = getSocketPath(PROJECT_ROOT);
console.log('Socket info:', socketInfo);
