import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { fixtureTextEquals, readFixtureText, writeFixtureFile } from './skill-eval-fixture-helpers';

export const KOTLIN_COROUTINE_SCENARIO = 'kotlin-engineering-full-task-1-individual';
export const KOTLIN_SEALED_SCENARIO = 'kotlin-engineering-full-task-2-individual';
export const KOTLIN_VERSION = '2.4.20';
export const KOTLIN_JAVA_VERSION = '27';
export const KOTLIN_COROUTINES_VERSION = '1.10.2';

const KOTLINC = process.env.KORY_EVAL_KOTLINC ?? '/opt/homebrew/bin/kotlinc';
const JAVA = process.env.KORY_EVAL_JAVA ?? '/opt/homebrew/opt/openjdk/bin/java';
const HOST_READINESS_TIMEOUT_MS = 30_000;
const M2 = resolve(import.meta.dir, '../../../.koryphaios/eval-tools/m2');
const COROUTINES_CORE = join(
  M2,
  'org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm',
  KOTLIN_COROUTINES_VERSION,
  `kotlinx-coroutines-core-jvm-${KOTLIN_COROUTINES_VERSION}.jar`,
);
const COROUTINES_TEST = join(
  M2,
  'org/jetbrains/kotlinx/kotlinx-coroutines-test-jvm',
  KOTLIN_COROUTINES_VERSION,
  `kotlinx-coroutines-test-jvm-${KOTLIN_COROUTINES_VERSION}.jar`,
);
const COROUTINES_CP = `${COROUTINES_CORE}:${COROUTINES_TEST}`;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(executable: string, args: string[], cwd: string, timeoutMs = 12_000): RunResult {
  const result = spawnSync(executable, args, {
    cwd,
    env: {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      HOME: cwd,
      LANG: 'C',
      LC_ALL: 'C',
      NO_COLOR: '1',
      JAVA_HOME: '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
    },
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1_000_000,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  };
}

export function kotlinHostReadiness(): string[] {
  const reasons: string[] = [];
  const compiler = run(KOTLINC, ['-version'], process.cwd(), HOST_READINESS_TIMEOUT_MS);
  const compilerText = `${compiler.stdout}${compiler.stderr}`;
  if (compiler.code !== 0 || !compilerText.includes(`kotlinc-jvm ${KOTLIN_VERSION}`))
    reasons.push(
      `Kotlin fixture requires kotlinc ${KOTLIN_VERSION}; observed ${compilerText.trim() || 'unavailable'}.`,
    );
  const java = run(JAVA, ['-version'], process.cwd(), HOST_READINESS_TIMEOUT_MS);
  const javaText = `${java.stdout}${java.stderr}`;
  if (java.code !== 0 || !javaText.includes(`openjdk version "${KOTLIN_JAVA_VERSION}"`))
    reasons.push(
      `Kotlin fixture requires OpenJDK ${KOTLIN_JAVA_VERSION}; observed ${javaText.split('\n')[0] || 'unavailable'}.`,
    );
  for (const jar of [COROUTINES_CORE, COROUTINES_TEST]) {
    if (!existsSync(jar))
      reasons.push(`Kotlin coroutine fixture requires pinned runtime jar ${jar}.`);
  }
  return reasons;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runtimeFiles(): Record<string, string> {
  return {
    '.kory-runtime/kotlinc': `#!/bin/sh\nexec ${shellQuote(KOTLINC)} "$@"\n`,
    '.kory-runtime/java': `#!/bin/sh\nexec ${shellQuote(JAVA)} "$@"\n`,
    '.kory-runtime/coroutines.classpath': `${COROUTINES_CP}\n`,
    '.kory-runtime/runtime.json': `${JSON.stringify(
      {
        runtime: 'kotlin-jvm',
        kotlin: KOTLIN_VERSION,
        java: KOTLIN_JAVA_VERSION,
        coroutines: KOTLIN_COROUTINES_VERSION,
        kotlinc: KOTLINC,
        javaExecutable: JAVA,
        coroutinesClasspath: COROUTINES_CP,
      },
      null,
      2,
    )}\n`,
  };
}

function materializeRuntime(root: string): void {
  for (const [path, content] of Object.entries(runtimeFiles())) {
    writeFixtureFile(root, path, content);
    if (path.endsWith('/kotlinc') || path.endsWith('/java')) chmodSync(join(root, path), 0o700);
  }
}

function intact(root: string, fixed: Record<string, string>): boolean {
  return Object.entries(fixed).every(([path, expected]) => fixtureTextEquals(root, path, expected));
}

function fail(evidence: string[], integrityFailure = false): SkillEvalDeterministicScore {
  return { passed: false, quality: 0, verification: 0, integrityFailure, evidence };
}

function kotlinTestText(root: string, patterns: RegExp[]): boolean {
  try {
    const tests = join(root, 'tests');
    if (!lstatSync(tests).isDirectory() || lstatSync(tests).isSymbolicLink()) return false;
    const text = readdirSync(tests)
      .filter((name) => name.endsWith('.kt'))
      .map((name) => readFixtureText(root, `tests/${name}`))
      .join('\n');
    return patterns.every((pattern) => pattern.test(text));
  } catch {
    return false;
  }
}

const COROUTINE_README = `# Kotlin structured coroutine ownership

Fix src/RequestService.kt. Request-bound work must be a child of the request and stop on parent cancellation/timeout/failure. Intentional durable work must transfer explicitly to the injected durableScope. Preserve the suspend handle API. The declared runtime is Kotlin ${KOTLIN_VERSION}, OpenJDK ${KOTLIN_JAVA_VERSION}, kotlinx-coroutines ${KOTLIN_COROUTINES_VERSION}; use ./.kory-runtime/kotlinc, ./.kory-runtime/java and the classpath file. Add virtual-time regressions for success, cancellation, timeout, request-child failure and durable ownership. Also set ProgressStore.failDurableWrites so a durable child itself fails under a SupervisorJob-owned durable scope, then prove that owner remains active and a later durable child still completes.
`;

const SEALED_README = `# Kotlin sealed-message queue compatibility

Fix src/QueueCodec.kt. The queue persists one JSON object per line with an explicit type discriminator. Known messages must remain ordered, unknown newer subtypes must be retained with their raw bytes and original index, malformed records must be quarantined without aborting later entries, and a newer codec must be able to reprocess retained supported messages after upgrade. Use the pinned Kotlin/JVM wrappers and add mixed-version/restart regressions. Treat this README, fixtures/, and .kory-runtime/ as fixed evaluator inputs; make implementation and regression changes only under src/ and tests/.
`;

const COROUTINE_STARTER = `package fixture

import kotlinx.coroutines.*

class ProgressStore {
    private val events = mutableListOf<String>()
    var failRequestWrites: Boolean = false
    var failDurableWrites: Boolean = false
    suspend fun write(event: String) {
        if (failRequestWrites && event.startsWith("request:")) throw IllegalStateException("request write failed")
        if (failDurableWrites && event.startsWith("durable:")) throw IllegalStateException("durable write failed")
        events += event
    }
    fun snapshot(): List<String> = events.toList()
}

class RequestService(
    private val store: ProgressStore,
    private val durableScope: CoroutineScope,
) {
    @OptIn(DelicateCoroutinesApi::class)
    suspend fun handle(id: String, startDurable: Boolean = false) {
        GlobalScope.launch {
            delay(100)
            store.write("request:$id")
        }
        if (startDurable) {
            GlobalScope.launch {
                delay(100)
                store.write("durable:$id")
            }
        }
    }
}
`;

export const KOTLIN_COROUTINE_CONTROL = `package fixture

import kotlinx.coroutines.*

class ProgressStore {
    private val events = mutableListOf<String>()
    var failRequestWrites: Boolean = false
    var failDurableWrites: Boolean = false
    suspend fun write(event: String) {
        if (failRequestWrites && event.startsWith("request:")) throw IllegalStateException("request write failed")
        if (failDurableWrites && event.startsWith("durable:")) throw IllegalStateException("durable write failed")
        events += event
    }
    fun snapshot(): List<String> = events.toList()
}

class RequestService(
    private val store: ProgressStore,
    private val durableScope: CoroutineScope,
) {
    suspend fun handle(id: String, startDurable: Boolean = false) = coroutineScope {
        if (startDurable) {
            durableScope.launch {
                delay(100)
                store.write("durable:$id")
            }
        }
        launch {
            delay(100)
            store.write("request:$id")
        }
    }
}
`;

const COROUTINE_HIDDEN = `import fixture.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*

fun main() = runTest {
    val durableJob = SupervisorJob()
    val durableFailures = mutableListOf<Throwable>()
    val durableScope = CoroutineScope(
        durableJob +
            StandardTestDispatcher(testScheduler) +
            CoroutineExceptionHandler { _, failure -> durableFailures += failure }
    )
    val store = ProgressStore()
    val service = RequestService(store, durableScope)

    service.handle("ok")
    check(store.snapshot() == listOf("request:ok")) { "normal request did not finish deterministically: ${'$'}{store.snapshot()}" }

    val cancelled = launch { service.handle("cancel") }
    runCurrent()
    cancelled.cancelAndJoin()
    advanceUntilIdle()
    check("request:cancel" !in store.snapshot()) { "cancelled request wrote progress" }

    try { withTimeout(50) { service.handle("timeout") } } catch (_: TimeoutCancellationException) {}
    advanceUntilIdle()
    check("request:timeout" !in store.snapshot()) { "timed out request wrote progress" }

    val durableRequest = launch { service.handle("durable", startDurable = true) }
    runCurrent()
    durableRequest.cancelAndJoin()
    advanceUntilIdle()
    check("request:durable" !in store.snapshot()) { "request child escaped cancellation" }
    check("durable:durable" in store.snapshot()) { "explicit durable work was cancelled with request" }

    store.failRequestWrites = true
    val failure = runCatching { service.handle("failure") }.exceptionOrNull()
    check(failure is IllegalStateException) { "child failure did not propagate: ${'$'}failure" }
    store.failRequestWrites = false

    store.failDurableWrites = true
    service.handle("durable-failure", startDurable = true)
    advanceUntilIdle()
    check(durableFailures.size == 1 && durableFailures.single() is IllegalStateException) {
        "durable child did not fail under supervisor ownership: ${'$'}durableFailures"
    }
    check(durableJob.isActive) { "durable supervisor was cancelled by child failure" }
    store.failDurableWrites = false
    service.handle("durable-recovery", startDurable = true)
    advanceUntilIdle()
    check("durable:durable-recovery" in store.snapshot()) {
        "durable owner could not run a later child after supervised failure: ${'$'}{store.snapshot()}"
    }

    durableJob.cancelAndJoin()
    println("KORY_KOTLIN_OK")
}
`;

const SEALED_STARTER = `package fixture

sealed interface Message { val id: String }
data class TextMessage(override val id: String, val text: String) : Message
data class ImageMessage(override val id: String, val url: String) : Message
data class VideoMessage(override val id: String, val url: String) : Message
data class IndexedMessage(val index: Int, val message: Message)
data class RetainedMessage(val index: Int, val raw: String, val reason: String)
data class QueueLoad(val known: List<IndexedMessage>, val retained: List<RetainedMessage>)

class QueueCodec(private val supportsVideo: Boolean = false) {
    fun load(lines: List<String>): QueueLoad {
        val known = lines.mapIndexed { index, raw -> IndexedMessage(index, decode(raw)) }
        return QueueLoad(known, emptyList())
    }
    fun reprocess(previous: QueueLoad): QueueLoad = load(
        (previous.known.map { it.index to encode(it.message) } + previous.retained.map { it.index to it.raw })
            .sortedBy { it.first }.map { it.second }
    )
    private fun decode(raw: String): Message {
        val type = field(raw, "type") ?: error("malformed")
        val id = field(raw, "id") ?: error("malformed")
        return when (type) {
            "text" -> TextMessage(id, field(raw, "text") ?: error("malformed"))
            "image" -> ImageMessage(id, field(raw, "url") ?: error("malformed"))
            "video" -> if (supportsVideo) VideoMessage(id, field(raw, "url") ?: error("malformed")) else error("unknown type video")
            else -> error("unknown type $type")
        }
    }
    private fun encode(message: Message): String = when (message) {
        is TextMessage -> """{"type":"text","id":"${'$'}{message.id}","text":"${'$'}{message.text}"}"""
        is ImageMessage -> """{"type":"image","id":"${'$'}{message.id}","url":"${'$'}{message.url}"}"""
        is VideoMessage -> """{"type":"video","id":"${'$'}{message.id}","url":"${'$'}{message.url}"}"""
    }
    private fun field(raw: String, name: String): String? = Regex("""["]${'$'}name["]\\s*:\\s*["]([^"]*)["]""").find(raw)?.groupValues?.get(1)
}
`;

export const KOTLIN_SEALED_CONTROL = `package fixture

sealed interface Message { val id: String }
data class TextMessage(override val id: String, val text: String) : Message
data class ImageMessage(override val id: String, val url: String) : Message
data class VideoMessage(override val id: String, val url: String) : Message
data class IndexedMessage(val index: Int, val message: Message)
data class RetainedMessage(val index: Int, val raw: String, val reason: String)
data class QueueLoad(val known: List<IndexedMessage>, val retained: List<RetainedMessage>)

class QueueCodec(private val supportsVideo: Boolean = false) {
    fun load(lines: List<String>): QueueLoad {
        val known = mutableListOf<IndexedMessage>()
        val retained = mutableListOf<RetainedMessage>()
        lines.forEachIndexed { index, raw ->
            when (val decoded = decode(raw)) {
                is Decode.Known -> known += IndexedMessage(index, decoded.message)
                is Decode.Retain -> retained += RetainedMessage(index, raw, decoded.reason)
            }
        }
        return QueueLoad(known, retained)
    }
    fun reprocess(previous: QueueLoad): QueueLoad {
        val all = previous.known.map { it.index to encode(it.message) } + previous.retained.map { it.index to it.raw }
        val known = mutableListOf<IndexedMessage>()
        val retained = mutableListOf<RetainedMessage>()
        for ((index, raw) in all.sortedBy { it.first }) {
            when (val decoded = decode(raw)) {
                is Decode.Known -> known += IndexedMessage(index, decoded.message)
                is Decode.Retain -> retained += RetainedMessage(index, raw, decoded.reason)
            }
        }
        return QueueLoad(known, retained)
    }
    private sealed interface Decode { data class Known(val message: Message): Decode; data class Retain(val reason: String): Decode }
    private fun decode(raw: String): Decode {
        if (!raw.trim().let { it.startsWith("{") && it.endsWith("}") }) return Decode.Retain("malformed")
        val type = field(raw, "type") ?: return Decode.Retain("malformed")
        val id = field(raw, "id") ?: return Decode.Retain("malformed")
        return when (type) {
            "text" -> field(raw, "text")?.let { Decode.Known(TextMessage(id, it)) } ?: Decode.Retain("malformed")
            "image" -> field(raw, "url")?.let { Decode.Known(ImageMessage(id, it)) } ?: Decode.Retain("malformed")
            "video" -> if (supportsVideo) field(raw, "url")?.let { Decode.Known(VideoMessage(id, it)) } ?: Decode.Retain("malformed") else Decode.Retain("unknown:video")
            else -> Decode.Retain("unknown:$type")
        }
    }
    private fun encode(message: Message): String = when (message) {
        is TextMessage -> """{"type":"text","id":"${'$'}{message.id}","text":"${'$'}{message.text}"}"""
        is ImageMessage -> """{"type":"image","id":"${'$'}{message.id}","url":"${'$'}{message.url}"}"""
        is VideoMessage -> """{"type":"video","id":"${'$'}{message.id}","url":"${'$'}{message.url}"}"""
    }
    private fun field(raw: String, name: String): String? = Regex("""["]${'$'}name["]\\s*:\\s*["]([^"]*)["]""").find(raw)?.groupValues?.get(1)
}
`;

const SEALED_CORPUS = `{"type":"text","id":"t1","text":"hello"}
{"type":"video","id":"v1","url":"video://1"}
not-json
{"type":"image","id":"i1","url":"image://1"}
`;

const SEALED_HIDDEN = `import fixture.*
import java.nio.file.Files
import java.nio.file.Path

fun main() {
    val lines = Files.readAllLines(Path.of("fixtures/mixed.jsonl"))
    val old = QueueCodec(false)
    val first = old.load(lines)
    check(first.known.map { it.index } == listOf(0, 3)) { "known ordering ${'$'}{first.known}" }
    check(first.retained.map { it.index } == listOf(1, 2)) { "retained indexes ${'$'}{first.retained}" }
    check(first.retained[0].raw.contains("video")) { "unknown payload lost" }
    val restart = old.load(lines)
    check(restart == first) { "old-build restart is not deterministic" }
    val upgraded = QueueCodec(true).reprocess(first)
    check(upgraded.known.map { it.index } == listOf(0, 1, 3)) { "upgrade ordering ${'$'}{upgraded.known}" }
    check(upgraded.known[1].message is VideoMessage) { "retained video was not reprocessed" }
    check(upgraded.retained.size == 1 && upgraded.retained[0].index == 2 && upgraded.retained[0].raw == "not-json") { "malformed record not retained" }
    val secondRestart = QueueCodec(true).reprocess(upgraded)
    check(secondRestart == upgraded) { "new-build restart is not stable" }
    println("KORY_KOTLIN_OK")
}
`;

function scoreKotlin(
  root: string,
  sourcePath: string,
  hidden: string,
  readme: string,
  patterns: RegExp[],
  withCoroutines: boolean,
  extraFixed: Record<string, string> = {},
): SkillEvalDeterministicScore {
  const fixed = { ...runtimeFiles(), 'README.md': readme, ...extraFixed };
  if (!intact(root, fixed))
    return fail(['Changed, missing or symlinked Kotlin runtime/contract input.'], true);
  const source = existsSync(join(root, sourcePath))
    ? readFileSync(join(root, sourcePath), 'utf8')
    : '';
  const noGlobalScope = !withCoroutines || !/\bGlobalScope\b/u.test(source);
  const regression = kotlinTestText(root, patterns);
  const nonce = randomUUID().replaceAll('-', '');
  const hiddenStem = `__KoryHidden_${nonce}`;
  const hiddenPath = `${hiddenStem}.kt`;
  const jarPath = `.kory-hidden-${nonce}.jar`;
  writeFixtureFile(root, hiddenPath, hidden);
  try {
    const compileArgs = [sourcePath, hiddenPath];
    if (withCoroutines) compileArgs.push('-cp', COROUTINES_CP);
    compileArgs.push('-include-runtime', '-d', jarPath);
    const compile = run(join(root, '.kory-runtime/kotlinc'), compileArgs, root, 15_000);
    if (compile.code !== 0 || compile.timedOut) {
      return {
        passed: false,
        quality: 0,
        verification: 0,
        integrityFailure: false,
        evidence: [
          `Kotlin compile: ${compile.timedOut ? 'timeout' : 'fail'}`,
          `GlobalScope absent: ${noGlobalScope ? 'yes' : 'no'}`,
          `candidate regression coverage: ${regression ? 'present' : 'missing'}`,
          `${compile.stdout}\n${compile.stderr}`.slice(-6000),
        ],
      };
    }
    const classpath = withCoroutines ? `${jarPath}:${COROUTINES_CP}` : jarPath;
    const execute = run(
      join(root, '.kory-runtime/java'),
      ['-cp', classpath, `${hiddenStem}Kt`],
      root,
      10_000,
    );
    const runtimePassed =
      execute.code === 0 && !execute.timedOut && /KORY_KOTLIN_OK/u.test(execute.stdout);
    const passed = runtimePassed && noGlobalScope && regression;
    return {
      passed,
      quality: passed ? 1 : runtimePassed && noGlobalScope ? 0.8 : 0,
      verification: runtimePassed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `Kotlin ${KOTLIN_VERSION}/JDK ${KOTLIN_JAVA_VERSION} runtime checks: ${runtimePassed ? 'pass' : execute.timedOut ? 'timeout' : 'fail'}`,
        ...(withCoroutines
          ? [
              `kotlinx-coroutines ${KOTLIN_COROUTINES_VERSION} virtual-time checks: ${runtimePassed ? 'pass' : 'fail'}`,
            ]
          : []),
        `GlobalScope absent: ${noGlobalScope ? 'yes' : 'no'}`,
        `candidate regression coverage: ${regression ? 'present' : 'missing'}`,
        `${execute.stdout}\n${execute.stderr}`.slice(-6000),
      ],
    };
  } finally {
    rmSync(join(root, hiddenPath), { force: true });
    rmSync(join(root, jarPath), { force: true });
  }
}

export const V5_KOTLIN_HOST_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'kotlin-engineering/actual-coroutine-ownership@2',
    realRuntime: true,
    readinessBlockers: kotlinHostReadiness(),
    matches: (scenario) => scenario.id === KOTLIN_COROUTINE_SCENARIO,
    materialize: (root) => {
      materializeRuntime(root);
      writeFixtureFile(root, 'README.md', COROUTINE_README);
      writeFixtureFile(root, 'src/RequestService.kt', COROUTINE_STARTER);
      writeFixtureFile(
        root,
        'tests/regression.kt',
        '// Add virtual-time assertions for cancellation, timeout, child failure, durable ownership and no post-request progress writes.\n',
      );
    },
  },
  {
    id: 'kotlin-engineering/actual-sealed-json-retention@2',
    realRuntime: true,
    readinessBlockers: kotlinHostReadiness(),
    matches: (scenario) => scenario.id === KOTLIN_SEALED_SCENARIO,
    materialize: (root) => {
      materializeRuntime(root);
      writeFixtureFile(root, 'README.md', SEALED_README);
      writeFixtureFile(root, 'fixtures/mixed.jsonl', SEALED_CORPUS);
      writeFixtureFile(root, 'src/QueueCodec.kt', SEALED_STARTER);
      writeFixtureFile(
        root,
        'tests/regression.kt',
        '// Add mixed-version, unknown subtype, malformed retention, ordering, upgrade reprocess and repeated restart assertions.\n',
      );
    },
  },
];

export const V5_KOTLIN_HOST_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'kotlin-engineering/actual-coroutine-ownership-scorer@2',
    scenarioIds: [KOTLIN_COROUTINE_SCENARIO],
    score: ({ workingDirectory }) =>
      scoreKotlin(
        workingDirectory,
        'src/RequestService.kt',
        COROUTINE_HIDDEN,
        COROUTINE_README,
        [
          /cancel|timeout|virtual|testScheduler|advance/iu,
          /failure|durable|orphan|progress|request/iu,
          /failDurableWrites|durable.{0,80}fail/isu,
          /SupervisorJob|supervisorScope/iu,
          /recovery|after.{0,80}fail|later.{0,80}durable|sibling/isu,
        ],
        true,
      ),
  },
  {
    id: 'kotlin-engineering/actual-sealed-json-retention-scorer@2',
    scenarioIds: [KOTLIN_SEALED_SCENARIO],
    score: ({ workingDirectory }) =>
      scoreKotlin(
        workingDirectory,
        'src/QueueCodec.kt',
        SEALED_HIDDEN,
        SEALED_README,
        [/unknown|subtype|retain|quarantin/iu, /order|restart|reprocess|upgrade|malform/iu],
        false,
        { 'fixtures/mixed.jsonl': SEALED_CORPUS },
      ),
  },
];
