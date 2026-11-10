#!/usr/bin/env bun
// A read-only native-account portability probe. Secrets travel only over SSH
// stdin, never argv, logs, shell configuration or the permanent target login.
import { readPortableAntigravityCredential } from '../backend/src/providers/antigravity-credentials';

const target = process.argv[2];
if (!target || !/^[a-zA-Z0-9_.@:-]+$/.test(target)) throw new Error('Supply the SSH target.');
const password = (await Bun.stdin.text()).trim();
if (!password || /[\r\n]/.test(password)) throw new Error('Supply the sudo password on stdin.');
const credential = await readPortableAntigravityCredential();
const helper = await Bun.file(new URL('../backend/src/providers/antigravity-credentials.ts', import.meta.url)).text();
const remote = `
const {mkdtempSync,rmSync}=await import('node:fs');
const {join}=await import('node:path');
const {tmpdir}=await import('node:os');
const input=JSON.parse(await Bun.stdin.text());
const root=mkdtempSync(join(tmpdir(),'kory-agy-portability-'));
try {
  await Bun.write(join(root,'credentials.ts'),input.helper);
  const {stageAntigravityCredential}=await import(join(root,'credentials.ts'));
  const stage=stageAntigravityCredential(input.credential,root);
  try {
    const child=Bun.spawn(['/usr/local/bin/agy','models'],{cwd:stage.home,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:stage.home,USERPROFILE:stage.home,GEMINI_DIR:join(stage.home,'.gemini'),ANTIGRAVITY_HOME:stage.home},stdout:'pipe',stderr:'pipe'});
    const timer=setTimeout(()=>child.kill(),30000);
    const [stdout,stderr]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
    const code=await child.exited; clearTimeout(timer);
    const models=[...new Set(stdout.match(/\\b(?:gemini|claude|gpt|o[1-9])[-a-z0-9_.]+/gi)??[])];
    console.log(JSON.stringify({exitCode:code,modelCount:models.length,loginRequired:/please sign in|not logged in|oauth flow/i.test(stdout+' '+stderr),keyringUnavailable:/keyring.*unavailable|dbus.*error/i.test(stderr)}));
    if(code!==0||!models.length)process.exitCode=1;
  } finally {stage.cleanup();}
} finally {rmSync(root,{recursive:true,force:true});}
`;
const command = `sudo -S -p '' -u koryphaios /var/lib/koryphaios/.bun/bin/bun -e ${"'" + remote.replaceAll("'", "'\\''") + "'"}`;
const child = Bun.spawn(['ssh', '-T', target, command], { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' });
child.stdin.write(`${password}\n${JSON.stringify({ credential, helper })}`);
child.stdin.end();
process.exitCode = await child.exited;
