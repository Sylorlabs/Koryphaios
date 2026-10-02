import type { SkillDefinition } from './skills';

interface SpecialistProfile {
  name: string;
  description: string;
  domains: string[];
  broader: string[];
  activation: string[];
  focus: string;
  verify: string;
  avoid: string;
  media?: string[];
  facets?: string[];
  requires?: string[];
  conflicts?: string[];
  excludes?: string[];
  evidence?: string[];
}

function specialist(profile: SpecialistProfile): SpecialistProfile {
  return profile;
}

const IMPLEMENTATION_VERIFY = ['verification'];

/**
 * Library V4 specialists deliberately describe professional responsibilities,
 * not package-manager shortcuts. Routing metadata stays small; deep practice is
 * rendered only after selection through SPECIALIST_SKILL_PLAYBOOKS below.
 */
const SPECIALIST_PROFILES: SpecialistProfile[] = [
  specialist({
    name: 'typescript-javascript-engineering',
    description:
      'Engineer TypeScript and JavaScript systems with sound runtime, type, module, and async boundaries',
    domains: ['code', 'typescript', 'javascript'],
    broader: ['implementation'],
    activation: ['typescript', 'javascript', 'ecmascript', 'tsx'],
    focus:
      'Model the JavaScript runtime separately from TypeScript static guarantees. Trace module format, package exports, async ownership, cancellation, serialization, structural typing, narrowing, and generated declarations before changing public contracts. Prefer types that encode real invariants without forcing consumers through unsafe assertions.',
    verify:
      'Run the repository typecheck plus representative runtime tests in every supported module/runtime target. Exercise rejected promises, cancellation, ESM/CJS boundaries, serialized data, and emitted declarations when they are part of the contract.',
    avoid:
      'Do not use any, non-null assertions, type casts, or transpilation success to conceal an unresolved runtime contract. Do not assume Node, browser, or Bun semantics without repository evidence.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'python-engineering',
    description:
      'Engineer Python applications and libraries with explicit typing, packaging, concurrency, and runtime behavior',
    domains: ['code', 'python'],
    broader: ['implementation'],
    activation: ['python', 'pyproject', 'pytest', 'asyncio'],
    focus:
      'Confirm supported Python versions, packaging layout, interpreter environment, type-checking policy, and sync or async execution model. Keep import side effects, mutable defaults, resource lifetimes, exception boundaries, and data-model semantics explicit. Use protocols and dataclasses or validated models when they clarify ownership rather than merely adding ceremony.',
    verify:
      'Run the project formatter or linter only when configured, static checks when authoritative, and focused pytest or runtime checks under a supported interpreter. Cover exception, cancellation, context-manager cleanup, timezone, and serialization boundaries where relevant.',
    avoid:
      'Do not mutate global interpreter state to make tests pass, confuse virtual-environment state with project dependencies, swallow broad exceptions, or rely on dynamic behavior that contradicts declared types.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'rust-engineering',
    description:
      'Engineer Rust systems around ownership, lifetimes, concurrency, unsafe boundaries, and stable public contracts',
    domains: ['code', 'rust'],
    broader: ['implementation'],
    activation: ['rustlang', 'rust crate', 'cargo workspace', 'borrow checker'],
    focus:
      'Use ownership and lifetimes to express resource responsibility rather than fighting the borrow checker with cloning or interior mutability. Inspect Send/Sync assumptions, pinning, async cancellation, error types, feature flags, trait coherence, and unsafe blocks at their actual invariants. Keep public APIs conservative and semver-aware.',
    verify:
      'Run cargo check or the repository build matrix plus focused tests for ownership-sensitive behavior, async cancellation, feature combinations, and unsafe invariants. Use Miri, sanitizers, or loom-style concurrency checks when the risk and toolchain support justify them.',
    avoid:
      'Do not add unsafe, leak resources, clone large state, or wrap everything in Arc<Mutex<_>> merely to satisfy compilation. Compilation alone does not prove aliasing, concurrency, or FFI correctness.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'go-engineering',
    description:
      'Engineer Go services and libraries with disciplined interfaces, goroutine lifecycles, context propagation, and module boundaries',
    domains: ['code', 'go'],
    broader: ['implementation'],
    activation: ['golang', 'go module', 'go package', 'go service'],
    focus:
      'Keep interfaces consumer-owned and small. Trace goroutine ownership, context cancellation, channel closure, error wrapping, zero values, module versions, and allocation behavior. Prefer straightforward composition over framework-like abstraction and make background work stoppable and observable.',
    verify:
      'Run go test across affected packages, race detection for concurrent changes when feasible, and representative cancellation or shutdown tests. Check module and generated-code changes explicitly and benchmark only when performance is part of the claim.',
    avoid:
      'Do not launch orphan goroutines, close channels from receivers, discard context, compare wrapped errors by string, or create interfaces solely for mocking.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'java-jvm-engineering',
    description:
      'Engineer Java and JVM systems with explicit concurrency, memory, compatibility, build, and framework lifecycle boundaries',
    domains: ['code', 'java', 'jvm'],
    broader: ['implementation'],
    activation: ['java', 'jvm', 'maven', 'gradle java'],
    focus:
      'Confirm language and JVM targets, build tool, dependency graph, nullability conventions, framework lifecycle, and concurrency model. Treat object identity, mutability, equals/hashCode, classloading, reflection, thread pools, and resource cleanup as contracts. Preserve binary and serialization compatibility where consumers depend on it.',
    verify:
      'Run the authoritative Gradle or Maven checks plus focused tests across supported runtime targets. Exercise shutdown, interrupted work, null and serialization boundaries, and migration compatibility when public models change.',
    avoid:
      'Do not hide lifecycle state in static singletons, block managed event loops, depend on unspecified iteration or reflection order, or add framework annotations without understanding ownership and scope.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'kotlin-engineering',
    description:
      'Engineer Kotlin systems with null-safety, coroutine structure, Java interoperability, and stable data contracts',
    domains: ['code', 'kotlin', 'jvm'],
    broader: ['implementation'],
    activation: ['kotlin', 'kotlin coroutine', 'ktor', 'gradle kotlin'],
    focus:
      'Use Kotlin nullability and sealed types to represent domain states rather than relying on !! or sentinel values. Keep coroutine scopes structured, dispatcher choices explicit, Flow collection lifecycle bounded, and Java interop annotations intentional. Distinguish data-class convenience from stable persistence or wire formats.',
    verify:
      'Run the configured Kotlin/JVM or multiplatform checks, coroutine tests with cancellation and failure propagation, and Java interop tests when public APIs cross the boundary.',
    avoid:
      'Do not leak GlobalScope work, block coroutine dispatchers, force unwrap nullable values, or assume Kotlin/JVM behavior applies unchanged to native or JS targets.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'swift-engineering',
    description:
      'Engineer Swift systems with value semantics, actor isolation, async lifecycles, package boundaries, and Apple runtime constraints',
    domains: ['code', 'swift'],
    broader: ['implementation'],
    activation: ['swift language', 'swift package', 'swift concurrency', 'swift actor'],
    focus:
      'Choose value versus reference semantics intentionally, preserve Sendable and actor isolation, model ownership around ARC, and treat Task cancellation as part of API behavior. Inspect platform availability, package products, Codable compatibility, and Objective-C interoperability before changing public interfaces.',
    verify:
      'Run the supported Swift package or Xcode test path, exercise actor isolation and cancellation, and validate on the actual supported Apple platform when platform APIs or UI lifecycles are involved.',
    avoid:
      'Do not silence concurrency warnings with unchecked annotations, retain cycles through closures, force unwrap routine data, or infer device behavior from host-only tests.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'c-cpp-systems-engineering',
    description:
      'Engineer C and C++ systems around memory ownership, ABI, undefined behavior, concurrency, toolchains, and performance',
    domains: ['code', 'c', 'cpp', 'systems'],
    broader: ['implementation'],
    activation: ['c++', 'cpp', 'cmake', 'native abi'],
    focus:
      'Establish compiler, language standard, ABI, allocation ownership, object lifetime, thread model, and error conventions before changing interfaces. In C++, use RAII and value semantics deliberately; in C, make ownership and buffer lengths explicit. Treat FFI, alignment, aliasing, integer conversion, and undefined behavior as first-class risks.',
    verify:
      'Run the configured build matrix and focused tests under sanitizers or static analysis when available. Exercise boundary sizes, allocation failure where modeled, concurrency, ABI consumers, and optimized builds for behavior sensitive to undefined assumptions.',
    avoid:
      'Do not rely on compiler extensions accidentally, mix allocators across ownership boundaries, return dangling views, suppress warnings blindly, or interpret debug-build success as proof against UB.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'csharp-dotnet-engineering',
    description:
      'Engineer C# and .NET systems with async discipline, dependency lifetimes, nullability, serialization, and runtime compatibility',
    domains: ['code', 'csharp', 'dotnet'],
    broader: ['implementation'],
    activation: ['c#', 'csharp', '.net', 'dotnet'],
    focus:
      'Confirm target frameworks, nullable context, hosting model, dependency lifetimes, async flow, and serializer configuration. Keep IDisposable/IAsyncDisposable ownership explicit, propagate CancellationToken through meaningful boundaries, and treat records, equality, reflection, trimming, and AOT behavior as contractual where deployed.',
    verify:
      'Run dotnet build/test for supported target frameworks, exercise cancellation and disposal, and validate serialization, trimming, or AOT paths when affected.',
    avoid:
      'Do not block async tasks with .Result or .Wait in request paths, capture scoped services in singletons, suppress nullable warnings without proof, or depend on reflection that deployment modes remove.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'ruby-engineering',
    description:
      'Engineer Ruby systems with explicit object boundaries, dependency behavior, metaprogramming restraint, and runtime observability',
    domains: ['code', 'ruby'],
    broader: ['implementation'],
    activation: ['ruby', 'bundler', 'rake task', 'ruby gem'],
    focus:
      'Confirm Ruby and gem versions, runtime entry points, dependency ownership, mutation patterns, and concurrency assumptions. Prefer explicit objects and messages over hidden metaprogramming, keep monkey patches narrowly scoped, and preserve exception context and transaction boundaries.',
    verify:
      'Run the project test suite and linting only as configured, reproduce behavior under the supported Ruby version, and cover transaction rollback, nil handling, time, encoding, and concurrency when relevant.',
    avoid:
      'Do not patch global classes for local convenience, rescue Exception broadly, depend on load order accidentally, or let implicit ActiveSupport behavior leak into library contracts.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'php-engineering',
    description:
      'Engineer PHP applications and libraries with type, request lifecycle, dependency, persistence, and runtime-version discipline',
    domains: ['code', 'php'],
    broader: ['implementation'],
    activation: ['php', 'composer package', 'phpstan', 'laravel php'],
    focus:
      'Confirm PHP target versions, Composer constraints, request lifecycle, autoloading, strict-types policy, framework container scope, and persistence boundaries. Use enums, value objects, and typed APIs where they encode domain invariants while keeping interoperability with existing consumers.',
    verify:
      'Run Composer validation plus configured static analysis and tests. Exercise request isolation, serialization, database rollback, timezone, and version-specific behavior for changed contracts.',
    avoid:
      'Do not depend on mutable process globals, hide dynamic-property behavior behind suppressions, weaken Composer constraints casually, or confuse framework helper availability with portable PHP.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'shell-cli-engineering',
    description:
      'Engineer shell scripts and command-line programs with quoting, portability, pipelines, exit semantics, and safe automation',
    domains: ['code', 'shell', 'cli'],
    broader: ['terminal-interface'],
    activation: ['shell script', 'bash script', 'zsh script', 'command line script'],
    focus:
      'Treat quoting, word splitting, globbing, environment inheritance, signals, stdin/stdout/stderr, working directories, and exit codes as interfaces. Prefer structured arguments over eval or string-built commands and declare portability assumptions between POSIX shell, Bash, Zsh, and platform utilities.',
    verify:
      'Exercise paths with spaces and special characters, missing inputs, failed child commands, interrupted execution, non-interactive use, and the supported shell/runtime. Check output remains machine-consumable when automation depends on it.',
    avoid:
      'Do not eval untrusted text, parse human-formatted output when a stable interface exists, overwrite broad paths through unresolved variables, or make success depend on interactive shell configuration.',
    requires: IMPLEMENTATION_VERIFY,
  }),

  specialist({
    name: 'react-engineering',
    description:
      'Engineer React interfaces with explicit state ownership, rendering boundaries, effect lifecycles, accessibility, and performance',
    domains: ['code', 'frontend', 'react'],
    broader: ['frontend-engineering'],
    activation: ['react component', 'react hook', 'react app', 'react jsx'],
    media: ['web'],
    focus:
      'Separate server or external state, durable application state, URL state, and ephemeral view state. Keep render functions pure, effects synchronized to external systems rather than used as general control flow, and component boundaries aligned to ownership. Preserve semantic HTML and existing design-system primitives.',
    verify:
      'Exercise real user interactions, rerenders, async races, unmount or navigation cleanup, keyboard behavior, loading/error/empty states, and performance-sensitive lists or transitions in the supported browser runtime.',
    avoid:
      'Do not mirror props into state without a synchronization contract, use effects to derive renderable values, hide unstable dependencies, or memoize indiscriminately.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'svelte-engineering',
    description:
      'Engineer Svelte interfaces with precise reactivity, lifecycle, stores, runes, transitions, and component contracts',
    domains: ['code', 'frontend', 'svelte'],
    broader: ['frontend-engineering'],
    activation: ['svelte component', 'sveltekit', 'svelte rune', 'svelte store'],
    media: ['web'],
    focus:
      'Confirm the Svelte generation and project conventions before choosing legacy reactive syntax, stores, or runes. Keep ownership of state and derived values explicit, avoid lifecycle work that can be expressed declaratively, and preserve SSR/browser boundaries in SvelteKit. Reuse shared Koryphaios controls rather than native browser controls where repository rules require it.',
    verify:
      'Run Svelte checks and focused component tests, then verify interaction, SSR/hydration when applicable, async races, navigation cleanup, focus, and representative rendered states.',
    avoid:
      'Do not mix reactivity generations accidentally, mutate state in opaque helpers that bypass tracking, access browser globals during SSR, or recreate shared controls locally.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'vue-engineering',
    description:
      'Engineer Vue interfaces with disciplined Composition API state, reactivity, component contracts, routing, and rendering',
    domains: ['code', 'frontend', 'vue'],
    broader: ['frontend-engineering'],
    activation: ['vue component', 'vue composition api', 'vue router', 'nuxt vue'],
    media: ['web'],
    focus:
      'Use refs, reactive objects, computed values, and watchers according to ownership and side-effect semantics. Keep composables focused on reusable behavior, component props/events explicit, and routing or SSR state bounded. Understand ref unwrapping and proxy identity before depending on equality or serialization.',
    verify:
      'Exercise component state transitions, watcher cleanup, routing, hydration when applicable, keyboard semantics, async loading/error states, and representative production build behavior.',
    avoid:
      'Do not use deep watchers as a substitute for state design, destructure reactive state in ways that lose tracking, or hide cross-component mutation in global singletons.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'angular-engineering',
    description:
      'Engineer Angular applications with explicit dependency scopes, signals or RxJS lifecycles, templates, routing, and change detection',
    domains: ['code', 'frontend', 'angular'],
    broader: ['frontend-engineering'],
    activation: ['angular component', 'angular service', 'angular signals', 'angular rxjs'],
    media: ['web'],
    focus:
      'Confirm Angular version and standalone/module conventions. Make DI lifetime, signal ownership, observable completion, template data flow, forms, routing, and change-detection expectations explicit. Prefer typed forms and narrow services over ambient mutable state.',
    verify:
      'Run Angular build/tests and exercise routing, form validation, subscription cleanup, async error states, keyboard behavior, and change-detection-sensitive interactions.',
    avoid:
      'Do not subscribe without lifecycle ownership, mutate shared service state invisibly, bypass template type checking, or mix incompatible reactive patterns without a reason.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'nextjs-engineering',
    description:
      'Engineer Next.js applications with clear server/client boundaries, routing, caching, rendering, actions, and deployment semantics',
    domains: ['code', 'frontend', 'nextjs'],
    broader: ['web-interface'],
    activation: ['next.js', 'nextjs', 'next app router', 'next server action'],
    media: ['web'],
    focus:
      'Confirm router generation and deployment target. Trace each dependency and data access across server components, client components, route handlers, actions, middleware, and caches. Treat revalidation, cookies, headers, dynamic rendering, streaming, and build-time execution as explicit contracts.',
    verify:
      'Exercise direct navigation, refresh, deep links, server/client transitions, cache invalidation, auth state, deployment build, and representative production runtime behavior.',
    avoid:
      'Do not add use client broadly, fetch the same authoritative data redundantly across boundaries, rely on development cache behavior, or leak secrets into client bundles.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'nodejs-runtime',
    description:
      'Engineer Node.js runtime systems with event-loop, stream, process, module, resource, and shutdown discipline',
    domains: ['code', 'backend', 'nodejs'],
    broader: ['backend-engineering'],
    activation: ['node.js', 'nodejs', 'node stream', 'node process'],
    focus:
      'Confirm Node version and module mode. Keep event-loop blocking, worker threads, streams/backpressure, AbortSignal propagation, child processes, handles, file descriptors, environment, and process signals explicit. Use runtime-native diagnostics before adding concurrency or retries.',
    verify:
      'Exercise shutdown, cancellation, stream errors, partial writes, process failures, memory-sensitive workloads, and supported Node versions in addition to focused tests.',
    avoid:
      'Do not block the event loop with CPU or sync I/O in latency-sensitive paths, ignore stream backpressure, leak timers/handles, or depend on undocumented internals.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'bun-deno-runtime',
    description:
      'Engineer Bun and Deno systems by validating runtime-specific APIs, compatibility, packaging, permissions, and deployment behavior',
    domains: ['code', 'backend', 'bun', 'deno'],
    broader: ['backend-engineering'],
    activation: ['bun runtime', 'bun test', 'deno runtime', 'deno deploy'],
    focus:
      'Treat Bun and Deno as distinct runtimes rather than generic Node replacements. Confirm supported versions, package-resolution mode, web/API compatibility, native extensions, permission model, lockfile behavior, test runner semantics, and deployment target before using runtime-specific shortcuts.',
    verify:
      'Run the exact runtime and version used by the project, exercise package resolution, file/network permissions, subprocesses, server shutdown, and compatibility-sensitive dependencies.',
    avoid:
      'Do not infer Node parity from API names, mix lockfiles casually, bypass Deno permissions for convenience, or rely on runtime-specific behavior without a version boundary.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'ios-swiftui',
    description:
      'Engineer iOS and SwiftUI applications with state ownership, navigation, lifecycle, concurrency, accessibility, and platform conventions',
    domains: ['code', 'frontend', 'ios', 'swiftui'],
    broader: ['native-interface'],
    activation: ['swiftui', 'ios app', 'uikit ios', 'ios navigation'],
    media: ['native'],
    focus:
      'Model source-of-truth state, environment dependencies, navigation identity, scene lifecycle, task cancellation, persistence, and UIKit bridges explicitly. Use platform controls and accessibility semantics unless a custom behavior has demonstrated value. Respect safe areas, Dynamic Type, localization, and reduced motion.',
    verify:
      'Test representative devices or faithful simulators across lifecycle interruption, navigation restoration, keyboard/focus, Dynamic Type, VoiceOver-sensitive semantics, permissions, offline state, and background/foreground transitions.',
    avoid:
      'Do not key views by unstable identity, start unbounded tasks from body evaluation, assume simulator success proves device integrations, or override platform behavior for purely visual reasons.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'android-compose',
    description:
      'Engineer Android and Jetpack Compose applications with lifecycle-aware state, navigation, coroutines, accessibility, and device constraints',
    domains: ['code', 'frontend', 'android', 'compose'],
    broader: ['native-interface'],
    activation: ['jetpack compose', 'android app', 'compose ui', 'android lifecycle'],
    media: ['native'],
    focus:
      'Separate durable domain state from composable state, collect flows with lifecycle awareness, use stable keys and state restoration intentionally, and keep navigation/back behavior aligned with platform conventions. Account for configuration changes, process death, insets, density, accessibility services, and permission lifecycles.',
    verify:
      'Exercise configuration/process recreation, navigation/back, offline/error states, TalkBack-sensitive semantics, font scaling, permission denial, and representative physical-device behavior for hardware integrations.',
    avoid:
      'Do not launch work from recomposition without lifecycle control, retain Activity references in long-lived state, assume preview behavior equals runtime, or ignore state restoration.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'react-native-expo',
    description:
      'Engineer React Native and Expo applications across JavaScript, native modules, navigation, lifecycle, offline, and platform behavior',
    domains: ['code', 'frontend', 'react-native', 'expo'],
    broader: ['native-interface'],
    activation: ['react native', 'expo app', 'expo router', 'native module expo'],
    media: ['native'],
    focus:
      'Confirm Expo SDK, development-client requirements, routing model, native dependencies, and supported platforms. Keep JavaScript state, native module lifecycles, permissions, app state, deep links, safe areas, keyboard behavior, and over-the-air update boundaries explicit.',
    verify:
      'Run on representative iOS and Android environments, including cold start, background/foreground, deep link, offline, permission denial, keyboard, and native-module paths. Distinguish Expo Go proof from custom development-client or production-build proof.',
    avoid:
      'Do not assume web DOM/CSS behavior, install native packages without checking Expo compatibility, rely on Expo Go for unsupported native modules, or hide platform differences behind fragile conditionals.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'desktop-electron-tauri',
    description:
      'Engineer Electron and Tauri desktop applications with process boundaries, IPC, filesystem authority, updates, packaging, and native behavior',
    domains: ['code', 'frontend', 'desktop'],
    broader: ['native-interface'],
    activation: ['electron app', 'tauri app', 'desktop webview', 'electron ipc'],
    media: ['native'],
    focus:
      'Trace renderer/webview, privileged host process, IPC commands, filesystem paths, deep links, windows, tray behavior, updates, signing, and packaging as separate trust and lifecycle boundaries. Keep privileged operations narrow and validate every renderer-originated input at the enforcing side.',
    verify:
      'Exercise packaged builds, multi-window lifecycle, IPC denial paths, filesystem permissions, update/restart behavior, platform shortcuts, and native window state on supported operating systems.',
    avoid:
      'Do not expose broad shell/filesystem primitives to the renderer, treat browser dev mode as packaged proof, disable web security for convenience, or conflate Electron and Tauri security models.',
    facets: ['application-security'],
    requires: IMPLEMENTATION_VERIFY,
  }),

  specialist({
    name: 'relational-data-modeling',
    description:
      'Design relational schemas around invariants, keys, normalization, lifecycle, transactions, and query access patterns',
    domains: ['data', 'database', 'relational'],
    broader: ['backend-engineering'],
    activation: [
      'relational schema',
      'database schema',
      'foreign key design',
      'normalization database',
    ],
    focus:
      'Start from entities, identities, invariants, lifecycle, cardinality, ownership, retention, and access patterns. Encode durable constraints in the database when it is the authority, normalize by default, and denormalize only with an explicit consistency and refresh contract. Treat nullability and time as domain decisions.',
    verify:
      'Validate representative inserts, updates, deletes, concurrent transactions, migrations, uniqueness, referential integrity, and high-value query plans against realistic data shapes.',
    avoid:
      'Do not use JSON columns to postpone every modeling decision, rely solely on application validation for database invariants, or choose surrogate keys without understanding natural uniqueness.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'postgres-engineering',
    description:
      'Engineer PostgreSQL schemas, queries, transactions, indexes, extensions, replication, and operational behavior',
    domains: ['data', 'database', 'postgres'],
    broader: ['relational-data-modeling'],
    activation: ['postgresql', 'postgres query', 'postgres index', 'psql'],
    focus:
      'Confirm PostgreSQL version, schema ownership, isolation needs, extension availability, and workload. Use constraints, partial/expression indexes, generated columns, JSONB, CTEs, locks, advisory locks, and advanced types only when they match the invariant and access pattern. Inspect MVCC and vacuum implications for write-heavy paths.',
    verify:
      'Use EXPLAIN with representative parameters/data, test lock and transaction behavior, migration rollback or forward recovery, constraint violations, and production-like statistics. Validate replicas/extensions separately when relevant.',
    avoid:
      'Do not cargo-cult indexes, trust estimated plans without data context, hold transactions across external work, or use serializable isolation without handling retries.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'mysql-engineering',
    description:
      'Engineer MySQL and InnoDB schemas, indexes, transactions, replication, SQL modes, and operational compatibility',
    domains: ['data', 'database', 'mysql'],
    broader: ['relational-data-modeling'],
    activation: ['mysql', 'innodb', 'mysql query', 'mysql index'],
    focus:
      'Confirm MySQL version, SQL mode, character set/collation, InnoDB behavior, replication topology, and workload. Design composite indexes around leftmost-prefix access, understand next-key locking and isolation, and make timestamp/JSON/generated-column behavior explicit across versions.',
    verify:
      'Inspect EXPLAIN plans, lock contention, transaction boundaries, migration behavior, collation-sensitive queries, replica lag/compatibility, and realistic row distributions.',
    avoid:
      'Do not assume PostgreSQL semantics transfer directly, ignore SQL modes or collations, depend on implicit type coercion, or add redundant indexes that amplify write cost.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'sqlite-engineering',
    description:
      'Engineer SQLite storage with transaction, locking, WAL, migration, durability, embedding, and file-lifecycle discipline',
    domains: ['data', 'database', 'sqlite'],
    broader: ['relational-data-modeling'],
    activation: ['sqlite', 'sqlite database', 'sqlite wal', 'sqlite migration'],
    focus:
      'Treat SQLite as an embedded database with file and process semantics, not a tiny network server. Confirm library version, journaling mode, busy timeout, foreign keys, synchronous level, connection pooling, and expected concurrency. Keep migrations compatible with SQLite DDL limits and app upgrade paths.',
    verify:
      'Exercise concurrent readers/writers, crash/reopen behavior where risk warrants it, migration from real prior schemas, foreign-key enforcement, WAL checkpointing, and backup/restore or file replacement flows.',
    avoid:
      'Do not open unbounded connections, assume foreign keys are always enabled, copy live database files casually, or use network-filesystem deployments without validated locking semantics.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'redis-engineering',
    description:
      'Engineer Redis usage around data structures, atomicity, TTL, persistence, clustering, eviction, and failure semantics',
    domains: ['data', 'database', 'redis'],
    broader: ['backend-engineering'],
    activation: ['redis', 'redis cache', 'redis stream', 'redis cluster'],
    focus:
      'Define whether Redis is a cache, coordination service, queue, stream, rate limiter, or authoritative store because durability and recovery differ. Choose data structures and Lua/transactions for the invariant, make TTL and eviction explicit, and model cluster slotting, failover, hot keys, and stampedes.',
    verify:
      'Exercise expiry, eviction, reconnect, failover assumptions, duplicate/replayed work, atomic operations, serialization compatibility, and load patterns with realistic key distributions.',
    avoid:
      'Do not treat cache presence as truth, use KEYS in production paths, depend on distributed locks without fencing/expiry analysis, or let retry loops multiply writes.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'mongodb-engineering',
    description:
      'Engineer MongoDB document models, indexes, transactions, aggregation, sharding, and schema evolution around access patterns',
    domains: ['data', 'database', 'mongodb'],
    broader: ['backend-engineering'],
    activation: ['mongodb', 'mongo collection', 'mongo aggregation', 'mongo index'],
    focus:
      'Model documents around ownership, atomic update boundaries, cardinality, growth, and dominant access patterns. Decide embed versus reference explicitly, enforce validation where appropriate, and understand multikey indexes, aggregation memory, transactions, replica consistency, and shard-key consequences.',
    verify:
      'Inspect explain plans and index coverage, test document growth and migration, concurrent updates, transaction/retry behavior, read/write concern, and representative aggregation cardinalities.',
    avoid:
      'Do not model every relation as embedded, use unbounded arrays, add indexes without write/storage cost analysis, or assume eventual consistency is acceptable without a product contract.',
    requires: IMPLEMENTATION_VERIFY,
  }),
  specialist({
    name: 'search-indexing',
    description:
      'Engineer full-text and structured search around indexing, analyzers, ranking, freshness, faceting, and relevance evaluation',
    domains: ['data', 'search'],
    broader: ['backend-engineering'],
    activation: ['full text search', 'search index', 'elasticsearch', 'opensearch'],
    focus:
      'Define search intents, corpus fields, language, analyzers, synonyms, filters, facets, ranking signals, freshness, and update/delete semantics before tuning queries. Separate lexical retrieval quality from UI presentation and make index rebuild/versioning a deployable lifecycle.',
    verify:
      'Maintain judged query sets spanning head/tail, exact/fuzzy, multilingual, empty/noisy, authorization-filtered, and freshness-sensitive cases. Measure retrieval and ranking changes against that set plus index/update performance.',
    avoid:
      'Do not tune from a handful of favorite queries, expose unauthorized documents through search, use wildcard scans as a default, or change analyzers without a reindex strategy.',
    requires: ['verification', 'ml-evaluation'],
  }),
  specialist({
    name: 'vector-search-systems',
    description:
      'Engineer embedding and vector retrieval systems around representation, indexing, filters, recall, latency, freshness, and evaluation',
    domains: ['data', 'search', 'ai'],
    broader: ['backend-engineering'],
    activation: ['vector database', 'vector search', 'nearest neighbor index', 'semantic search'],
    focus:
      'Define the retrieval unit, embedding version, metric, normalization, metadata filters, top-k behavior, ANN index parameters, update/delete lifecycle, and reranking contract. Keep source text and embedding provenance so representation changes are migratable.',
    verify:
      'Use labeled relevance cases to measure recall/precision or ranking quality across embedding/index revisions, filters, stale data, multilingual inputs, and latency/memory budgets. Compare ANN results to an exact-search sample when feasible.',
    avoid:
      'Do not treat cosine similarity as semantic truth, mix embeddings from incompatible models silently, ignore filter selectivity, or tune top-k without downstream evaluation.',
    requires: ['verification', 'ml-evaluation'],
  }),
  specialist({
    name: 'data-pipeline-engineering',
    description:
      'Engineer batch and incremental data pipelines with lineage, idempotency, schema evolution, backfills, partitioning, and recovery',
    domains: ['data', 'etl', 'pipeline'],
    broader: ['data-analysis'],
    activation: ['etl pipeline', 'data pipeline', 'incremental load', 'data backfill'],
    focus:
      'Define source authority, event/record identity, watermark, partition, schema, transformation lineage, retry semantics, and destination guarantees. Design backfills and reprocessing as first-class paths that cannot silently double-count or overwrite newer truth.',
    verify:
      'Test reruns, partial batches, late/out-of-order data, schema additions/removals, malformed records, backfills, reconciliation totals, and lineage from output rows to source inputs.',
    avoid:
      'Do not use processing time when event time matters, assume exactly-once from retries alone, discard bad rows without accounting, or let a backfill bypass normal quality gates.',
    requires: ['verification', 'data-analysis'],
  }),
  specialist({
    name: 'stream-processing',
    description:
      'Engineer streaming systems with event-time, ordering, delivery guarantees, state, partitions, replay, and backpressure',
    domains: ['data', 'streaming', 'distributed'],
    broader: ['distributed-backend'],
    activation: ['stream processing', 'kafka stream', 'event stream', 'consumer group'],
    focus:
      'Define event identity, keys, ordering scope, event-time versus processing-time, watermarking, delivery semantics, state stores, partition ownership, and replay behavior. Make consumers idempotent or deduplicating where delivery can repeat and control backpressure explicitly.',
    verify:
      'Exercise duplicates, reordering, partition rebalance, consumer restart, poison messages, lag spikes, replay from offsets, state recovery, and schema evolution with representative throughput.',
    avoid:
      'Do not claim global order from partition order, commit offsets before durable effects without understanding loss windows, or hide poison events in infinite retry loops.',
    requires: ['verification', 'reliability-verification'],
  }),
  specialist({
    name: 'analytics-engineering',
    description:
      'Engineer trustworthy analytical models with grain, lineage, tests, dimensions, metrics, incremental logic, and semantic consistency',
    domains: ['data', 'analytics'],
    broader: ['data-analysis'],
    activation: ['analytics engineering', 'dbt model', 'semantic layer', 'warehouse model'],
    focus:
      'Define model grain, source freshness, keys, dimensions, slowly changing behavior, metric semantics, and lineage before writing transformations. Reuse canonical business definitions and keep incremental logic equivalent to full rebuilds.',
    verify:
      'Run schema/data tests, reconcile important metrics to sources, compare incremental versus full-refresh outputs on sampled periods, and check late-arriving or corrected records.',
    avoid:
      'Do not bury business logic in dashboards, join tables with unclear grain, define the same metric differently across marts, or treat not-null tests as sufficient quality proof.',
    requires: ['verification', 'data-analysis'],
  }),
  specialist({
    name: 'database-performance',
    description:
      'Diagnose and improve database performance using workload evidence, query plans, contention, cache, storage, and concurrency behavior',
    domains: ['data', 'database', 'performance'],
    broader: ['performance-debugging'],
    activation: ['slow query', 'database performance', 'query plan', 'database contention'],
    focus:
      'Capture the exact query, parameters, schema, statistics, data distribution, concurrency, and latency/resource symptom before tuning. Inspect logical work, plan operators, index selectivity, cardinality estimates, locking, cache, I/O, and connection pressure as separate hypotheses.',
    verify:
      'Compare before/after plans and latency distributions under representative data and concurrency, confirm write/storage side effects of indexes or materialization, and monitor regressions on neighboring queries.',
    avoid:
      'Do not optimize from query text alone, add indexes for every predicate, trust one warm benchmark, or trade correctness/isolation for latency without an explicit decision.',
    requires: ['verification', 'performance-verification'],
  }),

  specialist({
    name: 'aws-cloud',
    description:
      'Design and operate AWS systems with explicit identity, network, service, region, scaling, reliability, and cost boundaries',
    domains: ['cloud', 'aws', 'infrastructure'],
    broader: ['architecture-planning'],
    activation: ['aws', 'amazon web services', 'cloudformation', 'aws iam'],
    focus:
      'Confirm account, region, workload, compliance, network, identity, data, availability, and operational requirements before selecting services. Prefer managed primitives when their failure and portability tradeoffs fit. Design IAM least privilege, encryption, logging, quotas, backups, and multi-AZ/region behavior explicitly.',
    verify:
      'Validate infrastructure plans, IAM denied/allowed paths, health and rollback, backup/restore where material, quota behavior, and cost-driving usage with the actual target account/environment before claiming readiness.',
    avoid:
      'Do not infer production identity from a local profile, use wildcard IAM by default, expose services publicly for convenience, or call multi-AZ deployment disaster recovery without recovery evidence.',
    facets: ['infrastructure-security'],
    requires: ['verification'],
  }),
  specialist({
    name: 'gcp-cloud',
    description:
      'Design and operate Google Cloud systems with explicit projects, identity, network, managed-service, reliability, and cost boundaries',
    domains: ['cloud', 'gcp', 'infrastructure'],
    broader: ['architecture-planning'],
    activation: ['google cloud', 'gcp project', 'cloud run gcp', 'gcp iam'],
    focus:
      'Confirm organization/project, region, service accounts, network, data residency, workload shape, quotas, and operational requirements. Use IAM conditions and service identities deliberately, understand managed service scaling and cold-start behavior, and keep audit/logging and billing ownership visible.',
    verify:
      'Validate deployed or planned IAM, network reachability, rollback, backup/recovery, quota and scaling behavior, and cost drivers in the intended project/environment.',
    avoid:
      'Do not grant project-wide roles for local convenience, mix user and service-account identity, rely on default networks accidentally, or assume a managed service removes application-level retry/idempotency work.',
    facets: ['infrastructure-security'],
    requires: ['verification'],
  }),
  specialist({
    name: 'azure-cloud',
    description:
      'Design and operate Azure systems with explicit tenants, subscriptions, identity, network, service, reliability, governance, and cost boundaries',
    domains: ['cloud', 'azure', 'infrastructure'],
    broader: ['architecture-planning'],
    activation: ['microsoft azure', 'azure subscription', 'azure resource', 'azure identity'],
    focus:
      'Resolve tenant, subscription, resource group, region, managed identity, network topology, policy, data, workload, and operational requirements. Distinguish Entra identity from resource RBAC and keep private endpoints, DNS, service tiers, scaling, monitoring, and governance explicit.',
    verify:
      'Validate RBAC and denied paths, network/DNS reachability, infrastructure changes, rollback, backup/recovery, quota/tier limits, and cost-driving resources in the target subscription.',
    avoid:
      'Do not assume tenant/subscription identity, grant Owner/Contributor broadly, expose PaaS endpoints unnecessarily, or treat portal configuration as reproducible infrastructure.',
    facets: ['infrastructure-security'],
    requires: ['verification'],
  }),
  specialist({
    name: 'kubernetes-operations',
    description:
      'Engineer Kubernetes workloads and clusters around scheduling, rollout, health, networking, storage, policy, observability, and recovery',
    domains: ['infrastructure', 'kubernetes'],
    broader: ['architecture-planning'],
    activation: ['kubernetes', 'k8s', 'helm chart', 'kubernetes pod'],
    focus:
      'Confirm cluster/version, workload controller, scheduling constraints, resource requests/limits, probes, disruption, network policy, ingress, storage, secrets, service accounts, rollout strategy, and autoscaling. Treat pod restartability and controller reconciliation as application contracts.',
    verify:
      'Render/validate manifests, exercise rollout/rollback, probe failures, pod/node disruption, scaling, persistent storage, denied network/RBAC paths, and logs/metrics in a representative cluster.',
    avoid:
      'Do not use latest tags, omit resource requests by default, mount broad credentials, equate liveness with readiness, or edit live objects manually without a source-of-truth plan.',
    facets: ['infrastructure-security'],
    requires: ['verification', 'reliability-verification'],
  }),
  specialist({
    name: 'container-engineering',
    description:
      'Engineer OCI containers with reproducible builds, minimal runtime surfaces, filesystem, signal, user, supply-chain, and portability discipline',
    domains: ['infrastructure', 'containers'],
    broader: ['implementation'],
    activation: ['dockerfile', 'container image', 'docker container', 'oci image'],
    focus:
      'Separate build and runtime dependencies, pin meaningful inputs, run as a non-root user where possible, keep filesystem writes and volumes explicit, propagate signals, and minimize the final image without deleting required diagnostics or certificates. Preserve multi-architecture and libc/runtime assumptions.',
    verify:
      'Build from a clean context, inspect image contents/metadata, run as the intended user with read-only or restricted filesystems when supported, exercise SIGTERM shutdown, health behavior, architecture, and vulnerability/license gates used by the project.',
    avoid:
      'Do not bake secrets into layers, depend on mutable latest tags, use privileged/root mode casually, or make development bind mounts required for production correctness.',
    facets: ['supply-chain-security'],
    requires: ['verification'],
  }),
  specialist({
    name: 'terraform-iac',
    description:
      'Engineer Terraform and infrastructure-as-code with state, provider, module, drift, import, lifecycle, and recovery discipline',
    domains: ['infrastructure', 'iac', 'terraform'],
    broader: ['architecture-planning'],
    activation: ['terraform', 'terraform plan', 'hcl infrastructure', 'terraform state'],
    focus:
      'Resolve backend/state ownership, workspace/environment, provider versions, credentials, module contracts, lifecycle, import history, and drift before editing. Keep modules aligned to durable ownership boundaries and avoid hiding provider semantics behind generic wrappers.',
    verify:
      'Format/validate, produce a plan against the intended non-production or approved environment, inspect destructive/replacement actions, test module inputs/outputs, and confirm state/rollback or import strategy before apply.',
    avoid:
      'Do not move or delete state casually, apply from an ambiguous workspace, put secrets in variable defaults or outputs, or use ignore_changes to conceal unmanaged drift.',
    requires: ['verification'],
  }),
  specialist({
    name: 'cicd-engineering',
    description:
      'Engineer CI/CD systems with reproducible gates, trustworthy artifacts, secret isolation, caching, promotion, rollout, and recovery',
    domains: ['infrastructure', 'ci', 'delivery'],
    broader: ['release-planning'],
    activation: ['ci/cd', 'continuous integration', 'github actions workflow', 'build pipeline'],
    focus:
      'Map source revision to immutable artifacts and environments. Separate validation, build, signing, publishing, deployment, activation, and promotion; keep secrets and untrusted contributions isolated; make cache keys correctness-preserving; and define concurrency/cancellation rules for overlapping runs.',
    verify:
      'Run or statically validate changed workflows, confirm artifact provenance and exact revision, exercise failure/cancel/retry behavior, and verify deployment rollback or promotion gates without bypassing protected environments.',
    avoid:
      'Do not run untrusted fork code with write secrets, deploy mutable branch state, reuse caches across incompatible inputs, or treat a green build as a successful release.',
    facets: ['supply-chain-security'],
    requires: ['verification'],
  }),
  specialist({
    name: 'observability-sre',
    description:
      'Engineer observability and SRE practices around service objectives, telemetry semantics, alert quality, incident diagnosis, and operational feedback',
    domains: ['operations', 'observability', 'sre'],
    broader: ['reliability-verification'],
    activation: ['observability', 'sre', 'service level objective', 'production telemetry'],
    focus:
      'Define user-visible reliability objectives and failure modes before adding telemetry. Make logs, metrics, traces, profiles, and events answer specific operational questions with stable dimensions, bounded cardinality, privacy controls, and correlation. Alert on actionable symptoms tied to ownership and response.',
    verify:
      'Inject or replay representative failures and confirm telemetry exposes cause and impact, alerts fire and recover at intended thresholds, dashboards preserve units/denominators, and SLO calculations match raw events.',
    avoid:
      'Do not emit high-cardinality identifiers into metrics, alert on every anomaly, log secrets, or equate telemetry volume with observability.',
    requires: ['verification'],
  }),
  specialist({
    name: 'incident-response',
    description:
      'Operate technical incidents with rapid triage, containment, evidence preservation, communication, recovery, and learning discipline',
    domains: ['operations', 'incident'],
    broader: ['reliability-verification'],
    activation: ['production incident', 'incident response', 'service outage', 'sev incident'],
    focus:
      'Establish incident commander, severity, user impact, current state, timeline, recent changes, and decision log. Stabilize before optimizing, use reversible mitigations, preserve evidence, separate hypotheses from observations, and communicate impact/next update cadence without unsupported certainty.',
    verify:
      'Confirm mitigation through user-impact and service-health signals, monitor for recurrence through an observation window, reconcile state after failover/rollback, and capture a factual timeline plus follow-up owners.',
    avoid:
      'Do not make multiple uncontrolled changes at once, delete evidence, overfocus on a plausible recent change without discrimination, or declare resolved when only one metric recovered.',
    requires: ['verification'],
  }),
  specialist({
    name: 'linux-systems',
    description:
      'Engineer and diagnose Linux systems around processes, filesystems, permissions, services, networking, resources, namespaces, and kernel interfaces',
    domains: ['systems', 'linux'],
    broader: ['backend-engineering'],
    activation: ['linux system', 'systemd service', 'linux process', 'linux filesystem'],
    focus:
      'Resolve distribution, kernel, init system, architecture, cgroups, filesystem, user/namespace, and packaging context first. Trace process ancestry, descriptors, mounts, capabilities, limits, signals, service units, and kernel-visible resource state rather than guessing from application symptoms.',
    verify:
      'Reproduce with read-only diagnostics first, then verify service lifecycle, permissions, resource limits, reboot/restart persistence, logs, and exact unit/package configuration after changes.',
    avoid:
      'Do not disable security controls globally, chmod 777 broad paths, edit generated system files without ownership context, or assume commands/options are portable across distributions.',
    facets: ['infrastructure-security'],
    requires: ['verification'],
  }),
  specialist({
    name: 'networking-systems',
    description:
      'Engineer and diagnose network systems across addressing, DNS, routing, transport, TLS, proxies, load balancing, firewalls, and failure modes',
    domains: ['systems', 'networking'],
    broader: ['network-service-backend'],
    activation: ['network routing', 'dns issue', 'tcp connection', 'load balancer network'],
    focus:
      'Establish source/destination identity, address family, DNS resolution path, route, NAT, firewall, proxy/LB, transport, TLS/SNI, application protocol, timeout, and retry ownership. Observe each layer independently and account for asymmetric paths and caches.',
    verify:
      'Capture representative resolution/connectivity/handshake evidence from the actual source environment, test failure/timeouts/retries, validate firewall/LB health and certificate chains, and compare both directions when relevant.',
    avoid:
      'Do not equate ping failure with service failure, flush global caches reflexively, disable TLS verification, or add retries before locating the timeout/loss boundary.',
    requires: ['verification'],
  }),
  specialist({
    name: 'edge-cdn',
    description:
      'Engineer CDN and edge delivery around cache keys, freshness, invalidation, routing, security, origin protection, and global behavior',
    domains: ['infrastructure', 'edge', 'cdn'],
    broader: ['network-service-backend'],
    activation: ['cdn cache', 'edge network', 'cloudflare cache', 'content delivery network'],
    focus:
      'Define cacheability, key dimensions, TTL/stale behavior, invalidation, variants, cookies/auth, compression, redirects, origin shielding, rate limits, and geographic routing. Keep personalized or authorization-sensitive content out of shared caches unless keys and privacy are proven.',
    verify:
      'Inspect headers and cache behavior across miss/hit/stale/purge, authenticated and anonymous variants, representative regions if material, origin failure, compression, and deployment propagation.',
    avoid:
      'Do not cache Set-Cookie/private responses accidentally, vary on unbounded headers, purge everything as a normal deployment strategy, or infer global propagation from one POP.',
    facets: ['application-security'],
    requires: ['verification'],
  }),
  specialist({
    name: 'serverless-platforms',
    description:
      'Engineer serverless functions and managed runtimes around invocation, concurrency, cold starts, limits, state, retries, and deployment contracts',
    domains: ['cloud', 'serverless'],
    broader: ['network-service-backend'],
    activation: ['serverless function', 'lambda function', 'cloud function', 'edge function'],
    focus:
      'Confirm provider/runtime, invocation source, concurrency model, timeout, memory/CPU, ephemeral filesystem, networking, secret/config injection, retry behavior, and deployment packaging. Make handlers idempotent where the platform can redeliver and keep durable state external.',
    verify:
      'Exercise cold/warm invocation, timeout, retry/duplicate event, concurrent requests, secret/config changes, network failures, and deployment rollback within real platform limits.',
    avoid:
      'Do not rely on warm globals for correctness, assume exactly-once invocation, perform long unbounded background work after response, or hide platform limits behind local emulators.',
    requires: ['verification', 'reliability-verification'],
  }),

  specialist({
    name: 'llm-application-engineering',
    description:
      'Engineer LLM applications around task decomposition, model contracts, tools, structured outputs, uncertainty, latency, cost, and evaluation',
    domains: ['ai', 'llm', 'code'],
    broader: ['implementation'],
    activation: [
      'llm application',
      'language model app',
      'ai assistant',
      'model inference workflow',
    ],
    focus:
      'Define the user task, model responsibilities, deterministic boundaries, context sources, tool authority, output schema, refusal/fallback behavior, latency/cost budget, and evaluation set before prompt tuning. Keep model output untrusted until validated at the consuming boundary.',
    verify:
      'Evaluate representative success, ambiguity, adversarial inputs, stale/missing context, malformed structured output, tool failures, latency/cost, and model/version changes against a persisted task suite.',
    avoid:
      'Do not substitute a longer prompt for missing product logic, treat one impressive transcript as evaluation, execute unvalidated model-generated actions, or hide model/version drift.',
    requires: ['verification', 'ml-evaluation'],
  }),
  specialist({
    name: 'agentic-systems',
    description:
      'Engineer tool-using AI agents with bounded authority, planning, state, delegation, retries, observability, and completion evidence',
    domains: ['ai', 'agents', 'code'],
    broader: ['llm-application-engineering'],
    activation: ['ai agent', 'agentic system', 'tool using agent', 'multi agent'],
    focus:
      'Separate goal interpretation, planning, tool discovery, authorization, execution, observation, memory, delegation, and completion judgment. Make tool contracts typed and enforce permissions outside prompts. Bound loops by progress/evidence, preserve state across retries, and keep agents able to explain what actually changed.',
    verify:
      'Use scenario suites covering tool success/failure, stale observations, partial side effects, denied permissions, duplicate retries, delegation errors, long-horizon drift, and independent verification of final state.',
    avoid:
      'Do not let prompts grant authority, let agents self-certify irreversible work, retry non-idempotent actions blindly, or add subagents when decomposition does not improve evidence or throughput.',
    facets: ['authorization-security'],
    requires: ['verification', 'ml-evaluation'],
  }),
  specialist({
    name: 'prompt-context-engineering',
    description:
      'Engineer prompts and context packages with explicit instruction hierarchy, retrieval boundaries, token economy, examples, and failure behavior',
    domains: ['ai', 'prompting', 'context'],
    broader: ['llm-application-engineering'],
    activation: ['prompt engineering', 'system prompt', 'context window', 'few shot prompt'],
    focus:
      'Define the behavioral contract, authority hierarchy, stable versus task-specific context, retrieved evidence, output schema, and known failure modes. Put discriminating instructions where they are cheapest to discover, use examples only when they clarify hard boundaries, and keep untrusted content clearly delimited from instructions.',
    verify:
      'Run prompt variants against held-out tasks, near-miss routing cases, injection attempts, long-context truncation/order changes, output-format stress, and model/version changes. Measure task behavior rather than wording similarity.',
    avoid:
      'Do not repeat generic advice until it crowds out task evidence, encode secrets in prompts, use examples that leak intended benchmark answers, or rely on prompt text for security enforcement.',
    requires: ['ml-evaluation'],
  }),
  specialist({
    name: 'rag-retrieval-systems',
    description:
      'Engineer retrieval-augmented generation around corpus ingestion, chunking, retrieval, reranking, citation grounding, freshness, and evaluation',
    domains: ['ai', 'retrieval', 'search'],
    broader: ['llm-application-engineering'],
    activation: [
      'retrieval augmented generation',
      'rag system',
      'rag pipeline',
      'grounded generation',
    ],
    focus:
      'Define source authority, document lifecycle, parsing, chunk identity, metadata, access control, retrieval stages, reranking, context assembly, citation mapping, and stale/deleted content behavior. Keep retrieval failure distinguishable from generation failure.',
    verify:
      'Use question sets with known source evidence to measure retrieval recall, answer groundedness, citation correctness, abstention on missing evidence, authorization filtering, freshness, and latency across corpus/index/model revisions.',
    avoid:
      'Do not optimize chunk size from intuition alone, cite documents the model did not actually use, return inaccessible content through retrieval, or treat vector similarity as sufficient relevance.',
    requires: ['verification', 'ml-evaluation'],
  }),
  specialist({
    name: 'llm-evaluation',
    description:
      'Evaluate LLM and agent behavior with representative task sets, calibrated graders, baselines, slices, regressions, and evidence integrity',
    domains: ['ai', 'evaluation'],
    broader: ['ml-evaluation'],
    activation: ['llm eval', 'model evaluation', 'agent evaluation', 'ai benchmark'],
    focus:
      'Define the decision the evaluation supports, task distribution, slices, baseline, success rubric, grader independence, contamination controls, and statistical uncertainty. Prefer observable task outcomes and deterministic checks; use model graders only with calibration and evidence.',
    verify:
      'Run candidate and baseline on the same held-out cases, inspect disagreement and failure slices, calibrate automated graders against blind human review when consequential, and persist raw artifacts and revision identities.',
    avoid:
      'Do not report one aggregate score without slices, let the author grade its own intended answer, change prompts and test cases together without a holdout, or hide invalid/incomplete runs.',
    requires: ['verification'],
  }),
  specialist({
    name: 'fine-tuning-training',
    description:
      'Design and validate model fine-tuning and training workflows around data quality, objectives, splits, optimization, safety, and deployment fit',
    domains: ['ai', 'ml', 'training'],
    broader: ['ml-evaluation'],
    activation: ['fine tuning', 'model training', 'supervised fine tune', 'lora training'],
    focus:
      'Start from a measured base-model failure and decide whether training, retrieval, prompting, tools, or product logic is the right intervention. Audit data provenance, consent, deduplication, leakage, label quality, train/validation/test splits, objective, optimizer, checkpoints, and target serving constraints.',
    verify:
      'Compare against the untouched base model on held-out tasks and safety slices, inspect overfitting and catastrophic regressions, measure serving cost/latency, and preserve exact data/model/config provenance for reproducibility.',
    avoid:
      'Do not train on evaluation answers, assume more epochs improve behavior, use private/licensed data without authority, or claim general capability gains from a narrow training distribution.',
    requires: ['verification', 'ml-evaluation'],
  }),
  specialist({
    name: 'embedding-systems',
    description:
      'Engineer embedding pipelines around representation choice, preprocessing, dimensionality, versioning, similarity, drift, and downstream evaluation',
    domains: ['ai', 'ml', 'embeddings'],
    broader: ['ml-evaluation'],
    activation: [
      'embedding model',
      'text embeddings',
      'embedding pipeline',
      'embedding similarity',
    ],
    focus:
      'Define the semantic unit and downstream decision before selecting an embedding model. Keep preprocessing, truncation, normalization, model/version, dimensionality, locale, batching, caching, and provenance explicit. Plan migrations because vector representations are not wire-compatible by default.',
    verify:
      'Evaluate downstream retrieval/classification/clustering behavior on labeled cases, compare model revisions, test long/short/multilingual inputs and zero/degenerate vectors, and measure latency/storage cost.',
    avoid:
      'Do not compare vectors from incompatible models, infer absolute meaning from similarity thresholds without calibration, or choose dimensions solely from benchmark headlines.',
    requires: ['ml-evaluation'],
  }),
  specialist({
    name: 'computer-vision',
    description:
      'Engineer computer-vision systems around data provenance, geometry, augmentation, model behavior, uncertainty, and deployment conditions',
    domains: ['ai', 'ml', 'vision'],
    broader: ['ml-evaluation'],
    activation: ['computer vision', 'image classifier', 'object detection model', 'vision model'],
    focus:
      'Define task, labels, camera/image formation, resolution, geometry, lighting, occlusion, populations, deployment hardware, and acceptable error tradeoffs. Preserve annotation provenance and distinguish classification, detection, segmentation, tracking, and multimodal reasoning metrics.',
    verify:
      'Evaluate held-out slices across lighting, scale, occlusion, background, device, demographic or environmental factors where relevant, plus latency/memory on target hardware and confidence calibration.',
    avoid:
      'Do not let random image splits leak near-duplicates, use augmentation that changes labels, generalize studio benchmarks to field conditions, or hide systematic slice failures in aggregate accuracy.',
    requires: ['verification', 'ml-evaluation'],
  }),
  specialist({
    name: 'speech-audio-ai',
    description:
      'Engineer speech and audio AI around signal conditions, transcription or synthesis quality, latency, speakers, languages, safety, and evaluation',
    domains: ['ai', 'ml', 'audio'],
    broader: ['ml-evaluation'],
    activation: ['speech recognition', 'text to speech', 'audio model', 'voice ai'],
    focus:
      'Define sample rates/codecs, acoustic environment, speaker/language distribution, streaming versus batch latency, diarization, punctuation, synthesis voice constraints, and privacy/consent. Evaluate semantic task success in addition to signal-level metrics.',
    verify:
      'Use held-out recordings across noise, accents/languages, overlapping speakers, device/channel conditions, long utterances, silence, interruptions, and streaming boundaries; measure latency and word/semantic error or human quality as appropriate.',
    avoid:
      'Do not train or clone voices without authority, tune only on clean studio audio, treat one language/accent as representative, or hide hallucinated transcription in average WER.',
    requires: ['verification', 'ml-evaluation'],
  }),
  specialist({
    name: 'recommendation-ranking',
    description:
      'Engineer recommendation and ranking systems around objectives, candidate generation, features, feedback loops, fairness, exploration, and evaluation',
    domains: ['ai', 'ml', 'ranking'],
    broader: ['ml-evaluation'],
    activation: ['recommendation system', 'ranking model', 'recommender', 'learning to rank'],
    focus:
      'Define the user/product objective, candidate set, ranking stages, feedback event semantics, position/exposure bias, freshness, diversity, constraints, and exploration policy. Separate offline predictive quality from online causal impact and guard against self-reinforcing feedback loops.',
    verify:
      'Evaluate offline on temporally correct splits and meaningful slices, then use controlled online experiments where authorized. Track diversity, novelty, calibration, long-term outcomes, and guardrail metrics beside engagement.',
    avoid:
      'Do not optimize click-through alone, use future leakage, interpret observational uplift as causal, or let popular-item bias erase cold-start and long-tail users/items.',
    requires: ['verification', 'ml-evaluation'],
  }),
  specialist({
    name: 'mlops',
    description:
      'Engineer ML operations around dataset, feature, model, evaluation, deployment, monitoring, lineage, rollback, and reproducibility lifecycles',
    domains: ['ai', 'ml', 'operations'],
    broader: ['release-planning'],
    activation: ['mlops', 'model deployment pipeline', 'model registry', 'feature store'],
    focus:
      'Make dataset snapshots, feature definitions, training code, environment, model artifacts, evaluation, approvals, serving configuration, monitoring, and rollback one traceable lineage. Distinguish model version from endpoint/config version and plan for schema/feature skew.',
    verify:
      'Reproduce a candidate from recorded inputs, compare offline and serving features, validate canary/rollback, test missing/stale features, and monitor performance/data drift with thresholds tied to action.',
    avoid:
      'Do not deploy untraceable notebook artifacts, let online/offline feature logic diverge silently, retrain automatically on unvalidated drift, or call a registry entry production-ready without evaluation evidence.',
    requires: ['verification', 'ml-evaluation'],
  }),
  specialist({
    name: 'ai-safety-evaluation',
    description:
      'Evaluate AI-system safety across misuse, harmful outputs, autonomy, privacy, prompt injection, reliability, and mitigation regressions',
    domains: ['ai', 'safety', 'evaluation'],
    broader: ['security-review'],
    activation: [
      'ai safety evaluation',
      'model safety testing',
      'prompt injection evaluation',
      'agent safety',
    ],
    focus:
      'Model realistic users, attackers, tools, data, authority, and consequences at the system level rather than evaluating the base model alone. Build scenario suites for misuse, unsafe assistance, prompt injection, data exfiltration, over-delegation, hallucinated authority, and recovery while preserving policy and domain boundaries.',
    verify:
      'Use independent/adversarial evaluators, deterministic enforcement checks, red-team scenarios, and regression suites across model/prompt/tool changes. Record severity and exploit prerequisites rather than one safety score.',
    avoid:
      'Do not treat refusal rate as complete safety, rely on prompts as authorization, test only obvious attacks, or publish sensitive exploit material beyond the authorized audience.',
    facets: ['application-security', 'privacy-engineering'],
    requires: ['verification', 'ml-evaluation'],
  }),

  specialist({
    name: 'api-contract-design',
    description:
      'Design APIs around stable resource and action semantics, types, compatibility, errors, pagination, idempotency, observability, and lifecycle',
    domains: ['backend', 'api'],
    broader: ['developer-experience'],
    activation: ['api design', 'public api contract', 'sdk api surface', 'api versioning'],
    focus:
      'Model domain concepts and caller journeys before choosing transport syntax. Define identity, lifecycle, validation, errors, pagination, filtering, ordering, idempotency, concurrency, auth context, deprecation, and versioning. Make defaults explicit and keep server-owned fields server-owned.',
    verify:
      'Use contract tests and runnable examples for success, invalid/denied, pagination, retries, concurrent modification, compatibility, and deprecation. Validate generated clients/docs against the normative schema where applicable.',
    avoid:
      'Do not expose persistence tables directly, return 200 for every semantic failure, add breaking fields/enum behavior casually, or force callers to reverse-engineer retryability.',
    requires: ['verification'],
  }),
  specialist({
    name: 'http-rest-engineering',
    description:
      'Engineer HTTP and REST interfaces with correct methods, status, caching, conditional requests, content negotiation, proxies, and resilience',
    domains: ['backend', 'http', 'api'],
    broader: ['api-contract-design'],
    activation: ['rest api', 'http endpoint', 'http caching', 'http status'],
    focus:
      'Use HTTP semantics deliberately: safe/idempotent methods, status classes, Location, validators, conditional requests, Cache-Control, content types, redirects, range/streaming, and proxy behavior. Separate application identity/auth from transport connection identity.',
    verify:
      'Exercise retries, conditional requests, cache hit/revalidation, malformed bodies, unsupported media, auth denial, proxy headers, timeouts, streaming disconnects, and client compatibility.',
    avoid:
      'Do not tunnel every action through POST without reason, cache personalized data incorrectly, trust forwarded headers from untrusted peers, or retry non-idempotent requests blindly.',
    requires: ['verification'],
  }),
  specialist({
    name: 'graphql-engineering',
    description:
      'Engineer GraphQL schemas, resolvers, loaders, errors, authorization, pagination, federation, and evolution around client needs',
    domains: ['backend', 'api', 'graphql'],
    broader: ['api-contract-design'],
    activation: ['graphql', 'graphql schema', 'graphql resolver', 'apollo graphql'],
    focus:
      'Design schema types from durable domain semantics and client composition needs. Keep resolver ownership, batching, nullability, pagination, error extensions, authorization, cost/depth limits, deprecation, and federation boundaries explicit. Authorize at data/action boundaries, not merely fields hidden by the UI.',
    verify:
      'Test representative queries/mutations, N+1/batching, partial errors, null propagation, pagination, authorization bypass attempts, schema compatibility, and query-cost controls.',
    avoid:
      'Do not expose arbitrary database graphs, make every field nullable to avoid schema decisions, put authorization only in top-level resolvers, or break clients by changing nullability/enums casually.',
    facets: ['authorization-security'],
    requires: ['verification'],
  }),
  specialist({
    name: 'grpc-protobuf',
    description:
      'Engineer gRPC and Protocol Buffers contracts with wire compatibility, deadlines, streaming, status semantics, retries, and schema evolution',
    domains: ['backend', 'api', 'grpc'],
    broader: ['api-contract-design'],
    activation: ['grpc', 'protobuf', 'protocol buffers', 'grpc streaming'],
    focus:
      'Treat field numbers and wire types as durable compatibility. Define unary/streaming lifecycle, deadlines, cancellation, metadata, status/details, idempotency, retry policy, flow control, and generated client/server versioning. Reserve removed field numbers/names.',
    verify:
      'Run cross-version compatibility tests, deadline/cancel behavior, streaming half-close/backpressure, retryable/non-retryable statuses, malformed/unknown fields, and representative generated clients.',
    avoid:
      'Do not reuse removed field numbers, depend on enum unknown-value behavior accidentally, ignore deadlines, or enable retries without idempotency analysis.',
    requires: ['verification'],
  }),
  specialist({
    name: 'event-driven-architecture',
    description:
      'Design event-driven systems with clear event semantics, ownership, ordering, delivery, schema evolution, replay, and side-effect boundaries',
    domains: ['backend', 'events', 'distributed'],
    broader: ['distributed-backend'],
    activation: [
      'event driven architecture',
      'domain event',
      'message broker architecture',
      'event bus',
    ],
    focus:
      'Distinguish commands, domain events, integration events, notifications, and change-data streams. Define producer ownership, event identity, schema, ordering scope, delivery guarantee, idempotency, outbox/inbox, replay, retention, dead-letter policy, and consumer side effects.',
    verify:
      'Exercise duplicate, delayed, reordered, missing, poison, schema-evolved, and replayed events; verify producer transaction boundaries and consumer idempotency/reconciliation.',
    avoid:
      'Do not use events to hide synchronous dependencies, publish before authoritative state commits without a recovery model, or let consumers depend on undocumented producer database fields.',
    requires: ['verification', 'reliability-verification'],
  }),
  specialist({
    name: 'oauth-oidc',
    description:
      'Engineer OAuth 2.x and OpenID Connect integrations with correct actors, flows, tokens, redirect security, scopes, validation, and lifecycle',
    domains: ['security', 'identity', 'oauth'],
    broader: ['authorization-security'],
    activation: ['oauth', 'openid connect', 'oidc', 'authorization code flow'],
    focus:
      'Identify resource owner, client, authorization server, resource server, user agent, and trust boundaries before choosing a flow. Validate issuer, audience, signature, nonce/state/PKCE as applicable; define scopes/claims, token storage, rotation, revocation, logout, and multi-tenant identity mapping.',
    verify:
      'Test legitimate login/consent, denied consent, expired/invalid/wrong-audience tokens, replay/state attacks, redirect mismatch, key rotation, refresh/revocation, and tenant/account switching against the real provider contract.',
    avoid:
      'Do not invent custom token flows, use ID tokens as API access tokens, trust unvalidated JWT claims, place long-lived tokens in unsafe browser storage, or accept broad redirect wildcards.',
    requires: ['security-verification'],
  }),
  specialist({
    name: 'webhook-integration',
    description:
      'Engineer webhook producers and consumers with authenticity, idempotency, ordering, retries, replay, observability, and lifecycle discipline',
    domains: ['backend', 'integration', 'webhooks'],
    broader: ['integration-implementation'],
    activation: ['webhook', 'webhook signature', 'webhook event', 'callback endpoint'],
    focus:
      'Define event identity/schema/version, signature/authentication, replay window, delivery retry schedule, ordering guarantees, endpoint ownership, acknowledgement timing, and durable processing. Acknowledge only after the system reaches the provider-required durable boundary.',
    verify:
      'Test valid/invalid signatures, duplicate/reordered events, retries, timeouts, endpoint downtime, old schema versions, replay attacks, and reconciliation with the provider source of truth.',
    avoid:
      'Do not perform long work before acknowledging when the provider contract discourages it, trust source IP alone, parse signatures after mutating raw bodies, or assume exactly-once delivery.',
    facets: ['application-security'],
    requires: ['verification'],
  }),
  specialist({
    name: 'payment-integration',
    description:
      'Engineer payment integrations with explicit money, idempotency, authorization, capture, refunds, disputes, ledgers, webhooks, and reconciliation',
    domains: ['backend', 'payments', 'integration'],
    broader: ['integration-implementation'],
    activation: ['payment integration', 'payment processor', 'checkout payment', 'payment webhook'],
    focus:
      'Model currency/minor units, payment intent/order identity, customer/payment-method ownership, authorization/capture, asynchronous states, idempotency keys, refunds, disputes, fees, taxes, and internal ledger/reconciliation. Treat provider state as external evidence, not the sole business ledger.',
    verify:
      'Use provider test modes for success, decline, authentication, timeout, duplicate submission, delayed webhook, refund/partial refund, dispute-like states, and reconciliation against provider reports before production changes.',
    avoid:
      'Do not store raw card secrets, compute money in binary floating point, mark paid solely from client redirects, or retry charges without idempotency and provider-state checks.',
    facets: ['application-security'],
    requires: ['verification'],
  }),
  specialist({
    name: 'email-delivery',
    description:
      'Engineer transactional and bulk email systems around authentication, reputation, suppression, templates, retries, tracking, privacy, and deliverability',
    domains: ['backend', 'email', 'delivery'],
    broader: ['integration-implementation'],
    activation: ['email delivery', 'transactional email', 'sendgrid email', 'ses email'],
    focus:
      'Separate transactional and marketing streams, configure SPF/DKIM/DMARC ownership, stable From/Return-Path domains, suppression/unsubscribe policy, templates, localization, bounce/complaint webhooks, rate limits, retry behavior, and provider failover. Protect recipient data and tracking choices.',
    verify:
      'Validate authentication records, render representative clients, exercise bounce/complaint/suppression and retry behavior, test unsubscribe where applicable, and monitor acceptance versus inbox placement separately.',
    avoid:
      'Do not retry permanent bounces indefinitely, send marketing mail without consent/unsubscribe requirements, use one reputation stream for everything, or log full message bodies unnecessarily.',
    requires: ['verification'],
  }),
  specialist({
    name: 'realtime-systems',
    description:
      'Engineer real-time client/server systems with connection lifecycle, ordering, fan-out, presence, backpressure, reconnection, and state reconciliation',
    domains: ['backend', 'realtime', 'distributed'],
    broader: ['network-service-backend'],
    activation: ['websocket', 'real time updates', 'realtime connection', 'server sent events'],
    focus:
      'Define connection identity, authentication refresh, subscription ownership, ordering scope, message IDs, acknowledgement, fan-out, presence semantics, heartbeat, backpressure, reconnect/resume, and authoritative state reconciliation. Treat the realtime channel as transport, not the only state source.',
    verify:
      'Exercise disconnect/reconnect, duplicate/missed/reordered messages, slow clients, auth expiry, multi-device sessions, server restart, scale-out routing, and catch-up from authoritative state.',
    avoid:
      'Do not assume persistent ordered connections, keep unbounded per-client queues, trust stale connection identity after token expiry, or make presence a strongly consistent fact without that infrastructure.',
    requires: ['verification', 'reliability-verification'],
  }),

  specialist({
    name: 'applied-cryptography',
    description:
      'Apply cryptography using established primitives with explicit threat, key, nonce, randomness, integrity, compatibility, and lifecycle models',
    domains: ['security', 'cryptography'],
    broader: ['security-review'],
    activation: [
      'cryptography',
      'encryption design',
      'digital signature',
      'authenticated encryption',
    ],
    focus:
      'Start from assets, attackers, required confidentiality/integrity/authenticity, key ownership, rotation, recovery, and interoperability. Prefer well-reviewed high-level constructions and platform libraries. Specify algorithms, parameters, nonce/IV generation, associated data, encoding, and versioning so migrations are possible.',
    verify:
      'Use published test vectors or interoperable reference implementations, negative tamper/wrong-key cases, randomness/nonce invariants, key rotation, and migration compatibility. Seek specialist review for novel or high-consequence protocols.',
    avoid:
      'Do not invent cryptographic primitives or protocols, reuse nonces where prohibited, hard-code production keys, compare MACs unsafely, or treat encryption without authentication as complete protection.',
    requires: ['security-verification'],
  }),
  specialist({
    name: 'secrets-key-management',
    description:
      'Engineer secret and key management with least exposure, workload identity, rotation, revocation, audit, encryption, and recovery',
    domains: ['security', 'secrets', 'identity'],
    broader: ['infrastructure-security'],
    activation: ['secret management', 'key management', 'kms key', 'credential rotation'],
    focus:
      'Inventory each secret/key, owner, consumers, scope, storage, distribution, lifetime, rotation, revocation, audit, backup/recovery, and compromise response. Prefer workload identity or short-lived credentials over copied long-lived secrets and keep secret material out of code, logs, prompts, and artifacts.',
    verify:
      'Test allowed and denied retrieval, rotation without downtime, revoked/expired credentials, audit events, backup/recovery for irreplaceable keys, and scanning gates for accidental disclosure.',
    avoid:
      'Do not store secrets in environment files committed to source, print them for debugging, share one credential across unrelated workloads, or rotate without a dual-key/rollout recovery plan.',
    requires: ['security-verification'],
  }),
  specialist({
    name: 'web-security',
    description:
      'Secure web applications across browser trust, sessions, cookies, CSRF, XSS, CSP, CORS, uploads, SSRF, and dependency boundaries',
    domains: ['security', 'web'],
    broader: ['application-security'],
    activation: ['web security', 'xss', 'csrf', 'content security policy'],
    media: ['web'],
    focus:
      'Map browser, origin, server, third-party, and user-controlled content boundaries. Keep session cookies, CSRF defenses, output encoding, templating, CSP, CORS, redirects, uploads, URL fetching, headers, and storage aligned to actual trust and browser behavior. Enforce authorization server-side independently.',
    verify:
      'Test reflected/stored/DOM injection paths, CSRF-sensitive actions, cross-origin requests, session fixation/expiry, open redirects, upload/content-type handling, SSRF targets, and CSP behavior in supported browsers.',
    avoid:
      'Do not rely on input sanitization alone for XSS, use permissive CORS as an auth mechanism, store sensitive tokens in unsafe client storage, or disable TLS/CSP protections to simplify development.',
    requires: ['security-verification'],
  }),
  specialist({
    name: 'cloud-security',
    description:
      'Secure cloud environments across organization, identity, network, data, workload, control plane, logging, posture, and recovery boundaries',
    domains: ['security', 'cloud'],
    broader: ['infrastructure-security'],
    activation: ['cloud security', 'cloud iam review', 'cloud posture', 'cloud network security'],
    focus:
      'Map organization/accounts/projects/subscriptions, federated and workload identities, privilege paths, network exposure, data stores, keys, images, pipelines, management APIs, logs, backups, and break-glass access. Prefer organization-level guardrails and short-lived identity over scattered local exceptions.',
    verify:
      'Test allowed/denied IAM paths, public exposure inventories, key/log policy, workload identity, cross-account/tenant trust, backup recovery, and representative attack paths using read-only or controlled environments.',
    avoid:
      'Do not treat provider defaults as secure for every workload, grant administrator roles to automation, leave orphaned credentials/resources, or infer enforcement from console visibility.',
    requires: ['security-verification'],
  }),
  specialist({
    name: 'secure-authentication',
    description:
      'Engineer user and service authentication with phishing resistance, sessions, recovery, MFA, device, federation, and abuse controls',
    domains: ['security', 'identity', 'authentication'],
    broader: ['application-security'],
    activation: [
      'authentication system',
      'login security',
      'passkey',
      'multi factor authentication',
    ],
    focus:
      'Model account identity, authenticators, enrollment, session issuance, reauthentication, MFA/passkeys, device/session management, credential reset/recovery, federation, brute-force/credential-stuffing defenses, and high-risk action step-up. Make recovery at least as secure as primary authentication.',
    verify:
      'Test enrollment/login/logout, expired/revoked sessions, MFA/passkey fallback, recovery abuse, account enumeration, rate limits, concurrent/device sessions, and federated identity changes with server-side enforcement.',
    avoid:
      'Do not invent password hashing, rely on security questions, leak account existence unnecessarily, let long-lived sessions survive credential compromise by default, or make SMS the strongest available factor without context.',
    requires: ['security-verification'],
  }),
  specialist({
    name: 'threat-modeling-practice',
    description:
      'Threat-model systems by assets, actors, trust boundaries, abuse cases, controls, assumptions, and verification priorities',
    domains: ['security', 'threat-modeling'],
    broader: ['security-review'],
    activation: [
      'threat model',
      'abuse case analysis',
      'trust boundary review',
      'security design review',
    ],
    focus:
      'Define scope and security objectives, then map assets, actors, identities, data/control flows, trust boundaries, dependencies, entry points, privilege transitions, and recovery paths. Generate credible abuse cases from attacker capabilities and system incentives, not generic acronym checklists, and tie mitigations to enforcing components.',
    verify:
      'Trace top threats through implementation and tests, confirm mitigation ownership and negative paths, revisit the model after architecture/identity changes, and record residual risk and assumptions explicitly.',
    avoid:
      'Do not produce diagram-only threat models, enumerate theoretical threats without prioritization, treat prompts/UI as enforcement, or claim a mitigation exists without locating its enforcing layer.',
    requires: ['security-verification'],
  }),

  specialist({
    name: 'product-management',
    description:
      'Drive product decisions from user problems, evidence, strategy, constraints, sequencing, measurable outcomes, and learning loops',
    domains: ['product', 'planning'],
    broader: ['planning'],
    activation: [
      'product management',
      'product roadmap',
      'feature prioritization',
      'product requirements',
    ],
    focus:
      'Frame the user/customer problem, affected segments, current behavior, strategic fit, constraints, alternatives, expected outcome, and leading/lagging measures before specifying features. Prioritize by value, evidence, effort, risk, dependencies, reversibility, and learning rather than stakeholder volume.',
    verify:
      'Use research, usage data, feasibility evidence, prototypes or experiments as appropriate; define launch/observation criteria and compare outcomes to the original hypothesis after release.',
    avoid:
      'Do not convert solution requests directly into requirements, use story-point totals as value, maintain roadmaps detached from evidence, or declare success from shipping alone.',
  }),
  specialist({
    name: 'product-analytics',
    description:
      'Analyze product behavior with trustworthy event semantics, funnels, retention, cohorts, segmentation, causality boundaries, and decision focus',
    domains: ['product', 'analytics', 'data'],
    broader: ['data-analysis'],
    activation: [
      'product analytics',
      'funnel analysis',
      'retention analysis',
      'user cohort analysis',
    ],
    focus:
      'Define actor, event semantics, identity stitching, exposure, unit of analysis, time window, denominator, and product decision first. Audit instrumentation before interpreting funnels or retention, segment by meaningful behavior/context, and distinguish descriptive patterns from causal effects.',
    verify:
      'Reconcile events to source behavior, inspect missing/duplicate/late events and identity changes, reproduce metrics from raw data, and sensitivity-test window/denominator choices.',
    avoid:
      'Do not treat DAU growth as product value automatically, mix users/accounts/sessions in denominators, interpret survivorship as retention success, or infer causation from pre/post changes alone.',
    requires: ['data-analysis'],
  }),
  specialist({
    name: 'experimentation-ab-testing',
    description:
      'Design and analyze controlled product experiments with valid randomization, exposure, power, guardrails, stopping, and interpretation',
    domains: ['product', 'experimentation', 'statistics'],
    broader: ['statistical-inference'],
    activation: ['a/b test', 'ab test', 'controlled experiment', 'randomized experiment'],
    focus:
      'Define hypothesis, randomization unit, eligibility, exposure, primary metric, guardrails, minimum detectable effect, duration, interference risks, and analysis plan before launch. Preserve assignment and analyze intention-to-treat unless a justified estimand differs.',
    verify:
      'Check sample-ratio mismatch, balance, exposure logging, novelty/seasonality, missingness, multiple comparisons, confidence intervals, and practical significance; inspect predefined slices without p-hacking.',
    avoid:
      'Do not stop repeatedly on significance, exclude noncompliers after assignment casually, run user-level randomization when network interference dominates, or report relative lift without baseline/absolute effect.',
    requires: ['statistical-inference'],
  }),
  specialist({
    name: 'market-strategy',
    description:
      'Develop market and competitive strategy from customer jobs, segments, alternatives, economics, capabilities, differentiation, and uncertainty',
    domains: ['business', 'market', 'strategy'],
    broader: ['market-competitive-research'],
    activation: ['market strategy', 'competitive strategy', 'market entry', 'positioning strategy'],
    focus:
      'Define the decision, target customer/job, alternatives including non-consumption, buying process, willingness to switch, distribution, economics, regulatory constraints, and company capabilities. Separate observed market facts from assumptions and choose where not to compete as explicitly as where to compete.',
    verify:
      'Triangulate primary customer evidence, authoritative market data, competitor behavior, pricing/distribution evidence, and small tests of the riskiest assumptions before large commitments.',
    avoid:
      'Do not equate TAM with obtainable revenue, rely on competitor feature grids as strategy, fabricate market-share precision, or assume expressed interest equals purchasing behavior.',
  }),
  specialist({
    name: 'pricing-monetization',
    description:
      'Design pricing and monetization around customer value, segmentation, packaging, usage, willingness to pay, economics, and operational constraints',
    domains: ['business', 'pricing', 'product'],
    broader: ['market-competitive-research'],
    activation: ['pricing strategy', 'monetization', 'pricing tiers', 'usage based pricing'],
    focus:
      'Identify value metric, customer segments, alternatives, willingness/ability to pay, cost-to-serve, packaging, discounting, billing complexity, expansion paths, and fairness/trust implications. Model how pricing changes behavior and sales motion rather than optimizing a spreadsheet in isolation.',
    verify:
      'Use customer research, historical conversion/retention, conjoint or pricing studies when justified, controlled packaging tests where feasible, and scenario economics across adoption/usage distributions.',
    avoid:
      'Do not price solely from competitor averages or cost-plus, hide unavoidable fees, create tiers no segment understands, or extrapolate willingness-to-pay from tiny convenience samples.',
  }),
  specialist({
    name: 'startup-operations',
    description:
      'Design startup operating systems around priorities, ownership, cash, hiring, process, risk, cadence, and decision speed',
    domains: ['business', 'operations'],
    broader: ['planning'],
    activation: [
      'startup operations',
      'company operating cadence',
      'startup planning',
      'founder operations',
    ],
    focus:
      'Tie operating cadence to current stage and constraint: product learning, growth, delivery, hiring, cash, or reliability. Make ownership, decision rights, metrics, meeting purpose, documentation, hiring bar, vendor commitments, and runway implications explicit while preserving speed and reversibility.',
    verify:
      'Review whether each recurring process changes decisions or outcomes, track ownership/completion, reconcile cash/runway and capacity, and remove rituals whose information is unused.',
    avoid:
      'Do not import big-company process for status theater, optimize headcount as the goal, hide cash implications, or make founders the permanent routing layer for every decision.',
  }),
  specialist({
    name: 'sales-engineering',
    description:
      'Run technical pre-sales around discovery, qualification, architecture fit, credible demos, security, integration evidence, and handoff',
    domains: ['business', 'sales', 'technical'],
    broader: ['technical-communication'],
    activation: [
      'sales engineering',
      'technical pre sales',
      'solution engineer',
      'customer technical demo',
    ],
    focus:
      'Start with customer outcomes, environment, current workflow, stakeholders, decision criteria, constraints, security/integration needs, and timeline. Map product capability honestly to those needs, build demos/prototypes using real boundaries, and record gaps/assumptions for product and delivery teams.',
    verify:
      'Rehearse the exact customer scenario, validate integration/security claims with authoritative evidence, capture technical acceptance criteria, and hand off configuration, gaps, commitments, and ownership explicitly.',
    avoid:
      'Do not invent roadmap commitments, fake integrations/data as production capability, oversell unsupported scale/security, or run generic feature tours disconnected from customer decisions.',
  }),
  specialist({
    name: 'customer-success',
    description:
      'Design customer-success systems around outcomes, onboarding, adoption, risk, support signals, value realization, renewal, and expansion evidence',
    domains: ['business', 'customer-success'],
    broader: ['human-experience'],
    activation: ['customer success', 'customer onboarding', 'renewal risk', 'customer adoption'],
    focus:
      'Define the customer outcome, stakeholders, implementation milestones, activation/adoption behaviors, dependencies, support burden, health signals, business review cadence, and renewal decision. Use product and qualitative evidence to diagnose risk rather than a single opaque health score.',
    verify:
      'Track milestone completion, representative usage/outcome metrics, unresolved support/product gaps, stakeholder changes, and explicit value evidence through onboarding and renewal cycles.',
    avoid:
      'Do not optimize touch count, treat logins as value universally, hide product gaps behind relationship management, or use health scores without interpretable components and actions.',
  }),
  specialist({
    name: 'growth-engineering',
    description:
      'Engineer product growth loops with trustworthy acquisition, activation, retention, referral, experimentation, instrumentation, and guardrails',
    domains: ['product', 'growth', 'engineering'],
    broader: ['product-analytics'],
    activation: ['growth engineering', 'activation funnel', 'growth loop', 'referral system'],
    focus:
      'Map the growth mechanism from source through activation and retained value, including identity, attribution, incentives, abuse, instrumentation, and downstream quality. Prefer compounding product loops over isolated conversion tricks and protect user trust, deliverability, and marketplace quality.',
    verify:
      'Instrument full funnels with valid denominators, run controlled experiments where appropriate, monitor retention/quality/abuse guardrails, and reconcile attribution or referral credit to authoritative events.',
    avoid:
      'Do not optimize signup conversion while degrading retained value, create incentives without fraud modeling, dark-pattern consent, or claim channel causality from last-touch attribution alone.',
    requires: ['product-analytics'],
  }),
  specialist({
    name: 'finops-cloud-cost',
    description:
      'Optimize cloud cost with workload-aware allocation, unit economics, commitments, rightsizing, architecture, governance, and reliability constraints',
    domains: ['business', 'cloud', 'cost'],
    broader: ['operational-data-analysis'],
    activation: ['finops', 'cloud cost optimization', 'aws cost', 'cloud spend'],
    focus:
      'Allocate spend to products/teams/environments and normalize by useful business or workload units before optimization. Separate idle waste, sizing, storage/lifecycle, data transfer, pricing model/commitments, architecture, and growth effects. Preserve reliability, latency, and developer productivity constraints.',
    verify:
      'Reconcile billing exports to provider totals, compare unit cost over time, model commitment utilization/risk, validate savings after changes, and monitor performance/reliability guardrails.',
    avoid:
      'Do not cut cost by deleting resilience blindly, buy commitments before workload stability, compare raw monthly totals across growth periods, or count list-price discounts as realized savings without usage.',
    requires: ['data-analysis'],
  }),

  specialist({
    name: 'image-generation-practice',
    description:
      'Design image-generation workflows around composition, subject fidelity, style, constraints, iteration, provenance, and deliverable quality',
    domains: ['creative', 'image', 'generation'],
    broader: ['visual-interface-design'],
    activation: ['image generation', 'generate an image', 'text to image', 'edit generated image'],
    focus:
      'Translate the intended use into subject, composition, camera/view, lighting, palette, material, typography constraints, aspect ratio, negative constraints, and required fidelity. Iterate on the highest-impact visual discrepancy rather than stacking contradictory adjectives. Preserve source/consent boundaries for edits involving supplied assets.',
    verify:
      'Inspect output at delivery resolution for anatomy/geometry, text accuracy, edge artifacts, repeated patterns, perspective, brand/style consistency, and task-specific fidelity; compare variants against the intended use rather than prompt literalism.',
    avoid:
      'Do not claim exact likeness or trademark/style fidelity without evidence, hide obvious generation artifacts under effects, or keep expanding prompts when the composition itself is wrong.',
  }),
  specialist({
    name: 'video-production',
    description:
      'Plan and produce video around story, shot design, timing, motion, audio, captions, encoding, platform, and review evidence',
    domains: ['creative', 'video'],
    broader: ['human-experience'],
    activation: ['video production', 'motion video', 'edit this video', 'programmatic video'],
    focus:
      'Define audience, outcome, duration, platform/aspect, narrative beats, shot grammar, pacing, visual continuity, motion language, voice/music/SFX, captions, and brand constraints. Build timing from the message and audio rather than decorating a sequence with arbitrary transitions.',
    verify:
      'Review full renders plus key frames for pacing, cuts, legibility, caption timing, audio levels, clipping, motion continuity, encoding, and target-platform dimensions; test beginning/end and seek points explicitly.',
    avoid:
      'Do not overuse motion presets, let captions obscure primary content, rely on draft-preview timing as final render proof, or use copyrighted media without appropriate rights.',
  }),
  specialist({
    name: 'audio-production',
    description:
      'Engineer and produce audio around recording, editing, dynamics, loudness, spatial balance, noise, delivery format, and listening context',
    domains: ['creative', 'audio'],
    broader: ['human-experience'],
    activation: ['audio production', 'mix this audio', 'podcast audio', 'sound design'],
    focus:
      'Define listening context, source quality, sample rate/bit depth, edit intent, noise floor, dynamics, EQ, stereo/spatial image, loudness target, true peak, music/dialog balance, and delivery codec. Preserve intelligibility and natural dynamics before pursuing loudness or polish.',
    verify:
      'Monitor on representative speakers/headphones at multiple levels, inspect clipping/noise/artifacts, measure loudness/true peak where relevant, check mono compatibility, edits, fades, silence, metadata, and final encoded file.',
    avoid:
      'Do not normalize blindly to peak level, over-denoise until speech artifacts appear, compress every source heavily, or judge a mix from one playback system alone.',
  }),
  specialist({
    name: 'three-d-graphics',
    description:
      'Engineer real-time and rendered 3D graphics around geometry, transforms, materials, lighting, cameras, animation, performance, and asset pipelines',
    domains: ['creative', 'graphics', '3d'],
    broader: ['game-spatial-interface'],
    activation: ['3d graphics', 'three.js scene', 'webgl', 'rendering pipeline 3d'],
    focus:
      'Establish coordinate systems, units, handedness, transform hierarchy, camera model, mesh topology, materials/color space, lights, shadows, texture budgets, animation ownership, and target GPU/runtime. Keep asset import/export conventions and deterministic transforms explicit.',
    verify:
      'Inspect representative scenes for geometry/normals, scale, camera clipping, color/gamma, material response, animation interpolation, z-fighting, GPU/CPU frame cost, memory, and fallback behavior on supported hardware.',
    avoid:
      'Do not fix coordinate mistakes with scattered magic rotations, mix color spaces, ship unbounded texture/poly budgets, or infer mobile/VR performance from a desktop editor.',
    requires: ['visual-verification', 'performance-verification'],
  }),
  specialist({
    name: 'game-development',
    description:
      'Engineer game systems around simulation, input, timing, state, content, save/load, networking, performance, tooling, and player experience',
    domains: ['code', 'game', 'simulation'],
    broader: ['implementation'],
    activation: ['game development', 'gameplay system', 'game engine', 'game loop'],
    focus:
      'Separate deterministic simulation, presentation, input mapping, physics, AI, animation, audio, content data, save state, online authority, and tooling. Define fixed/variable timestep behavior, pause/interruption, entity lifecycle, serialization/versioning, and frame budgets before adding mechanics.',
    verify:
      'Exercise low/high frame rates, pause/resume, controller/input changes, save/load/version migration, long sessions, scene transitions, network loss if relevant, and representative target hardware performance.',
    avoid:
      'Do not tie simulation correctness to render frame rate, hide game rules in presentation scripts, serialize unstable runtime pointers, or optimize only an empty test scene.',
    requires: ['verification', 'performance-verification'],
  }),
  specialist({
    name: 'embedded-firmware',
    description:
      'Engineer embedded firmware around hardware contracts, interrupts, timing, memory, power, buses, boot, update, safety, and observability',
    domains: ['code', 'embedded', 'firmware'],
    broader: ['compiler-runtime-backend'],
    activation: ['embedded firmware', 'microcontroller', 'rtos firmware', 'device firmware'],
    focus:
      'Resolve MCU/board revision, clocks, memory map, peripherals, electrical assumptions, RTOS/bare-metal model, ISR/task ownership, watchdog, power states, boot/update path, and safety constraints. Keep bounded timing and memory explicit and isolate hardware abstraction from domain behavior.',
    verify:
      'Use simulation/unit tests for pure logic plus hardware-in-loop for peripheral/timing/power claims; exercise reset, brownout, watchdog, interrupt races, bus errors, update rollback, and boundary memory conditions.',
    avoid:
      'Do not perform blocking/unbounded work in interrupts, allocate unpredictably in hard real-time paths, assume simulator timing proves hardware, or deploy irreversible firmware updates without recovery.',
    facets: ['embedded-device-security'],
    requires: ['verification', 'simulation-device-testing'],
  }),
  specialist({
    name: 'robotics-control',
    description:
      'Engineer robotics systems around sensing, estimation, planning, control, timing, safety, calibration, simulation, and physical verification',
    domains: ['code', 'robotics', 'control'],
    broader: ['implementation'],
    activation: ['robotics', 'robot control', 'motion planning', 'sensor fusion robot'],
    focus:
      'Define physical plant, coordinate frames, sensors/actuators, rates/latencies, calibration, estimator state, planner constraints, controller limits, safety interlocks, and human/environment interaction. Separate perception uncertainty from control authority and keep commands bounded by physical limits.',
    verify:
      'Progress from deterministic simulation to hardware-in-loop and controlled physical tests, measuring tracking error, stability, timing, saturation, sensor dropout, emergency stop, localization loss, and recovery under safe bounds.',
    avoid:
      'Do not tune controllers from one trajectory, bypass safety interlocks for testing, assume simulation friction/noise matches reality, or command hardware without validated units/frames.',
    facets: ['embedded-device-security'],
    requires: ['verification', 'simulation-device-testing'],
  }),
  specialist({
    name: 'gpu-compute',
    description:
      'Engineer GPU compute workloads around memory movement, kernels, synchronization, numerical behavior, occupancy, portability, and profiling',
    domains: ['code', 'gpu', 'performance'],
    broader: ['performance-debugging'],
    activation: ['gpu compute', 'cuda kernel', 'metal compute', 'compute shader'],
    focus:
      'Establish target GPU/API, data layout, host-device transfers, kernel launch geometry, synchronization, precision, reductions/atomics, memory hierarchy, and workload sizes. Optimize from profiler evidence and arithmetic/memory intensity rather than kernel folklore.',
    verify:
      'Compare numerical results to a trusted CPU/reference path across edge sizes and precision, profile transfer/kernel timing and occupancy/cache behavior, test synchronization/races, and validate representative target hardware.',
    avoid:
      'Do not measure only kernel time while ignoring transfer/synchronization, assume floating-point associativity, add shared-memory complexity without profiling, or generalize one GPU architecture to all targets.',
    requires: ['verification', 'performance-verification'],
  }),

  specialist({
    name: 'financial-modeling',
    description:
      'Build decision-grade financial models with explicit assumptions, linked statements, cash flows, scenarios, sensitivities, and auditability',
    domains: ['business', 'finance', 'analysis'],
    broader: ['data-analysis'],
    activation: ['financial model', 'cash flow model', 'three statement model', 'forecast model'],
    focus:
      'Define decision, historical sources, accounting/operating drivers, units, timing, taxes, financing, working capital, capex, and scenario assumptions. Keep inputs distinct from formulas, link dependent statements consistently, and make circularity or balancing logic explicit rather than hiding plugs.',
    verify:
      'Reconcile historical periods to source data, run balance/cash checks, inspect formula consistency, stress key drivers and downside cases, and trace every headline output to auditable assumptions.',
    avoid:
      'Do not hard-code outputs into formulas, mix nominal/real or monthly/annual units, hide unsupported precision, or present scenario results as predictions.',
    requires: ['data-analysis'],
  }),
  specialist({
    name: 'business-case-analysis',
    description:
      'Evaluate business investments and initiatives using alternatives, economics, risk, timing, dependencies, scenarios, and decision criteria',
    domains: ['business', 'strategy', 'analysis'],
    broader: ['planning'],
    activation: ['business case', 'investment case', 'build vs buy analysis', 'roi analysis'],
    focus:
      'Frame the decision and alternatives including do-nothing, identify beneficiaries and costs, model cash/time/capacity impacts, strategic fit, dependencies, reversibility, opportunity cost, risks, and uncertain assumptions. Use ranges/scenarios where precision is unsupported.',
    verify:
      'Trace costs/benefits to evidence, sensitivity-test the assumptions that can flip the recommendation, compare alternatives on consistent horizons/discounting, and define post-decision measures that would validate or invalidate the case.',
    avoid:
      'Do not count sunk costs as future benefits, double-count productivity, ignore implementation/adoption cost, or use a single ROI number to hide timing and risk.',
  }),
  specialist({
    name: 'contract-analysis',
    description:
      'Analyze commercial contracts for obligations, rights, dependencies, ambiguity, risk allocation, operational impact, and unresolved legal review needs',
    domains: ['business', 'contracts', 'documents'],
    broader: ['reference-communication'],
    activation: [
      'contract analysis',
      'review this agreement',
      'msa review',
      'commercial terms review',
    ],
    focus:
      'Identify parties, term, scope, deliverables, payment, service levels, data/security/privacy, IP, confidentiality, warranties, indemnity, liability, termination, renewal, assignment, change control, disputes, governing law, and operational notice obligations. Distinguish plain-language extraction from legal conclusions.',
    verify:
      'Cross-reference defined terms, schedules/exhibits, incorporated documents, dates, caps/exceptions, survival clauses, and conflicting provisions; map material obligations to owners and flag items requiring qualified legal advice.',
    avoid:
      'Do not invent missing clauses, treat summaries as legal advice, ignore exhibits/definitions, or state enforceability without jurisdiction-specific qualified review.',
  }),
  specialist({
    name: 'project-program-management',
    description:
      'Manage projects and programs through outcomes, dependencies, ownership, critical path, risk, decisions, evidence, and adaptive delivery',
    domains: ['planning', 'delivery', 'program'],
    broader: ['planning'],
    activation: [
      'project management',
      'program management',
      'critical path plan',
      'delivery program',
    ],
    focus:
      'Translate objectives into measurable deliverables and work packages with owners, dependencies, decision gates, acceptance evidence, and realistic capacity. Identify critical path and uncertainty separately from task volume, maintain risk/decision logs, and replan when evidence changes.',
    verify:
      'Review milestone evidence, dependency readiness, risk trends, blocked ownership, forecast accuracy, and acceptance criteria at each decision point; close work only when downstream consumers can use the result.',
    avoid:
      'Do not use percent-complete theater, treat every task as equal priority, hide unresolved dependencies inside dates, or optimize schedule by removing verification/recovery work invisibly.',
  }),
  specialist({
    name: 'marketing-strategy',
    description:
      'Develop marketing strategy around audience, positioning, message, channels, journey, economics, measurement, brand, and experimentation',
    domains: ['business', 'marketing', 'strategy'],
    broader: ['market-competitive-research'],
    activation: [
      'marketing strategy',
      'go to market campaign',
      'demand generation',
      'brand positioning',
    ],
    focus:
      'Define target audience/job, category/frame, differentiated promise, proof, buying journey, channel fit, creative/message system, offer, budget/economics, measurement, and brand constraints. Match channel to audience behavior rather than chasing platform trends.',
    verify:
      'Use customer evidence, creative/message testing, channel-level incrementality where feasible, funnel quality, CAC/payback or mission-relevant outcomes, and brand/retention guardrails rather than impressions alone.',
    avoid:
      'Do not manufacture customer claims, optimize vanity reach without downstream quality, use dark patterns, or attribute all conversions to the last measurable touchpoint.',
  }),
  specialist({
    name: 'procurement-vendor-evaluation',
    description:
      'Evaluate vendors and procurement decisions through requirements, fit, security, reliability, economics, contracts, switching cost, and evidence',
    domains: ['business', 'procurement', 'analysis'],
    broader: ['market-competitive-research'],
    activation: [
      'vendor evaluation',
      'procurement decision',
      'software vendor selection',
      'rfp evaluation',
    ],
    focus:
      'Define required outcomes, must-have constraints, users/operators, integration/data/security needs, service/support, implementation effort, total cost, contractual risks, portability, exit/migration, and vendor viability before scoring products. Weight criteria by consequence rather than feature count.',
    verify:
      'Use authoritative documentation, security/compliance evidence, referenceable customers where appropriate, hands-on trials with representative workflows, pricing/contract review, failure/support tests, and migration/exit analysis.',
    avoid:
      'Do not award points for irrelevant features, accept roadmap promises as current capability, compare teaser pricing without total cost, or ignore data export and termination costs.',
  }),
];

export const SPECIALIST_SKILL_DEFINITIONS: SkillDefinition[] = SPECIALIST_PROFILES.map(
  (profile) => ({
    name: profile.name,
    description: profile.description,
    domains: profile.domains,
    media: profile.media,
    broader: profile.broader,
    facets: profile.facets,
    requires: profile.requires,
    conflicts: profile.conflicts,
    activation: profile.activation,
    excludes: profile.excludes,
    instructions: `${profile.focus}\n\nVerification focus: ${profile.verify}\n\nFailure boundaries: ${profile.avoid}`,
    should: [`Apply ${profile.activation[0]} expertise to this task`],
    shouldNot: ['Rewrite an unrelated sentence without changing any domain behavior'],
    evidence: profile.evidence ?? [
      `${profile.name} decision and boundary evidence`,
      'Representative verification results or explicit unavailable checks',
    ],
  }),
);

function specialistPlaybook(profile: SpecialistProfile): string {
  return `### Specialist operating contract

${profile.focus}

Begin by confirming that the request actually involves this specialist domain and by resolving the exact runtime, version, provider, platform, data shape, or operating environment that changes the answer. Inspect the existing repository or product conventions before introducing a new dependency, abstraction, service, format, or process. Separate source facts, observed behavior, user requirements, assumptions, and preferences. Preserve compatibility and user-owned state unless the task explicitly changes them.

For consequential decisions, compare the smallest viable alternatives against correctness, lifecycle, failure behavior, operability, security or privacy where applicable, performance, cost, migration, and reversibility. Prefer the option whose invariants can be expressed and verified most clearly. Keep external/provider-reported state distinct from local inference and keep unknown values unknown. A specialist skill supplies expertise, never additional execution authority.

### Verification discipline

${profile.verify}

Map each material completion claim to an observable artifact or runtime result. Exercise success plus the highest-value invalid, denied, interrupted, stale, partial, concurrent, compatibility, and recovery paths for this domain. Record versions, inputs, configuration, environment, and outputs when reproducibility matters. Label simulated, mocked, inferred, unavailable, and physical or production-like evidence accurately; never widen a claim beyond the environment that was actually exercised.

### Failure patterns to resist

${profile.avoid}

Do not cargo-cult a familiar framework or vendor pattern into a different topology. Do not convert documentation examples into proof of current runtime behavior, and do not hide missing evidence behind generated code, mocks, screenshots, aggregate scores, or successful compilation. When evidence contradicts the current hypothesis, preserve the contradiction, update the model, and run the next discriminating check instead of stacking retries or unrelated changes. Completion means the requested outcome works at the real boundary with residual uncertainty stated explicitly.`;
}

export const SPECIALIST_SKILL_PLAYBOOKS: Readonly<Record<string, string>> = Object.fromEntries(
  SPECIALIST_PROFILES.map((profile) => [profile.name, specialistPlaybook(profile)]),
);

export const SPECIALIST_SKILL_COUNT = SPECIALIST_PROFILES.length;
