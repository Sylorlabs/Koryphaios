import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dir, '..');
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
  'chatgpt-web/high';
const reasoningEffort =
  process.argv
    .find((argument) => argument.startsWith('--reasoning-effort='))
    ?.slice('--reasoning-effort='.length)
    .trim() ||
  process.env.KORY_SKILL_BLIND_REASONING_EFFORT?.trim() ||
  'high';
const reviewerBaseUrl =
  process.argv
    .find((argument) => argument.startsWith('--reviewer-base-url='))
    ?.slice('--reviewer-base-url='.length)
    .trim() ||
  process.env.KORY_SKILL_CHATGPT_WEB_BASE_URL?.trim() ||
  'http://127.0.0.1:17841/v1';
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

if (!/^chatgpt-web\/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(reviewerModel)) {
  throw new Error(`Reviewer model must be a chatgpt-web/... identity, received ${reviewerModel}`);
}
if (!['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
  throw new Error(`Invalid --reasoning-effort=${reasoningEffort}`);
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error(`Invalid --concurrency=${String(concurrency)}; expected 1-4`);
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
}): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
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

async function terminateStaleBrowserHelpers(): Promise<number> {
  const processList = await runCommand({
    command: 'ps',
    args: ['-axo', 'pid=,command='],
    cwd: projectRoot,
    timeoutMs: 10_000,
  });
  if (processList.code !== 0) return 0;
  const helperPids = processList.stdout
    .split(/\r?\n/u)
    .flatMap((line) => {
      if (!/Codex Web GPT.*browser-helper\.cjs/iu.test(line)) return [];
      const match = line.trim().match(/^(\d+)\s/u);
      return match ? [Number(match[1])] : [];
    })
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  let terminated = 0;
  for (const pid of helperPids) {
    try {
      process.kill(pid, 'SIGTERM');
      terminated += 1;
    } catch {
      // The helper may have exited between ps and kill; the follow-up check is authoritative.
    }
  }
  return terminated;
}

async function restartChatGptWebLauncher(): Promise<{
  restarted: boolean;
  detail: string;
}> {
  const processList = await runCommand({
    command: 'ps',
    args: ['-axo', 'pid=,ppid=,command='],
    cwd: projectRoot,
    timeoutMs: 10_000,
  });
  if (processList.code !== 0) {
    return { restarted: false, detail: compactControlDetail(processList) };
  }
  const launcherPids = processList.stdout
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
      if (!match) return [];
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const command = match[3] ?? '';
      if (
        parentPid !== 1 ||
        command !== '/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT'
      ) {
        return [];
      }
      return [pid];
    })
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);

  for (const pid of launcherPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // A concurrent exit is equivalent to successful termination here.
    }
  }
  if (launcherPids.length) await delay(750);

  const opened = await runCommand({
    command: 'open',
    args: ['-a', 'Codex Web GPT'],
    cwd: projectRoot,
    timeoutMs: 10_000,
  });
  if (opened.code !== 0) {
    return { restarted: false, detail: compactControlDetail(opened) };
  }

  let last = 'launcher restarted but browser readiness was not observed';
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt) await delay(750);
    const check = await runChatGptWebControl(['browser', 'check']);
    last = compactControlDetail(check);
    if (check?.code === 0) return { restarted: true, detail: last };
  }
  return { restarted: false, detail: last };
}

async function ensureChatGptWebReviewerReady(): Promise<{
  ready: boolean;
  recovered: boolean;
  detail: string;
}> {
  const initial = await runChatGptWebControl(['browser', 'check']);
  if (initial?.code === 0) {
    return { ready: true, recovered: false, detail: compactControlDetail(initial) };
  }
  // When this campaign is itself launched from Native2, the outer task owns a
  // healthy ChatGPT Web turn. The launcher supports additional tabs, so "busy"
  // is not a stale-browser signal and must never trigger cancellation/restart.
  if (browserControlIsBusy(initial)) {
    return {
      ready: true,
      recovered: false,
      detail: `browser busy with an active Codex turn; concurrent reviewer allowed: ${compactControlDetail(initial)}`,
    };
  }
  if (concurrency !== 1) {
    return {
      ready: false,
      recovered: false,
      detail: `reviewer recovery requires serial execution; ${compactControlDetail(initial)}`,
    };
  }

  await runChatGptWebControl(['service', 'cancel-turns']);
  const afterCancel = await runChatGptWebControl(['browser', 'check']);
  if (afterCancel?.code === 0) {
    return { ready: true, recovered: true, detail: compactControlDetail(afterCancel) };
  }
  if (browserControlIsBusy(afterCancel)) {
    return {
      ready: true,
      recovered: true,
      detail: `browser remained busy with a live Codex turn after cancellation request; concurrent reviewer allowed: ${compactControlDetail(afterCancel)}`,
    };
  }

  const staleBrowser =
    /running Codex turn|launcher.*unavailable|browser.*unavailable|502|bad gateway/iu.test(
      `${compactControlDetail(initial)}\n${compactControlDetail(afterCancel)}`,
    );
  if (!staleBrowser) {
    return { ready: false, recovered: false, detail: compactControlDetail(afterCancel) };
  }

  const terminated = await terminateStaleBrowserHelpers();
  if (terminated) await delay(750);
  const afterRestart = await runChatGptWebControl(['browser', 'check']);
  if (afterRestart?.code === 0) {
    return {
      ready: true,
      recovered: terminated > 0,
      detail: compactControlDetail(afterRestart),
    };
  }

  const launcherRestart = await restartChatGptWebLauncher();
  return {
    ready: launcherRestart.restarted,
    recovered: terminated > 0 || launcherRestart.restarted,
    detail: launcherRestart.detail,
  };
}

interface PreparedAssignment {
  assignmentId: string;
  skill: string;
  scenarioId: string;
  pairId: string;
  promptPath: string;
  promptSha256: string;
}

interface PrepareResult {
  preparedAssignments: PreparedAssignment[];
  skippedExistingReviews: number;
  queuedPairs: number;
}

interface ReviewResult {
  assignment: PreparedAssignment;
  runRoot: string;
  attempts: number;
  reviewerThread?: string;
  envelopePath?: string;
  failure?: string;
}

const prepareArgs = [
  'run',
  'scripts/run-skill-v5-blind-review.ts',
  '--prepare-only',
  '--concurrency=1',
  `--max-per-skill=${String(maxPerSkill)}`,
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
        maxReviewerAttempts,
        reviewerWallClockMs,
        requestedSkills,
        skippedExistingReviews: prepared.skippedExistingReviews,
        availableAssignments: prepared.preparedAssignments.length,
        selectedAssignments: assignments.map(({ assignmentId, skill, scenarioId, pairId }) => ({
          assignmentId,
          skill,
          scenarioId,
          pairId,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

let cursor = 0;
let completed = 0;
let persisted = 0;
let infrastructureFailures = 0;
const failures: Array<{ assignmentId: string; skill: string; scenarioId: string; detail: string }> =
  [];
let ingestTail = Promise.resolve();

function queuedIngest(result: ReviewResult): Promise<void> {
  const run = async () => {
    if (!result.envelopePath) throw new Error('Missing blind review import envelope');
    const ingest = await runCommand({
      command: 'bun',
      args: [
        'run',
        'scripts/run-skill-v5-blind-review.ts',
        `--skill=${result.assignment.skill}`,
        `--ingest=${result.envelopePath}`,
      ],
      cwd: projectRoot,
    });
    if (ingest.code !== 0) {
      throw new Error(`Blind review ingest failed: ${ingest.stderr || ingest.stdout}`);
    }
    const parsed = JSON.parse(ingest.stdout) as { persistedReviews?: number };
    if (parsed.persistedReviews !== 1) {
      throw new Error(`Blind review ingest persisted ${String(parsed.persistedReviews)} reviews`);
    }
    persisted += 1;
  };
  const promise = ingestTail.then(run);
  ingestTail = promise.catch(() => undefined);
  return promise;
}

async function reviewAssignment(assignment: PreparedAssignment): Promise<ReviewResult> {
  const runRoot = mkdtempSync(join(tmpdir(), 'kory-v5-blind-review-'));
  let attempts = 0;
  try {
    if (!existsSync(assignment.promptPath)) throw new Error('Prepared prompt is missing');
    const prompt = readFileSync(assignment.promptPath, 'utf8');
    let reviewerThread: string | undefined;
    let output: string | undefined;
    let lastFailure = 'Reviewer did not complete';

    const recoverReviewer = async (reason: string): Promise<boolean> => {
      const recovery = await ensureChatGptWebReviewerReady();
      console.log(
        JSON.stringify({
          type: 'reviewer-recovery',
          assignmentId: assignment.assignmentId,
          skill: assignment.skill,
          scenarioId: assignment.scenarioId,
          reason,
          ready: recovery.ready,
          recovered: recovery.recovered,
          detail: recovery.detail,
        }),
      );
      return recovery.ready;
    };

    if (concurrency === 1) {
      const ready = await recoverReviewer('preflight');
      if (!ready) throw new Error('ChatGPT Web reviewer preflight recovery failed');
    }

    for (let attempt = 1; attempt <= maxReviewerAttempts; attempt += 1) {
      attempts = attempt;
      const resultPath = join(runRoot, `result-${String(attempt)}.txt`);
      rmSync(resultPath, { force: true });
      const reviewer = await runCommand({
        command: 'codex',
        args: [
          'exec',
          '--skip-git-repo-check',
          '--ignore-rules',
          '--ignore-user-config',
          '-c',
          `openai_base_url=${JSON.stringify(reviewerBaseUrl)}`,
          '--sandbox',
          'read-only',
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
      });
      if (reviewer.code !== 0) {
        const detail = (reviewer.stderr || reviewer.stdout).slice(-6000);
        lastFailure = reviewer.timedOut
          ? `Reviewer exceeded ${String(reviewerWallClockMs)}ms wall-clock budget: ${detail}`
          : `Reviewer process failed: ${detail}`;
        const nonRetryable = /model is not supported|unknown model|invalid model/iu.test(detail);
        if (nonRetryable || attempt === maxReviewerAttempts) break;
        const rateLimited =
          /rate limit exceeded|too many requests|try again in a few minutes/iu.test(detail);
        if (!rateLimited && concurrency === 1) {
          await recoverReviewer(
            reviewer.timedOut ? 'reviewer timeout' : 'reviewer process failure',
          );
        }
        await delay(rateLimited ? 45_000 : Math.min(4_000, attempt * 1_000));
        continue;
      }
      if (!existsSync(resultPath)) {
        lastFailure = 'Reviewer returned no final result artifact';
        if (attempt === maxReviewerAttempts) break;
        if (concurrency === 1) await recoverReviewer('missing result artifact');
        await delay(Math.min(4_000, attempt * 1_000));
        continue;
      }
      const threadEvent = reviewer.stdout
        .split(/\r?\n/u)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
        .find((event) => event.type === 'thread.started');
      reviewerThread =
        typeof threadEvent?.thread_id === 'string'
          ? threadEvent.thread_id
          : typeof threadEvent?.threadId === 'string'
            ? threadEvent.threadId
            : undefined;
      if (!reviewerThread) {
        lastFailure = 'Reviewer did not expose a task id for provenance';
        if (attempt === maxReviewerAttempts) break;
        if (concurrency === 1) await recoverReviewer('missing reviewer task id');
        await delay(Math.min(4_000, attempt * 1_000));
        continue;
      }
      output = readFileSync(resultPath, 'utf8');
      if (!output.trim()) {
        reviewerThread = undefined;
        lastFailure = 'Reviewer returned an empty final result';
        if (attempt === maxReviewerAttempts) break;
        if (concurrency === 1) await recoverReviewer('empty reviewer result');
        await delay(Math.min(4_000, attempt * 1_000));
        continue;
      }
      break;
    }

    if (!reviewerThread || output === undefined) throw new Error(lastFailure);
    const envelopePath = join(runRoot, 'import.json');
    writeFileSync(
      envelopePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          reviewer: {
            agentId: `chatgpt-web-reviewer:${reviewerThread}`,
            provider: 'chatgpt-web',
            model: reviewerModel,
          },
          reviews: [{ assignmentId: assignment.assignmentId, output }],
        },
        null,
        2,
      )}\n`,
    );
    return { assignment, runRoot, attempts, reviewerThread, envelopePath };
  } catch (error) {
    return {
      assignment,
      runRoot,
      attempts,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

async function worker(): Promise<void> {
  while (true) {
    const index = cursor;
    cursor += 1;
    const assignment = assignments[index];
    if (!assignment) return;
    const result = await reviewAssignment(assignment);
    try {
      if (result.failure) {
        infrastructureFailures += 1;
        failures.push({
          assignmentId: assignment.assignmentId,
          skill: assignment.skill,
          scenarioId: assignment.scenarioId,
          detail: result.failure,
        });
      } else {
        await queuedIngest(result);
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
          persisted: success,
          infrastructureFailure: !success,
        }),
      );
      if (success) rmSync(result.runRoot, { recursive: true, force: true });
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(concurrency, assignments.length) }, () => worker()),
);
await ingestTail;

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      dryRun: false,
      reviewerModel,
      reviewerBaseUrl,
      reasoningEffort,
      concurrency,
      maxPerSkill,
      maxReviewerAttempts,
      reviewerWallClockMs,
      requestedSkills,
      skippedExistingReviews: prepared.skippedExistingReviews,
      availableAssignments: prepared.preparedAssignments.length,
      queued: assignments.length,
      completed,
      persisted,
      infrastructureFailures,
      failures: failures.slice(0, 50),
    },
    null,
    2,
  ),
);
