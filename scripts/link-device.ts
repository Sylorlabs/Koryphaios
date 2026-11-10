// Compatibility entry point for the original headless device helper.
import { runAdminCli } from './admin-cli';
const [command = 'status', id, check] = process.argv.slice(2);
try {
  if (command === 'status') {
    const output: string[] = [];
    await runAdminCli(['devices', 'list'], { write: (text) => output.push(text) });
    await runAdminCli(['devices', 'pending'], { write: (text) => output.push(text) });
    console.log(JSON.stringify({ ...JSON.parse(output[0]!), ...JSON.parse(output[1]!) }, null, 2));
  } else {
    const args =
      command === 'approve'
        ? ['devices', 'approve', id ?? '', '--check', check ?? '']
        : ['devices', command, ...(id ? [id] : [])];
    await runAdminCli(args);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Device command failed');
  process.exitCode = 1;
}
