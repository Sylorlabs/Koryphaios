import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  hasRegressionText,
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const KUBE_INFRA = 'infrastructure-security-full-task-1';
const HOST_INFRA = 'infrastructure-security-full-task-2';
const WASM_RUNTIME = 'language-runtime-security-full-task-1-individual';
const COMPILER_RUNTIME = 'language-runtime-security-full-task-2-individual';
const REPORT_REVIEW = 'security-review-full-task-1-individual';
const IMPORT_REVIEW = 'security-review-full-task-2-individual';
const REPORT_THREAT = 'threat-modeling-practice-full-task-1-individual';
const AGENT_THREAT = 'threat-modeling-practice-full-task-2-individual';

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

const INFRA_SIM = `export interface KubeHardeningSpec {
  kubernetesVersion:string;podSecurity:{level:'baseline'|'restricted';version:string;exceptions:string[]};
  workloads:Record<string,{serviceAccount:string;runAsNonRoot:boolean;allowPrivilegeEscalation:boolean;hostNamespaces:boolean;hostMounts:string[];capabilities:string[]}>;
  publicIngressPaths:string[];adminIngressPaths:string[];networkAllows:Array<{from:string;to:string;port:string}>;
  dnsExplicit:boolean;dependencyEgressExplicit:boolean;adminAuthenticated:boolean;adminAudited:boolean;breakGlassNonShared:boolean;
  runtimeProof:{uids:Record<string,number>;serviceAccounts:Record<string,string>;capabilities:Record<string,string[]>;mounts:Record<string,string[]>;listeners:string[];reachability:Array<{from:string;to:string;allowed:boolean}>};
  imageProvenanceOwnedBy:string;
}
export function kubeHardened(s:KubeHardeningSpec):boolean {const names=['api','worker','redis','admin'];const workloads=names.every(n=>!!s.workloads[n]&&s.workloads[n].serviceAccount!=='default'&&s.workloads[n].runAsNonRoot&&!s.workloads[n].allowPrivilegeEscalation&&!s.workloads[n].hostNamespaces&&s.workloads[n].hostMounts.length===0&&!s.workloads[n].capabilities.includes('ALL'));const adminPublic=s.publicIngressPaths.some(p=>/admin|diagnostic/i.test(p));return /^v?1\./.test(s.podSecurity.version)&&workloads&&!adminPublic&&s.adminIngressPaths.length>0&&s.dnsExplicit&&s.dependencyEgressExplicit&&s.adminAuthenticated&&s.adminAudited&&s.breakGlassNonShared&&Object.keys(s.runtimeProof.uids).length>=4&&s.runtimeProof.reachability.some(x=>x.to==='admin'&&!x.allowed)}

export interface HostHardeningSpec {
  osVersion:string;installedPackages:string[];enabledServices:string[];listeners:Array<{port:number;purpose:string;networks:string[]}>;
  serviceIdentity:{user:string;uid:number;sharedWithAdmin:boolean;privileged:boolean};admin:{sharedAccount:boolean;timeBounded:boolean;audited:boolean;managementNetworks:string[];emergencySeparate:boolean};
  patch:{supportedBase:boolean;owner:string;riskBasedDeadline:boolean;immutableRebuildPreferred:boolean;rollbackArtifact:boolean;emergencyConvergesBack:boolean};
  permissions:{configWritableByService:boolean;secretWorldReadable:boolean};privilegedChangeLogging:boolean;
  actualStateChecked:string[];cloudIamOwnedBy:string;
}
export function hostHardened(s:HostHardeningSpec):boolean{return s.installedPackages.every(x=>!['telnet','rsh-server','ftp-server'].includes(x))&&s.enabledServices.every(x=>!['telnet','rsh','ftp'].includes(x))&&s.listeners.every(x=>x.purpose==='service'||x.networks.every(n=>/management|bastion|vpn/i.test(n)))&&!s.serviceIdentity.sharedWithAdmin&&!s.serviceIdentity.privileged&&s.serviceIdentity.uid>0&&!s.admin.sharedAccount&&s.admin.timeBounded&&s.admin.audited&&s.admin.managementNetworks.length>0&&s.admin.emergencySeparate&&s.patch.supportedBase&&!!s.patch.owner&&s.patch.riskBasedDeadline&&s.patch.immutableRebuildPreferred&&s.patch.rollbackArtifact&&s.patch.emergencyConvergesBack&&!s.permissions.configWritableByService&&!s.permissions.secretWorldReadable&&s.privilegedChangeLogging&&['packages','listeners','identities','permissions','network','patches','audit'].every(k=>s.actualStateChecked.includes(k))}
`;

const KUBE_CORPUS = `${JSON.stringify(
  {
    kubernetesVersion: '1.37',
    insecure: {
      serviceAccounts: { api: 'default', worker: 'default', redis: 'default', admin: 'default' },
      rootWorkload: 'worker',
      allowPrivilegeEscalation: true,
      hostMount: '/var/run',
      publicPaths: ['/api', '/admin/diagnostics'],
      networkPolicy: 'none',
    },
    reachability: [
      { from: 'internet', to: 'api', allowed: true },
      { from: 'internet', to: 'admin', allowed: false },
      { from: 'api', to: 'redis', allowed: true },
      { from: 'worker', to: 'redis', allowed: true },
      { from: 'redis', to: 'internet', allowed: false },
    ],
  },
  null,
  2,
)}\n`;
const HOST_CORPUS = `${JSON.stringify(
  {
    osVersion: 'Ubuntu 26.04 LTS',
    packages: ['service-runtime', 'curl', 'telnet', 'ftp-server', 'debug-tool'],
    listeners: [
      { port: 443, purpose: 'service', networks: ['service'] },
      { port: 22, purpose: 'admin', networks: ['0.0.0.0/0'] },
      { port: 9000, purpose: 'admin', networks: ['service'] },
    ],
    serviceUser: 'shared-rootish',
    patch: 'manual/no rollback',
  },
  null,
  2,
)}\n`;

const kubeMaterializer: SkillEvalFixtureMaterializer = {
  id: 'infrastructure-security/kubernetes-runtime-hardening@1',
  matches: (s) => s.id === KUBE_INFRA,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-kube-infra-security'));
    writeFixtureFile(d, 'src/infra-sim.ts', INFRA_SIM);
    writeFixtureFile(d, 'evidence/kube.json', KUBE_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Kubernetes infrastructure-security fixture

Write \`.kory-eval/kube-hardening.json\` as \`KubeHardeningSpec\` for Kubernetes 1.37. Pin an explicit Pod Security Standards version/level and name any exception; this fixture should need none for API/worker/Redis/admin. Each workload has a purpose-specific service account, non-root identity, no privilege escalation, host namespace/mount or broad capabilities. Public ingress serves only API; admin diagnostics has a separate authenticated/audited management path with non-shared break-glass.

Network policy is explicit for API/worker/Redis/admin, DNS and documented dependencies. Populate \`runtimeProof\` from the synthetic running-state inspection—UID, service account, caps, mounts, listeners and the supplied allowed/denied reachability matrix. Manifest intent alone does not pass. Image provenance stays \`supply-chain-security\`.
`,
    );
  },
};
const kubeScorer: SkillEvalDeterministicScorer = {
  id: 'infrastructure-security/kubernetes-runtime-hardening-scorer@1',
  scenarioIds: [KUBE_INFRA],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{kubeHardened,type KubeHardeningSpec}from'../src/infra-sim';const s=JSON.parse(readFileSync('.kory-eval/kube-hardening.json','utf8')) as KubeHardeningSpec;
test('hidden: workload privilege/identity/network/admin policy and runtime proof align',()=>{expect(s.kubernetesVersion).toBe('1.37');expect(kubeHardened(s)).toBe(true);for(const n of ['api','worker','redis','admin']){expect(s.runtimeProof.uids[n]).toBeGreaterThan(0);expect(s.runtimeProof.serviceAccounts[n]).toBe(s.workloads[n].serviceAccount);expect(s.runtimeProof.capabilities[n]).not.toContain('SYS_ADMIN');expect(s.runtimeProof.mounts[n]).not.toContain('/var/run');}expect(s.runtimeProof.reachability).toContainEqual({from:'internet',to:'admin',allowed:false});expect(s.imageProvenanceOwnedBy).toBe('supply-chain-security');});
`,
    );
    const fixed = readFileSync(join(workingDirectory, 'src/infra-sim.ts'), 'utf8') === INFRA_SIM;
    const corpus =
      readFileSync(join(workingDirectory, 'evidence/kube.json'), 'utf8') === KUBE_CORPUS;
    const passed = hidden.passed && fixed && corpus;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `effective K8s runtime hardening: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed runtime corpus preserved: ${fixed && corpus ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const hostMaterializer: SkillEvalFixtureMaterializer = {
  id: 'infrastructure-security/linux-host-baseline@1',
  matches: (s) => s.id === HOST_INFRA,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-host-infra-security'));
    writeFixtureFile(d, 'src/infra-sim.ts', INFRA_SIM);
    writeFixtureFile(d, 'evidence/host.json', HOST_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Linux host hardening/effective-state fixture

Write \`.kory-eval/host-hardening.json\` as \`HostHardeningSpec\`. Remove/disable supplied unused packages/daemons and keep only listeners tied to service or management need. SSH/admin listeners are restricted to management/bastion/VPN networks. Service runs under a dedicated unprivileged non-admin identity; privileged admin elevation is separate, time-bounded, audited and has a separate emergency path.

Use a supported base/package lifecycle with named owner, risk-based remediation deadlines, immutable-image rebuild preference, rollback artifact and convergence of emergency changes back into managed image/config. Service cannot overwrite protected config or read world-readable secrets. Record effective-state checks for packages, listeners, identities, permissions, network, patches and audit after deployment. Cloud IAM remains \`cloud-security\`.
`,
    );
  },
};
const hostScorer: SkillEvalDeterministicScorer = {
  id: 'infrastructure-security/linux-host-baseline-scorer@1',
  scenarioIds: [HOST_INFRA],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{hostHardened,type HostHardeningSpec}from'../src/infra-sim';const s=JSON.parse(readFileSync('.kory-eval/host-hardening.json','utf8')) as HostHardeningSpec;test('hidden: desired host baseline also proves effective running state',()=>{expect(hostHardened(s)).toBe(true);expect(s.cloudIamOwnedBy).toBe('cloud-security');});\n`,
    );
    const fixed = readFileSync(join(workingDirectory, 'src/infra-sim.ts'), 'utf8') === INFRA_SIM;
    const corpus =
      readFileSync(join(workingDirectory, 'evidence/host.json'), 'utf8') === HOST_CORPUS;
    const passed = hidden.passed && fixed && corpus;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.85 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `host least-privilege/effective-state policy: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed inventory preserved: ${fixed && corpus ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const WASM_SIM = `export interface WasmRuntimeSpec{runtimeVersion:string;featureSet:string[];imports:Record<string,'deny'|'workspace-read'|'bounded-log'|'clock'|'random'>;workspaceRoot:string;symlinkEscapeDenied:boolean;validateBeforeExecution:boolean;sameValidatedBytesInterpreterJit:boolean;limits:{memoryBytes:number;stackDepth:number;fuel:number;hostCalls:number;outputBytes:number;cancellationMs:number};stagePrivilegedWrites:boolean;commitPrivilegedWrites:boolean;coreMemorySafetyClaim:string;hostConfinementClaim:string}
export interface ModuleCase{id:string;valid:boolean;featureSupported:boolean;action:'workspace-read'|'path-escape'|'http'|'sign'|'loop'|'memory-grow'|'trap-after-write'|'log';mode:'interpreter'|'jit'}
export function executeModule(s:WasmRuntimeSpec,m:ModuleCase):{accepted:boolean;effect:boolean;terminated:boolean;reason:string}{if(!m.valid||!m.featureSupported)return{accepted:false,effect:false,terminated:true,reason:'validation'};if(m.action==='path-escape'&&s.symlinkEscapeDenied)return{accepted:true,effect:false,terminated:true,reason:'denied-fs'};if(m.action==='http'&&s.imports.http==='deny')return{accepted:true,effect:false,terminated:true,reason:'denied-http'};if(m.action==='sign'&&s.imports.signing==='deny')return{accepted:true,effect:false,terminated:true,reason:'denied-signing'};if(m.action==='loop'||m.action==='memory-grow')return{accepted:true,effect:false,terminated:Object.values(s.limits).every(x=>x>0),reason:'resource-limit'};if(m.action==='trap-after-write')return{accepted:true,effect:s.commitPrivilegedWrites,terminated:true,reason:'trap'};return{accepted:true,effect:m.action==='workspace-read'||m.action==='log',terminated:true,reason:'ok'}}
`;
const WASM_CORPUS = `${JSON.stringify(
  {
    runtimeVersion: 'Wasmtime 42.0',
    features: ['mutable-globals', 'bulk-memory'],
    workspaceRoot: '/workspaces/tenant-7',
    cases: [
      { id: 'valid-read', valid: true, featureSupported: true, action: 'workspace-read' },
      { id: 'malformed', valid: false, featureSupported: true, action: 'workspace-read' },
      { id: 'unsupported-feature', valid: true, featureSupported: false, action: 'workspace-read' },
      { id: 'symlink-escape', valid: true, featureSupported: true, action: 'path-escape' },
      { id: 'http', valid: true, featureSupported: true, action: 'http' },
      { id: 'sign', valid: true, featureSupported: true, action: 'sign' },
      { id: 'loop', valid: true, featureSupported: true, action: 'loop' },
      { id: 'memory', valid: true, featureSupported: true, action: 'memory-grow' },
      { id: 'trap-write', valid: true, featureSupported: true, action: 'trap-after-write' },
    ],
  },
  null,
  2,
)}\n`;
const wasmMaterializer: SkillEvalFixtureMaterializer = {
  id: 'language-runtime-security/wasm-capability-runtime@1',
  matches: (s) => s.id === WASM_RUNTIME,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-wasm-security'));
    writeFixtureFile(d, 'src/wasm-sim.ts', WASM_SIM);
    writeFixtureFile(d, 'evidence/wasm-corpus.json', WASM_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Untrusted WebAssembly capability-confinement fixture

Write \`.kory-eval/wasm-runtime.json\` as \`WasmRuntimeSpec\` for the exact supplied Wasmtime/runtime features. Guest authority is only per-workspace read and bounded logging; HTTP, signing, process/environment and filesystem write are denied. Path traversal/symlink escape cannot leave the workspace root. Malformed/unsupported bytes reject before execution, and interpreter/JIT consume the same validated bytes/features.

Set positive finite memory/stack/fuel/host-call/output/cancellation limits. Trap/resource-exhaustion cannot commit a staged privileged write. Distinguish WebAssembly core type/memory-safety guarantees from host capability/resource confinement in separate claims. Write \`.kory-eval/wasm-evidence.json\` with every supplied case in interpreter and JIT and durable side-effect audit.
`,
    );
  },
};
const wasmScorer: SkillEvalDeterministicScorer = {
  id: 'language-runtime-security/wasm-capability-runtime-scorer@1',
  scenarioIds: [WASM_RUNTIME],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{executeModule,type WasmRuntimeSpec,type ModuleCase}from'../src/wasm-sim';const s=JSON.parse(readFileSync('.kory-eval/wasm-runtime.json','utf8')) as WasmRuntimeSpec;const c=JSON.parse(readFileSync('evidence/wasm-corpus.json','utf8')) as any;
test('hidden: exact runtime/import authority and adversarial cases agree across modes',()=>{expect(s.runtimeVersion).toBe(c.runtimeVersion);expect(s.workspaceRoot).toBe(c.workspaceRoot);expect(s.imports.filesystem).toBe('workspace-read');expect(s.imports.logging).toBe('bounded-log');expect(s.imports.http).toBe('deny');expect(s.imports.signing).toBe('deny');expect(s.symlinkEscapeDenied).toBe(true);expect(s.validateBeforeExecution).toBe(true);expect(s.sameValidatedBytesInterpreterJit).toBe(true);for(const row of c.cases){for(const mode of ['interpreter','jit'] as const){const r=executeModule(s,{...row,mode} as ModuleCase);expect(r.terminated,row.id+mode).toBe(true);if(['symlink-escape','http','sign','loop','memory','trap-write','malformed','unsupported-feature'].includes(row.id))expect(r.effect,row.id+mode).toBe(false);}}});
test('hidden: resource and guarantee boundaries are explicit',()=>{for(const n of Object.values(s.limits))expect(n).toBeGreaterThan(0);expect(s.stagePrivilegedWrites).toBe(true);expect(s.commitPrivilegedWrites).toBe(false);expect(s.coreMemorySafetyClaim).toMatch(/wasm|type|memory/i);expect(s.hostConfinementClaim).toMatch(/capab|resource|host/i);});
`,
    );
    const fixed = readFileSync(join(workingDirectory, 'src/wasm-sim.ts'), 'utf8') === WASM_SIM;
    const corpus =
      readFileSync(join(workingDirectory, 'evidence/wasm-corpus.json'), 'utf8') === WASM_CORPUS;
    const ev = artifactText(workingDirectory, '.kory-eval/wasm-evidence.json');
    const bounded =
      Boolean(ev.artifact) &&
      /interpreter/u.test(ev.text) &&
      /jit/u.test(ev.text) &&
      /malformed/u.test(ev.text) &&
      /symlink/u.test(ev.text) &&
      /sign/u.test(ev.text) &&
      /durable|effect/u.test(ev.text);
    const passed = hidden.passed && fixed && corpus && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && fixed ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !corpus,
      evidence: [
        `Wasm capability/resource vectors: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed corpus preserved: ${corpus ? 'yes' : 'no'}`,
        `dual-mode/effect evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const COMPILER_SOURCE = `export interface EvalResult{mode:'interpreter'|'O0'|'O2';outcome:'trap-overflow'|'trap-bounds'|'array-access';ir:string}
const MAX=2147483647,MIN=-2147483648;
export function compileAndRun(a:number,b:number,indexBase:number,length:number,mode:'interpreter'|'O0'|'O2'):EvalResult{const sum=a+b;const overflow=sum>MAX||sum<MIN;if(mode!=='O2'&&overflow)return{mode,outcome:'trap-overflow',ir:'checked.add i32'};// BUG: nsw promises overflow cannot happen, allowing O2 to reason away source traps/checks.
const wrapped=(sum|0);const ir=mode==='O2'?'%sum = add nsw i32 %a, %b':'%sum = add i32 %a, %b';if(mode==='O2'&&overflow)return{mode,outcome:'array-access',ir};const idx=indexBase+wrapped;if(idx<0||idx>=length)return{mode,outcome:'trap-bounds',ir};return{mode,outcome:'array-access',ir}}
`;
const COMPILER_CORPUS = `${JSON.stringify(
  {
    toolchain: { llvm: '22.0.0', target: 'x86_64-apple-darwin', flags: { O0: '-O0', O2: '-O2' } },
    guarantee: { signedOverflow: 'trap', bounds: 'check-before-index' },
    cases: [
      {
        id: 'overflow-index',
        a: 2147483647,
        b: 1,
        indexBase: 0,
        length: 8,
        expected: 'trap-overflow',
      },
      { id: 'negative-bounds', a: -4, b: 1, indexBase: 0, length: 8, expected: 'trap-bounds' },
      { id: 'high-bounds', a: 4, b: 5, indexBase: 0, length: 8, expected: 'trap-bounds' },
      { id: 'safe', a: 2, b: 1, indexBase: 0, length: 8, expected: 'array-access' },
    ],
  },
  null,
  2,
)}\n`;
const compilerMaterializer: SkillEvalFixtureMaterializer = {
  id: 'language-runtime-security/compiler-overflow-lowering@1',
  matches: (s) => s.id === COMPILER_RUNTIME,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-compiler-security'));
    writeFixtureFile(d, 'src/compiler.ts', COMPILER_SOURCE);
    writeFixtureFile(d, 'evidence/compiler-corpus.json', COMPILER_CORPUS);
    writeFixtureFile(
      d,
      'tests/compiler.test.ts',
      `import{expect,test}from'bun:test';import{compileAndRun}from'../src/compiler';test('pre-fix mismatch exists',()=>{expect(compileAndRun(2147483647,1,0,8,'O0').outcome).toBe('trap-overflow');expect(compileAndRun(2147483647,1,0,8,'O2').outcome).toBe('array-access');});\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Custom compiler overflow/bounds mismatch fixture

Repair \`src/compiler.ts\` so lowering never asserts \`nsw\` or equivalent no-overflow facts stronger than the source language's trapping signed-overflow guarantee. The overflow trap must occur before the array bounds/index access in interpreter, O0 and O2. Keep the supplied LLVM 22.0.0 target/flag identity and nearby corpus.

Add regressions proving every corpus case agrees across interpreter/O0/O2 and the O2 IR no longer carries unjustified \`nsw\` on the trapping source addition (or uses an explicitly checked intrinsic/control-flow representation). Write \`.kory-eval/compiler-security.json\` tracing source→lowering→IR→optimizer→codegen, minimized pre-fix mismatch, post-fix IR and exact toolchain. Scope the issue to this custom compiler guarantee; do not label generic LLVM behavior a vulnerability.
`,
    );
  },
};
const compilerScorer: SkillEvalDeterministicScorer = {
  id: 'language-runtime-security/compiler-overflow-lowering-scorer@1',
  scenarioIds: [COMPILER_RUNTIME],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{compileAndRun}from'../src/compiler';const c=JSON.parse(readFileSync('evidence/compiler-corpus.json','utf8')) as any;
test('hidden: interpreter/O0/O2 agree with trapping/bounds corpus',()=>{for(const row of c.cases){const results=['interpreter','O0','O2'].map(mode=>compileAndRun(row.a,row.b,row.indexBase,row.length,mode as any));for(const r of results)expect(r.outcome,row.id+r.mode).toBe(row.expected);if(row.id==='overflow-index')expect(results.find(r=>r.mode==='O2')!.ir).not.toMatch(/\bnsw\b/);}});
`,
    );
    const corpus =
      readFileSync(join(workingDirectory, 'evidence/compiler-corpus.json'), 'utf8') ===
      COMPILER_CORPUS;
    const reg = hasRegressionText(workingDirectory, [
      /interpreter|O0|O2/iu,
      /overflow|bounds|nsw/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/compiler-security.json');
    const bounded =
      Boolean(report.artifact) &&
      /22\.0\.0/u.test(report.text) &&
      /lower/u.test(report.text) &&
      /ir/u.test(report.text) &&
      /optimizer/u.test(report.text) &&
      /custom compiler/u.test(report.text) &&
      !/llvm.*vulnerab/u.test(report.text);
    const passed = hidden.passed && corpus && reg && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.9 : hidden.passed ? 0.65 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !corpus,
      evidence: [
        `compiler mode/corpus agreement: ${hidden.passed ? 'pass' : 'fail'}`,
        `regression coverage: ${reg ? 'present' : 'missing'}`,
        `toolchain/scoping evidence: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const REVIEW_CORPUS = `${JSON.stringify({ reporting: { files: ['route.ts', 'data.ts', 'export-worker.ts', 'logger.ts'], route: { reportIdSource: 'path', tenantSource: 'session', dataLookup: 'getReportById(reportId)', tenantGuard: 'missing' }, queue: { payload: ['reportId', 'format'], tenantContext: 'missing' }, decoy: { query: 'parameterized', logging: 'redacts report payload' } }, importer: { files: ['import-api.ts', 'worker.ts', 'renderer.ts', 'webhook.ts'], source: 'archive entry name', queueBoundary: true, filesystemSink: 'join(extractRoot, entry.name) without post-normalization root containment', renderDecoy: 'framework auto-escapes text node', webhookDecoy: 'HTTPS host allowlist + DNS/IP post-resolution deny private ranges' } }, null, 2)}\n`;
const reportReviewMaterializer: SkillEvalFixtureMaterializer = {
  id: 'security-review/multitenant-reporting-pr@1',
  matches: (s) => s.id === REPORT_REVIEW,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-security-review-reporting'));
    writeFixtureFile(d, 'evidence/review-corpus.json', REVIEW_CORPUS);
    writeFixtureFile(
      d,
      'fixture/route.ts',
      `export async function download(session:any,reportId:string){return getReportById(reportId)}\n`,
    );
    writeFixtureFile(
      d,
      'fixture/export-worker.ts',
      `export async function work(job:any){return getReportById(job.reportId)}\n`,
    );
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Review-only multi-tenant reporting PR

Do not modify \`fixture/\` or \`evidence/review-corpus.json\`. Write \`.kory-eval/security-review-reporting.json\` as the review result. The seeded reachable finding is report ID accepted from the request and loaded by ID without authenticated tenant binding; the async export payload also loses tenant/delegated authorization context. Trace both. The seeded query/logging decoy is safe because it is parameterized/redacted and must be explicitly cleared.

For each validated finding include actor/prerequisite, trust boundary, source→sink path, confidentiality/integrity impact, blast radius, confidence and severity rationale. Do not claim exploit execution. Hand \`security-verification\` a concrete matrix including same-tenant allow, cross-tenant deny, async cross-tenant deny and denied-side-effect checks; identify untested assumptions.
`,
    );
  },
};
const reportReviewScorer: SkillEvalDeterministicScorer = {
  id: 'security-review/multitenant-reporting-pr-scorer@1',
  scenarioIds: [REPORT_REVIEW],
  score: ({ workingDirectory }) => {
    const fixture =
      readFileSync(join(workingDirectory, 'fixture/route.ts'), 'utf8') ===
        `export async function download(session:any,reportId:string){return getReportById(reportId)}\n` &&
      readFileSync(join(workingDirectory, 'fixture/export-worker.ts'), 'utf8') ===
        `export async function work(job:any){return getReportById(job.reportId)}\n`;
    const corpus =
      readFileSync(join(workingDirectory, 'evidence/review-corpus.json'), 'utf8') === REVIEW_CORPUS;
    const r = artifactText(workingDirectory, '.kory-eval/security-review-reporting.json');
    const good =
      Boolean(r.artifact) &&
      /cross.?tenant/u.test(r.text) &&
      /report.?id/u.test(r.text) &&
      /tenant/u.test(r.text) &&
      /queue|async/u.test(r.text) &&
      /parameterized/u.test(r.text) &&
      /redact/u.test(r.text) &&
      /prerequis/u.test(r.text) &&
      /blast|impact/u.test(r.text) &&
      /confidence/u.test(r.text) &&
      /severity/u.test(r.text) &&
      /security-verification/u.test(r.text) &&
      /same.?tenant/u.test(r.text) &&
      /denied.*(?:side|effect)|side.*effect/u.test(r.text) &&
      /not.*(?:executed|proved)|no dynamic/u.test(r.text);
    const passed = fixture && corpus && good;
    return {
      passed,
      quality: passed ? 1 : fixture && corpus && Boolean(r.artifact) ? 0.6 : 0,
      verification: good ? 1 : 0,
      integrityFailure: !fixture || !corpus,
      evidence: [
        `review fixture immutable: ${fixture && corpus ? 'yes' : 'no'}`,
        `reachable finding/decoy/handoff: ${good ? 'complete' : 'missing'}`,
      ],
    };
  },
};

const importReviewMaterializer: SkillEvalFixtureMaterializer = {
  id: 'security-review/document-import-worker@1',
  matches: (s) => s.id === IMPORT_REVIEW,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-security-review-import'));
    writeFixtureFile(d, 'evidence/review-corpus.json', REVIEW_CORPUS);
    writeFixtureFile(
      d,
      'fixture/worker.ts',
      `export function pathFor(root:string,name:string){return join(root,name)}\n`,
    );
    writeFixtureFile(d, 'fixture/renderer.ts', `return frameworkTextNode(metadata.title)\n`);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Review-only document-import worker

Do not change fixture/evidence. Write \`.kory-eval/security-review-import.json\`. The seeded reachable path is user archive entry name persisted across the queue then joined to the privileged worker extraction root without root-containment validation; trace actor→API→queue→worker→filesystem sink and the worker privilege expansion. Clear the rendering decoy because the supplied framework text-node path contextually escapes it; clear the webhook decoy because the supplied HTTPS allowlist plus post-resolution private-IP denial holds.

Report prerequisites, runtime configuration, CIA impact, blast/confidence/severity rationale and a current CWE only if it fits; any CVSS must be v4.0. Remediation belongs at extraction-path normalization/root containment and archive-link handling, not a whole-app rewrite. Static review did not execute the exploit. Hand concrete traversal/symlink/absolute-path/benign-name plus webhook/render regression cases to \`security-verification\`.
`,
    );
  },
};
const importReviewScorer: SkillEvalDeterministicScorer = {
  id: 'security-review/document-import-worker-scorer@1',
  scenarioIds: [IMPORT_REVIEW],
  score: ({ workingDirectory }) => {
    const fixture =
      readFileSync(join(workingDirectory, 'fixture/worker.ts'), 'utf8') ===
        `export function pathFor(root:string,name:string){return join(root,name)}\n` &&
      readFileSync(join(workingDirectory, 'fixture/renderer.ts'), 'utf8') ===
        `return frameworkTextNode(metadata.title)\n`;
    const corpus =
      readFileSync(join(workingDirectory, 'evidence/review-corpus.json'), 'utf8') === REVIEW_CORPUS;
    const r = artifactText(workingDirectory, '.kory-eval/security-review-import.json');
    const good =
      Boolean(r.artifact) &&
      /archive|entry/u.test(r.text) &&
      /queue/u.test(r.text) &&
      /filesystem|extract/u.test(r.text) &&
      /travers|contain/u.test(r.text) &&
      /framework|escape/u.test(r.text) &&
      /webhook/u.test(r.text) &&
      /allowlist/u.test(r.text) &&
      /private/u.test(r.text) &&
      /prerequis/u.test(r.text) &&
      /severity/u.test(r.text) &&
      /security-verification/u.test(r.text) &&
      /symlink/u.test(r.text) &&
      /not.*(?:executed|proved)|static review/u.test(r.text) &&
      (!/cvss/u.test(r.text) || /cvss.?4|4\.0/u.test(r.text));
    const passed = fixture && corpus && good;
    return {
      passed,
      quality: passed ? 1 : fixture && corpus && Boolean(r.artifact) ? 0.6 : 0,
      verification: good ? 1 : 0,
      integrityFailure: !fixture || !corpus,
      evidence: [
        `review fixture immutable: ${fixture && corpus ? 'yes' : 'no'}`,
        `source-sink/decoy/remediation handoff: ${good ? 'complete' : 'missing'}`,
      ],
    };
  },
};

const THREAT_CORPUS = `${JSON.stringify({ reportService: { components: ['browser', 'api', 'identity', 'metadata-db', 'queue', 'export-worker', 'object-storage', 'signed-url', 'outbound-webhook', 'support-admin', 'restore'], actors: ['tenant-user', 'compromised-tenant-user', 'service-identity', 'support-operator', 'external-webhook-endpoint'], requiredAbuses: ['cross-tenant-export', 'confused-deputy-queue', 'signed-url-leak-replay', 'webhook-ssrf', 'support-admin-misuse', 'stale-retry-authorization', 'restore-reintroduction'] }, agent: { oldAuthority: ['repo-read'], newAuthority: ['shell', 'repo-write', 'web', 'authenticated-tools', 'network-egress', 'deployment'], trustDomains: ['system-instruction', 'developer-instruction', 'user-intent', 'retrieved-untrusted-content', 'repository-untrusted-content', 'agent-identity', 'delegated-user-authority', 'local-secret', 'tool-grant'], requiredAbuses: ['instruction-injection', 'confused-deputy-tool', 'secret-exfiltration', 'unauthorized-repo-mutation', 'grant-drift', 'unreviewed-deployment', 'false-success-evidence'], refreshTriggers: ['new-tool', 'changed-grant', 'changed-identity', 'new-orchestration', 'new-external-side-effect', 'incident'] } }, null, 2)}\n`;
const reportThreatMaterializer: SkillEvalFixtureMaterializer = {
  id: 'threat-modeling-practice/report-export-service@1',
  matches: (s) => s.id === REPORT_THREAT,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-threat-report'));
    writeFixtureFile(d, 'evidence/threat-corpus.json', THREAT_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Report-export service threat model

Write \`.kory-eval/threat-report-service.json\`. Include every supplied component, actor/identity, queue/retry, support-admin and recovery/restore path with data/control flow and trust/privilege boundaries. State security objectives, non-goals and assumptions.

Explicitly disposition all seven supplied abuse cases. Each high-priority case needs attacker starting capability, concrete path, prerequisites, affected asset/outcome, existing control/assumption and priority rationale. Every proposed mitigation names its enforcing component and invariant and is marked planned vs observed. Record residual risk/assumptions and focused negative verification cases without claiming they ran.
`,
    );
  },
};
const reportThreatScorer: SkillEvalDeterministicScorer = {
  id: 'threat-modeling-practice/report-export-service-scorer@1',
  scenarioIds: [REPORT_THREAT],
  score: ({ workingDirectory }) => {
    const corpus =
      readFileSync(join(workingDirectory, 'evidence/threat-corpus.json'), 'utf8') === THREAT_CORPUS;
    const r = artifactText(workingDirectory, '.kory-eval/threat-report-service.json');
    const required = [
      'browser',
      'api',
      'identity',
      'metadata-db',
      'queue',
      'export-worker',
      'object-storage',
      'signed-url',
      'outbound-webhook',
      'support-admin',
      'restore',
      'tenant-user',
      'compromised-tenant-user',
      'service-identity',
      'support-operator',
      'external-webhook-endpoint',
      'cross-tenant-export',
      'confused-deputy-queue',
      'signed-url-leak-replay',
      'webhook-ssrf',
      'support-admin-misuse',
      'stale-retry-authorization',
      'restore-reintroduction',
    ];
    const good =
      Boolean(r.artifact) &&
      required.every((x) => r.text.includes(x)) &&
      /non.?goal/u.test(r.text) &&
      /assumption/u.test(r.text) &&
      /prerequis/u.test(r.text) &&
      /enforc/u.test(r.text) &&
      /planned|observed/u.test(r.text) &&
      /residual/u.test(r.text) &&
      /verification/u.test(r.text) &&
      /not.*(?:executed|passed)|unexecuted/u.test(r.text);
    const passed = corpus && good;
    return {
      passed,
      quality: passed ? 1 : corpus && Boolean(r.artifact) ? 0.65 : 0,
      verification: good ? 1 : 0,
      integrityFailure: !corpus,
      evidence: [
        `architecture corpus preserved: ${corpus ? 'yes' : 'no'}`,
        `full abuse/control/verification model: ${good ? 'complete' : 'missing'}`,
      ],
    };
  },
};

const agentThreatMaterializer: SkillEvalFixtureMaterializer = {
  id: 'threat-modeling-practice/coding-agent-capability-expansion@1',
  matches: (s) => s.id === AGENT_THREAT,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-threat-agent'));
    writeFixtureFile(d, 'evidence/threat-corpus.json', THREAT_CORPUS);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Coding-agent capability-expansion threat model

Write \`.kory-eval/threat-agent.json\`. Explicitly diff the old read-only/no-side-effect authority from shell, repository write, untrusted web/repository content, authenticated tools, network egress and deployment. Tool grants/identities are authority changes even when no architecture box changes. Separate system/developer/user intent from untrusted retrieved content; distinguish agent identity, delegated user authority, local secrets and tool capabilities.

Disposition all seven supplied abuse cases with attacker path/prerequisites/impact. Controls must attach to actual enforcing layers—tool permissions/capability scope, approvals, sandbox, egress, secret isolation, audit/independent verification and deployment gates. Prompt wording alone is never an enforcement boundary. Include every supplied refresh trigger and concrete verification/specialist owners without claiming cases passed.
`,
    );
  },
};
const agentThreatScorer: SkillEvalDeterministicScorer = {
  id: 'threat-modeling-practice/coding-agent-capability-expansion-scorer@1',
  scenarioIds: [AGENT_THREAT],
  score: ({ workingDirectory }) => {
    const corpus =
      readFileSync(join(workingDirectory, 'evidence/threat-corpus.json'), 'utf8') === THREAT_CORPUS;
    const r = artifactText(workingDirectory, '.kory-eval/threat-agent.json');
    const required = [
      'repo-read',
      'shell',
      'repo-write',
      'web',
      'authenticated-tools',
      'network-egress',
      'deployment',
      'system-instruction',
      'developer-instruction',
      'user-intent',
      'retrieved-untrusted-content',
      'agent-identity',
      'delegated-user-authority',
      'local-secret',
      'tool-grant',
      'instruction-injection',
      'confused-deputy-tool',
      'secret-exfiltration',
      'unauthorized-repo-mutation',
      'grant-drift',
      'unreviewed-deployment',
      'false-success-evidence',
      'new-tool',
      'changed-grant',
      'changed-identity',
      'new-orchestration',
      'new-external-side-effect',
      'incident',
    ];
    const good =
      Boolean(r.artifact) &&
      required.every((x) => r.text.includes(x)) &&
      /permission|capab/u.test(r.text) &&
      /approval/u.test(r.text) &&
      /sandbox/u.test(r.text) &&
      /egress/u.test(r.text) &&
      /audit|verification/u.test(r.text) &&
      /deployment gate/u.test(r.text) &&
      /prompt.*(?:not|isn).*security|prompt.*not.*enforc/u.test(r.text) &&
      /not.*(?:passed|executed)|unexecuted/u.test(r.text);
    const passed = corpus && good;
    return {
      passed,
      quality: passed ? 1 : corpus && Boolean(r.artifact) ? 0.65 : 0,
      verification: good ? 1 : 0,
      integrityFailure: !corpus,
      evidence: [
        `agent capability corpus preserved: ${corpus ? 'yes' : 'no'}`,
        `authority-diff/abuse/control/refresh model: ${good ? 'complete' : 'missing'}`,
      ],
    };
  },
};

export const SECURITY_REVIEW_RUNTIME_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    kubeMaterializer,
    hostMaterializer,
    wasmMaterializer,
    compilerMaterializer,
    reportReviewMaterializer,
    importReviewMaterializer,
    reportThreatMaterializer,
    agentThreatMaterializer,
  ];
export const SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  kubeScorer,
  hostScorer,
  wasmScorer,
  compilerScorer,
  reportReviewScorer,
  importReviewScorer,
  reportThreatScorer,
  agentThreatScorer,
];
