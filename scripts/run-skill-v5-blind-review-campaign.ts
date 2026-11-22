import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalizePath, findExecutableOnPath, looksLikePath } from '../backend/src/runtime/platform';
import { createNativeArchiveDirectory } from './native-reviewer-archive';
import { archiveNativeStageEvidence, verifyNativeStageEvidence, type NativeStageEvidence } from './native-reviewer-stage-evidence';
import { NATIVE_MAC_STAGE_MODE } from './native-reviewer-sandbox';
import { strictJson, validateAdjudication } from './reviewer-json';

import { assertPackagedEvalBackend } from './eval-backend-guard';

const projectRoot = resolve(import.meta.dir, '..');
// A reviewer turn reads a sealed packet through the same backend; a watcher restart
// during it produces a reviewer failure that is not the reviewer's fault.
if (
  !process.argv.includes('--allow-watcher-backend') &&
  !process.env.KORY_SKILL_EVAL_ALLOW_WATCHER_BACKEND?.trim()
) {
  await assertPackagedEvalBackend();
}
const reviewerAdapter =
  process.argv
    .find((argument) => argument.startsWith('--reviewer-adapter='))
    ?.slice('--reviewer-adapter='.length)
    .trim() ||
  process.env.KORY_SKILL_BLIND_REVIEWER_ADAPTER?.trim() ||
  'chatgpt-web';
// The adapter runs from a private review directory. Resolve explicit relative
// paths against the project before changing cwd; bare commands still use PATH.
const reviewerCommand = reviewerAdapter === 'chatgpt-web'
  ? 'codex'
  : looksLikePath(reviewerAdapter)
    ? resolve(projectRoot, reviewerAdapter)
    : reviewerAdapter;
const nativeReviewerAdapter = ['kory-native-stateless-reviewer', 'kory-native-stateless-reviewer.ts'].includes(basename(reviewerAdapter));
const reviewerProvider =
  process.env.KORY_SKILL_BLIND_REVIEWER_PROVIDER?.trim() ||
  (reviewerAdapter === 'chatgpt-web' ? 'chatgpt-web' : 'independent-agent');
const requestedSkills = process.argv
  .filter((argument) => argument.startsWith('--skill='))
  .map((argument) => argument.slice('--skill='.length).trim())
  .filter(Boolean);
const reviewerModel =
  process.argv
    .find((argument) => argument.startsWith('--reviewer-model='))
    ?.slice('--reviewer-model='.length)
    .trim() ||
  process.env.KORY_SKILL_BLIND_REVIEWER_MODEL?.trim() ||
  (reviewerAdapter === 'chatgpt-web' ? 'chatgpt-web/high' : 'reviewer-model-v1');
const reasoningEffort =
  process.argv
    .find((argument) => argument.startsWith('--reasoning-effort='))
    ?.slice('--reasoning-effort='.length)
    .trim() ||
  process.env.KORY_SKILL_BLIND_REASONING_EFFORT?.trim() ||
  'high';
function parseReviewerBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ChatGPT Web reviewer base URL: ${JSON.stringify(value)}`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/v1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `Invalid ChatGPT Web reviewer base URL: ${JSON.stringify(value)}; expected a loopback /v1 endpoint`,
    );
  }
  return url.href;
}

const reviewerBaseUrl = parseReviewerBaseUrl(
  process.argv
    .find((argument) => argument.startsWith('--reviewer-base-url='))
    ?.slice('--reviewer-base-url='.length)
    .trim() ||
    process.env.KORY_SKILL_CHATGPT_WEB_BASE_URL?.trim() ||
    'http://127.0.0.1:17841/v1',
);
const concurrency = Number(
  process.argv
    .find((argument) => argument.startsWith('--concurrency='))
    ?.slice('--concurrency='.length) ||
    process.env.KORY_SKILL_BLIND_REVIEW_CONCURRENCY?.trim() ||
    '1',
);
const maxArgument = process.argv
  .find((argument) => argument.startsWith('--max-assignments='))
  ?.slice('--max-assignments='.length);
const maxAssignments = maxArgument ? Number(maxArgument) : Number.POSITIVE_INFINITY;
const maxPerSkillArgument = process.argv
  .find((argument) => argument.startsWith('--max-per-skill='))
  ?.slice('--max-per-skill='.length);
const maxPerSkill = Number(
  maxPerSkillArgument || process.env.KORY_SKILL_BLIND_MAX_PER_SKILL?.trim() || '1',
);
const reviewerAttemptsArgument = process.argv
  .find((argument) => argument.startsWith('--max-reviewer-attempts='))
  ?.slice('--max-reviewer-attempts='.length);
const maxReviewerAttempts = Number(
  reviewerAttemptsArgument || process.env.KORY_SKILL_BLIND_REVIEWER_ATTEMPTS?.trim() || '3',
);
const reviewerWallClockArgument = process.argv
  .find((argument) => argument.startsWith('--reviewer-wall-clock-ms='))
  ?.slice('--reviewer-wall-clock-ms='.length);
const reviewerWallClockMs = Number(
  reviewerWallClockArgument ||
    process.env.KORY_SKILL_BLIND_REVIEWER_WALL_CLOCK_MS?.trim() ||
    '180000',
);
const dryRun = process.argv.includes('--dry-run');
const diagnoseReviewer = process.argv.includes('--diagnose-reviewer');
// This campaign only stages evidence. Ledger ingestion belongs to the coordinator
// and must be invoked separately with the importer after inspecting the evidence.
const reviewOnly = true;
const retryFailed = process.argv.includes('--retry-failed');

if (process.argv.some((argument) => argument === '--ingest' || argument.startsWith('--ingest='))) {
  throw new Error('The campaign cannot ingest evaluations; use the coordinator importer');
}

if (!reviewerAdapter.trim()) {
  throw new Error('Reviewer adapter must be non-empty');
}
if (!reviewerModel.trim()) {
  throw new Error('Reviewer model metadata must be non-empty');
}
if (!['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
  throw new Error(`Invalid --reasoning-effort=${reasoningEffort}`);
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error(`Invalid --concurrency=${String(concurrency)}; expected 1-4`);
}
if (!dryRun && !diagnoseReviewer && concurrency !== 1) {
  throw new Error('Live independent browser reviews must run serially (--concurrency=1)');
}
if (
  maxAssignments !== Number.POSITIVE_INFINITY &&
  (!Number.isInteger(maxAssignments) || maxAssignments < 1)
) {
  throw new Error(`Invalid --max-assignments=${String(maxArgument)}`);
}
if (!Number.isInteger(maxPerSkill) || maxPerSkill < 1 || maxPerSkill > 2) {
  throw new Error(`Invalid --max-per-skill=${String(maxPerSkillArgument)}; expected 1-2`);
}
if (!Number.isInteger(maxReviewerAttempts) || maxReviewerAttempts < 1 || maxReviewerAttempts > 5) {
  throw new Error(
    `Invalid --max-reviewer-attempts=${String(reviewerAttemptsArgument)}; expected 1-5`,
  );
}
if (
  !Number.isInteger(reviewerWallClockMs) ||
  reviewerWallClockMs < 30_000 ||
  reviewerWallClockMs > 600_000
) {
  throw new Error(
    `Invalid --reviewer-wall-clock-ms=${String(reviewerWallClockArgument)}; expected 30000-600000`,
  );
}

const delay = (milliseconds: number) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  killProcessGroup?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: input.killProcessGroup === true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (input.killProcessGroup && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process may already have exited; close/error remains authoritative.
      }
    };
    const timeout = input.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate('SIGTERM');
          forceKillTimer = setTimeout(() => terminate('SIGKILL'), 2_000);
        }, input.timeoutMs)
      : undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveResult({ code: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut });
    });
    if (input.stdin !== undefined) child.stdin.end(input.stdin);
    else child.stdin.end();
  });
}

interface ChatGptWebCommand {
  command: string;
  args: string[];
}

function resolveChatGptWebCommand(): ChatGptWebCommand | null {
  const explicit = process.env.KORY_SKILL_CHATGPT_WEB_CLI?.trim();
  if (explicit) return { command: explicit, args: [] };

  const home = process.env.CODEX_CHATGPT_WEB_HOME?.trim() || join(homedir(), '.codex-chatgpt-web');
  const versionsRoot = join(home, 'versions');
  if (!existsSync(versionsRoot)) return null;
  const versions = readdirSync(versionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  for (const version of versions.reverse()) {
    const runtime = join(versionsRoot, version, 'runtime', 'bun');
    const cli = join(versionsRoot, version, 'app', 'cli.js');
    if (existsSync(runtime) && existsSync(cli)) {
      return { command: runtime, args: [cli] };
    }
  }
  return null;
}

async function runChatGptWebControl(args: string[]): Promise<CommandResult | null> {
  const command = resolveChatGptWebCommand();
  if (!command) return null;
  return runCommand({
    command: command.command,
    args: [...command.args, ...args],
    cwd: projectRoot,
    timeoutMs: 15_000,
  });
}

function compactControlDetail(result: CommandResult | null): string {
  if (!result) return 'chatgpt-web control CLI unavailable';
  return (result.stderr || result.stdout || `exit ${String(result.code)}`).trim().slice(-1_500);
}

function browserControlIsBusy(result: CommandResult | null): boolean {
  return Boolean(
    result &&
    /ChatGPT browser is running Codex turn [a-f0-9]+/iu.test(compactControlDetail(result)),
  );
}

async function inspectChatGptWebReviewer(): Promise<{
  canAttempt: boolean;
  ready: boolean;
  routeVerified: boolean;
  browserBusy: boolean;
  detail: string;
}> {
  const route = await runChatGptWebControl(['route', 'status']);
  if (route?.code !== 0) {
    return {
      canAttempt: false,
      ready: false,
      routeVerified: false,
      browserBusy: false,
      detail: `ChatGPT Web route unavailable: ${compactControlDetail(route)}`,
    };
  }
  let routeStatus: {
    installed?: boolean;
    active?: boolean;
    routeUrl?: string;
    errors?: unknown[];
  };
  try {
    routeStatus = JSON.parse(route.stdout) as typeof routeStatus;
  } catch {
    return {
      canAttempt: false,
      ready: false,
      routeVerified: false,
      browserBusy: false,
      detail: 'ChatGPT Web route status is not valid JSON',
    };
  }
  if (
    !routeStatus ||
    routeStatus.installed !== true ||
    routeStatus.active !== true ||
    routeStatus.routeUrl !== reviewerBaseUrl ||
    !Array.isArray(routeStatus.errors) ||
    routeStatus.errors.length !== 0
  ) {
    return {
      canAttempt: false,
      ready: false,
      routeVerified: false,
      browserBusy: false,
      detail: 'ChatGPT Web route is inactive or does not match the configured reviewer endpoint',
    };
  }
  const initial = await runChatGptWebControl(['browser', 'check']);
  if (initial?.code === 0) {
    return {
      canAttempt: true,
      ready: true,
      routeVerified: true,
      browserBusy: false,
      detail: compactControlDetail(initial),
    };
  }
  // Busy is not proof of an authenticated, independent reviewer. Do not submit
  // another turn or disturb the turn currently owned by the browser launcher.
  if (browserControlIsBusy(initial)) {
    return {
      canAttempt: false,
      ready: false,
      routeVerified: true,
      browserBusy: true,
      detail: `browser has an active Codex turn; independent reviewer readiness is unverified: ${compactControlDetail(initial)}`,
    };
  }
  return {
    canAttempt: false,
    ready: false,
    routeVerified: true,
    browserBusy: false,
    detail: compactControlDetail(initial),
  };
}

async function inspectReviewerAdapter(): Promise<{
  canAttempt: boolean;
  ready: boolean;
  routeVerified: boolean;
  browserBusy: boolean;
  executableAvailable?: boolean;
  isolationVerified?: boolean;
  stageOnlyAttemptAllowed?: boolean;
  detail: string;
}> {
  if (reviewerAdapter !== 'chatgpt-web') {
    let executableAvailable = false;
    try {
      const executable = looksLikePath(reviewerAdapter)
        ? reviewerCommand
        : findExecutableOnPath(reviewerAdapter);
      if (executable && statSync(executable).isFile()) {
        accessSync(executable, constants.X_OK);
        executableAvailable = true;
      }
    } catch {
      // Missing or non-executable adapters cannot produce staged evidence.
    }
    return {
      canAttempt: false,
      ready: false,
      routeVerified: false,
      browserBusy: false,
      executableAvailable,
      isolationVerified: false,
      // Explicit generic campaigns may stage unqualified evidence for coordinator
      // inspection. Executability is not proof of an isolated reviewer route.
      stageOnlyAttemptAllowed: !diagnoseReviewer && executableAvailable,
      detail: executableAvailable
        ? 'Provider-neutral reviewer executable is available; route and isolation are unverified. Stage-only evidence requires coordinator qualification before ingestion.'
        : 'Provider-neutral reviewer executable is unavailable; route and isolation are unverified.',
    };
  }
  return inspectChatGptWebReviewer();
}

function canStageReviewerAttempt(status: Awaited<ReturnType<typeof inspectReviewerAdapter>>): boolean {
  return status.canAttempt || status.stageOnlyAttemptAllowed === true;
}

if (diagnoseReviewer) {
  const status = await inspectReviewerAdapter();
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        mode: 'diagnostic',
        reviewerAdapter,
        reviewerProvider,
        reviewerModel,
        reviewerBaseUrl,
        ...status,
        trustedNetworkContext: 'unverified (cannot be granted by child CLI configuration)',
        independentReviewerCompleted: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

interface PreparedAssignment {
  assignmentId: string;
  skill: string;
  scenarioId: string;
  pairId: string;
  promptPath: string;
  promptSha256: string;
}

interface SealedAssignment {
  prompt: string;
  privatePath: string;
  privateSha256: string;
  snapshotPath: string;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const validHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

function sealAssignment(assignment: PreparedAssignment, runRoot: string): SealedAssignment {
  if (!/^[a-zA-Z0-9_-]{1,120}$/u.test(assignment.assignmentId)) {
    throw new Error('Prepared assignment has an invalid id');
  }
  if (!validHash(assignment.promptSha256)) {
    throw new Error(`Prepared assignment ${assignment.assignmentId} has an invalid prompt hash`);
  }
  const privatePath = join(
    dirname(assignment.promptPath),
    `${assignment.assignmentId}.private.json`,
  );
  const privateBytes = readFileSync(privatePath);
  const privateRecord = JSON.parse(privateBytes.toString('utf8')) as Record<string, unknown>;
  if (
    privateRecord.schemaVersion !== 3 ||
    privateRecord.assignmentId !== assignment.assignmentId ||
    privateRecord.skill !== assignment.skill ||
    privateRecord.scenarioId !== assignment.scenarioId ||
    privateRecord.pairId !== assignment.pairId ||
    privateRecord.promptPath !== assignment.promptPath ||
    privateRecord.promptSha256 !== assignment.promptSha256 ||
    !validHash(privateRecord.artifactASha256) ||
    !validHash(privateRecord.artifactBSha256)
  ) {
    throw new Error(
      `Prepared assignment ${assignment.assignmentId} has inconsistent private evidence`,
    );
  }
  const promptBytes = readFileSync(assignment.promptPath);
  if (sha256(promptBytes) !== assignment.promptSha256) {
    throw new Error(`Prepared assignment ${assignment.assignmentId} prompt hash mismatch`);
  }
  const prompt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(promptBytes);
  if (!prompt.trim()) throw new Error(`Prepared assignment ${assignment.assignmentId} is empty`);

  // Feed the reviewer these verified bytes. Preserve a protected local snapshot
  // so a failed attempt can be audited without relying on a mutable pending file.
  const snapshotPath = join(runRoot, 'review-task.prompt.txt');
  writeFileSync(snapshotPath, promptBytes, { flag: 'wx', mode: nativeReviewerAdapter ? 0o600 : 0o400 });
  return { prompt, privatePath, privateSha256: sha256(privateBytes), snapshotPath };
}

function assertAssignmentSealed(assignment: PreparedAssignment, seal: SealedAssignment): void {
  if (
    sha256(readFileSync(assignment.promptPath)) !== assignment.promptSha256 ||
    sha256(readFileSync(seal.snapshotPath)) !== assignment.promptSha256 ||
    sha256(readFileSync(seal.privatePath)) !== seal.privateSha256
  ) {
    throw new Error(`Prepared assignment ${assignment.assignmentId} changed during review`);
  }
}

interface ReviewerEvent extends Record<string, unknown> {
  type: string;
  item?: { type?: string; text?: string };
}

function verifiedReviewerThread(stdout: string, output: string): string {
  const events = stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      let event: ReviewerEvent;
      try {
        event = JSON.parse(line) as ReviewerEvent;
      } catch {
        throw new Error('Reviewer Codex event stream contains invalid JSON');
      }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
        throw new Error('Reviewer Codex event stream contains an invalid event');
      }
      return event;
    });
  const threads = events.filter((event) => event.type === 'thread.started');
  const starts = events.filter((event) => event.type === 'turn.started');
  const completions = events.filter((event) => event.type === 'turn.completed');
  const failed = events.find((event) => event.type === 'turn.failed');
  if (
    threads.length !== 1 ||
    starts.length !== 1 ||
    completions.length !== 1 ||
    failed ||
    events.indexOf(threads[0]!) > events.indexOf(starts[0]!) ||
    events.indexOf(starts[0]!) > events.indexOf(completions[0]!)
  ) {
    const reason =
      failed && typeof (failed.error as { message?: unknown } | undefined)?.message === 'string'
        ? `: ${(failed.error as { message: string }).message}`
        : '';
    throw new Error(`Reviewer did not confirm a completed single Codex turn${reason}`);
  }
  const threadId = threads[0]?.thread_id ?? threads[0]?.threadId;
  if (
    typeof threadId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(threadId)
  ) {
    throw new Error('Reviewer did not expose a valid independent Codex task id');
  }
  const lastMessage = events
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')
    .at(-1);
  if (
    !lastMessage ||
    typeof lastMessage.item?.text !== 'string' ||
    events.indexOf(lastMessage) <= events.indexOf(starts[0]!) ||
    events.indexOf(lastMessage) >= events.indexOf(completions[0]!) ||
    lastMessage.item.text.trimEnd() !== output.trimEnd()
  ) {
    throw new Error('Reviewer result artifact differs from its completed Codex agent message');
  }
  if (
    !output.trim() ||
    !['artifactA', 'artifactB', 'preference', 'rationale'].every((key) =>
      new RegExp(`"${key}"\\s*:`, 'u').test(output),
    )
  ) {
    throw new Error('Reviewer returned an incomplete semantic adjudication');
  }
  return threadId;
}

interface GenericReviewerEvent {
  type: 'review.started' | 'review.completed';
  reviewerId: string;
  outputSha256?: string;
}

interface GenericReviewerResponse {
  schemaVersion: 1;
  reviewerId: string;
  completed: true;
  output: string;
  events: GenericReviewerEvent[];
}

function verifiedGenericReviewer(stdout: string): GenericReviewerResponse {
  let response: GenericReviewerResponse;
  try {
    response = (nativeReviewerAdapter ? strictJson(stdout) : JSON.parse(stdout)) as GenericReviewerResponse;
  } catch {
    throw new Error('Generic reviewer adapter returned invalid JSON');
  }
  if (
    !response ||
    typeof response !== 'object' ||
    response.schemaVersion !== 1 ||
    response.completed !== true ||
    typeof response.reviewerId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,200}$/u.test(response.reviewerId) ||
    typeof response.output !== 'string' ||
    !response.output.trim() ||
    !Array.isArray(response.events)
  ) {
    throw new Error('Generic reviewer adapter returned an invalid completion envelope');
  }
  const events = response.events;
  if (
    events.length !== 2 ||
    events[0]?.type !== 'review.started' ||
    events[1]?.type !== 'review.completed' ||
    events.some(
      (event) =>
        !event ||
        typeof event !== 'object' ||
        event.reviewerId !== response.reviewerId ||
        (event.type === 'review.completed' &&
          event.outputSha256 !== sha256(response.output)),
    )
  ) {
    throw new Error(
      'Generic reviewer adapter did not provide one ordered start/completion event pair bound to its output',
    );
  }
  return response;
}

function validateReviewerAdjudication(output: string): void {
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new Error('Reviewer returned invalid adjudication JSON');
  }
  const validScore = (input: unknown): boolean => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const score = input as Record<string, unknown>;
    return (
      typeof score.passed === 'boolean' &&
      typeof score.quality === 'number' &&
      Number.isFinite(score.quality) &&
      score.quality >= 0 &&
      score.quality <= 1 &&
      typeof score.verification === 'number' &&
      Number.isFinite(score.verification) &&
      score.verification >= 0 &&
      score.verification <= 1 &&
      typeof score.integrityFailure === 'boolean' &&
      Array.isArray(score.evidence) &&
      score.evidence.every((item: unknown) => typeof item === 'string')
    );
  };
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !validScore(result.artifactA) ||
    !validScore(result.artifactB) ||
    !['A', 'B', 'tie'].includes(result.preference as string) ||
    !Array.isArray(result.rationale) ||
    !result.rationale.every((item: unknown) => typeof item === 'string')
  ) {
    throw new Error('Reviewer returned an invalid adjudication schema');
  }
}

interface PrepareResult {
  preparedAssignments: PreparedAssignment[];
  eligible?: Array<{ skill: string; scenarioId: string; pairId: string }>;
  skippedExistingReviews: number;
  queuedPairs: number;
}

interface ReviewResult {
  assignment: PreparedAssignment;
  runRoot: string;
  attempts: number;
  reviewerThread?: string;
  reviewerEventsPath?: string;
  envelopePath?: string;
  seal?: SealedAssignment;
  nativeStageEvidence?: NativeStageEvidence;
  failure?: string;
  stopCampaign?: boolean;
}

const prepareArgs = [
  'run',
  'scripts/run-skill-v5-blind-review.ts',
  dryRun ? '--dry-run' : '--prepare-only',
  '--concurrency=1',
  `--max-per-skill=${String(maxPerSkill)}`,
  ...(retryFailed ? ['--retry-failed'] : []),
  ...requestedSkills.map((skill) => `--skill=${skill}`),
];
const preparedProcess = await runCommand({ command: 'bun', args: prepareArgs, cwd: projectRoot });
if (preparedProcess.code !== 0) {
  throw new Error(
    `Failed to prepare blind assignments\n${preparedProcess.stderr || preparedProcess.stdout}`,
  );
}
const prepared = JSON.parse(preparedProcess.stdout) as PrepareResult;
const assignments = prepared.preparedAssignments.slice(
  0,
  Number.isFinite(maxAssignments) ? maxAssignments : undefined,
);

if (dryRun) {
  const selected = (prepared.eligible ?? [])
    .slice(0, Number.isFinite(maxAssignments) ? maxAssignments : undefined)
    .map(({ skill, scenarioId, pairId }) => ({
      assignmentId: `blind-v5-${sha256(`${skill}\0${scenarioId}\0${pairId}`).slice(0, 20)}`,
      skill,
      scenarioId,
      pairId,
    }));
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        dryRun: true,
        reviewerModel,
        reviewerBaseUrl,
        reasoningEffort,
        concurrency,
        maxPerSkill,
        retryFailed,
        maxReviewerAttempts,
        reviewerWallClockMs,
        reviewOnly,
        requestedSkills,
        skippedExistingReviews: prepared.skippedExistingReviews,
        availableAssignments: prepared.eligible?.length ?? 0,
        selectedAssignments: selected,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

let cursor = 0;
let completed = 0;
let reviewed = 0;
let infrastructureFailures = 0;
let terminalBlocker: string | undefined;
const usedReviewerThreads = new Set<string>();
const stagedReviews: Array<{
  assignmentId: string;
  reviewerThread: string;
  attestationPath: string;
  envelopePath: string;
}> = [];
const failures: Array<{ assignmentId: string; skill: string; scenarioId: string; detail: string }> =
  [];

function validateReviewForFinalization(result: ReviewResult): void {
  if (!result.envelopePath) throw new Error('Missing blind review import envelope');
  if (!result.seal) throw new Error('Missing sealed blind review assignment');
  if (!result.reviewerThread) throw new Error('Missing independent reviewer task id');
  if (!result.reviewerEventsPath) throw new Error('Missing independent reviewer event evidence');
  if (usedReviewerThreads.has(result.reviewerThread)) {
    throw new Error(`Reviewer task ${result.reviewerThread} was reused across blind assignments`);
  }
  assertAssignmentSealed(result.assignment, result.seal);
  usedReviewerThreads.add(result.reviewerThread);
}

function verifyNativeFinalization(result: ReviewResult): void {
  if (!nativeReviewerAdapter) return;
  if (!result.nativeStageEvidence || !result.envelopePath || !result.seal) {
    throw new Error('Native reviewer stage is missing fresh archived evidence');
  }
  const envelope = strictJson(readFileSync(result.envelopePath, 'utf8')) as {
    nativeStageEvidence: unknown; reviews: Array<{ output: string }>; reviewer: { agentId: string; model: string };
  };
  if (envelope.reviewer.agentId !== result.reviewerThread || envelope.reviewer.model !== reviewerModel ||
    envelope.reviews.length !== 1 || JSON.stringify(envelope.nativeStageEvidence) !== JSON.stringify(result.nativeStageEvidence)) {
    throw new Error('Native reviewer import envelope changed its completion binding');
  }
  verifyNativeStageEvidence(envelope.nativeStageEvidence, dirname(result.nativeStageEvidence.rawEvents.path),
    result.seal.prompt, reviewerModel, canonicalizePath(projectRoot), envelope.reviews[0]!.output, result.reviewerThread);
}

async function stageReviewOnly(result: ReviewResult): Promise<void> {
  validateReviewForFinalization(result);
  verifyNativeFinalization(result);
  const envelopePath = result.envelopePath!;
  const eventsPath = result.reviewerEventsPath!;
  const seal = result.seal!;
  const reviewerThread = result.reviewerThread!;
  const initialEnvelopeSha256 = sha256(readFileSync(envelopePath));
  const validation = await runCommand({
    command: 'bun',
    args: [
      'run',
      'scripts/run-skill-v5-blind-review.ts',
      `--skill=${result.assignment.skill}`,
      `--validate-only=${envelopePath}`,
      ...(nativeReviewerAdapter ? ['--allow-native-stage'] : []),
    ],
    cwd: projectRoot,
  });
  if (validation.code !== 0) {
    throw new Error(`Blind review validation failed: ${validation.stderr || validation.stdout}`);
  }
  let validated: { mode?: string; validatedReviews?: number; persistedReviews?: number };
  try {
    validated = JSON.parse(validation.stdout) as typeof validated;
  } catch {
    throw new Error('Blind review validator returned an invalid summary');
  }
  if (
    validated.mode !== 'validate' ||
    validated.validatedReviews !== 1 ||
    validated.persistedReviews !== 0
  ) {
    throw new Error('Blind review validator did not confirm one unpersisted valid review');
  }
  assertAssignmentSealed(result.assignment, seal);
  verifyNativeFinalization(result);
  const envelope = readFileSync(envelopePath);
  if (sha256(envelope) !== initialEnvelopeSha256) {
    throw new Error('Blind review envelope changed during validation');
  }
  const reviewer = JSON.parse(envelope.toString('utf8')) as {
    reviews: Array<{ output: string }>;
  };
  const attestationPath = join(result.runRoot, 'review-attestation.json');
  writeFileSync(
    attestationPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: 'unimported',
        assignmentId: result.assignment.assignmentId,
        skill: result.assignment.skill,
        scenarioId: result.assignment.scenarioId,
        pairId: result.assignment.pairId,
        reviewerThread,
        reviewerIdentitySource:
          nativeReviewerAdapter ? 'host-observed-native-cli-session-id' :
          reviewerAdapter === 'chatgpt-web' ? 'codex-jsonl-thread.started' : 'external-reviewer-adapter-output',
        reviewerAdapter,
        reviewerModel,
        reviewerModelSource:
          nativeReviewerAdapter ? 'native-cli-empty-tool-init-model' :
          reviewerAdapter === 'chatgpt-web' ? 'codex-cli-model-selection-and-matching-local-route' : 'configured-provider-model-metadata',
        ...(result.nativeStageEvidence ? { nativeStageEvidence: result.nativeStageEvidence } : {}),
        reviewerBaseUrl,
        promptSha256: result.assignment.promptSha256,
        privateAssignmentSha256: seal.privateSha256,
        reviewerEventsSha256: sha256(readFileSync(eventsPath)),
        judgeOutputSha256: sha256(reviewer.reviews[0]!.output),
        envelopeSha256: sha256(envelope),
        importValidation: {
          mode: validated.mode,
          validatedReviews: validated.validatedReviews,
          persistedReviews: validated.persistedReviews,
        },
        promptSnapshotPath: seal.snapshotPath,
        reviewerEventsPath: eventsPath,
        envelopePath,
        // Original reviewer evidence is retained alongside these hashes. Native
        // opaque thinking stays only in the protected raw-event archive.
        // Read-only import validation passed; persistence and qualification
        // remain coordinator owned.
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  stagedReviews.push({
    assignmentId: result.assignment.assignmentId,
    reviewerThread,
    attestationPath,
    envelopePath,
  });
  reviewed += 1;
}

// Pair eligibility can move while the reviewer works: any later campaign that
// records a newer pair for the same scenario supersedes the sealed one. Re-check
// immediately before writing the envelope so a doomed assignment fails fast
// instead of producing staged evidence that ingestion must refuse as stale.
async function assertAssignmentStillEligible(assignment: PreparedAssignment): Promise<void> {
  const check = await runCommand({
    command: 'bun',
    args: [
      'run',
      'scripts/run-skill-v5-blind-review.ts',
      '--prepare-only',
      '--concurrency=1',
      `--skill=${assignment.skill}`,
    ],
    cwd: projectRoot,
  });
  if (check.code !== 0) {
    throw new Error(
      `Stale-pair check failed for ${assignment.assignmentId}: ${check.stderr || check.stdout}`,
    );
  }
  let current: PrepareResult;
  try {
    current = JSON.parse(check.stdout) as PrepareResult;
  } catch {
    throw new Error(`Stale-pair check returned invalid JSON for ${assignment.assignmentId}`);
  }
  const stillEligible = (current.eligible ?? []).some(
    (item) =>
      item.skill === assignment.skill &&
      item.scenarioId === assignment.scenarioId &&
      item.pairId === assignment.pairId,
  );
  if (!stillEligible) {
    throw new Error(
      `Blind assignment ${assignment.assignmentId} became stale before finalization; ` +
        'a newer eligible pair exists for this scenario. Rerun the campaign after qualification and regression retests settle.',
    );
  }
}

async function reviewAssignment(assignment: PreparedAssignment): Promise<ReviewResult> {
  const runRoot = canonicalizePath(mkdtempSync(join(canonicalizePath(tmpdir()), 'kory-v5-blind-review-')));
  let attempts = 0;
  let stopCampaign = false;
  try {
    const seal = sealAssignment(assignment, runRoot);
    const prompt = seal.prompt;
    let reviewerThread: string | undefined;
    let reviewerEventsPath: string | undefined;
    let output: string | undefined;
    let genericReviewerEvidence: string | undefined;
    let nativeStageEvidence: NativeStageEvidence | undefined;
    let lastFailure = 'Reviewer did not complete';

    const checkReviewer = async (reason: string) => {
      const status = await inspectReviewerAdapter();
      console.log(
        JSON.stringify({
          type: 'reviewer-status',
          assignmentId: assignment.assignmentId,
          skill: assignment.skill,
          scenarioId: assignment.scenarioId,
          reason,
          ready: status.ready,
          canAttempt: status.canAttempt,
          routeVerified: status.routeVerified,
          browserBusy: status.browserBusy,
          executableAvailable: status.executableAvailable,
          isolationVerified: status.isolationVerified,
          stageOnlyAttemptAllowed: status.stageOnlyAttemptAllowed,
          detail: status.detail,
        }),
      );
      return status;
    };

    const preflight = await checkReviewer('preflight');
    if (!canStageReviewerAttempt(preflight)) {
      stopCampaign = true;
      throw new Error(`Reviewer preflight failed: ${preflight.detail}`);
    }

    for (let attempt = 1; attempt <= maxReviewerAttempts; attempt += 1) {
      attempts = attempt;
      const resultPath = join(runRoot, `result-${String(attempt)}.txt`);
      rmSync(resultPath, { force: true });
      const genericReviewer = reviewerAdapter !== 'chatgpt-web';
      const archiveDirectory = nativeReviewerAdapter ? createNativeArchiveDirectory(runRoot) : undefined;
      const reviewer = await runCommand({
        command: reviewerCommand,
        args: genericReviewer
          ? ['-p', 'Return only the required JSON adjudication object. Do not add commentary.']
          : [
              'exec',
              '--skip-git-repo-check',
              '--strict-config',
              '--ignore-user-config',
              '-c',
              `openai_base_url=${JSON.stringify(reviewerBaseUrl)}`,
              '--sandbox',
              'workspace-write',
              '--ephemeral',
              '-m',
              reviewerModel,
              '-c',
              `model_reasoning_effort="${reasoningEffort}"`,
              '--json',
              '-o',
              resultPath,
              '-',
            ],
        cwd: runRoot,
        stdin: prompt,
        timeoutMs: reviewerWallClockMs,
        killProcessGroup: true,
        ...(archiveDirectory ? { env: {
          ...process.env,
          KORY_NATIVE_REVIEW_ARCHIVE_DIR: archiveDirectory,
          KORY_NATIVE_REVIEW_PENDING_ROOT: canonicalizePath(dirname(assignment.promptPath)),
          KORY_NATIVE_REVIEW_STAGE_SANDBOX: NATIVE_MAC_STAGE_MODE,
          KORY_NATIVE_REVIEW_MODEL: reviewerModel,
          KORY_NATIVE_REVIEW_TIMEOUT_MS: String(Math.min(reviewerWallClockMs, 550_000)),
        } } : {}),
      });
      if (reviewer.code !== 0) {
        const detail = nativeReviewerAdapter ? 'Native reviewer diagnostics redacted; no completed archived stage.' :
          `${reviewer.stderr}\n${reviewer.stdout}`.slice(-6000);
        lastFailure = reviewer.timedOut
          ? `Reviewer exceeded ${String(reviewerWallClockMs)}ms wall-clock budget: ${detail}`
          : `Reviewer process failed: ${detail}`;
        const nonRetryable =
          /model is not supported|unknown model|invalid model|Free usage limit reached|ChatGPT web turn is missing network access in trusted Codex environment context|This tool call was blocked by OpenAI|couldn't determine the safety status of the request/iu.test(
            detail,
          );
        if (nonRetryable) stopCampaign = true;
        if (nonRetryable || attempt === maxReviewerAttempts) break;
        const rateLimited =
          /rate limit exceeded|too many requests|try again in a few minutes/iu.test(detail);
        if (!rateLimited) {
          const status = await checkReviewer(
            reviewer.timedOut ? 'reviewer timeout' : 'reviewer process failure',
          );
          if (!canStageReviewerAttempt(status)) {
            stopCampaign = true;
            break;
          }
        }
        await delay(rateLimited ? 45_000 : Math.min(4_000, attempt * 1_000));
        continue;
      }
      if (genericReviewer) {
        const genericResponse = verifiedGenericReviewer(reviewer.stdout.trim());
        if (archiveDirectory) {
          nativeStageEvidence = archiveNativeStageEvidence(genericResponse, archiveDirectory, prompt,
            reviewerModel, canonicalizePath(projectRoot));
        }
        writeFileSync(resultPath, genericResponse.output, { flag: 'wx', mode: 0o600 });
        reviewerThread = genericResponse.reviewerId;
        genericReviewerEvidence = JSON.stringify(genericResponse, null, 2);
      }
      if (!existsSync(resultPath)) {
        lastFailure = 'Reviewer returned no final result artifact';
        if (attempt === maxReviewerAttempts) break;
        if (!canStageReviewerAttempt(await checkReviewer('missing result artifact'))) {
          stopCampaign = true;
          break;
        }
        await delay(Math.min(4_000, attempt * 1_000));
        continue;
      }
      const resultStat = lstatSync(resultPath);
      if (!resultStat.isFile() || resultStat.size > 1_048_576) {
        lastFailure = 'Reviewer result artifact is not a bounded regular file';
        if (attempt === maxReviewerAttempts) break;
        if (!canStageReviewerAttempt(await checkReviewer('invalid reviewer result artifact'))) {
          stopCampaign = true;
          break;
        }
        await delay(Math.min(4_000, attempt * 1_000));
        continue;
      }
      const attemptOutput = readFileSync(resultPath, 'utf8');
      try {
        if (genericReviewer) {
          if (!genericReviewerEvidence) {
            throw new Error('Generic reviewer evidence was not retained');
          }
        } else {
          reviewerThread = verifiedReviewerThread(reviewer.stdout, attemptOutput);
        }
        if (nativeReviewerAdapter) validateAdjudication(attemptOutput);
        else validateReviewerAdjudication(attemptOutput);
        if (nativeStageEvidence) {
          verifyNativeStageEvidence(nativeStageEvidence, archiveDirectory!, prompt, reviewerModel,
            canonicalizePath(projectRoot), attemptOutput, reviewerThread);
          reviewerEventsPath = nativeStageEvidence.hostReceipt.path;
        } else {
          reviewerEventsPath = join(runRoot, genericReviewer ? 'reviewer-events.json' : 'reviewer-events.jsonl');
          writeFileSync(reviewerEventsPath, genericReviewer ? `${genericReviewerEvidence}\n` : reviewer.stdout,
            { flag: 'wx', mode: 0o600 });
        }
        output = attemptOutput;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
        if (attempt === maxReviewerAttempts) break;
        if (!canStageReviewerAttempt(await checkReviewer('unverified reviewer result'))) {
          stopCampaign = true;
          break;
        }
        await delay(Math.min(4_000, attempt * 1_000));
        continue;
      }
      break;
    }

    if (!reviewerThread || output === undefined) throw new Error(lastFailure);
    assertAssignmentSealed(assignment, seal);
    await assertAssignmentStillEligible(assignment);
    const envelopePath = join(runRoot, 'import.json');
    writeFileSync(
      envelopePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          reviewer: {
            // ChatGPT Web identities come from the completed Codex event stream;
            // provider-neutral adapters must supply their own stable identity in
            // the signed-by-convention completion envelope. Never synthesize an
            // identity from a model label or from the anonymous prompt.
            agentId: reviewerThread,
            provider: reviewerProvider,
            model: reviewerModel,
          },
          reviews: [{ assignmentId: assignment.assignmentId, output }],
          ...(nativeStageEvidence ? { nativeStageEvidence } : {}),
        },
        null,
        2,
      )}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return {
      assignment,
      runRoot,
      attempts,
      reviewerThread,
      reviewerEventsPath,
      envelopePath,
      seal,
      nativeStageEvidence,
    };
  } catch (error) {
    return {
      assignment,
      runRoot,
      attempts,
      failure: error instanceof Error ? error.message : String(error),
      stopCampaign,
    };
  }
}

async function worker(): Promise<void> {
  while (true) {
    if (terminalBlocker) return;
    const index = cursor;
    cursor += 1;
    const assignment = assignments[index];
    if (!assignment) return;
    const result = await reviewAssignment(assignment);
    try {
      if (result.failure) {
        infrastructureFailures += 1;
        if (result.stopCampaign) terminalBlocker = result.failure;
        failures.push({
          assignmentId: assignment.assignmentId,
          skill: assignment.skill,
          scenarioId: assignment.scenarioId,
          detail: result.failure,
        });
      } else {
        await stageReviewOnly(result);
      }
    } catch (error) {
      infrastructureFailures += 1;
      failures.push({
        assignmentId: assignment.assignmentId,
        skill: assignment.skill,
        scenarioId: assignment.scenarioId,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      completed += 1;
      const success = !failures.some((item) => item.assignmentId === assignment.assignmentId);
      console.log(
        JSON.stringify({
          type: 'progress',
          complete: completed,
          totalQueued: assignments.length,
          assignmentId: assignment.assignmentId,
          skill: assignment.skill,
          scenarioId: assignment.scenarioId,
          reviewerThread: result.reviewerThread ?? null,
          attempts: result.attempts,
          persisted: false,
          staged: success,
          infrastructureFailure: !success,
        }),
      );
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(concurrency, assignments.length) }, () => worker()),
);

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      dryRun: false,
      reviewOnly,
      reviewerModel,
      reviewerBaseUrl,
      reasoningEffort,
      concurrency,
      maxPerSkill,
      retryFailed,
      maxReviewerAttempts,
      reviewerWallClockMs,
      requestedSkills,
      skippedExistingReviews: prepared.skippedExistingReviews,
      availableAssignments: prepared.preparedAssignments.length,
      queued: assignments.length,
      completed,
      notAttempted: assignments.length - completed,
      terminalBlocker: terminalBlocker ?? null,
      persisted: 0,
      reviewed,
      stagedReviews,
      infrastructureFailures,
      failures: failures.slice(0, 50),
    },
    null,
    2,
  ),
);
if (infrastructureFailures > 0) process.exitCode = 1;
