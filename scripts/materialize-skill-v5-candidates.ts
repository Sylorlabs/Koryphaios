import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  LEGACY_BUNDLED_SKILL_DEFINITIONS,
  normalizeSkillTokens,
  type SkillDefinition,
} from '../backend/src/kory/skills';
import type {
  V5EvalEnvironmentKind,
  V5SkillKind,
  V5SkillPackageSidecar,
  V5SkillSourceRecord,
  V5SourceType,
} from '../backend/src/kory/skill-packages';

const VERIFIED_AT = '2026-09-04';
const projectRoot = resolve(import.meta.dir, '..');
const skillsRoot = join(projectRoot, 'skills-v5');
const refreshGenerated = process.argv.includes('--refresh-generated');
const generatedFormatPaths: string[] = [];
const HAND_AUTHORED_V5 = new Set([
  'accessibility-practice',
  'content-error-design',
  'developer-experience',
  'frontend-engineering',
  'human-experience',
  'information-architecture',
  'interaction-design',
  'native-interface',
  'plan-mode',
  'repository-environment-discovery',
  'skill-authoring-evaluation',
  'task-routing',
  'usability-evaluation',
  'user-research',
  'visual-interface-design',
  'web-interface',
]);

function existingPackageMaturity(name: string): 'scaffold' | 'individual' | undefined {
  const sidecarPath = join(skillsRoot, name, 'kory.json');
  if (!existsSync(sidecarPath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(sidecarPath, 'utf8')) as {
      authoringMaturity?: unknown;
      maturity?: unknown;
    };
    const maturity = value.authoringMaturity ?? value.maturity;
    return maturity === 'scaffold' || maturity === 'individual' ? maturity : undefined;
  } catch {
    return undefined;
  }
}

interface SourceSeed {
  label: string;
  url: string;
  sourceType: V5SourceType;
  versionScope: string;
  staleAfterDays: number;
  notes: string;
}

const source = (
  label: string,
  url: string,
  sourceType: V5SourceType,
  versionScope: string,
  staleAfterDays: number,
  notes: string,
): SourceSeed => ({ label, url, sourceType, versionScope, staleAfterDays, notes });

const S = {
  agentSkills: source(
    'Agent Skills specification',
    'https://agentskills.io/specification',
    'spec',
    'Agent Skills open specification as available 2026-09-04',
    90,
    'Portable package structure and progressive-disclosure requirements.',
  ),
  codexSkills: source(
    'OpenAI Codex skills',
    'https://developers.openai.com/codex/skills',
    'official-docs',
    'OpenAI Codex skill guidance as available 2026-09-04',
    45,
    'Current OpenAI guidance for skill discovery, packaging, and use.',
  ),
  cursorSkills: source(
    'Cursor skills',
    'https://docs.cursor.com/context/skills',
    'official-docs',
    'Cursor skill guidance as available 2026-09-04',
    45,
    'Current Cursor skill packaging and context-loading behavior used as competitive reference only.',
  ),
  mattPocockSkills: source(
    'Matt Pocock skills',
    'https://github.com/mattpocock/skills',
    'community-pattern',
    'mattpocock/skills repository as available 2026-09-04',
    30,
    'High-signal community examples for focused TypeScript/React skill packaging; never authority over upstream product docs.',
  ),
  swebok: source(
    'SWEBOK',
    'https://www.computer.org/education/bodies-of-knowledge/software-engineering',
    'official-docs',
    'IEEE Computer Society SWEBOK landing guidance as available 2026-09-04',
    180,
    'Software engineering lifecycle, construction, testing, maintenance, and professional-practice baseline.',
  ),
  iso42010: source(
    'ISO/IEC/IEEE 42010',
    'https://www.iso.org/standard/74393.html',
    'spec',
    'ISO/IEC/IEEE 42010:2022 architecture description standard',
    365,
    'Architecture description, stakeholder, concern, viewpoint, and correspondence concepts.',
  ),
  semver: source(
    'Semantic Versioning',
    'https://semver.org/',
    'spec',
    'Semantic Versioning 2.0.0',
    365,
    'Compatibility and release-version contract reference.',
  ),
  nistSsdf: source(
    'NIST SSDF',
    'https://csrc.nist.gov/pubs/sp/800/218/final',
    'spec',
    'NIST SP 800-218 Secure Software Development Framework',
    365,
    'Secure software-development and supply-chain practices.',
  ),
  owaspAsvs: source(
    'OWASP ASVS',
    'https://owasp.org/www-project-application-security-verification-standard/',
    'official-docs',
    'OWASP ASVS project guidance as available 2026-09-04',
    120,
    'Application-security controls and verification requirements.',
  ),
  wcag: source(
    'WCAG 2.2',
    'https://www.w3.org/TR/WCAG22/',
    'spec',
    'W3C Web Content Accessibility Guidelines 2.2',
    365,
    'Accessibility principles and testable success criteria where the web medium applies.',
  ),
  plainLanguage: source(
    'PlainLanguage.gov guidelines',
    'https://www.plainlanguage.gov/guidelines/',
    'official-docs',
    'U.S. federal plain-language guidelines as available 2026-09-04',
    180,
    'Audience-centered structure, wording, and readability guidance.',
  ),
  nistStats: source(
    'NIST/SEMATECH e-Handbook',
    'https://www.itl.nist.gov/div898/handbook/',
    'official-docs',
    'NIST/SEMATECH statistical methods handbook as available 2026-09-04',
    365,
    'Statistical analysis, experimental design, exploratory analysis, and measurement reference.',
  ),
  prisma: source(
    'PRISMA',
    'https://www.prisma-statement.org/',
    'official-docs',
    'PRISMA evidence-synthesis guidance as available 2026-09-04',
    180,
    'Transparent literature-search and evidence-synthesis reporting.',
  ),
  locResearch: source(
    'Library of Congress research strategies',
    'https://guides.loc.gov/student-resources/search-strategies',
    'official-docs',
    'Library of Congress research guidance as available 2026-09-04',
    180,
    'Research question framing, source discovery, evaluation, and citation workflow.',
  ),
  githubSearch: source(
    'GitHub search documentation',
    'https://docs.github.com/en/search-github',
    'official-docs',
    'GitHub search documentation as available 2026-09-04',
    90,
    'Repository/code/issues/commits search behavior and query boundaries.',
  ),
  posix: source(
    'POSIX.1-2024',
    'https://pubs.opengroup.org/onlinepubs/9799919799/',
    'spec',
    'The Open Group Base Specifications Issue 8 / POSIX.1-2024',
    365,
    'Shell, utilities, process, stream, signal, and portability contracts.',
  ),
  openxr: source(
    'OpenXR 1.1 specification',
    'https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html',
    'spec',
    'Khronos OpenXR 1.1 specification',
    365,
    'Spatial runtime, interaction, action, view, and lifecycle semantics.',
  ),
  fdaHumanFactors: source(
    'FDA human factors guidance',
    'https://www.fda.gov/regulatory-information/search-fda-guidance-documents/applying-human-factors-and-usability-engineering-medical-devices',
    'official-docs',
    'FDA human-factors/usability engineering guidance as available 2026-09-04',
    365,
    'Safety-critical human-device interaction, use-related hazards, validation, and representative-use conditions.',
  ),
  llvm: source(
    'LLVM documentation',
    'https://llvm.org/docs/',
    'official-docs',
    'LLVM project documentation as available 2026-09-04',
    90,
    'Compiler, IR, runtime, optimization, toolchain, and testing reference.',
  ),
  libFuzzer: source(
    'LLVM libFuzzer',
    'https://llvm.org/docs/LibFuzzer.html',
    'reference-implementation',
    'LLVM libFuzzer documentation as available 2026-09-04',
    90,
    'Coverage-guided fuzzing corpus, reproduction, and minimization behavior.',
  ),
  googleSre: source(
    'Google SRE book',
    'https://sre.google/sre-book/table-of-contents/',
    'official-docs',
    'Google Site Reliability Engineering book as available 2026-09-04',
    365,
    'Reliability, monitoring, incident response, capacity, release, and distributed-systems operating practices.',
  ),
  typescript: source(
    'TypeScript Handbook',
    'https://www.typescriptlang.org/docs/handbook/intro.html',
    'official-docs',
    'TypeScript documentation as available 2026-09-04',
    60,
    'Language, type-system, module, and declaration reference.',
  ),
  python: source(
    'Python documentation',
    'https://docs.python.org/3/',
    'official-docs',
    'Current supported Python 3 documentation as available 2026-09-04',
    60,
    'Language, standard library, packaging/runtime, and concurrency reference.',
  ),
  rust: source(
    'The Rust Programming Language',
    'https://doc.rust-lang.org/book/',
    'official-docs',
    'Current Rust book as available 2026-09-04',
    60,
    'Ownership, lifetimes, traits, concurrency, and language guidance.',
  ),
  go: source(
    'Go specification',
    'https://go.dev/ref/spec',
    'spec',
    'Current Go language specification as available 2026-09-04',
    90,
    'Language semantics, types, interfaces, and concurrency foundation.',
  ),
  java: source(
    'Java SE documentation',
    'https://docs.oracle.com/en/java/javase/',
    'official-docs',
    'Oracle Java SE documentation as available 2026-09-04',
    90,
    'JVM language/runtime, APIs, compatibility, and concurrency reference.',
  ),
  kotlin: source(
    'Kotlin documentation',
    'https://kotlinlang.org/docs/home.html',
    'official-docs',
    'Kotlin documentation as available 2026-09-04',
    60,
    'Language, nullability, coroutine, multiplatform, and interoperability reference.',
  ),
  swift: source(
    'The Swift Programming Language',
    'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/',
    'official-docs',
    'Swift language documentation as available 2026-09-04',
    60,
    'Value/reference semantics, concurrency, ownership, and language contracts.',
  ),
  cpp: source(
    'ISO C++ standard information',
    'https://isocpp.org/std/the-standard',
    'official-docs',
    'ISO C++ standard status/reference as available 2026-09-04',
    180,
    'Current C++ standard/version boundary and language reference entry point.',
  ),
  dotnet: source(
    '.NET documentation',
    'https://learn.microsoft.com/dotnet/',
    'official-docs',
    '.NET documentation as available 2026-09-04',
    60,
    'C#/.NET runtime, async, deployment, and API reference.',
  ),
  ruby: source(
    'Ruby documentation',
    'https://www.ruby-lang.org/en/documentation/',
    'official-docs',
    'Ruby documentation as available 2026-09-04',
    90,
    'Ruby language/runtime and standard-library reference.',
  ),
  php: source(
    'PHP manual',
    'https://www.php.net/manual/en/',
    'official-docs',
    'PHP manual as available 2026-09-04',
    60,
    'PHP language/runtime, type, request, and library reference.',
  ),
  react: source(
    'React documentation',
    'https://react.dev/',
    'official-docs',
    'React documentation as available 2026-09-04',
    45,
    'React state, rendering, effect, component, and accessibility guidance.',
  ),
  svelte: source(
    'Svelte documentation',
    'https://svelte.dev/docs/svelte/overview',
    'official-docs',
    'Svelte documentation as available 2026-09-04',
    45,
    'Svelte reactivity, components, runes, lifecycle, and rendering guidance.',
  ),
  vue: source(
    'Vue documentation',
    'https://vuejs.org/guide/introduction.html',
    'official-docs',
    'Vue documentation as available 2026-09-04',
    45,
    'Vue Composition API, reactivity, components, and lifecycle guidance.',
  ),
  angular: source(
    'Angular documentation',
    'https://angular.dev/overview',
    'official-docs',
    'Angular documentation as available 2026-09-04',
    45,
    'Angular components, dependency injection, signals, routing, and rendering reference.',
  ),
  nextjs: source(
    'Next.js documentation',
    'https://nextjs.org/docs',
    'official-docs',
    'Next.js documentation as available 2026-09-04',
    30,
    'App Router, rendering, data, caching, routing, and deployment behavior.',
  ),
  node: source(
    'Node.js API documentation',
    'https://nodejs.org/docs/latest/api/',
    'official-docs',
    'Current Node.js API documentation as available 2026-09-04',
    45,
    'Node runtime, modules, streams, events, processes, and async APIs.',
  ),
  bun: source(
    'Bun documentation',
    'https://bun.com/docs',
    'official-docs',
    'Bun documentation as available 2026-09-04',
    30,
    'Bun runtime, package, test, server, and compatibility behavior.',
  ),
  deno: source(
    'Deno documentation',
    'https://docs.deno.com/',
    'official-docs',
    'Deno documentation as available 2026-09-04',
    30,
    'Deno runtime, permissions, package, server, and compatibility behavior.',
  ),
  swiftui: source(
    'SwiftUI documentation',
    'https://developer.apple.com/documentation/swiftui',
    'official-docs',
    'Apple SwiftUI documentation as available 2026-09-04',
    45,
    'SwiftUI scene, state, layout, navigation, lifecycle, and accessibility reference.',
  ),
  compose: source(
    'Jetpack Compose documentation',
    'https://developer.android.com/compose',
    'official-docs',
    'Android Jetpack Compose documentation as available 2026-09-04',
    45,
    'Compose state, layout, navigation, adaptive UI, lifecycle, and accessibility guidance.',
  ),
  expo: source(
    'Expo documentation',
    'https://docs.expo.dev/',
    'official-docs',
    'Expo documentation as available 2026-09-04',
    30,
    'Expo/React Native platform, routing, build, module, and deployment behavior.',
  ),
  electron: source(
    'Electron documentation',
    'https://www.electronjs.org/docs/latest/',
    'official-docs',
    'Electron documentation as available 2026-09-04',
    45,
    'Electron process, IPC, window, security, and lifecycle reference.',
  ),
  tauri: source(
    'Tauri documentation',
    'https://v2.tauri.app/',
    'official-docs',
    'Tauri v2 documentation as available 2026-09-04',
    45,
    'Tauri app architecture, capabilities, commands, windowing, and security reference.',
  ),
  postgres: source(
    'PostgreSQL documentation',
    'https://www.postgresql.org/docs/current/',
    'official-docs',
    'Current PostgreSQL documentation as available 2026-09-04',
    45,
    'SQL, transactions, locking, indexes, planning, replication, and operations reference.',
  ),
  mysql: source(
    'MySQL 8.4 reference manual',
    'https://dev.mysql.com/doc/refman/8.4/en/',
    'official-docs',
    'MySQL 8.4 reference manual as available 2026-09-04',
    60,
    'SQL, InnoDB, replication, indexing, locking, and operations reference.',
  ),
  sqlite: source(
    'SQLite documentation',
    'https://sqlite.org/docs.html',
    'official-docs',
    'SQLite documentation as available 2026-09-04',
    60,
    'SQLite transactions, locking, SQL, file format, and deployment behavior.',
  ),
  redis: source(
    'Redis documentation',
    'https://redis.io/docs/latest/',
    'official-docs',
    'Redis documentation as available 2026-09-04',
    45,
    'Redis data types, persistence, replication, clustering, and command behavior.',
  ),
  mongodb: source(
    'MongoDB manual',
    'https://www.mongodb.com/docs/manual/',
    'official-docs',
    'MongoDB manual as available 2026-09-04',
    45,
    'MongoDB schema, consistency, indexing, transactions, sharding, and operations reference.',
  ),
  lucene: source(
    'Apache Lucene',
    'https://lucene.apache.org/core/',
    'reference-implementation',
    'Apache Lucene current core documentation as available 2026-09-04',
    90,
    'Reference implementation for indexing, analysis, scoring, and search internals.',
  ),
  pgvector: source(
    'pgvector',
    'https://github.com/pgvector/pgvector',
    'reference-implementation',
    'pgvector repository/docs as available 2026-09-04',
    45,
    'Reference vector-index implementation and metric/index tradeoffs.',
  ),
  airflow: source(
    'Apache Airflow documentation',
    'https://airflow.apache.org/docs/',
    'official-docs',
    'Apache Airflow documentation as available 2026-09-04',
    60,
    'DAG orchestration, retries, scheduling, state, and operational behavior.',
  ),
  kafka: source(
    'Apache Kafka documentation',
    'https://kafka.apache.org/documentation/',
    'official-docs',
    'Apache Kafka documentation as available 2026-09-04',
    60,
    'Streams, partitions, delivery, ordering, replication, and operational behavior.',
  ),
  dbt: source(
    'dbt documentation',
    'https://docs.getdbt.com/docs/introduction',
    'official-docs',
    'dbt documentation as available 2026-09-04',
    45,
    'Analytics transformation, lineage, testing, modeling, and deployment reference.',
  ),
  awsWa: source(
    'AWS Well-Architected Framework',
    'https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html',
    'official-docs',
    'AWS Well-Architected Framework as available 2026-09-04',
    45,
    'AWS architecture, reliability, security, performance, cost, and operations guidance.',
  ),
  gcpArch: source(
    'Google Cloud Architecture Framework',
    'https://cloud.google.com/architecture/framework',
    'official-docs',
    'Google Cloud Architecture Framework as available 2026-09-04',
    45,
    'Google Cloud architecture, reliability, security, performance, and cost guidance.',
  ),
  azureArch: source(
    'Azure Architecture Center',
    'https://learn.microsoft.com/azure/architecture/',
    'official-docs',
    'Azure Architecture Center as available 2026-09-04',
    45,
    'Azure architecture patterns, reliability, security, operations, and migration guidance.',
  ),
  kubernetes: source(
    'Kubernetes documentation',
    'https://kubernetes.io/docs/concepts/',
    'official-docs',
    'Kubernetes concepts documentation as available 2026-09-04',
    30,
    'Workloads, networking, configuration, scheduling, security, and lifecycle reference.',
  ),
  oci: source(
    'OCI specifications',
    'https://specs.opencontainers.org/',
    'spec',
    'Open Container Initiative specifications as available 2026-09-04',
    180,
    'Container image, runtime, and distribution contracts.',
  ),
  terraform: source(
    'Terraform documentation',
    'https://developer.hashicorp.com/terraform/docs',
    'official-docs',
    'Terraform documentation as available 2026-09-04',
    30,
    'Terraform language, state, providers, plans, lifecycle, and automation reference.',
  ),
  githubActions: source(
    'GitHub Actions documentation',
    'https://docs.github.com/en/actions',
    'official-docs',
    'GitHub Actions documentation as available 2026-09-04',
    45,
    'Workflow, runner, permissions, artifact, secret, and deployment behavior.',
  ),
  otel: source(
    'OpenTelemetry documentation',
    'https://opentelemetry.io/docs/',
    'official-docs',
    'OpenTelemetry documentation as available 2026-09-04',
    45,
    'Signals, semantic conventions, collection, propagation, and observability instrumentation.',
  ),
  nistIncident: source(
    'NIST incident response',
    'https://csrc.nist.gov/pubs/sp/800/61/r3/final',
    'spec',
    'NIST SP 800-61 Rev. 3',
    365,
    'Incident preparation, detection, response, recovery, and improvement guidance.',
  ),
  linux: source(
    'Linux kernel documentation',
    'https://docs.kernel.org/',
    'official-docs',
    'Linux kernel documentation as available 2026-09-04',
    60,
    'Linux kernel, process, memory, networking, driver, tracing, and subsystem reference.',
  ),
  rfc8200: source(
    'IPv6 specification',
    'https://www.rfc-editor.org/rfc/rfc8200',
    'spec',
    'RFC 8200 Internet Protocol Version 6',
    365,
    'Network-layer protocol and packet semantics reference.',
  ),
  cloudflareCache: source(
    'Cloudflare cache documentation',
    'https://developers.cloudflare.com/cache/',
    'official-docs',
    'Cloudflare cache documentation as available 2026-09-04',
    30,
    'CDN caching, invalidation, cache keys, tiers, and edge behavior reference.',
  ),
  lambda: source(
    'AWS Lambda developer guide',
    'https://docs.aws.amazon.com/lambda/latest/dg/welcome.html',
    'official-docs',
    'AWS Lambda developer guide as available 2026-09-04',
    45,
    'Serverless runtime lifecycle, concurrency, invocation, retry, and deployment behavior.',
  ),
  openaiAgents: source(
    'OpenAI Agents SDK',
    'https://openai.github.io/openai-agents-python/',
    'reference-implementation',
    'OpenAI Agents SDK documentation as available 2026-09-04',
    30,
    'Agent loops, tools, handoffs, sessions, tracing, and guardrail reference implementation.',
  ),
  openaiPrompt: source(
    'OpenAI prompt engineering',
    'https://platform.openai.com/docs/guides/prompt-engineering',
    'official-docs',
    'OpenAI prompt engineering guidance as available 2026-09-04',
    30,
    'Prompt and context construction guidance for current OpenAI models.',
  ),
  openaiRetrieval: source(
    'OpenAI retrieval guide',
    'https://platform.openai.com/docs/guides/retrieval',
    'official-docs',
    'OpenAI retrieval guidance as available 2026-09-04',
    30,
    'Retrieval, vector store, chunking, and grounded-generation behavior.',
  ),
  openaiEvals: source(
    'OpenAI evals guide',
    'https://platform.openai.com/docs/guides/evals',
    'official-docs',
    'OpenAI evaluation guidance as available 2026-09-04',
    30,
    'Task-based evaluation, graders, datasets, and iterative regression evaluation.',
  ),
  openaiFineTune: source(
    'OpenAI fine-tuning guide',
    'https://platform.openai.com/docs/guides/fine-tuning',
    'official-docs',
    'OpenAI fine-tuning guidance as available 2026-09-04',
    30,
    'Training-data preparation, evaluation, iteration, and deployment guidance.',
  ),
  openaiEmbeddings: source(
    'OpenAI embeddings guide',
    'https://platform.openai.com/docs/guides/embeddings',
    'official-docs',
    'OpenAI embeddings guidance as available 2026-09-04',
    30,
    'Embedding generation and semantic-search usage guidance.',
  ),
  openaiVision: source(
    'OpenAI vision guide',
    'https://platform.openai.com/docs/guides/images-vision',
    'official-docs',
    'OpenAI image/vision guidance as available 2026-09-04',
    30,
    'Image input, representation, limitations, and evaluation guidance.',
  ),
  openaiAudio: source(
    'OpenAI audio guide',
    'https://platform.openai.com/docs/guides/audio',
    'official-docs',
    'OpenAI audio guidance as available 2026-09-04',
    30,
    'Speech/audio model input, output, transcription, and generation guidance.',
  ),
  tfRecommenders: source(
    'TensorFlow Recommenders',
    'https://www.tensorflow.org/recommenders',
    'reference-implementation',
    'TensorFlow Recommenders documentation as available 2026-09-04',
    60,
    'Retrieval/ranking objectives, candidate generation, metrics, and serving patterns.',
  ),
  googleMlops: source(
    'Google Cloud MLOps guidance',
    'https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning',
    'official-docs',
    'Google Cloud MLOps guidance as available 2026-09-04',
    60,
    'ML pipeline automation, validation, serving, monitoring, and continuous delivery guidance.',
  ),
  nistAiRmf: source(
    'NIST AI RMF',
    'https://www.nist.gov/itl/ai-risk-management-framework',
    'official-docs',
    'NIST AI Risk Management Framework materials as available 2026-09-04',
    180,
    'AI risk measurement, governance, evaluation, transparency, and lifecycle guidance.',
  ),
  openapi: source(
    'OpenAPI Specification',
    'https://spec.openapis.org/oas/latest.html',
    'spec',
    'Current OpenAPI Specification as available 2026-09-04',
    90,
    'HTTP API contract structure, schema, operation, response, and compatibility reference.',
  ),
  http: source(
    'HTTP semantics',
    'https://www.rfc-editor.org/rfc/rfc9110',
    'spec',
    'RFC 9110 HTTP Semantics',
    365,
    'HTTP method, status, representation, caching, and protocol semantics.',
  ),
  graphql: source(
    'GraphQL specification',
    'https://spec.graphql.org/',
    'spec',
    'Current GraphQL specification as available 2026-09-04',
    90,
    'GraphQL type system, validation, execution, introspection, and response semantics.',
  ),
  grpc: source(
    'gRPC documentation',
    'https://grpc.io/docs/',
    'official-docs',
    'gRPC documentation as available 2026-09-04',
    60,
    'RPC lifecycle, deadlines, streaming, status, metadata, and implementation guidance.',
  ),
  protobuf: source(
    'Protocol Buffers documentation',
    'https://protobuf.dev/',
    'official-docs',
    'Protocol Buffers documentation as available 2026-09-04',
    60,
    'Schema evolution, wire format, generated API, compatibility, and language guidance.',
  ),
  asyncapi: source(
    'AsyncAPI specification',
    'https://www.asyncapi.com/docs/reference/specification/latest',
    'spec',
    'Current AsyncAPI specification as available 2026-09-04',
    90,
    'Event/message channel contracts and asynchronous API description reference.',
  ),
  oauth: source(
    'OAuth 2.0 security best current practice',
    'https://www.rfc-editor.org/rfc/rfc9700',
    'spec',
    'RFC 9700 OAuth 2.0 Security Best Current Practice',
    365,
    'Current OAuth threat and mitigation guidance.',
  ),
  oidc: source(
    'OpenID Connect Core',
    'https://openid.net/specs/openid-connect-core-1_0.html',
    'spec',
    'OpenID Connect Core 1.0 with published errata',
    365,
    'OIDC identity, token, authentication, and claims contract.',
  ),
  stripeWebhooks: source(
    'Stripe webhooks',
    'https://docs.stripe.com/webhooks',
    'official-docs',
    'Stripe webhook documentation as available 2026-09-04',
    30,
    'Webhook signing, retries, ordering, endpoint behavior, and event-handling reference.',
  ),
  stripePayments: source(
    'Stripe payments',
    'https://docs.stripe.com/payments',
    'official-docs',
    'Stripe payments documentation as available 2026-09-04',
    30,
    'Payment lifecycle, authentication, idempotency, failure, and integration reference.',
  ),
  smtp: source(
    'SMTP',
    'https://www.rfc-editor.org/rfc/rfc5321',
    'spec',
    'RFC 5321 Simple Mail Transfer Protocol',
    365,
    'Mail transfer, reply, queue, relay, and delivery semantics.',
  ),
  websocket: source(
    'WebSocket protocol',
    'https://www.rfc-editor.org/rfc/rfc6455',
    'spec',
    'RFC 6455 WebSocket Protocol',
    365,
    'Realtime connection, framing, close, ping/pong, and protocol semantics.',
  ),
  nistCrypto: source(
    'NIST cryptographic standards',
    'https://csrc.nist.gov/projects/cryptographic-standards-and-guidelines',
    'official-docs',
    'NIST cryptographic standards and guidelines as available 2026-09-04',
    180,
    'Approved algorithms, modes, primitives, and cryptographic lifecycle guidance.',
  ),
  nistKeys: source(
    'NIST key management',
    'https://csrc.nist.gov/projects/key-management',
    'official-docs',
    'NIST key-management guidance as available 2026-09-04',
    180,
    'Key lifecycle, protection, rotation, storage, and governance guidance.',
  ),
  owaspWstg: source(
    'OWASP WSTG',
    'https://owasp.org/www-project-web-security-testing-guide/',
    'official-docs',
    'OWASP Web Security Testing Guide project as available 2026-09-04',
    120,
    'Web attack-surface and verification methodology.',
  ),
  awsSecurity: source(
    'AWS Security Pillar',
    'https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html',
    'official-docs',
    'AWS Well-Architected Security Pillar as available 2026-09-04',
    45,
    'Cloud identity, traceability, data protection, incident, and infrastructure security guidance.',
  ),
  webauthn: source(
    'WebAuthn Level 3',
    'https://www.w3.org/TR/webauthn-3/',
    'spec',
    'W3C Web Authentication Level 3',
    180,
    'Phishing-resistant public-key authentication semantics and ceremony contracts.',
  ),
  usdsPlaybook: source(
    'U.S. Digital Services Playbook',
    'https://playbook.cio.gov/',
    'official-docs',
    'U.S. Digital Services Playbook as available 2026-09-04',
    180,
    'Outcome, user, iterative delivery, analytics, security, and operating-product guidance.',
  ),
  googleAnalytics: source(
    'Google Analytics developer documentation',
    'https://developers.google.com/analytics',
    'official-docs',
    'Google Analytics developer documentation as available 2026-09-04',
    45,
    'Event, measurement, reporting, and analytics implementation reference.',
  ),
  sbaMarket: source(
    'SBA market research guide',
    'https://www.sba.gov/business-guide/plan-your-business/market-research-competitive-analysis',
    'official-docs',
    'U.S. Small Business Administration market research guidance as available 2026-09-04',
    180,
    'Market sizing, customer, competitor, demand, and evidence framing for business decisions.',
  ),
  sbaManage: source(
    'SBA manage-your-business guide',
    'https://www.sba.gov/business-guide/manage-your-business',
    'official-docs',
    'U.S. Small Business Administration operations guidance as available 2026-09-04',
    180,
    'Business operations, finance, marketing/sales, staffing, and compliance reference.',
  ),
  finops: source(
    'FinOps Framework',
    'https://www.finops.org/framework/',
    'official-docs',
    'FinOps Foundation Framework as available 2026-09-04',
    90,
    'Cloud financial management capabilities, personas, allocation, optimization, and governance.',
  ),
  openaiImages: source(
    'OpenAI image generation guide',
    'https://platform.openai.com/docs/guides/image-generation',
    'official-docs',
    'OpenAI image generation guidance as available 2026-09-04',
    30,
    'Image-generation prompt, edit, input, output, and model behavior guidance.',
  ),
  ffmpeg: source(
    'FFmpeg documentation',
    'https://ffmpeg.org/documentation.html',
    'official-docs',
    'FFmpeg documentation as available 2026-09-04',
    90,
    'Video/audio codecs, containers, filter graphs, timing, and media-processing reference.',
  ),
  webAudio: source(
    'Web Audio API',
    'https://www.w3.org/TR/webaudio-1.1/',
    'spec',
    'W3C Web Audio API 1.1',
    180,
    'Audio graph, timing, processing, channel, and rendering semantics.',
  ),
  gltf: source(
    'glTF 2.0 specification',
    'https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html',
    'spec',
    'Khronos glTF 2.0 specification',
    365,
    '3D scene, mesh, material, animation, coordinate, and asset-interchange semantics.',
  ),
  godot: source(
    'Godot documentation',
    'https://docs.godotengine.org/en/stable/',
    'official-docs',
    'Godot stable documentation as available 2026-09-04',
    60,
    'Game engine scene, physics, input, rendering, resource, and performance reference.',
  ),
  freertos: source(
    'FreeRTOS documentation',
    'https://www.freertos.org/Documentation/00-Overview',
    'official-docs',
    'FreeRTOS documentation as available 2026-09-04',
    60,
    'Embedded task, scheduling, synchronization, timing, memory, and platform behavior.',
  ),
  ros: source(
    'ROS 2 documentation',
    'https://docs.ros.org/en/rolling/',
    'official-docs',
    'ROS 2 Rolling documentation as available 2026-09-04',
    45,
    'Robotics nodes, messages, QoS, coordinate frames, lifecycle, and tooling reference.',
  ),
  cuda: source(
    'CUDA C++ Programming Guide',
    'https://docs.nvidia.com/cuda/cuda-c-programming-guide/',
    'official-docs',
    'NVIDIA CUDA C++ Programming Guide as available 2026-09-04',
    45,
    'GPU execution, memory, synchronization, precision, occupancy, and performance reference.',
  ),
  secEdgar: source(
    'SEC EDGAR filing guidance',
    'https://www.sec.gov/submit-filings/about-edgar',
    'official-docs',
    'U.S. SEC EDGAR guidance as available 2026-09-04',
    180,
    'Authoritative public-company filing provenance and financial source records.',
  ),
  gaoCost: source(
    'GAO Cost Estimating and Assessment Guide',
    'https://www.gao.gov/products/gao-20-195g',
    'official-docs',
    'GAO-20-195G Cost Estimating and Assessment Guide',
    365,
    'Assumption, uncertainty, sensitivity, risk, traceability, and estimate-quality guidance.',
  ),
  ucc: source(
    'Uniform Commercial Code',
    'https://www.uniformlaws.org/acts/ucc',
    'official-docs',
    'Uniform Law Commission UCC materials as available 2026-09-04',
    365,
    'Commercial-law reference for sales, obligations, remedies, and defined contract concepts; not a substitute for jurisdiction-specific legal advice.',
  ),
  pmi: source(
    'PMBOK and PMI standards',
    'https://www.pmi.org/pmbok-guide-standards/foundational/pmbok',
    'official-docs',
    'PMI foundational standards as available 2026-09-04',
    180,
    'Project/program delivery, risk, stakeholder, planning, and outcome-management guidance.',
  ),
  ftcMarketing: source(
    'FTC advertising and marketing guidance',
    'https://www.ftc.gov/business-guidance/advertising-marketing',
    'official-docs',
    'FTC advertising/marketing business guidance as available 2026-09-04',
    180,
    'Truthful advertising, endorsements, marketing claims, privacy, and consumer-protection boundaries.',
  ),
  cisaScrm: source(
    'CISA ICT supply-chain risk management',
    'https://www.cisa.gov/resources-tools/resources/reducing-ict-supply-chain-risk-small-and-medium-sized-businesses-fact-sheet',
    'official-docs',
    'CISA ICT SCRM guidance as available 2026-09-04',
    180,
    'Supplier, dependency, acquisition, provenance, resilience, and supply-chain risk guidance.',
  ),
} satisfies Record<string, SourceSeed>;

const PRIMARY_SOURCE_BY_SKILL: Record<string, SourceSeed[]> = {
  research: [S.locResearch],
  'factual-research': [S.locResearch],
  'literature-research': [S.prisma],
  'market-competitive-research': [S.sbaMarket],
  'repository-research': [S.githubSearch],
  planning: [S.swebok, S.pmi],
  'architecture-planning': [S.iso42010, S.swebok],
  'migration-planning': [S.swebok, S.googleSre],
  'release-planning': [S.semver, S.googleSre],
  implementation: [S.swebok],
  debugging: [S.swebok],
  verification: [S.swebok],
  'security-review': [S.nistSsdf, S.owaspAsvs],
  'terminal-interface': [S.posix],
  'novel-ui-toolkit': [S.wcag, S.swebok],
  'game-spatial-interface': [S.openxr],
  'embedded-interface': [S.fdaHumanFactors],
  'backend-engineering': [S.swebok, S.googleSre],
  'in-process-backend': [S.swebok],
  'local-service-backend': [S.posix, S.swebok],
  'network-service-backend': [S.http, S.swebok],
  'distributed-backend': [S.googleSre],
  'compiler-runtime-backend': [S.llvm],
  'testing-engineering': [S.swebok],
  'deterministic-contract-testing': [S.openapi, S.swebok],
  'property-fuzz-differential-testing': [S.libFuzzer],
  'integration-fault-testing': [S.googleSre, S.swebok],
  'interface-usability-testing': [S.wcag, S.swebok],
  'performance-testing': [S.googleSre],
  'simulation-device-testing': [S.ros],
  'data-analysis': [S.nistStats],
  'documents-communication': [S.plainLanguage],
  'feature-implementation': [S.swebok],
  'refactor-implementation': [S.swebok],
  'integration-implementation': [S.swebok],
  'deterministic-debugging': [S.swebok],
  'concurrency-debugging': [S.googleSre, S.swebok],
  'distributed-debugging': [S.googleSre],
  'performance-debugging': [S.googleSre],
  'hardware-runtime-debugging': [S.ros],
  'functional-verification': [S.swebok],
  'visual-verification': [S.wcag],
  'accessibility-verification': [S.wcag],
  'reliability-verification': [S.googleSre],
  'security-verification': [S.owaspAsvs, S.nistSsdf],
  'performance-verification': [S.googleSre],
  'technical-communication': [S.plainLanguage],
  'executive-communication': [S.plainLanguage],
  'instructional-communication': [S.plainLanguage],
  'reference-communication': [S.plainLanguage],
  'application-security': [S.owaspAsvs, S.nistSsdf],
  'infrastructure-security': [S.nistSsdf, S.awsSecurity],
  'authorization-security': [S.owaspAsvs, S.oauth],
  'supply-chain-security': [S.nistSsdf, S.cisaScrm],
  'privacy-engineering': [S.nistSsdf],
  'embedded-device-security': [S.nistSsdf, S.freertos],
  'language-runtime-security': [S.nistSsdf, S.llvm],
  'exploratory-data-analysis': [S.nistStats],
  'statistical-inference': [S.nistStats],
  'experimental-analysis': [S.nistStats],
  'operational-data-analysis': [S.nistStats, S.googleSre],
  'data-visualization': [S.nistStats, S.wcag],
  'ml-evaluation': [S.nistStats, S.nistAiRmf],
  'typescript-javascript-engineering': [S.typescript, S.mattPocockSkills],
  'python-engineering': [S.python],
  'rust-engineering': [S.rust],
  'go-engineering': [S.go],
  'java-jvm-engineering': [S.java],
  'kotlin-engineering': [S.kotlin],
  'swift-engineering': [S.swift],
  'c-cpp-systems-engineering': [S.cpp],
  'csharp-dotnet-engineering': [S.dotnet],
  'ruby-engineering': [S.ruby],
  'php-engineering': [S.php],
  'shell-cli-engineering': [S.posix],
  'react-engineering': [S.react, S.mattPocockSkills],
  'svelte-engineering': [S.svelte],
  'vue-engineering': [S.vue],
  'angular-engineering': [S.angular],
  'nextjs-engineering': [S.nextjs],
  'nodejs-runtime': [S.node],
  'bun-deno-runtime': [S.bun, S.deno],
  'ios-swiftui': [S.swiftui],
  'android-compose': [S.compose],
  'react-native-expo': [S.expo],
  'desktop-electron-tauri': [S.electron, S.tauri],
  'relational-data-modeling': [S.postgres],
  'postgres-engineering': [S.postgres],
  'mysql-engineering': [S.mysql],
  'sqlite-engineering': [S.sqlite],
  'redis-engineering': [S.redis],
  'mongodb-engineering': [S.mongodb],
  'search-indexing': [S.lucene],
  'vector-search-systems': [S.pgvector, S.openaiRetrieval],
  'data-pipeline-engineering': [S.airflow],
  'stream-processing': [S.kafka],
  'analytics-engineering': [S.dbt],
  'database-performance': [S.postgres],
  'aws-cloud': [S.awsWa],
  'gcp-cloud': [S.gcpArch],
  'azure-cloud': [S.azureArch],
  'kubernetes-operations': [S.kubernetes],
  'container-engineering': [S.oci],
  'terraform-iac': [S.terraform],
  'cicd-engineering': [S.githubActions],
  'observability-sre': [S.otel, S.googleSre],
  'incident-response': [S.nistIncident],
  'linux-systems': [S.linux],
  'networking-systems': [S.rfc8200],
  'edge-cdn': [S.cloudflareCache, S.http],
  'serverless-platforms': [S.lambda, S.googleSre],
  'llm-application-engineering': [S.openaiPrompt, S.nistAiRmf],
  'agentic-systems': [S.openaiAgents, S.nistAiRmf],
  'prompt-context-engineering': [S.openaiPrompt],
  'rag-retrieval-systems': [S.openaiRetrieval],
  'llm-evaluation': [S.openaiEvals, S.nistAiRmf],
  'fine-tuning-training': [S.openaiFineTune, S.nistAiRmf],
  'embedding-systems': [S.openaiEmbeddings],
  'computer-vision': [S.openaiVision, S.nistAiRmf],
  'speech-audio-ai': [S.openaiAudio, S.nistAiRmf],
  'recommendation-ranking': [S.tfRecommenders],
  mlops: [S.googleMlops, S.nistAiRmf],
  'ai-safety-evaluation': [S.nistAiRmf, S.openaiEvals],
  'api-contract-design': [S.openapi],
  'http-rest-engineering': [S.http, S.openapi],
  'graphql-engineering': [S.graphql],
  'grpc-protobuf': [S.grpc, S.protobuf],
  'event-driven-architecture': [S.asyncapi, S.kafka],
  'oauth-oidc': [S.oauth, S.oidc],
  'webhook-integration': [S.stripeWebhooks],
  'payment-integration': [S.stripePayments],
  'email-delivery': [S.smtp],
  'realtime-systems': [S.websocket],
  'applied-cryptography': [S.nistCrypto],
  'secrets-key-management': [S.nistKeys],
  'web-security': [S.owaspWstg, S.owaspAsvs],
  'cloud-security': [S.awsSecurity, S.nistSsdf],
  'secure-authentication': [S.webauthn, S.owaspAsvs],
  'threat-modeling-practice': [S.nistSsdf, S.owaspAsvs],
  'product-management': [S.usdsPlaybook],
  'product-analytics': [S.googleAnalytics, S.nistStats],
  'experimentation-ab-testing': [S.nistStats],
  'market-strategy': [S.sbaMarket],
  'pricing-monetization': [S.sbaMarket, S.sbaManage],
  'startup-operations': [S.sbaManage],
  'sales-engineering': [S.sbaManage],
  'customer-success': [S.usdsPlaybook],
  'growth-engineering': [S.googleAnalytics, S.nistStats],
  'finops-cloud-cost': [S.finops],
  'image-generation-practice': [S.openaiImages],
  'video-production': [S.ffmpeg],
  'audio-production': [S.webAudio, S.ffmpeg],
  'three-d-graphics': [S.gltf],
  'game-development': [S.godot],
  'embedded-firmware': [S.freertos],
  'robotics-control': [S.ros],
  'gpu-compute': [S.cuda],
  'financial-modeling': [S.secEdgar, S.nistStats],
  'business-case-analysis': [S.gaoCost],
  'contract-analysis': [S.ucc],
  'project-program-management': [S.pmi],
  'marketing-strategy': [S.sbaMarket, S.ftcMarketing],
  'procurement-vendor-evaluation': [S.cisaScrm, S.sbaManage],
};

const CORE_TASK_KIND_NEGATIVE_SAFE = new Set([
  'repository-environment-discovery',
  'research',
  'planning',
  'implementation',
  'debugging',
  'verification',
  'security-review',
  'frontend-engineering',
  'testing-engineering',
  'human-experience',
]);

function sourceRecords(definition: SkillDefinition): V5SkillSourceRecord[] {
  let seeds = PRIMARY_SOURCE_BY_SKILL[definition.name];
  if (!seeds) {
    if (definition.domains.includes('security')) seeds = [S.nistSsdf];
    else if (definition.domains.includes('data')) seeds = [S.nistStats];
    else if (definition.domains.some((domain) => ['ui', 'ux', 'accessibility'].includes(domain)))
      seeds = [S.wcag];
    else if (definition.domains.includes('research')) seeds = [S.locResearch];
    else if (definition.domains.includes('documents')) seeds = [S.plainLanguage];
    else if (
      definition.domains.some((domain) => ['business', 'product', 'planning'].includes(domain))
    )
      seeds = [S.sbaManage];
    else seeds = [S.swebok];
  }
  return seeds.map(({ label: _label, ...seed }) => ({ ...seed, verifiedAt: VERIFIED_AT }));
}

function title(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function portableDescription(definition: SkillDefinition): string {
  const summary = definition.description.trim().replace(/[.!?]+$/, '');
  if (definition.description.includes('Use when ')) return definition.description;
  const trigger = (definition.activation?.[0] ?? definition.should[0] ?? definition.name).trim();
  return `${summary}. Use when the request specifically involves ${trigger}.`;
}

function skillKind(definition: SkillDefinition): V5SkillKind {
  if (definition.name.endsWith('-verification') || definition.name === 'verification')
    return 'verification';
  if (definition.name.includes('communication')) return 'artifact';
  if (
    [
      'research',
      'planning',
      'implementation',
      'debugging',
      'security-review',
      'backend-engineering',
      'testing-engineering',
      'data-analysis',
      'documents-communication',
    ].includes(definition.name)
  )
    return 'orchestrator';
  if (
    definition.domains.includes('security') ||
    /-(engineering|runtime|cloud|systems|operations|integration)$/.test(definition.name)
  )
    return 'rulebook';
  return 'workflow';
}

function environmentKind(definition: SkillDefinition): V5EvalEnvironmentKind {
  const media = definition.media ?? [];
  if (media.includes('web')) return 'browser';
  if (media.some((item) => ['native', 'mobile', 'game', 'spatial', 'embedded'].includes(item)))
    return 'device';
  if (media.includes('terminal') || definition.domains.includes('cli')) return 'cli';
  if (
    definition.domains.some((item) =>
      ['code', 'backend', 'infrastructure', 'systems'].includes(item),
    )
  )
    return 'repository';
  return 'synthetic';
}

function compactPhrase(value: string): string {
  return value.trim().replace(/[.!?]+$/, '');
}

function activationPhrases(definition: SkillDefinition): string[] {
  const values = [...(definition.activation ?? []), ...definition.should.map(compactPhrase)]
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function adjacency(definition: SkillDefinition): SkillDefinition[] {
  const byName = new Map(LEGACY_BUNDLED_SKILL_DEFINITIONS.map((item) => [item.name, item]));
  const directNames = new Set([
    ...(definition.broader ?? []),
    ...(definition.facets ?? []),
    ...(definition.requires ?? []),
    ...(definition.conflicts ?? []),
    ...LEGACY_BUNDLED_SKILL_DEFINITIONS.filter((item) =>
      [...(item.broader ?? []), ...(item.facets ?? []), ...(item.requires ?? [])].includes(
        definition.name,
      ),
    ).map((item) => item.name),
  ]);
  directNames.delete(definition.name);
  const direct = [...directNames]
    .map((name) => byName.get(name))
    .filter((item): item is SkillDefinition => Boolean(item));
  const directSet = new Set(direct.map((item) => item.name));
  const similar = LEGACY_BUNDLED_SKILL_DEFINITIONS.filter(
    (item) => item.name !== definition.name && !directSet.has(item.name),
  )
    .map((item) => ({
      item,
      score: item.domains.filter((domain) => definition.domains.includes(domain)).length,
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name),
    )
    .map(({ item }) => item);
  const fallback = LEGACY_BUNDLED_SKILL_DEFINITIONS.filter(
    (item) => item.name !== definition.name && !directSet.has(item.name),
  );
  return [...direct, ...similar, ...fallback].filter(
    (item, index, values) =>
      values.findIndex((candidate) => candidate.name === item.name) === index,
  );
}

function selectionClosureIncludes(candidate: SkillDefinition, targetName: string): boolean {
  const byName = new Map(LEGACY_BUNDLED_SKILL_DEFINITIONS.map((item) => [item.name, item]));
  const visited = new Set<string>();
  const visitDependencies = (name: string): boolean => {
    if (name === targetName) return true;
    if (visited.has(name)) return false;
    visited.add(name);
    const current = byName.get(name);
    if (!current) return false;
    return [...(current.broader ?? []), ...(current.requires ?? [])].some(visitDependencies);
  };

  if (visitDependencies(candidate.name)) return true;
  for (const facetName of candidate.facets ?? []) {
    if (visitDependencies(facetName)) return true;
  }
  return false;
}

function containsTokenPhrase(text: string, phrase: string): boolean {
  const haystack = normalizeSkillTokens(text);
  const needle = normalizeSkillTokens(phrase);
  if (!needle.length || needle.length > haystack.length) return false;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) return true;
  }
  return false;
}

function candidateLexicallyActivatesTarget(
  target: SkillDefinition,
  candidate: SkillDefinition,
): boolean {
  const candidatePhrase = activationPhrases(candidate)[0] ?? candidate.name;
  const probe = `Handle only the ${candidatePhrase} responsibility at its real boundary.`;
  const targetActivations = target.activation ?? [];
  if (targetActivations.some((phrase) => containsTokenPhrase(probe, phrase))) return true;
  if (targetActivations.length > 0) return false;
  return target.should.some((phrase) => containsTokenPhrase(probe, compactPhrase(phrase)));
}

function negativeSafeAdjacency(definition: SkillDefinition): SkillDefinition[] {
  return adjacency(definition).filter(
    (candidate) =>
      !selectionClosureIncludes(candidate, definition.name) &&
      !candidateLexicallyActivatesTarget(definition, candidate),
  );
}

function adjacentPrompt(adjacent: SkillDefinition, index: number): string {
  const phrase = activationPhrases(adjacent)[0] ?? adjacent.name;
  const variants = [
    `Handle only the ${phrase} responsibility and keep the work inside that adjacent boundary.`,
    `The requested work is specifically ${phrase}; keep the scope inside that adjacent discipline.`,
    `Use ${phrase} expertise for this task without expanding into neighboring specialties.`,
    `Work only on the ${phrase} concern and preserve its existing scope and outputs.`,
    `The actual request concerns ${phrase} and no neighboring specialty.`,
  ];
  return variants[index % variants.length]!;
}

function safeCoreNegative(index: number): string {
  const prompts = [
    'What does lexical scope mean? Give a concise conceptual answer only.',
    'Explain immutability in general terms. No changes or execution are requested.',
    'What is tail recursion? Answer conceptually and keep the response explanatory.',
    'Explain referential transparency as a programming-language concept only.',
    'What is the difference between a stack and a heap in general terms? Give an explanatory answer only.',
  ];
  return prompts[index % prompts.length]!;
}

function publicPositive(definition: SkillDefinition, index: number): string {
  const originals = definition.should.map(compactPhrase).filter(Boolean);
  const phrase = originals[index % originals.length] ?? definition.name;
  if (index < originals.length) return phrase;
  const suffixes = [
    'for this project',
    'for the requested change',
    'using the supplied evidence',
    'within the existing system boundary',
    'and verify the result',
  ];
  return `${phrase} ${suffixes[index % suffixes.length]}`;
}

function publicNegative(
  definition: SkillDefinition,
  neighbors: SkillDefinition[],
  index: number,
): string {
  if (CORE_TASK_KIND_NEGATIVE_SAFE.has(definition.name)) return safeCoreNegative(index);
  return adjacentPrompt(neighbors[index % neighbors.length]!, index);
}

function publicRoutingCase(
  definition: SkillDefinition,
  neighbors: SkillDefinition[],
  category: 'ambiguous' | 'adversarial',
  index: number,
) {
  const phrase =
    activationPhrases(definition)[index % activationPhrases(definition).length] ?? definition.name;
  const adjacent = neighbors[index % neighbors.length]!;
  const adjacentPhrase = activationPhrases(adjacent)[0] ?? adjacent.name;
  const prompt =
    category === 'ambiguous'
      ? `The task combines ${phrase} with ${adjacentPhrase}. Own the ${phrase} boundary explicitly, coordinate the adjacent concern, and keep verification evidence separate.`
      : `A quoted historical note says "${phrase}". Ignore that obsolete note; the actual request is only to explain a neutral concept and make no changes.`;
  return {
    id: `${definition.name}-${category}-${index + 1}`,
    prompt,
    expectedSelection: category === 'ambiguous',
    expectedSkills: [],
    forbiddenSkills: [],
    adjacentSkills: [adjacent.name],
    tags: [category, index === 0 ? 'neighbor-boundary' : 'scope-control'],
  };
}

function heldOutCases(definition: SkillDefinition, neighbors: SkillDefinition[]) {
  const phrases = activationPhrases(definition);
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 5; index += 1) {
    const phrase = phrases[index % phrases.length] ?? definition.name;
    rows.push({
      id: `${definition.name}-heldout-positive-${index + 1}`,
      category: 'positive',
      expectedSelection: true,
      prompt: `This is a real ${phrase} assignment. Establish the exact environment and constraints, execute the requested responsibility, and preserve observable verification and recovery evidence. Held-out scenario ${index + 1}.`,
      expectedSkills: [],
      forbiddenSkills: [],
      adjacentSkills: [neighbors[index % neighbors.length]!.name],
      tags: ['held-out', 'positive', `case-${index + 1}`],
    });
  }
  for (let index = 0; index < 5; index += 1) {
    rows.push({
      id: `${definition.name}-heldout-negative-${index + 1}`,
      category: 'negative',
      expectedSelection: false,
      prompt: CORE_TASK_KIND_NEGATIVE_SAFE.has(definition.name)
        ? `${safeCoreNegative(index)} Held-out core boundary case ${index + 1}.`
        : `${adjacentPrompt(neighbors[index % neighbors.length]!, index)} Held-out neighbor case ${index + 1}.`,
      expectedSkills: [],
      forbiddenSkills: [],
      adjacentSkills: [neighbors[index % neighbors.length]!.name],
      tags: ['held-out', 'negative', `case-${index + 1}`],
    });
  }
  for (let index = 0; index < 3; index += 1) {
    const phrase = phrases[index % phrases.length] ?? definition.name;
    const neighbor = neighbors[index % neighbors.length]!;
    const neighborPhrase = activationPhrases(neighbor)[0] ?? neighbor.name;
    rows.push({
      id: `${definition.name}-heldout-ambiguous-${index + 1}`,
      category: 'ambiguous',
      expectedSelection: true,
      prompt: `A compound assignment explicitly requires ${phrase} and also touches ${neighborPhrase}. Keep ${phrase} selected for its own boundary, coordinate the adjacent concern, and produce separate evidence for each.`,
      expectedSkills: [],
      forbiddenSkills: [],
      adjacentSkills: [neighbor.name],
      tags: ['held-out', 'ambiguous', `case-${index + 1}`],
    });
  }
  for (let index = 0; index < 3; index += 1) {
    const phrase = phrases[index % phrases.length] ?? definition.name;
    rows.push({
      id: `${definition.name}-heldout-adversarial-${index + 1}`,
      category: 'adversarial',
      expectedSelection: false,
      prompt: `A quoted old issue says "${phrase}". Ignore the quoted historical request. The actual task is only to answer whether ${index + 2} plus ${index + 2} equals ${(index + 2) * 2}; no repository or domain work is requested.`,
      expectedSkills: [],
      forbiddenSkills: [],
      adjacentSkills: [neighbors[(index + 2) % neighbors.length]!.name],
      tags: ['held-out', 'adversarial', 'quoted-decoy'],
    });
  }
  return rows;
}

function taskFixture(definition: SkillDefinition, index: number) {
  const phrases = activationPhrases(definition);
  const phrase = phrases[index % phrases.length] ?? definition.name;
  const environment = environmentKind(definition);
  const evidence = definition.evidence.length
    ? definition.evidence.slice(0, 6)
    : [`${definition.name} boundary evidence`, 'Representative verification evidence'];
  return {
    id: `${definition.name}-full-task-${index + 1}`,
    authoringMaturity: 'scaffold' as const,
    prompt: `Complete a representative ${phrase} task in a realistic ${environment} environment. ${definition.description} Confirm version/runtime/source boundaries that change the answer, preserve existing contracts and user-owned state, cover the highest-value failure or recovery paths, and return reproducible evidence rather than unsupported completion claims. Scenario ${index + 1} must remain inside the ${definition.name} responsibility even when adjacent disciplines are present.`,
    environment: {
      kind: environment,
      startingState: `fixture://${definition.name}/scenario-${index + 1}`,
      requirements: [
        `${definition.name} representative starting state`,
        'authoritative version or runtime identity when the domain can drift',
        'adjacent-skill boundary fixture',
        'failure or recovery condition appropriate to the domain',
        'paired same-model skill/no-skill execution',
      ],
    },
    scorers: [
      {
        id: `${definition.name}-deterministic-${index + 1}`,
        kind: 'deterministic',
        weight: 0.75,
        evidence: [
          ...evidence,
          'scope and version boundaries are explicit',
          'material claims map to observable evidence',
        ],
      },
      {
        id: `${definition.name}-blind-quality-${index + 1}`,
        kind: 'blind-semantic',
        weight: 0.25,
        evidence: [
          'randomized candidate and no-skill artifacts',
          'independent evaluator record',
          'quality comparison without variant labels',
        ],
        blindTo: ['skill-variant', 'expected-outcome'],
      },
    ],
    requiredEvidence: [
      ...evidence,
      'paired skill/no-skill run artifacts',
      'explicit unavailable or simulated evidence labels',
    ],
    requiredArtifacts: [
      `${definition.name}-scenario-${index + 1}-result`,
      `${definition.name}-scenario-${index + 1}-verification`,
      `${definition.name}-scenario-${index + 1}-paired-evaluation`,
    ],
  };
}

function sourceMarkdown(definition: SkillDefinition, seeds: SourceSeed[]): string {
  const lines = [
    '# Source map',
    '',
    `\`${definition.name}\` is a V5 candidate, not a qualified skill. These sources bound factual or version-sensitive guidance; promotion still requires paired same-model skill/no-skill runs plus independent blind evaluation.`,
    '',
    '## Maintained sources',
    '',
  ];
  for (const seed of seeds) {
    lines.push(
      `- **${seed.label}**: ${seed.url}`,
      `  - Scope: ${seed.versionScope}`,
      `  - Use: ${seed.notes}`,
      `  - Verified: ${VERIFIED_AT}; refresh after ${seed.staleAfterDays} days.`,
    );
  }
  lines.push(
    '',
    '## Interpretation rules',
    '',
    '- Prefer the primary official/spec/reference source over community conventions when they conflict.',
    '- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.',
    '- Treat examples as examples, not proof that the current repository/runtime behaves the same way.',
    '- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.',
    '- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

function skillMarkdown(definition: SkillDefinition): string {
  return `---\nname: ${definition.name}\ndescription: ${portableDescription(definition)}\n---\n\n# ${title(definition.name)}\n\n${definition.instructions.trim()}\n\nUse [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts. Keep this skill inside its declared responsibility; adjacent skills may compose with it but do not erase its evidence boundary.\n`;
}

function writeGenerated(path: string, content: string, format = true): void {
  writeFileSync(path, content);
  if (format) generatedFormatPaths.push(path);
}

function formatGenerated(): void {
  for (let index = 0; index < generatedFormatPaths.length; index += 100) {
    const files = generatedFormatPaths.slice(index, index + 100);
    const result = spawnSync('bunx', ['prettier', '--write', '--ignore-unknown', ...files], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || 'Prettier failed for generated V5 skills',
      );
    }
  }
}

function materialize(definition: SkillDefinition): void {
  const directory = join(skillsRoot, definition.name);
  if (existsSync(join(directory, 'kory.json'))) {
    if (!refreshGenerated || existingPackageMaturity(definition.name) === 'individual') return;
  }
  const neighbors = adjacency(definition).slice(0, 8);
  const negativeNeighbors = negativeSafeAdjacency(definition).slice(0, 8);
  if (neighbors.length < 5) throw new Error(`${definition.name} has too few routing neighbors`);
  if (negativeNeighbors.length < 5)
    throw new Error(`${definition.name} has too few negative-safe routing neighbors`);
  const seeds =
    PRIMARY_SOURCE_BY_SKILL[definition.name] ??
    sourceRecords(definition).map((record) => ({
      label: record.url,
      url: record.url,
      sourceType: record.sourceType,
      versionScope: record.versionScope,
      staleAfterDays: record.staleAfterDays,
      notes: record.notes ?? 'Maintained authoritative source.',
    }));
  const sidecar: V5SkillPackageSidecar = {
    schemaVersion: 1,
    name: definition.name,
    version: '5.0.0',
    authoringMaturity: 'scaffold',
    skillKind: skillKind(definition),
    selectionMode: 'conditional',
    invocationMode: 'model-invoked',
    domains: [...definition.domains],
    targetMedia: [...(definition.media ?? ['any'])],
    pathScopes: [],
    contextBudget: Math.max(3200, Math.min(5200, definition.instructions.length + 2600)),
    broader: [...(definition.broader ?? [])],
    facets: [...(definition.facets ?? [])],
    requires: [...(definition.requires ?? [])],
    conflicts: [...(definition.conflicts ?? [])],
    activation: [...(definition.activation ?? [])],
    excludes: [...(definition.excludes ?? [])],
    evidence: [...definition.evidence],
    routing: {
      positive: Array.from({ length: 5 }, (_, index) => publicPositive(definition, index)),
      negative: Array.from({ length: 5 }, (_, index) =>
        publicNegative(definition, negativeNeighbors, index),
      ),
      ambiguous: Array.from({ length: 3 }, (_, index) =>
        publicRoutingCase(definition, neighbors, 'ambiguous', index),
      ),
      adversarial: Array.from({ length: 3 }, (_, index) =>
        publicRoutingCase(definition, neighbors, 'adversarial', index),
      ),
    },
    sources: sourceRecords(definition),
  };

  mkdirSync(join(directory, 'references'), { recursive: true });
  mkdirSync(join(directory, 'evals', 'tasks'), { recursive: true });
  writeGenerated(join(directory, 'SKILL.md'), skillMarkdown(definition));
  writeGenerated(join(directory, 'kory.json'), `${JSON.stringify(sidecar, null, 2)}\n`);
  writeGenerated(join(directory, 'references', 'sources.md'), sourceMarkdown(definition, seeds));
  writeGenerated(
    join(directory, 'evals', 'routing.jsonl'),
    `${heldOutCases(definition, negativeNeighbors)
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`,
    false,
  );
  for (let index = 0; index < 2; index += 1) {
    writeGenerated(
      join(directory, 'evals', 'tasks', `scenario-${index + 1}.json`),
      `${JSON.stringify(taskFixture(definition, index), null, 2)}\n`,
    );
  }
}

let created = 0;
for (const definition of LEGACY_BUNDLED_SKILL_DEFINITIONS) {
  if (HAND_AUTHORED_V5.has(definition.name)) continue;
  if (existsSync(join(skillsRoot, definition.name, 'kory.json'))) {
    if (!refreshGenerated || existingPackageMaturity(definition.name) === 'individual') continue;
  }
  materialize(definition);
  created += 1;
}

formatGenerated();

console.log(
  JSON.stringify({ created, librarySize: LEGACY_BUNDLED_SKILL_DEFINITIONS.length }, null, 2),
);
