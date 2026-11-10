import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { anonymousArtifact } from './blind-review-import-validation';
import { buildBlindReviewJudgePrompt } from '../backend/src/kory/skill-eval-blind-review';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalizePath, isContainedBy } from '../backend/src/runtime/platform';
import { NATIVE_REVIEW_SYSTEM_PROMPT, NATIVE_REVIEW_VERSION } from './kory-native-stateless-reviewer.ts';
import { nativeMacStageProfile } from './native-reviewer-sandbox';
import { readProtectedNativeReference, requireNativeStageOptIn, retainNativeBlindReviewEvidence, verifyNativeBlindReviewImport } from './blind-review-native-import';
import { createIsolatedTestEnvironment } from './test-backend-isolated';

const roots: string[] = [];
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(passed = true) {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), 'blind-native-import-test-'))); roots.push(root);
  const stageRoot = join(root, 'stage'); const archiveRoot = join(stageRoot, 'archive'); const repository = join(root, 'repository'); const credentials = join(root, 'credentials'); const durable = join(root, 'durable');
  for (const path of [stageRoot, archiveRoot, repository, credentials, durable]) mkdirSync(path, { mode: 0o700 });
  const privateRoot = `${root}-deleted-native-private-home`;
  const model = 'gpt-6.1-sol'; const reviewer = { agentId: 'native-cli:fixture-session', model };
  const score = { passed, quality: passed ? 0.9 : 0.2, verification: passed ? 0.9 : 0.2, integrityFailure: false, evidence: ['Fixture evidence'] };
  const output = JSON.stringify({ artifactA: score, artifactB: score, preference: 'tie', rationale: ['Fixture adjudication'] });
  const prompt = 'An actually sealed anonymous fixture prompt';
  const request = JSON.stringify({ system: NATIVE_REVIEW_SYSTEM_PROMPT, prompt, model });
  const eventList = [
    { type: 'system', subtype: 'init', session_id: 'fixture-session', model, tools: [], mcp_servers: [], skills: [] },
    { type: 'assistant', session_id: 'fixture-session', message: { role: 'assistant', content: [{ type: 'text', text: output }], stop_reason: 'end_turn' } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'fixture-session', result: output },
  ];
  const rawBytes = Buffer.from(`${eventList.map(event => JSON.stringify(event)).join('\n')}\n`);
  const save = (path: string, bytes: string | Buffer, mode = 0o600) => {
    writeFileSync(path, bytes, { mode }); const buffer = Buffer.from(bytes);
    return { path, sha256: sha(buffer), bytes: buffer.length };
  };
  const rawRef = save(join(archiveRoot, 'native-cli-events.jsonl'), rawBytes);
  const profile = nativeMacStageProfile(privateRoot, ['/Users', '/Volumes', '/private/var/folders', '/private/tmp']);
  const profileRef = save(join(archiveRoot, 'native-kernel-profile.sb'), profile);
  const sealRef = save(join(stageRoot, 'review-task.prompt.txt'), prompt, 0o400);
  const receipt: any = {
    schemaVersion: 1, stageOnly: true, identitySource: 'host-observed-native-cli-session-id', runtimeVersion: NATIVE_REVIEW_VERSION,
    requestedModel: model, observedModel: model, boundary: 'native-no-tools-bare-restricted-explicit-stdin', tools: [], mcpServers: [], skills: [],
    promptSha256: sha(prompt), systemPromptSha256: sha(NATIVE_REVIEW_SYSTEM_PROMPT), requestSerialization: 'host-declared-system-prompt-model-not-upstream-wire',
    requestBytes: Buffer.byteLength(request), requestSha256: sha(request), responseBytes: rawBytes.length, responseSha256: sha(rawBytes), outputSha256: sha(output),
    rawEventArchive: rawRef, osIsolationVerified: false, upstreamIdentityVerified: false, upstreamCancellationAcknowledged: false, signed: false,
    kernelStage: {
      mode: 'macos-private-roots', enforcement: 'sandbox-exec', readPolicy: 'broad-runtime-reads-with-explicit-canonical-private-root-denies',
      privateRoot, readDenyRoots: ['/Users', '/Volumes', '/private/var/folders', '/private/tmp'], protectedRoots: [stageRoot, archiveRoot, repository, credentials],
      profileSha256: profileRef.sha256, profileArchive: profileRef, writableRoots: [privateRoot], writableDevice: '/dev/null', universalReadAllowlist: false,
    },
  };
  const completion: any = { schemaVersion: 1, reviewerId: reviewer.agentId, completed: true, output, events: [{ type: 'review.started', reviewerId: reviewer.agentId }, { type: 'review.completed', reviewerId: reviewer.agentId, outputSha256: sha(output) }], hostReceipt: receipt };
  const hostRef = save(join(stageRoot, 'reviewer-events.json'), JSON.stringify(completion));
  const stage: any = { schemaVersion: 1, stageOnly: true, rawEvents: rawRef, hostReceipt: hostRef, sealedPrompt: sealRef, kernelProfile: profileRef };
  const input = { stage, reviewer, output, promptSha256: sha(prompt), requiredProtectedRoots: [repository, credentials] };
  function updateReceipt() { stage.hostReceipt = save(hostRef.path, JSON.stringify(completion)); }
  function updateRaw(events: unknown[]) {
    const bytes = `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
    const ref = save(rawRef.path, bytes); stage.rawEvents = ref; receipt.rawEventArchive = ref; receipt.responseSha256 = ref.sha256; receipt.responseBytes = ref.bytes; updateReceipt();
  }
  return { root, stageRoot, archiveRoot, durable, credentials, repository, privateRoot, model, output, input, stage, receipt, completion, eventList, updateReceipt, updateRaw, save };
}

test.each([true, false])('fresh archived native %s adjudication qualifies narrowly and retains exact protected durable evidence', passed => {
  const f = fixture(passed); const verified = verifyNativeBlindReviewImport(f.input);
  expect(verified.provenance).toMatchObject({ sessionId: 'fixture-session', runtimeVersion: NATIVE_REVIEW_VERSION, model: f.model, signed: false, upstreamIdentityVerified: false, universalReadAllowlist: false });
  const envelope = Buffer.from(JSON.stringify({ schemaVersion: 1, reviewer: f.input.reviewer, nativeStageEvidence: f.stage, reviews: [{ assignmentId: 'fixture', output: f.output }] }));
  const artifacts = retainNativeBlindReviewEvidence(f.durable, verified, envelope, Buffer.from('{"fixturePrepared":true}'));
  expect(artifacts).toHaveLength(7);
  for (const artifact of artifacts) {
    expect(lstatSync(artifact.location).mode & 0o777).toBe(0o600);
    expect(lstatSync(dirname(artifact.location)).mode & 0o777).toBe(0o700);
    expect(sha(readFileSync(artifact.location))).toBe(artifact.sha256);
  }
  expect(readFileSync(artifacts[0]!.location)).toEqual(readFileSync(f.stage.rawEvents.path));
  expect(readFileSync(artifacts.find(item => item.location.endsWith('import.json'))!.location)).toEqual(envelope);
  rmSync(f.stageRoot, { recursive: true });
  expect(artifacts.every(item => existsSync(item.location))).toBe(true);
});

test('legacy nonnative opt-in behaviour is unchanged; old native stages fail even when explicitly validating', () => {
  expect(requireNativeStageOptIn({ reviewer: { agentId: 'legacy-reviewer' }, reviews: [{}] }, false)).toBe(false);
  const old = { reviewer: { agentId: 'native-cli:old' }, reviews: [{}] };
  expect(() => requireNativeStageOptIn(old, false)).toThrow('old unarchived');
  expect(() => requireNativeStageOptIn(old, true)).toThrow('old unarchived');
});

test.each([false, true])('native provider label cannot bypass archived stage qualification with a nonnative agent ID (opt-in %s)', allowed => {
  expect(() => requireNativeStageOptIn({ reviewer: { agentId: 'renamed-session', provider: 'native-cli' }, reviews: [{}] }, allowed)).toThrow('old unarchived');
});

test('fresh native refs do not enable ingestion automatically or permit multiple assignments per session', () => {
  const f = fixture(); const envelope = { nativeStageEvidence: f.stage, reviewer: f.input.reviewer, reviews: [{}] };
  expect(() => requireNativeStageOptIn(envelope, false)).toThrow('--allow-native-stage');
  expect(requireNativeStageOptIn(envelope, true)).toBe(true);
  expect(() => requireNativeStageOptIn({ ...envelope, reviews: [{}, {}] }, true)).toThrow('require');
});

test.each(['rawEvents', 'hostReceipt', 'sealedPrompt', 'kernelProfile'])('missing %s ref never qualifies even if receipt is complete', key => {
  const f = fixture(); delete f.stage[key];
  expect(() => verifyNativeBlindReviewImport(f.input)).toThrow();
});

test.each(['rawEvents', 'hostReceipt', 'sealedPrompt', 'kernelProfile'])('forged %s digest or stale bytes fail closed', key => {
  const f = fixture(); f.stage[key].sha256 = '0'.repeat(64);
  expect(() => verifyNativeBlindReviewImport(f.input)).toThrow();
});

test.each(['rawEvents', 'hostReceipt', 'sealedPrompt', 'kernelProfile'])('symlink %s refs are rejected instead of resolving through target', key => {
  const f = fixture(); const path = f.stage[key].path; const target = `${path}.target`; const bytes = readFileSync(path);
  writeFileSync(target, bytes, { mode: 0o600 }); rmSync(path); symlinkSync(target, path);
  expect(() => verifyNativeBlindReviewImport(f.input)).toThrow();
});

test.each(['mode', 'hardlink', 'parent-mode', 'parent-link', 'size', 'oversize'])('protected bounded raw file enforces %s', mutation => {
  const f = fixture(); const ref = f.stage.rawEvents;
  if (mutation === 'mode') chmodSync(ref.path, 0o644);
  if (mutation === 'hardlink') linkSync(ref.path, join(f.archiveRoot, 'extra-link'));
  if (mutation === 'parent-mode') chmodSync(f.archiveRoot, 0o755);
  if (mutation === 'parent-link') { const alias = join(f.stageRoot, 'archive-alias'); symlinkSync(f.archiveRoot, alias); ref.path = join(alias, 'native-cli-events.jsonl'); }
  if (mutation === 'size') ref.bytes += 1;
  if (mutation === 'oversize') ref.bytes = 1_048_577;
  expect(() => readProtectedNativeReference(ref, 1_048_576)).toThrow();
});

test.each(['requestedModel', 'observedModel', 'runtimeVersion', 'promptSha256', 'systemPromptSha256', 'requestSha256', 'requestBytes', 'requestSerialization', 'responseSha256', 'responseBytes', 'outputSha256', 'boundary', 'signed', 'upstreamIdentityVerified', 'osIsolationVerified', 'tools', 'mcpServers', 'skills'])('receipt %s cannot substitute for actual request/session evidence', key => {
  const f = fixture(); const actual = f.receipt[key];
  f.receipt[key] = Array.isArray(actual) ? ['forged-tool'] : typeof actual === 'boolean' ? !actual : typeof actual === 'number' ? actual + 1 : 'forged';
  f.updateReceipt(); expect(() => verifyNativeBlindReviewImport(f.input)).toThrow();
});

test.each(['tool-init', 'wrong-model', 'session', 'missing-result', 'tool-call', 'output', 'duplicate-result', 'extra-init'])('independently parses actual raw stream and rejects %s', mutation => {
  const f = fixture(); const events: any[] = structuredClone(f.eventList);
  if (mutation === 'tool-init') events[0].tools = ['Read'];
  if (mutation === 'wrong-model') events[0].model = 'other';
  if (mutation === 'session') events[1].session_id = 'foreign';
  if (mutation === 'missing-result') events.pop();
  if (mutation === 'tool-call') events[1].message.content = [{ type: 'tool_use', name: 'Read', input: {} }];
  if (mutation === 'output') { events[1].message.content[0].text = 'different'; events[2].result = 'different'; }
  if (mutation === 'duplicate-result') events.push(events[2]);
  if (mutation === 'extra-init') events.splice(1, 0, events[0]);
  f.updateRaw(events); expect(() => verifyNativeBlindReviewImport(f.input)).toThrow();
});

test.each(['identity', 'output-newline', 'event-hash', 'completed', 'archive-ref'])('host completion %s remains bound to stream, not convention', mutation => {
  const f = fixture();
  if (mutation === 'identity') f.completion.reviewerId = 'native-cli:forged';
  if (mutation === 'output-newline') f.input.output += '\n';
  if (mutation === 'event-hash') f.completion.events[1].outputSha256 = '0'.repeat(64);
  if (mutation === 'completed') f.completion.completed = false;
  if (mutation === 'archive-ref') f.receipt.rawEventArchive = { ...f.stage.rawEvents, path: `${f.stage.rawEvents.path}.stale` };
  f.updateReceipt(); expect(() => verifyNativeBlindReviewImport(f.input)).toThrow();
});

test.each(['missing-profile', 'none-mode', 'profile-ref', 'profile-bytes', 'universal', 'write-root', 'read-policy', 'unprotected-credentials', 'unprotected-stage', 'allow-private-read', 'canonical-alias'])('kernel boundary fails closed for %s', mutation => {
  const f = fixture(); const k = f.receipt.kernelStage;
  if (mutation === 'missing-profile') delete k.profileArchive;
  if (mutation === 'none-mode') k.mode = 'none';
  if (mutation === 'profile-ref') k.profileArchive = { ...f.stage.kernelProfile, sha256: '0'.repeat(64) };
  if (mutation === 'profile-bytes') { const ref = f.save(f.stage.kernelProfile.path, `${readFileSync(f.stage.kernelProfile.path, 'utf8')}\n(allow file-read*)`); f.stage.kernelProfile = ref; k.profileArchive = ref; k.profileSha256 = ref.sha256; }
  if (mutation === 'universal') k.universalReadAllowlist = true;
  if (mutation === 'write-root') k.writableRoots.push(f.repository);
  if (mutation === 'read-policy') k.readPolicy = 'all-read';
  if (mutation === 'unprotected-credentials') k.protectedRoots = k.protectedRoots.filter((root: string) => root !== f.credentials);
  if (mutation === 'unprotected-stage') k.protectedRoots = k.protectedRoots.filter((root: string) => root !== f.stageRoot);
  if (mutation === 'allow-private-read') k.privateRoot = f.stageRoot;
  if (mutation === 'canonical-alias') k.readDenyRoots[3] = '/tmp';
  f.updateReceipt(); expect(() => verifyNativeBlindReviewImport(f.input)).toThrow();
});

test('stale sealed prompt hashes cannot be requalified by updating only the unsigned receipt', () => {
  const f = fixture(); chmodSync(f.stage.sealedPrompt.path, 0o600);
  f.stage.sealedPrompt = f.save(f.stage.sealedPrompt.path, 'changed sealed prompt'); f.receipt.promptSha256 = f.stage.sealedPrompt.sha256; f.updateReceipt();
  expect(() => verifyNativeBlindReviewImport(f.input)).toThrow();
});

test('native validation is read-only and retains nothing until explicit successful ingestion', () => {
  const f = fixture(); verifyNativeBlindReviewImport(f.input);
  expect(lstatSync(f.durable).isDirectory()).toBe(true);
  expect(readdirSync(f.durable)).toEqual([]);
  const before = readFileSync(f.stage.rawEvents.path); verifyNativeBlindReviewImport(f.input);
  expect(readFileSync(f.stage.rawEvents.path)).toEqual(before);
});

test.each(['root-link', 'root-mode', 'empty-prepared', 'oversize-prepared', 'forged-file-digest', 'extra-file'])('durable retention rejects %s before creating evidence', mutation => {
  const f = fixture(); const verified = verifyNativeBlindReviewImport(f.input);
  let root = f.durable; let prepared = Buffer.from('{}');
  if (mutation === 'root-link') { root = join(f.root, 'durable-alias'); symlinkSync(f.durable, root); }
  if (mutation === 'root-mode') chmodSync(root, 0o755);
  if (mutation === 'empty-prepared') prepared = Buffer.alloc(0);
  if (mutation === 'oversize-prepared') prepared = Buffer.alloc(2_097_153);
  if (mutation === 'forged-file-digest') verified.files[0]!.sha256 = '0'.repeat(64);
  if (mutation === 'extra-file') verified.files.push({ name: '../escape', bytes: Buffer.from('x'), sha256: sha('x') });
  expect(() => retainNativeBlindReviewEvidence(root, verified, Buffer.from('{}'), prepared)).toThrow();
  expect(readdirSync(f.durable)).toEqual([]);
});

test.each(['stage-extra-key', 'ref-extra-key', 'duplicate-output-key'])('native approved schema rejects ambiguous %s evidence', mutation => {
  const f = fixture();
  if (mutation === 'stage-extra-key') f.stage.claimedUpstreamAttestation = true;
  if (mutation === 'ref-extra-key') f.stage.rawEvents.claimedSigned = true;
  if (mutation === 'duplicate-output-key') f.input.output = f.output.replace('"preference":"tie"', '"preference":"A","preference":"tie"');
  expect(() => verifyNativeBlindReviewImport(f.input)).toThrow('Invalid reviewer JSON');
});

// Execute the real importer against an isolated ledger/package boundary. No
// actual repository evaluations are loaded, ingested, or changed by these tests.
function importerHarness(sourceEnv: NodeJS.ProcessEnv = process.env) {
  const f = fixture();
  const childHome = join(f.root, 'import-home');
  // The host test process can have missing or unrelated HOME-relative paths.
  // Stage authority must bind the actual mock importer's private environment,
  // never inherit ambient credentials or rely on an earlier test seeding it.
  const { KORY_DOCKER_HOST: _unusedDockerHost, ...runtimeEnv } = sourceEnv;
  const childEnv = createIsolatedTestEnvironment({ ...runtimeEnv, KORY_RUN_LIVE_PROVIDER_TESTS: '0' }, childHome);
  childEnv.CLAUDE_CONFIG_DIR = join(childHome, '.claude');
  for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'KORYPHAIOS_DATA_DIR', 'KORYPHAIOS_SKILLS_HOME',
    'KORYPHAIOS_WORKFLOWS_HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA', 'PROJECT_ROOT', 'LOG_DIR']) {
    mkdirSync(childEnv[key]!, { recursive: true, mode: 0o700 });
  }
  const skill = 'fixture-skill';
  const task = { id: 'scenario-fixture', falsifiableChecks: [], requiredEvidence: [], requiredArtifacts: [] };
  const armRoot = join(f.root, 'arms'); mkdirSync(armRoot);
  const arms = ['with-skill', 'without-skill'].map(variant => {
    const root = join(armRoot, variant); mkdirSync(root);
    const manifestPath = join(root, 'run-manifest.json'); const outputPath = join(root, 'final-output.txt');
    writeFileSync(manifestPath, JSON.stringify({ changes: [], evidence: [] })); writeFileSync(outputPath, 'Fixture task output');
    return { id: variant, skill, revisionHash: 'fixture-revision', caseId: task.id, scenarioId: task.id, comparisonId: 'fixture-pair', provider: 'fixture-source', model: 'fixture-source-model', harnessVersion: 'fixture-execution', evaluator: 'deterministic', protocolVersion: 3, variant, caseCategory: 'full-task', evaluationContractHash: 'fixture-contract', evaluationContractVersion: 3, materializerId: 'fixture', deterministicScorerId: 'fixture', passed: true, quality: 1, verification: 1, integrityFailure: false, role: 'worker', evidence: [], recordedAt: '2026-10-01T00:00:00.000Z', artifacts: [{ kind: 'report', location: manifestPath, sha256: sha(readFileSync(manifestPath)) }, { kind: 'report', location: outputPath, sha256: sha(readFileSync(outputPath)) }] };
  });
  const packages = [{ sidecar: { name: skill, version: '1' }, evaluation: { tasks: [task] } }];
  const dataPath = join(f.root, 'fixture.json'); writeFileSync(dataPath, JSON.stringify({ arms, packages }));
  const persisted = join(f.root, 'isolated-recorded-runs.json');
  const loaderPath = join(f.root, 'importer-loader.ts');
  writeFileSync(loaderPath, `import { mock } from 'bun:test';\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst data = JSON.parse(readFileSync(process.env.BLIND_TEST_DATA!, 'utf8'));\nmock.module(${JSON.stringify(resolve(import.meta.dir, '../backend/src/kory/skill-evaluations.ts'))}, () => ({ CURRENT_SKILL_EVAL_CONTRACT_VERSION: 3, listSkillEvaluationRuns: () => data.arms, recordSkillEvaluationRuns: (_root: string, rows: unknown) => writeFileSync(process.env.BLIND_TEST_RECORDED!, JSON.stringify(rows)) }));\nmock.module(${JSON.stringify(resolve(import.meta.dir, '../backend/src/kory/skill-packages.ts'))}, () => ({ loadV5SkillPackages: () => ({ packages: data.packages }) }));\nmock.module(${JSON.stringify(resolve(import.meta.dir, '../backend/src/kory/skills.ts'))}, () => ({ listSkills: () => [{ name: 'fixture-skill', state: 'active', validation: { valid: true }, hash: 'fixture-revision' }] }));\nmock.module(${JSON.stringify(resolve(import.meta.dir, '../backend/src/kory/skill-stewards.ts'))}, () => ({ getSkillSteward: () => ({ agentId: 'fixture-steward' }), buildSkillStewardDisplayLabel: () => 'Fixture reviewer' }));\nmock.module(${JSON.stringify(resolve(import.meta.dir, '../backend/src/kory/skill-eval-fixtures.ts'))}, () => ({ BUILTIN_SKILL_EVAL_MATERIALIZERS: [{ id: 'fixture', matches: (scenario: any) => scenario.skill === 'fixture-skill' && scenario.category === 'full-task' && scenario.expectedSelection === true && Array.isArray(scenario.expectedSkills) && Array.isArray(scenario.forbiddenSkills) && scenario.heldOut === true }], BUILTIN_SKILL_EVAL_SCORERS: [{ id: 'fixture', scenarioIds: ['scenario-fixture'] }] }));\nmock.module(${JSON.stringify(resolve(import.meta.dir, '../backend/src/kory/skill-eval-contract-hash.ts'))}, () => ({ skillEvaluationV5ContractHash: () => 'fixture-contract' }));\nlet source = readFileSync(${JSON.stringify(resolve(import.meta.dir, 'run-skill-v5-blind-review.ts'))}, 'utf8');\nsource = source.replace("const projectRoot = resolve(import.meta.dir, '..');", 'const projectRoot = ' + JSON.stringify(process.env.BLIND_TEST_ROOT) + ';');\nsource = source.replace(/from '(\\.[^']+)'/g, (_match, relative) => 'from ' + JSON.stringify(new URL(relative.endsWith('.ts') ? relative : relative + '.ts', ${JSON.stringify(new URL('./', import.meta.url).href)}).pathname));\nconst target = process.env.BLIND_TEST_ROOT + '/isolated-importer.ts';\nwriteFileSync(target, source);\nawait import(target);\n`);
  const nativeProtected = [f.root, ...['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'KORYPHAIOS_DATA_DIR', 'KORYPHAIOS_SKILLS_HOME']
    .map(key => canonicalizePath(childEnv[key]!))];
  f.receipt.kernelStage.protectedRoots = [...new Set([...f.receipt.kernelStage.protectedRoots, ...nativeProtected])];
  f.updateReceipt();
  const assignmentId = 'fixture-assignment';
  const pending = join(f.root, '.koryphaios', 'skills', 'blind-reviews', 'pending'); mkdirSync(pending, { recursive: true, mode: 0o700 });
  const promptPath = join(pending, `${assignmentId}.prompt.txt`);
  const artifactA = anonymousArtifact(arms[0] as any, skill); const artifactB = anonymousArtifact(arms[1] as any, skill);
  const prompt = buildBlindReviewJudgePrompt({ task: task as any, artifactA, artifactB, pairEvidence: {
    matchedPair: true, sameScenario: true, sameProviderModel: true, sameHarness: true, sameEvaluationContract: true,
    sameMaterializer: true, sameDeterministicScorer: true, randomizedArmIdentity: true, evidenceOwner: 'evaluation-harness',
  } });
  writeFileSync(promptPath, prompt, { mode: 0o600 });
  chmodSync(f.stage.sealedPrompt.path, 0o600);
  f.stage.sealedPrompt = f.save(f.stage.sealedPrompt.path, prompt);
  f.input.promptSha256 = sha(prompt); f.receipt.promptSha256 = sha(prompt);
  const request = JSON.stringify({ system: NATIVE_REVIEW_SYSTEM_PROMPT, prompt, model: f.model });
  f.receipt.requestBytes = Buffer.byteLength(request); f.receipt.requestSha256 = sha(request); f.updateReceipt();
  const prepared: any = { schemaVersion: 3, assignmentId, skill, scenarioId: task.id, pairId: 'fixture-pair', revisionHash: 'fixture-revision', evaluationContractHash: 'fixture-contract', evaluationContractVersion: 3, materializerId: 'fixture', deterministicScorerId: 'fixture', withIsA: true, promptSha256: sha(readFileSync(promptPath)), artifactASha256: sha(JSON.stringify(artifactA)), artifactBSha256: sha(JSON.stringify(artifactB)), promptPath };
  const preparedPath = join(pending, `${assignmentId}.private.json`); writeFileSync(preparedPath, JSON.stringify(prepared), { mode: 0o600 });
  const envelope: any = { schemaVersion: 1, reviewer: { ...f.input.reviewer, provider: 'native-cli' }, nativeStageEvidence: f.stage, reviews: [{ assignmentId, output: f.output }] };
  const envelopePath = join(f.stageRoot, 'import.json');
  const run = (mode = 'validate-only', allowed = true) => {
    writeFileSync(preparedPath, JSON.stringify(prepared), { mode: 0o600 }); writeFileSync(envelopePath, JSON.stringify(envelope), { mode: 0o600 });
    return spawnSync(process.execPath, [loaderPath, mode === 'prepare-only' ? '--prepare-only' : `--${mode}=${envelopePath}`, ...(allowed ? ['--allow-native-stage'] : [])], { encoding: 'utf8', timeout: 10_000, env: { ...childEnv, BLIND_TEST_ROOT: f.root, BLIND_TEST_DATA: dataPath, BLIND_TEST_RECORDED: persisted } });
  };
  return { f, run, envelope, prepared, persisted, dataPath, pending, childEnv };
}

test('mock importer creates its own protected child roots when ambient HOME and skills directories do not exist', () => {
  const ambientRoot = canonicalizePath(mkdtempSync(join(tmpdir(), 'blind-native-ambient-test-'))); roots.push(ambientRoot);
  const keys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'KORYPHAIOS_DATA_DIR', 'KORYPHAIOS_SKILLS_HOME'];
  const sourceEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of keys) sourceEnv[key] = join(ambientRoot, `missing-${key}`);
  const h = importerHarness(sourceEnv);
  for (const key of keys) {
    expect(existsSync(sourceEnv[key]!)).toBe(false);
    expect(h.childEnv[key]).not.toBe(sourceEnv[key]);
    expect(isContainedBy(h.f.root, h.childEnv[key]!)).toBe(true);
    expect(lstatSync(h.childEnv[key]!).mode & 0o777).toBe(0o700);
    expect(h.f.receipt.kernelStage.protectedRoots).toContain(canonicalizePath(h.childEnv[key]!));
  }
  const validated = h.run(); expect(validated.stderr).toBe(''); expect(validated.status).toBe(0);
  expect(JSON.parse(validated.stdout)).toMatchObject({ validatedReviews: 1, persistedReviews: 0 });
  expect(existsSync(h.persisted)).toBe(false);
});

test('mock importer binds actual private child HOME instead of unrelated ambient roots or live credentials', () => {
  const h = importerHarness({ ...process.env, HOME: '/', USERPROFILE: '/', CLAUDE_CONFIG_DIR: '/',
    KORYPHAIOS_DATA_DIR: '/', KORYPHAIOS_SKILLS_HOME: '/', KORY_RUN_LIVE_PROVIDER_TESTS: '1',
    OPENAI_API_KEY: 'not-live-fixture-key', ANTHROPIC_API_KEY: 'not-live-fixture-key' });
  expect(h.childEnv.HOME).toBe(join(h.f.root, 'import-home'));
  expect(h.childEnv.KORY_RUN_LIVE_PROVIDER_TESTS).toBe('0');
  expect(h.childEnv.OPENAI_API_KEY).toBeUndefined(); expect(h.childEnv.ANTHROPIC_API_KEY).toBeUndefined();
  expect(h.f.receipt.kernelStage.protectedRoots).not.toContain('/');
  const validated = h.run(); expect(validated.stderr).toBe(''); expect(validated.status).toBe(0);
  expect(JSON.parse(validated.stdout)).toMatchObject({ validatedReviews: 1, persistedReviews: 0 });
  expect(existsSync(h.persisted)).toBe(false);
});

test('preparation adds generic hash domains only to new seals and never changes existing same-ID bytes', () => {
  const h = importerHarness(); const first = h.run('prepare-only'); expect(first.status).toBe(0);
  const assignments = JSON.parse(first.stdout).preparedAssignments; expect(assignments).toHaveLength(1);
  const prepared = JSON.parse(readFileSync(join(h.pending, `${assignments[0].assignmentId}.private.json`), 'utf8'));
  expect(readFileSync(prepared.promptPath, 'utf8')).toContain('SNAPSHOT HASH DOMAINS');
  const historicalPrompt = 'Historical immutable sealed prompt without new explanation';
  writeFileSync(prepared.promptPath, historicalPrompt); prepared.promptSha256 = sha(historicalPrompt);
  const privatePath = join(h.pending, `${prepared.assignmentId}.private.json`); writeFileSync(privatePath, JSON.stringify(prepared));
  const historicalPrivate = readFileSync(privatePath);
  const second = h.run('prepare-only'); expect(second.status).toBe(0);
  expect(readFileSync(prepared.promptPath, 'utf8')).toBe(historicalPrompt);
  expect(readFileSync(privatePath)).toEqual(historicalPrivate);
});

test('nonnative import validation behaviour is unchanged without native opt-in or evidence', () => {
  const h = importerHarness(); delete h.envelope.nativeStageEvidence; h.envelope.reviewer.agentId = 'legacy-independent-fixture'; h.envelope.reviewer.provider = 'legacy-neutral';
  const result = h.run('validate-only', false); expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ validatedReviews: 1, persistedReviews: 0 });
  expect(existsSync(h.persisted)).toBe(false);
});

test('real importer validates fresh native evidence without persistence then retains all evidence on isolated successful ingestion', () => {
  const h = importerHarness();
  const validated = h.run(); expect(validated.stderr).toBe(''); expect(validated.status).toBe(0);
  expect(JSON.parse(validated.stdout)).toMatchObject({ validatedReviews: 1, persistedReviews: 0 });
  expect(existsSync(h.persisted)).toBe(false);
  const ingested = h.run('ingest'); expect(ingested.stderr).toBe(''); expect(ingested.status).toBe(0);
  const rows = JSON.parse(readFileSync(h.persisted, 'utf8')); expect(rows).toHaveLength(1);
  expect(rows[0].artifacts).toHaveLength(8);
  expect(rows[0].evaluatorProvenance.evidence.filter((item: string) => item.startsWith('native-evidence:'))).toHaveLength(7);
  for (const artifact of rows[0].artifacts) {
    expect(sha(readFileSync(artifact.location))).toBe(artifact.sha256);
    expect(lstatSync(artifact.location).mode & 0o777).toBe(0o600);
    expect(lstatSync(dirname(artifact.location)).mode & 0o777).toBe(0o700);
  }
  rmSync(h.f.stageRoot, { recursive: true });
  expect(rows[0].artifacts.every((artifact: any) => existsSync(artifact.location))).toBe(true);
});

test.each(['old-unarchived', 'no-opt-in', 'stale-A', 'stale-B', 'self-review', 'excluded-source', 'raw-forgery', 'traversal-id', 'revisionHash', 'evaluationContractHash', 'evaluationContractVersion', 'suiteId', 'materializerId', 'deterministicScorerId', 'withIsA', 'prompt-alias', 'prompt-symlink', 'object-output', 'stale-prompt-bundle', 'stale-source-revision', 'stale-source-contract', 'missing-source-arm'])('real importer fails closed for %s without recording', mutation => {
  const h = importerHarness();
  if (mutation === 'old-unarchived') delete h.envelope.nativeStageEvidence;
  if (mutation === 'traversal-id') h.envelope.reviews[0].assignmentId = '../fixture-assignment';
  if (mutation === 'stale-A') h.prepared.artifactASha256 = '0'.repeat(64);
  if (mutation === 'stale-B') h.prepared.artifactBSha256 = '0'.repeat(64);
  if (mutation === 'self-review') h.envelope.reviewer.agentId = 'fixture-steward';
  if (mutation === 'excluded-source') { const data = JSON.parse(readFileSync(h.dataPath, 'utf8')); data.arms[0].harnessVersion = 'fixture:opencode-text-patch:quarantined'; writeFileSync(h.dataPath, JSON.stringify(data)); }
  if (mutation === 'raw-forgery') h.envelope.nativeStageEvidence.rawEvents.sha256 = '0'.repeat(64);
  if (['revisionHash', 'evaluationContractHash', 'suiteId', 'materializerId', 'deterministicScorerId'].includes(mutation)) h.prepared[mutation] = 'forged';
  if (mutation === 'evaluationContractVersion') h.prepared.evaluationContractVersion = 4;
  if (mutation === 'withIsA') h.prepared.withIsA = 'true';
  if (mutation === 'prompt-alias') h.prepared.promptPath = h.f.stage.sealedPrompt.path;
  if (mutation === 'prompt-symlink') { const path = h.prepared.promptPath; rmSync(path); symlinkSync(h.f.stage.sealedPrompt.path, path); }
  if (mutation === 'object-output') h.envelope.reviews[0].output = JSON.parse(h.envelope.reviews[0].output);
  if (mutation === 'stale-prompt-bundle') {
    const prompt = 'Previously sealed but unrelated anonymous pair'; writeFileSync(h.prepared.promptPath, prompt);
    h.prepared.promptSha256 = sha(prompt); h.f.input.promptSha256 = sha(prompt);
    h.f.stage.sealedPrompt = h.f.save(h.f.stage.sealedPrompt.path, prompt); h.f.receipt.promptSha256 = sha(prompt);
    const request = JSON.stringify({ system: NATIVE_REVIEW_SYSTEM_PROMPT, prompt, model: h.f.model });
    h.f.receipt.requestSha256 = sha(request); h.f.receipt.requestBytes = Buffer.byteLength(request); h.f.updateReceipt();
  }
  if (['stale-source-revision', 'stale-source-contract', 'missing-source-arm'].includes(mutation)) {
    const data = JSON.parse(readFileSync(h.dataPath, 'utf8'));
    if (mutation === 'missing-source-arm') data.arms.pop();
    else for (const arm of data.arms) arm[mutation === 'stale-source-revision' ? 'revisionHash' : 'evaluationContractHash'] = 'stale';
    writeFileSync(h.dataPath, JSON.stringify(data));
  }
  const result = h.run('validate-only', mutation !== 'no-opt-in');
  expect(result.status).not.toBe(0); expect(existsSync(h.persisted)).toBe(false);
  if (['revisionHash', 'evaluationContractHash', 'evaluationContractVersion', 'suiteId', 'materializerId', 'deterministicScorerId'].includes(mutation)) expect(result.stderr).toContain('exact current eligible');
  if (mutation === 'stale-prompt-bundle') expect(result.stderr).toContain('exact current anonymous');
  if (['stale-source-revision', 'stale-source-contract', 'missing-source-arm'].includes(mutation)) expect(result.stderr).toContain('no longer eligible');
});

test.each(['evaluationContractVersion', 'materializerId', 'deterministicScorerId'])('current hash cannot qualify mutually consistent stale source/prepared %s metadata', key => {
  const h = importerHarness(); const data = JSON.parse(readFileSync(h.dataPath, 'utf8'));
  const stale = key === 'evaluationContractVersion' ? 2 : 'fixture@stale';
  for (const arm of data.arms) arm[key] = stale;
  h.prepared[key] = stale;
  writeFileSync(h.dataPath, JSON.stringify(data));
  const result = h.run();
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('no longer eligible');
  expect(existsSync(h.persisted)).toBe(false);
});

