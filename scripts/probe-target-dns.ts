import { wrapCommand } from '/opt/koryphaios/backend/src/collaboration/sandbox-runner';
const cwd = '/var/lib/koryphaios/workspace';
const args = ['hosts', 'daily-cloudcode-pa.googleapis.com'];
const wrapped = wrapCommand('/usr/bin/getent', args, { cwd, policy: { allowNetwork: true, allowShell: false, allowEdits: false, filesystemIsolation: true } });
for (const [name, command, argv] of [['host', '/usr/bin/getent', args], ['jail', wrapped.command, wrapped.args]] as const) {
  const child = Bun.spawn([command, ...argv], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  console.log(JSON.stringify({ name, exitCode: await child.exited, resolved: !!stdout.trim(), error: stderr.trim() }));
}
for (const [name, binary, argv] of [
  ['resolv-readable', '/usr/bin/test', ['-r', '/etc/resolv.conf']],
  ['nss-readable', '/usr/bin/test', ['-r', '/etc/nsswitch.conf']],
  ['dns-direct', '/usr/bin/getent', ['-s', 'dns', 'hosts', 'daily-cloudcode-pa.googleapis.com']],
] as const) {
  const sandboxed = wrapCommand(binary, [...argv], { cwd, policy: { allowNetwork: true, allowShell: false, allowEdits: false, filesystemIsolation: true } });
  const child = Bun.spawn([sandboxed.command, ...sandboxed.args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  console.log(JSON.stringify({ name, exitCode: await child.exited, output: stdout.trim(), error: stderr.trim() }));
}
