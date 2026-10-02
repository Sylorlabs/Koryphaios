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

const GITHUB_CICD = 'cicd-engineering-full-task-1-individual';
const GITLAB_CICD = 'cicd-engineering-full-task-2-individual';
const CONTAINER_RUNTIME = 'container-engineering-full-task-1-individual';
const CONTAINER_MULTIARCH = 'container-engineering-full-task-2-individual';
const KUBE_ROLLOUT = 'kubernetes-operations-full-task-1-individual';
const KUBE_UPGRADE = 'kubernetes-operations-full-task-2-individual';
const TF_IMPORT = 'terraform-iac-full-task-1-individual';
const TF_REFACTOR = 'terraform-iac-full-task-2-individual';
const LAMBDA_SQS = 'serverless-platforms-full-task-1-individual';
const WORKER_ISOLATE = 'serverless-platforms-full-task-2-individual';

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

function bool(value: unknown, key: string, expected: boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => bool(item, key, expected));
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record[key] === expected) return true;
  return Object.values(record).some((item) => bool(item, key, expected));
}

const CICD_SIM = `export interface GithubPipelineSpec {
  validation: { permissions: string[]; cloudSecretAvailable: boolean; idToken: boolean };
  production: {
    permissions: string[];
    environment: string;
    protected: boolean;
    oidc: { enabled: boolean; repository: string; ref: string; environment: string };
    concurrency: { group: string; serial: boolean };
  };
  artifact: { buildOnce: boolean; exactCommit: boolean; immutableDigest: boolean; rebuildOnDeploy: boolean };
  cacheKeyInputs: string[];
  retryKeepsOriginalCommitAndDigest: boolean;
  rollbackUsesKnownGoodDigest: boolean;
}

export interface GitlabPipelineSpec {
  mergeRequest: { productionSecretAvailable: boolean; deployAuthority: boolean };
  release: { protectedRefOnly: boolean; immutableArtifact: boolean; exactCommit: boolean };
  staging: { rebuilds: boolean; consumesReleaseDigest: boolean };
  production: { protectedEnvironment: boolean; allowedToDeployOnly: boolean; serial: boolean; consumesReleaseDigest: boolean };
  cacheKeyInputs: string[];
  retryKeepsOriginalRevisionAndDigest: boolean;
  rollbackUsesKnownGoodDigest: boolean;
}

export function githubForkCanReachProduction(spec: GithubPipelineSpec): boolean {
  return spec.validation.cloudSecretAvailable || spec.validation.idToken ||
    spec.validation.permissions.some((permission) => /write|id-token/i.test(permission));
}

export function githubDeployAllowed(spec: GithubPipelineSpec, approved: boolean): boolean {
  return approved && spec.production.protected && spec.production.environment === 'production' &&
    spec.production.oidc.enabled && spec.production.oidc.environment === 'production';
}

export function githubPromotionIdentity(spec: GithubPipelineSpec): boolean {
  return spec.artifact.buildOnce && spec.artifact.exactCommit && spec.artifact.immutableDigest &&
    !spec.artifact.rebuildOnDeploy && spec.retryKeepsOriginalCommitAndDigest;
}

export function gitlabMrCanDeploy(spec: GitlabPipelineSpec): boolean {
  return spec.mergeRequest.productionSecretAvailable || spec.mergeRequest.deployAuthority;
}

export function gitlabPromotionIdentity(spec: GitlabPipelineSpec): boolean {
  return spec.release.protectedRefOnly && spec.release.immutableArtifact && spec.release.exactCommit &&
    !spec.staging.rebuilds && spec.staging.consumesReleaseDigest && spec.production.consumesReleaseDigest &&
    spec.retryKeepsOriginalRevisionAndDigest;
}
`;

const githubMaterializer: SkillEvalFixtureMaterializer = {
  id: 'cicd-engineering/github-actions-trust-promotion@1',
  matches: (scenario) => scenario.id === GITHUB_CICD,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-github-cicd'));
    writeFixtureFile(destination, 'src/cicd-sim.ts', CICD_SIM);
    writeFixtureFile(
      destination,
      'evidence/starting-workflow.json',
      `${JSON.stringify(
        {
          workflowPermissions: ['contents:write', 'id-token:write'],
          validationSecret: 'SYNTHETIC_LONG_LIVED_CLOUD_SECRET',
          deploySource: 'current-main-head',
          cacheKeyInputs: ['os'],
          productionConcurrency: 'overlap-allowed',
          environmentProtection: false,
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# GitHub Actions trust/promotion simulator

Preserve \`src/cicd-sim.ts\` and the starting evidence. Write \`.kory-eval/github-pipeline.json\` matching \`GithubPipelineSpec\`. Fork validation must have no production secret, id-token, or broad write authority. Only the environment-gated production job may receive minimal OIDC authority, with repository/ref/environment claim constraints.

Build/test/publish once from an exact commit and promote the immutable tested digest; deployment may not rebuild from mutable main. Cache correctness inputs must include lockfile, architecture, and toolchain/runtime. Production is serialized. Rejected approval deploys nothing and obtains no deployment authority. Retry preserves original commit/digest; rollback selects the prior known-good digest through the same protected environment.

Write \`.kory-eval/github-cicd-evidence.json\` with fork/failure/cancel/approval/rejection/retry/rollback simulator results, exact commit→digest chain, OIDC claim boundary, and \`liveProviderVerified: false\`/synthetic evidence labels.
`,
    );
  },
};

const githubScorer: SkillEvalDeterministicScorer = {
  id: 'cicd-engineering/github-actions-trust-promotion-scorer@1',
  scenarioIds: [GITHUB_CICD],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect,test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { githubDeployAllowed,githubForkCanReachProduction,githubPromotionIdentity,type GithubPipelineSpec } from '../src/cicd-sim';
const spec=JSON.parse(readFileSync('.kory-eval/github-pipeline.json','utf8')) as GithubPipelineSpec;

test('hidden: fork validation cannot cross privileged boundary',()=>{
  expect(githubForkCanReachProduction(spec)).toBe(false);
  expect(spec.validation.permissions.every((p)=>!/write|id-token/i.test(p))).toBe(true);
});
test('hidden: prod gate/OIDC/serialization are scoped',()=>{
  expect(githubDeployAllowed(spec,false)).toBe(false);
  expect(githubDeployAllowed(spec,true)).toBe(true);
  expect(spec.production.oidc.repository).toBeTruthy();
  expect(spec.production.oidc.ref).toMatch(/main|refs\/heads\/main/);
  expect(spec.production.concurrency.serial).toBe(true);
  expect(spec.production.concurrency.group).toMatch(/prod/i);
});
test('hidden: one immutable artifact survives retry/rollback and cache is correctness-scoped',()=>{
  expect(githubPromotionIdentity(spec)).toBe(true);
  for(const input of ['lockfile','architecture','toolchain']) expect(spec.cacheKeyInputs.map(x=>x.toLowerCase())).toContain(input);
  expect(spec.rollbackUsesKnownGoodDigest).toBe(true);
});
`,
    );
    const simPreserved =
      readFileSync(join(workingDirectory, 'src/cicd-sim.ts'), 'utf8') === CICD_SIM;
    const evidence = artifactText(workingDirectory, '.kory-eval/github-cicd-evidence.json');
    const bounded =
      Boolean(evidence.artifact) &&
      /fork/u.test(evidence.text) &&
      /reject/u.test(evidence.text) &&
      /retry/u.test(evidence.text) &&
      /rollback/u.test(evidence.text) &&
      /digest/u.test(evidence.text) &&
      bool(evidence.artifact, 'liveProviderVerified', false);
    const passed = hidden.passed && simPreserved && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.7 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !simPreserved,
      evidence: [
        `pipeline simulator: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed simulator preserved: ${simPreserved ? 'yes' : 'no'}`,
        `bounded evidence: ${bounded ? 'yes' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const gitlabMaterializer: SkillEvalFixtureMaterializer = {
  id: 'cicd-engineering/gitlab-immutable-promotion@1',
  matches: (scenario) => scenario.id === GITLAB_CICD,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-gitlab-cicd'));
    writeFixtureFile(destination, 'src/cicd-sim.ts', CICD_SIM);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# GitLab immutable promotion simulator

Write \`.kory-eval/gitlab-pipeline.json\` matching \`GitlabPipelineSpec\`. Merge-request jobs must run untrusted code without production secrets/deploy authority. A protected release ref builds exactly once from the exact revision, publishes an immutable digest, and staging/production both consume that same digest without rebuilding. Production is a protected Allowed-to-deploy boundary and serialized.

Cache keys include lockfile, architecture, and toolchain/runtime. Failed tests and canceled promotion cannot advance. Retry retains the original revision/digest; selecting a newer revision requires a new pipeline/gates. Rollback promotes the prior known-good digest.

Write \`.kory-eval/gitlab-cicd-evidence.json\` with MR/protected-job permission matrix, failed/unauthorized/cancel/retry/rollback results, revision→digest→staging→production chain, and \`liveProviderVerified:false\` synthetic evidence. Signing/attestation remains adjacent \`supply-chain-security\`, not a substitute for CI/CD proof.
`,
    );
  },
};

const gitlabScorer: SkillEvalDeterministicScorer = {
  id: 'cicd-engineering/gitlab-immutable-promotion-scorer@3',
  scenarioIds: [GITLAB_CICD],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect,test } from 'bun:test'; import { readFileSync } from 'node:fs';
import { gitlabMrCanDeploy,gitlabPromotionIdentity,type GitlabPipelineSpec } from '../src/cicd-sim';
const spec=JSON.parse(readFileSync('.kory-eval/gitlab-pipeline.json','utf8')) as GitlabPipelineSpec;
test('hidden: MR path unprivileged',()=>expect(gitlabMrCanDeploy(spec)).toBe(false));
test('hidden: release artifact promoted unchanged',()=>{expect(gitlabPromotionIdentity(spec)).toBe(true);expect(spec.production.protectedEnvironment).toBe(true);expect(spec.production.allowedToDeployOnly).toBe(true);expect(spec.production.serial).toBe(true);});
test('hidden: cache/retry/rollback contract',()=>{const inputs=spec.cacheKeyInputs.map(x=>x.toLowerCase());expect(inputs).toContain('lockfile');expect(inputs).toContain('architecture');expect(inputs.some(x=>/toolchain|runtime|bun.*version|node.*version|compiler.*version/u.test(x))).toBe(true);expect(spec.rollbackUsesKnownGoodDigest).toBe(true);});
`,
    );
    const simPreserved =
      readFileSync(join(workingDirectory, 'src/cicd-sim.ts'), 'utf8') === CICD_SIM;
    const evidence = artifactText(workingDirectory, '.kory-eval/gitlab-cicd-evidence.json');
    const bounded =
      Boolean(evidence.artifact) &&
      /unauthor|denied/u.test(evidence.text) &&
      /cancel/u.test(evidence.text) &&
      /retry/u.test(evidence.text) &&
      /rollback/u.test(evidence.text) &&
      /digest/u.test(evidence.text) &&
      /supply(?:[-_ ]?chain)(?:[-_ ]?security)/u.test(evidence.text) &&
      bool(evidence.artifact, 'liveProviderVerified', false);
    const passed = hidden.passed && simPreserved && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.7 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !simPreserved,
      evidence: [
        `GitLab simulator: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed simulator preserved: ${simPreserved ? 'yes' : 'no'}`,
        `bounded CI/CD evidence: ${bounded ? 'yes' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const CONTAINER_INSPECTOR = `export interface ImageInspection {
  stages: number;
  finalBasePinned: boolean;
  finalUser: string | null;
  shellEntrypoint: boolean;
  syntheticSecretPresent: boolean;
}

export function inspectDockerfile(source:string):ImageInspection {
  const lines=source.split(/\\r?\\n/).map((line)=>line.trim()).filter(Boolean);
  const from=lines.filter((line)=>/^FROM\\s+/i.test(line));
  const finalFrom=from.at(-1) ?? '';
  const user=[...lines].reverse().find((line)=>/^USER\\s+/i.test(line));
  const command=lines.find((line)=>/^(?:ENTRYPOINT|CMD)\\s+/i.test(line)) ?? '';
  return {
    stages:from.length,
    finalBasePinned:/@sha256:[a-f0-9]{16,}/i.test(finalFrom),
    finalUser:user?.replace(/^USER\\s+/i,'') ?? null,
    shellEntrypoint:/sh\\s+-c|["']sh["']\\s*,\\s*["']-c/i.test(command),
    syntheticSecretPresent:/SYNTHETIC_REGISTRY_TOKEN|REGISTRY_TOKEN=/i.test(source),
  };
}
`;

const containerRuntimeMaterializer: SkillEvalFixtureMaterializer = {
  id: 'container-engineering/production-image-runtime@3',
  matches: (scenario) => scenario.id === CONTAINER_RUNTIME,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-container-runtime'));
    writeFixtureFile(destination, 'src/container-inspector.ts', CONTAINER_INSPECTOR);
    writeFixtureFile(destination, 'bun.lock', 'synthetic-lock-v1\n');
    writeFixtureFile(
      destination,
      'evidence/base-digest.txt',
      'sha256:1111111111111111111111111111111111111111111111111111111111111111\n',
    );
    writeFixtureFile(
      destination,
      'Dockerfile',
      `FROM oven/bun:latest\nENV REGISTRY_TOKEN=SYNTHETIC_REGISTRY_TOKEN\nRUN apt-get update && apt-get install -y build-essential\nCOPY . /app\nWORKDIR /app\nRUN bun install && bun run build\nUSER root\nCMD ["sh","-c","bun run src/server.ts"]\n`,
    );
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# Production OCI image fixture

Repair \`Dockerfile\` while preserving the fixed inspector. Use a clean multi-stage build with the supplied lockfile and the exact synthetic digest in \`evidence/base-digest.txt\` as the literal digest-pinned final base identity. The synthetic registry token may be consumed only through a non-persisting build-secret mechanism and must not appear in Dockerfile ENV/ARG defaults or final history/config/files. Final process is non-root and directly execs the app (no \`sh -c\`).

Write \`.kory-eval/container-runtime.json\`. At the top level it must contain \`buildToolingInFinalImage:false\`, \`secretPersisted:false\`, \`readOnlyRoot:true\`, \`writableMounts:["/tmp","/var/lib/app"]\`, \`sigtermReachedApp:true\`, numeric \`exitMs\` no greater than 10000, and \`orphanChild:false\`. Also record numeric non-root UID/GID, final image digest/config/history inspection, clean-context/lockfile identity, and synthetic/local evidence. Keep host-isolation and supply-chain claims explicitly unproved unless separately exercised.
`,
    );
  },
};

const containerRuntimeScorer: SkillEvalDeterministicScorer = {
  id: 'container-engineering/production-image-runtime-scorer@1',
  scenarioIds: [CONTAINER_RUNTIME],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import {expect,test} from 'bun:test';import {readFileSync} from 'node:fs';import {inspectDockerfile} from '../src/container-inspector';
const image=inspectDockerfile(readFileSync('Dockerfile','utf8'));const report=JSON.parse(readFileSync('.kory-eval/container-runtime.json','utf8')) as any;
test('hidden: final build shape and process identity',()=>{expect(image.stages).toBeGreaterThanOrEqual(2);expect(image.finalBasePinned).toBe(true);expect(image.syntheticSecretPresent).toBe(false);expect(image.shellEntrypoint).toBe(false);expect(image.finalUser).toBeTruthy();expect(image.finalUser).not.toMatch(/^root$|^0(?::0)?$/);});
test('hidden: runtime contract',()=>{expect(report.secretPersisted).toBe(false);expect(report.buildToolingInFinalImage).toBe(false);expect(report.readOnlyRoot).toBe(true);expect(new Set(report.writableMounts)).toEqual(new Set(['/tmp','/var/lib/app']));expect(report.sigtermReachedApp).toBe(true);expect(report.exitMs).toBeLessThanOrEqual(10000);expect(report.orphanChild).toBe(false);});
`,
    );
    const fixed =
      readFileSync(join(workingDirectory, 'src/container-inspector.ts'), 'utf8') ===
      CONTAINER_INSPECTOR;
    const report = artifactText(workingDirectory, '.kory-eval/container-runtime.json');
    const bounded =
      Boolean(report.artifact) &&
      /synthetic|local/u.test(report.text) &&
      /digest/u.test(report.text) &&
      /config/u.test(report.text) &&
      /history/u.test(report.text) &&
      /lock/u.test(report.text) &&
      /host.*(?:unproved|not.*proved|unavailable)|supply.*(?:unproved|not.*proved|unavailable)/u.test(
        report.text,
      );
    const passed = hidden.passed && fixed && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `image/runtime simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `inspector preserved: ${fixed ? 'yes' : 'no'}`,
        `evidence boundary: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const OCI_INSPECTOR = `export interface ChildManifest { platform:{os:string;architecture:string}; digest:string; nativeDependency:string; libc:string; entrypoint:string[]; user:string; writablePaths:string[]; smoke:'pass'|'fail'; execution:'native'|'emulated' }
export interface OciIndex { mediaType:string; manifests:ChildManifest[] }
export function child(index:OciIndex,arch:string):ChildManifest|undefined{return index.manifests.find((item)=>item.platform.os==='linux'&&item.platform.architecture===arch);}
`;

const containerMultiarchMaterializer: SkillEvalFixtureMaterializer = {
  id: 'container-engineering/multiarch-oci-index@1',
  matches: (s) => s.id === CONTAINER_MULTIARCH,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-container-multiarch'));
    writeFixtureFile(destination, 'src/oci-inspector.ts', OCI_INSPECTOR);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'evidence/starting-index.json',
      `${JSON.stringify({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ platform: { os: 'linux', architecture: 'amd64' }, digest: 'sha256:amd64-old', nativeDependency: 'native-addon-amd64', libc: 'glibc' }] }, null, 2)}\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Multi-platform OCI fixture

Write \`.kory-eval/oci-index.json\` matching \`OciIndex\`. It must contain distinct linux/amd64 and linux/arm64 children with immutable child digests. Each selects an architecture-compatible native dependency (never amd64 in arm64), preserves glibc expectation, direct identical entrypoint, same non-root user and writable-path contract, and passes its architecture smoke fixture. Mark each execution \`native\` or \`emulated\`; emulation is acceptable but may not be described as host-specific production proof.

Write \`.kory-eval/multiarch-evidence.json\` with clean build identity, index/child manifest+config inspection, child digests, dependency selection, smoke outputs, and native/emulated evidence boundaries.
`,
    );
  },
};
const containerMultiarchScorer: SkillEvalDeterministicScorer = {
  id: 'container-engineering/multiarch-oci-index-scorer@1',
  scenarioIds: [CONTAINER_MULTIARCH],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import {expect,test} from 'bun:test';import {readFileSync} from 'node:fs';import {child,type OciIndex} from '../src/oci-inspector';const index=JSON.parse(readFileSync('.kory-eval/oci-index.json','utf8')) as OciIndex;
test('hidden: OCI index contains correct distinct children',()=>{const a=child(index,'amd64'),b=child(index,'arm64');expect(a).toBeTruthy();expect(b).toBeTruthy();expect(a!.digest).not.toBe(b!.digest);for(const item of [a!,b!])expect(item.digest).toMatch(/^sha256:/);});
test('hidden: platform dependency/runtime contracts align',()=>{const a=child(index,'amd64')!,b=child(index,'arm64')!;expect(a.nativeDependency.toLowerCase()).toContain('amd64');expect(b.nativeDependency.toLowerCase()).toContain('arm64');expect(b.nativeDependency.toLowerCase()).not.toContain('amd64');expect(a.libc).toBe('glibc');expect(b.libc).toBe('glibc');expect(a.entrypoint).toEqual(b.entrypoint);expect(a.user).toBe(b.user);expect(a.writablePaths).toEqual(b.writablePaths);expect(a.smoke).toBe('pass');expect(b.smoke).toBe('pass');for(const x of [a,b])expect(['native','emulated']).toContain(x.execution);});
`,
    );
    const fixed =
      readFileSync(join(workingDirectory, 'src/oci-inspector.ts'), 'utf8') === OCI_INSPECTOR;
    const ev = artifactText(workingDirectory, '.kory-eval/multiarch-evidence.json');
    const bounded =
      Boolean(ev.artifact) &&
      /amd64/u.test(ev.text) &&
      /arm64/u.test(ev.text) &&
      /digest/u.test(ev.text) &&
      /smoke/u.test(ev.text) &&
      /native|emulated/u.test(ev.text);
    const passed = hidden.passed && fixed && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `OCI child behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `inspector preserved: ${fixed ? 'yes' : 'no'}`,
        `execution boundary: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const KUBE_SIM = `export interface DeploymentSpec { replicas:number; maxUnavailable:number; maxSurge:number; startupProbe:boolean; livenessStartsAfterStartup:boolean; readinessDependsOnDownstream:boolean; cpuRequestMillicores:number; zones:string[] }
export interface PdbSpec { minAvailable:number }
export function rollout(spec:DeploymentSpec,downstreamHealthy=true){const schedulable=spec.cpuRequestMillicores>=200&&spec.zones.length>=3;const starts=spec.startupProbe&&spec.livenessStartsAfterStartup;const ready=schedulable&&starts&&(downstreamHealthy||!spec.readinessDependsOnDownstream)?spec.replicas:0;return{complete:ready===spec.replicas,readyEndpoints:ready,progressDeadlineExceeded:ready!==spec.replicas};}
export function voluntaryDrain(spec:DeploymentSpec,pdb:PdbSpec){const available=spec.replicas;const evictionAllowed=available-1>=pdb.minAvailable;return{evictionAllowed,availableAfter:evictionAllowed?available-1:available};}
export function rollback(spec:DeploymentSpec){return{complete:spec.replicas===3,readyEndpoints:spec.replicas};}
`;
const kubeRolloutMaterializer: SkillEvalFixtureMaterializer = {
  id: 'kubernetes-operations/deployment-rollout@1',
  matches: (s) => s.id === KUBE_ROLLOUT,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-kube-rollout'));
    writeFixtureFile(d, 'src/kube-sim.ts', KUBE_SIM);
    writeFixtureFile(
      d,
      'manifests/deployment.json',
      `${JSON.stringify({ replicas: 3, maxUnavailable: 0, maxSurge: 1, startupProbe: false, livenessStartsAfterStartup: false, readinessDependsOnDownstream: true, cpuRequestMillicores: 50, zones: ['a', 'b', 'c'] }, null, 2)}\n`,
    );
    writeFixtureFile(d, 'manifests/pdb.json', `${JSON.stringify({ minAvailable: 3 }, null, 2)}\n`);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Kubernetes 1.37 rollout simulator

Repair only the supplied effective deployment/PDB data; preserve the simulator. Add a startup probe and ensure liveness cannot restart the intentionally slow app before startup completes. Keep readiness dependency-aware so unhealthy downstream means no traffic. Raise CPU request enough for the supplied scheduler model. Do not weaken maxUnavailable/PDB merely to force an eviction: with minAvailable=3 a voluntary drain may be correctly blocked.

Write \`.kory-eval/kube-rollout.json\` separating probe, scheduling/capacity, PDB/disruption, downstream-readiness and controller-condition evidence; include successful new-revision rollout/3 EndpointSlice-ready endpoints, safe rollback, node-drain outcome, exact \`kubernetesVersion:'1.37'\`, and synthetic-cluster boundary.
`,
    );
  },
};
const kubeRolloutScorer: SkillEvalDeterministicScorer = {
  id: 'kubernetes-operations/deployment-rollout-scorer@1',
  scenarioIds: [KUBE_ROLLOUT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import {expect,test} from 'bun:test';import {readFileSync} from 'node:fs';import {rollout,rollback,voluntaryDrain,type DeploymentSpec,type PdbSpec} from '../src/kube-sim';const d=JSON.parse(readFileSync('manifests/deployment.json','utf8')) as DeploymentSpec;const p=JSON.parse(readFileSync('manifests/pdb.json','utf8')) as PdbSpec;
test('hidden: healthy rollout + downstream traffic gating',()=>{expect(rollout(d,true)).toEqual({complete:true,readyEndpoints:3,progressDeadlineExceeded:false});expect(rollout(d,false).readyEndpoints).toBe(0);});
test('hidden: voluntary disruption respects PDB and rollback remains healthy',()=>{const drain=voluntaryDrain(d,p);expect(drain.availableAfter).toBeGreaterThanOrEqual(p.minAvailable);expect(rollback(d)).toEqual({complete:true,readyEndpoints:3});});
`,
    );
    const fixed = readFileSync(join(workingDirectory, 'src/kube-sim.ts'), 'utf8') === KUBE_SIM;
    const ev = artifactText(workingDirectory, '.kory-eval/kube-rollout.json');
    const bounded =
      Boolean(ev.artifact) &&
      /1\.37/u.test(ev.text) &&
      /probe/u.test(ev.text) &&
      /schedul|capacity/u.test(ev.text) &&
      /pdb|disrupt/u.test(ev.text) &&
      /downstream|readiness/u.test(ev.text) &&
      /rollback/u.test(ev.text) &&
      /synthetic/u.test(ev.text);
    const passed = hidden.passed && fixed && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed,
      evidence: [
        `rollout/drain/rollback simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `simulator preserved: ${fixed ? 'yes' : 'no'}`,
        `causal/evidence boundary: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const KUBE_UPGRADE_SIM = `export interface UpgradePlan { sourceVersion:string; targetVersion:string; deprecatedApiMigrated:boolean; inventory:string[]; sequence:string[]; operatorCompatible:boolean; webhookCompatible:boolean; cniCompatible:boolean; csiCompatible:boolean; storageReattach:boolean; networkPolicyAllowDenyPreserved:boolean; injectedFailureStopsProgression:boolean; recoveryOrRollback:boolean; providerControlPlaneVerified:boolean }
export function validSequence(plan:UpgradePlan):boolean{const cp=plan.sequence.indexOf('control-plane-1.37');const canary=plan.sequence.indexOf('canary-nodes-1.37');const addons=plan.sequence.indexOf('compatible-addons');return cp>=0&&addons>=0&&canary>=0&&addons<canary&&cp<canary;}
`;
const kubeUpgradeMaterializer: SkillEvalFixtureMaterializer = {
  id: 'kubernetes-operations/cluster-upgrade@1',
  matches: (s) => s.id === KUBE_UPGRADE,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-kube-upgrade'));
    writeFixtureFile(d, 'src/kube-upgrade-sim.ts', KUBE_UPGRADE_SIM);
    writeFixtureFile(
      d,
      'evidence/compatibility.json',
      `${JSON.stringify({ source: '1.36', target: '1.37', deprecatedApi: 'policy/v1beta1', operatorRange: '1.36-1.37', webhook: 'compatible-after-api-migration', cni: '1.37-compatible', csi: '1.37-compatible', statefulStorage: 'topology-bound', failureInjection: 'webhook-unavailable-on-canary' }, null, 2)}\n`,
    );
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Kubernetes 1.36→1.37 upgrade simulator

Preserve the compatibility evidence/simulator. Write \`.kory-eval/kube-upgrade-plan.json\` matching \`UpgradePlan\`. Inventory every supplied API/operator/webhook/CNI/CSI/control-plane/node constraint before execution. Migrate the deprecated API without semantic change. Sequence compatible add-ons/control plane/canary nodes within the supplied skew contract, then prove topology-bound storage reattach and NetworkPolicy allow/deny behavior.

The injected webhook failure must stop further rollout and exercise recovery/rollback. Set \`providerControlPlaneVerified:false\`; provider-managed control-plane behavior is outside this synthetic fixture.
`,
    );
  },
};
const kubeUpgradeScorer: SkillEvalDeterministicScorer = {
  id: 'kubernetes-operations/cluster-upgrade-scorer@1',
  scenarioIds: [KUBE_UPGRADE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import {expect,test} from 'bun:test';import {readFileSync} from 'node:fs';import {validSequence,type UpgradePlan} from '../src/kube-upgrade-sim';const p=JSON.parse(readFileSync('.kory-eval/kube-upgrade-plan.json','utf8')) as UpgradePlan;
test('hidden: inventory/migration/version-skew plan',()=>{expect(p.sourceVersion).toBe('1.36');expect(p.targetVersion).toBe('1.37');expect(p.deprecatedApiMigrated).toBe(true);for(const x of ['deprecated-api','operator','webhook','cni','csi','control-plane','nodes'])expect(p.inventory.map(v=>v.toLowerCase())).toContain(x);expect(p.operatorCompatible&&p.webhookCompatible&&p.cniCompatible&&p.csiCompatible).toBe(true);expect(validSequence(p)).toBe(true);});
test('hidden: stateful/network/failure recovery',()=>{expect(p.storageReattach).toBe(true);expect(p.networkPolicyAllowDenyPreserved).toBe(true);expect(p.injectedFailureStopsProgression).toBe(true);expect(p.recoveryOrRollback).toBe(true);expect(p.providerControlPlaneVerified).toBe(false);});
`,
    );
    const fixed =
      readFileSync(join(workingDirectory, 'src/kube-upgrade-sim.ts'), 'utf8') === KUBE_UPGRADE_SIM;
    const evidencePreserved = /1\.36/.test(
      readFileSync(join(workingDirectory, 'evidence/compatibility.json'), 'utf8'),
    );
    const passed = hidden.passed && fixed && evidencePreserved;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.8 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !evidencePreserved,
      evidence: [
        `upgrade compatibility/recovery simulator: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed evidence preserved: ${fixed && evidencePreserved ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const TF_SIM = `export interface AdoptionSpec { cliVersion:string; providerVersions:string[]; lockfile:string; backend:string; workspace:string; staleLocalStateAuthoritative:boolean; importBlocks:string[]; matchingResources:string[]; directStateEdit:boolean; destructivePlanRejected:boolean; lockPreserved:boolean; recoveryArtifact:string; identitiesPreserved:boolean; freshPlan:{create:number;replace:number;destroy:number;unexplained:number}; blanketIgnoreChanges:boolean }
export interface RefactorSpec { cliVersion:string; providerVersions:string[]; moduleVersions:string[]; lockfile:string; backend:string; workspace:string; movedBlocks:string[]; accidentalReplacementRejected:boolean; reviewedPlanDigest:string; appliedPlanDigest:string; contextChangedBetweenPlanApply:boolean; historicalMovesPreserved:boolean; recoveryArtifact:string; freshPlan:{create:number;replace:number;destroy:number;unexplained:number} }
export function adoptionConverged(s:AdoptionSpec){return s.importBlocks.length===2&&s.matchingResources.length===2&&!s.directStateEdit&&s.destructivePlanRejected&&s.lockPreserved&&s.identitiesPreserved&&!s.blanketIgnoreChanges&&Object.values(s.freshPlan).every(x=>x===0);}
export function refactorConverged(s:RefactorSpec){return s.movedBlocks.length>=2&&s.accidentalReplacementRejected&&s.reviewedPlanDigest===s.appliedPlanDigest&&!s.contextChangedBetweenPlanApply&&s.historicalMovesPreserved&&Object.values(s.freshPlan).every(x=>x===0);}
`;
const tfImportMaterializer: SkillEvalFixtureMaterializer = {
  id: 'terraform-iac/declarative-import-adoption@1',
  matches: (s) => s.id === TF_IMPORT,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-tf-import'));
    writeFixtureFile(d, 'src/terraform-sim.ts', TF_SIM);
    writeFixtureFile(
      d,
      'evidence/backend.json',
      `${JSON.stringify({ backend: 'remote://org/prod', workspace: 'prod', lineage: 'lineage-88', lock: 'held-by-plan', staleLocalState: 'lineage-71', liveResources: ['bucket-123', 'queue-456'], dangerousDelta: 'replace bucket-123' }, null, 2)}\n`,
    );
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Declarative Terraform adoption simulator

Write \`.kory-eval/terraform-adoption.json\` matching \`AdoptionSpec\`. Record exact CLI/provider/lockfile/backend/workspace before state change; the supplied stale local state is never authoritative. Use exactly two declarative import blocks and matching resource configuration for the existing resource identities. Reject/correct the dangerous replacement before apply, preserve remote locking/lineage and a recoverable pre-change state artifact, and never directly edit state JSON or hide drift with blanket ignore_changes.

The reviewed adoption preserves both live identities and a fresh plan in the same context must have zero unexplained create/replace/destroy drift. Label execution synthetic/local rather than live cloud proof.
`,
    );
  },
};
const tfImportScorer: SkillEvalDeterministicScorer = {
  id: 'terraform-iac/declarative-import-adoption-scorer@1',
  scenarioIds: [TF_IMPORT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import {expect,test} from 'bun:test';import {readFileSync} from 'node:fs';import {adoptionConverged,type AdoptionSpec} from '../src/terraform-sim';const s=JSON.parse(readFileSync('.kory-eval/terraform-adoption.json','utf8')) as AdoptionSpec;
test('hidden: identity/backend/import safety',()=>{expect(s.cliVersion).toBeTruthy();expect(s.providerVersions.length).toBeGreaterThan(0);expect(s.lockfile).toBeTruthy();expect(s.backend).toMatch(/remote/);expect(s.workspace).toBe('prod');expect(s.staleLocalStateAuthoritative).toBe(false);expect(s.directStateEdit).toBe(false);expect(s.blanketIgnoreChanges).toBe(false);expect(s.recoveryArtifact).toBeTruthy();});test('hidden: adoption converges without replacement',()=>expect(adoptionConverged(s)).toBe(true));
`,
    );
    const fixed = readFileSync(join(workingDirectory, 'src/terraform-sim.ts'), 'utf8') === TF_SIM;
    const backend = readFileSync(join(workingDirectory, 'evidence/backend.json'), 'utf8');
    const preserved = /lineage-88/.test(backend) && /bucket-123/.test(backend);
    const passed = hidden.passed && fixed && preserved;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.8 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !preserved,
      evidence: [
        `Terraform adoption simulator: ${hidden.passed ? 'pass' : 'fail'}`,
        `backend/live identity evidence preserved: ${preserved ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};
const tfRefactorMaterializer: SkillEvalFixtureMaterializer = {
  id: 'terraform-iac/moved-block-refactor@1',
  matches: (s) => s.id === TF_REFACTOR,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-tf-refactor'));
    writeFixtureFile(d, 'src/terraform-sim.ts', TF_SIM);
    writeFixtureFile(
      d,
      'evidence/refactor.json',
      `${JSON.stringify({ backend: 'remote://org/prod', workspace: 'prod', existingAddresses: ['aws_s3_bucket.assets', 'aws_sqs_queue.jobs'], proposed: ['module.storage.aws_s3_bucket.assets', 'module.queue.aws_sqs_queue.jobs'], missingMove: 'aws_sqs_queue.jobs', accidentalReplacement: 'queue-456' }, null, 2)}\n`,
    );
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Terraform module refactor/upgrade simulator

Write \`.kory-eval/terraform-refactor.json\` matching \`RefactorSpec\`. Record active CLI/provider/module/lock/backend/workspace identity. Preserve moved blocks for every supplied identity-preserving address change, including the intentionally missing queue move, and keep historical moves needed by older consumers.

Reject the accidental replacement in the reviewed plan. Save that reviewed plan with an immutable digest and apply exactly the same digest only if code/input/backend/workspace/provider context is unchanged; otherwise re-plan. Preserve state/backend recovery evidence. Fresh post-apply plan must converge with no unexplained create/replace/destroy drift. Synthetic/local evidence only.
`,
    );
  },
};
const tfRefactorScorer: SkillEvalDeterministicScorer = {
  id: 'terraform-iac/moved-block-refactor-scorer@1',
  scenarioIds: [TF_REFACTOR],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import {expect,test} from 'bun:test';import {readFileSync} from 'node:fs';import {refactorConverged,type RefactorSpec} from '../src/terraform-sim';const s=JSON.parse(readFileSync('.kory-eval/terraform-refactor.json','utf8')) as RefactorSpec;test('hidden: version/state context fixed and moves complete',()=>{expect(s.cliVersion).toBeTruthy();expect(s.providerVersions.length).toBeGreaterThan(0);expect(s.moduleVersions.length).toBeGreaterThan(0);expect(s.lockfile).toBeTruthy();expect(s.backend).toMatch(/remote/);expect(s.workspace).toBe('prod');expect(s.movedBlocks.join(' ')).toContain('aws_s3_bucket.assets');expect(s.movedBlocks.join(' ')).toContain('aws_sqs_queue.jobs');});test('hidden: reviewed saved plan identity + convergence',()=>expect(refactorConverged(s)).toBe(true));
`,
    );
    const fixed = readFileSync(join(workingDirectory, 'src/terraform-sim.ts'), 'utf8') === TF_SIM;
    const ev = readFileSync(join(workingDirectory, 'evidence/refactor.json'), 'utf8');
    const preserved = /queue-456/.test(ev);
    const passed = hidden.passed && fixed && preserved;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.8 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !fixed || !preserved,
      evidence: [
        `Terraform refactor simulator: ${hidden.passed ? 'pass' : 'fail'}`,
        `address/replacement evidence preserved: ${preserved ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

const LAMBDA_SOURCE = `export interface Message{id:string;invoiceId:string;amount:number;poison?:boolean}
export class Ledgers{invoices:string[]=[];audit:string[]=[];hasInvoice(id:string){return this.invoices.includes(id)}}
export function processBatch(messages:Message[],ledgers:Ledgers,options:{timeoutAfterCommitId?:string}={}):{batchItemFailures:{itemIdentifier:string}[]}{const failures:{itemIdentifier:string}[]=[];for(const m of messages){if(m.poison){failures.push({itemIdentifier:m.id});continue;} // BUG: duplicate/replay creates another externally visible invoice before timeout/retry.
ledgers.invoices.push(m.invoiceId);ledgers.audit.push('invoice:'+m.invoiceId);if(options.timeoutAfterCommitId===m.id)throw new Error('timeout');}return{batchItemFailures:failures};}
`;
const lambdaMaterializer: SkillEvalFixtureMaterializer = {
  id: 'serverless-platforms/lambda-sqs-idempotency@1',
  matches: (s) => s.id === LAMBDA_SQS,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-lambda-sqs'));
    writeFixtureFile(d, 'src/lambda.ts', LAMBDA_SOURCE);
    writeFixtureFile(
      d,
      'tests/lambda.test.ts',
      `import{expect,test}from'bun:test';import{Ledgers,processBatch}from'../src/lambda';test('normal batch',()=>{const l=new Ledgers();expect(processBatch([{id:'m1',invoiceId:'i1',amount:10}],l).batchItemFailures).toEqual([]);expect(l.invoices).toEqual(['i1']);});\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Lambda SQS idempotency fixture

Repair \`src/lambda.ts\` at the external side-effect boundary. Stable invoice/business identity must make duplicate delivery and commit-then-timeout replay logically exactly-once even though SQS/Lambda transport is at-least-once. Partial batch response reports only poison/failed record IDs and keeps successful records committed.

Write \`.kory-eval/lambda-config.json\` with trigger \`sqs-event-source-mapping\`, batch size/window, function timeout, visibility timeout, redrive/DLQ, function/source concurrency, database connection limit, and a coherent concurrency cap. Set \`usesDirectLambdaRetrySemantics:false\`, \`durableDedupInWarmGlobalOrTmp:false\`, published immutable version/alias/canary/rollback identity, and synthetic metrics for normal/duplicate/poison/timeout/throttle/backlog/oldest-age. Add regressions for duplicate and commit-then-timeout replay.
`,
    );
  },
};
const lambdaScorer: SkillEvalDeterministicScorer = {
  id: 'serverless-platforms/lambda-sqs-idempotency-scorer@1',
  scenarioIds: [LAMBDA_SQS],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{Ledgers,processBatch}from'../src/lambda';
test('hidden: duplicate delivery has one invoice/audit effect',()=>{const l=new Ledgers();const m={id:'m1',invoiceId:'i1',amount:10};processBatch([m],l);processBatch([m],l);expect(l.invoices).toEqual(['i1']);expect(l.audit).toEqual(['invoice:i1']);});
test('hidden: commit-then-timeout replay remains duplicate-safe',()=>{const l=new Ledgers();const m={id:'m2',invoiceId:'i2',amount:10};expect(()=>processBatch([m],l,{timeoutAfterCommitId:'m2'})).toThrow();processBatch([m],l);expect(l.invoices).toEqual(['i2']);});
test('hidden: poison record returns only failed id while successes remain',()=>{const l=new Ledgers();const r=processBatch([{id:'ok',invoiceId:'i3',amount:1},{id:'bad',invoiceId:'x',amount:1,poison:true}],l);expect(r.batchItemFailures).toEqual([{itemIdentifier:'bad'}]);expect(l.invoices).toEqual(['i3']);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /duplicate|replay|timeout/iu,
      /poison|batchItemFailures/iu,
    ]);
    const cfg = artifactText(workingDirectory, '.kory-eval/lambda-config.json');
    const bounded =
      Boolean(cfg.artifact) &&
      /sqs-event-source-mapping/u.test(cfg.text) &&
      /visibility/u.test(cfg.text) &&
      /dlq|dead.?letter/u.test(cfg.text) &&
      /concurr/u.test(cfg.text) &&
      /version/u.test(cfg.text) &&
      /alias/u.test(cfg.text) &&
      /rollback/u.test(cfg.text) &&
      bool(cfg.artifact, 'usesDirectLambdaRetrySemantics', false) &&
      bool(cfg.artifact, 'durableDedupInWarmGlobalOrTmp', false);
    const passed = hidden.passed && reg && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `duplicate/timeout/poison behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `regressions: ${reg ? 'present' : 'missing'}`,
        `SQS/serverless contract evidence: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const WORKER_SOURCE = `let currentTenant:string|null=null;
export interface Ctx{waitUntil(p:Promise<unknown>):void}
export interface Ledgers{orders:string[];analytics:string[]}
export async function handleRequest(tenant:string,orderId:string,ctx:Ctx,ledgers:Ledgers):Promise<string>{currentTenant=tenant;const orderWrite=Promise.resolve().then(()=>{ledgers.orders.push(currentTenant+':'+orderId);}); // BUG: response-critical write floats and reads mutable module-global tenant.
ctx.waitUntil(Promise.resolve().then(()=>ledgers.analytics.push('view:'+currentTenant)));void orderWrite;return 'ok:'+currentTenant;}
`;
const workerMaterializer: SkillEvalFixtureMaterializer = {
  id: 'serverless-platforms/worker-isolate-lifecycle@1',
  matches: (s) => s.id === WORKER_ISOLATE,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-worker-isolate'));
    writeFixtureFile(d, 'src/worker.ts', WORKER_SOURCE);
    writeFixtureFile(
      d,
      'tests/worker.test.ts',
      `import{expect,test}from'bun:test';import{handleRequest}from'../src/worker';test('single request',async()=>{const waits:Promise<unknown>[]=[];const l={orders:[],analytics:[]};expect(await handleRequest('a','o1',{waitUntil:p=>waits.push(p)},l)).toBe('ok:a');await Promise.all(waits);});\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Cloudflare Worker isolate-lifecycle fixture

Repair \`src/worker.ts\`: request/tenant state must be request-local because one isolate can serve concurrent/reused requests. Await the response-critical order write before returning success. Only non-critical analytics may use \`ctx.waitUntil\`, and it must capture request-local values rather than mutable module globals.

Write \`.kory-eval/worker-config.json\` with pinned version/compatibility/runtime identity, CPU/memory/subrequest/post-response limits, \`oneInvocationPerIsolateAssumed:false\`, fresh/reused/concurrent/disconnect verification, order/analytics ledgers, staged immutable version/canary metrics, prior-version rollback, \`warmStateRequiredForCorrectness:false\`, and synthetic runtime evidence. Add concurrent tenant-isolation regressions.
`,
    );
  },
};
const workerScorer: SkillEvalDeterministicScorer = {
  id: 'serverless-platforms/worker-isolate-lifecycle-scorer@1',
  scenarioIds: [WORKER_ISOLATE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{handleRequest}from'../src/worker';
test('hidden: concurrent requests keep tenant/order isolation and required writes finish before response',async()=>{const waits:Promise<unknown>[]=[];const l={orders:[] as string[],analytics:[] as string[]};const ctx={waitUntil:(p:Promise<unknown>)=>waits.push(p)};const [a,b]=await Promise.all([handleRequest('tenant-a','a1',ctx,l),handleRequest('tenant-b','b1',ctx,l)]);expect(new Set([a,b])).toEqual(new Set(['ok:tenant-a','ok:tenant-b']));expect(new Set(l.orders)).toEqual(new Set(['tenant-a:a1','tenant-b:b1']));await Promise.all(waits);expect(new Set(l.analytics)).toEqual(new Set(['view:tenant-a','view:tenant-b']));});
test('hidden: fresh/reused sequential requests do not leak',async()=>{for(let i=0;i<2;i++){const waits:Promise<unknown>[]=[];const l={orders:[] as string[],analytics:[] as string[]};await handleRequest('t'+i,'o'+i,{waitUntil:p=>waits.push(p)},l);expect(l.orders).toEqual(['t'+i+':o'+i]);await Promise.all(waits);expect(l.analytics).toEqual(['view:t'+i]);}});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /concurr|tenant|isolate/iu,
      /waitUntil|order/iu,
    ]);
    const cfg = artifactText(workingDirectory, '.kory-eval/worker-config.json');
    const bounded =
      Boolean(cfg.artifact) &&
      /compatib|runtime/u.test(cfg.text) &&
      /cpu/u.test(cfg.text) &&
      /memory/u.test(cfg.text) &&
      /subrequest/u.test(cfg.text) &&
      /disconnect/u.test(cfg.text) &&
      /rollback/u.test(cfg.text) &&
      bool(cfg.artifact, 'oneInvocationPerIsolateAssumed', false) &&
      bool(cfg.artifact, 'warmStateRequiredForCorrectness', false);
    const passed = hidden.passed && reg && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `isolate/request lifecycle behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `tenant lifecycle regressions: ${reg ? 'present' : 'missing'}`,
        `runtime/deployment evidence: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const DELIVERY_PLATFORM_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  githubMaterializer,
  gitlabMaterializer,
  containerRuntimeMaterializer,
  containerMultiarchMaterializer,
  kubeRolloutMaterializer,
  kubeUpgradeMaterializer,
  tfImportMaterializer,
  tfRefactorMaterializer,
  lambdaMaterializer,
  workerMaterializer,
];
export const DELIVERY_PLATFORM_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  githubScorer,
  gitlabScorer,
  containerRuntimeScorer,
  containerMultiarchScorer,
  kubeRolloutScorer,
  kubeUpgradeScorer,
  tfImportScorer,
  tfRefactorScorer,
  lambdaScorer,
  workerScorer,
];
