import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  C_CPP_SKILL_EVAL_MATERIALIZERS,
  C_CPP_SKILL_EVAL_SCORERS,
} from './skill-eval-c-cpp-fixtures';
import {
  WRITING_STYLE_SKILL_EVAL_MATERIALIZERS,
  WRITING_STYLE_SKILL_EVAL_SCORERS,
} from './skill-eval-writing-style-fixtures';
import {
  COMMUNICATION_SKILL_EVAL_MATERIALIZERS,
  COMMUNICATION_SKILL_EVAL_SCORERS,
} from './skill-eval-communication-fixtures';
import {
  RESPONSE_STYLE_SKILL_EVAL_MATERIALIZERS,
  RESPONSE_STYLE_SKILL_EVAL_SCORERS,
} from './skill-eval-response-style-fixtures';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  hasRegressionText,
  packageJson,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';
import {
  PILOT_SKILL_EVAL_MATERIALIZERS,
  PILOT_SKILL_EVAL_SCORERS,
} from './skill-eval-pilot-fixtures';
import {
  TASK_ROUTING_SKILL_EVAL_MATERIALIZERS,
  TASK_ROUTING_SKILL_EVAL_SCORERS,
} from './skill-eval-task-routing-fixtures';
import {
  REPOSITORY_ENVIRONMENT_DISCOVERY_SKILL_EVAL_MATERIALIZERS,
  REPOSITORY_ENVIRONMENT_DISCOVERY_SKILL_EVAL_SCORERS,
} from './skill-eval-repository-environment-discovery-fixtures';
import {
  PLAN_MODE_SKILL_EVAL_MATERIALIZERS,
  PLAN_MODE_SKILL_EVAL_SCORERS,
} from './skill-eval-plan-mode-fixtures';
import {
  WEBHOOK_INTEGRATION_SKILL_EVAL_MATERIALIZERS,
  WEBHOOK_INTEGRATION_SKILL_EVAL_SCORERS,
} from './skill-eval-webhook-integration-fixtures';
import {
  API_CONTRACT_DESIGN_SKILL_EVAL_MATERIALIZERS,
  API_CONTRACT_DESIGN_SKILL_EVAL_SCORERS,
} from './skill-eval-api-contract-design-fixtures';
import {
  HTTP_REST_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  HTTP_REST_ENGINEERING_SKILL_EVAL_SCORERS,
} from './skill-eval-http-rest-engineering-fixtures';
import {
  GRAPHQL_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  GRAPHQL_ENGINEERING_SKILL_EVAL_SCORERS,
} from './skill-eval-graphql-engineering-fixtures';
import {
  GRPC_PROTOBUF_SKILL_EVAL_MATERIALIZERS,
  GRPC_PROTOBUF_SKILL_EVAL_SCORERS,
} from './skill-eval-grpc-protobuf-fixtures';
import {
  FRONTEND_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  FRONTEND_ENGINEERING_SKILL_EVAL_SCORERS,
} from './skill-eval-frontend-engineering-fixtures';
import {
  CRITIC_SKILL_EVAL_MATERIALIZERS,
  CRITIC_SKILL_EVAL_SCORERS,
} from './skill-eval-critic-fixtures';
import {
  VERIFICATION_SKILL_EVAL_MATERIALIZERS,
  VERIFICATION_SKILL_EVAL_SCORERS,
} from './skill-eval-verification-fixtures';
import {
  SKILL_AUTHORING_EVALUATION_MATERIALIZERS,
  SKILL_AUTHORING_EVALUATION_SCORERS,
} from './skill-eval-skill-authoring-evaluation-fixtures';
import {
  DEVELOPER_EXPERIENCE_SKILL_EVAL_MATERIALIZERS,
  DEVELOPER_EXPERIENCE_SKILL_EVAL_SCORERS,
} from './skill-eval-developer-experience-fixtures';
import {
  REPOSITORY_RESEARCH_SKILL_EVAL_MATERIALIZERS,
  REPOSITORY_RESEARCH_SKILL_EVAL_SCORERS,
} from './skill-eval-repository-research-fixtures';
import {
  CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS,
  CORE_EXECUTION_SKILL_EVAL_SCORERS,
} from './skill-eval-core-execution-fixtures';
import {
  FEATURE_IMPLEMENTATION_SKILL_EVAL_MATERIALIZERS,
  FEATURE_IMPLEMENTATION_SKILL_EVAL_SCORERS,
} from './skill-eval-feature-implementation-fixtures';
import {
  VERIFICATION_CHILD_SKILL_EVAL_MATERIALIZERS,
  VERIFICATION_CHILD_SKILL_EVAL_SCORERS,
} from './skill-eval-verification-children-fixtures';
import {
  SECURITY_RELIABILITY_VERIFICATION_MATERIALIZERS,
  SECURITY_RELIABILITY_VERIFICATION_SCORERS,
} from './skill-eval-security-reliability-verification-fixtures';
import {
  ARCHITECTURE_PLANNING_SKILL_EVAL_MATERIALIZERS,
  ARCHITECTURE_PLANNING_SKILL_EVAL_SCORERS,
} from './skill-eval-architecture-planning-fixtures';
import {
  CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS,
  CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS,
} from './skill-eval-contract-concurrency-fixtures';
import {
  DATA_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  DATA_ENGINEERING_SKILL_EVAL_SCORERS,
} from './skill-eval-data-engineering-fixtures';
import {
  DATA_PERFORMANCE_VISUALIZATION_MATERIALIZERS,
  DATA_PERFORMANCE_VISUALIZATION_SCORERS,
} from './skill-eval-data-performance-visualization-fixtures';
import {
  EVENT_DISTRIBUTED_SKILL_EVAL_MATERIALIZERS,
  EVENT_DISTRIBUTED_SKILL_EVAL_SCORERS,
} from './skill-eval-event-distributed-fixtures';
import {
  AUTHORIZATION_SECURITY_SKILL_EVAL_MATERIALIZERS,
  AUTHORIZATION_SECURITY_SKILL_EVAL_SCORERS,
} from './skill-eval-authorization-security-fixtures';
import {
  CRYPTO_CLOUD_SECURITY_SKILL_EVAL_MATERIALIZERS,
  CRYPTO_CLOUD_SECURITY_SKILL_EVAL_SCORERS,
} from './skill-eval-crypto-cloud-security-fixtures';
import {
  DELIVERY_PLATFORM_SKILL_EVAL_MATERIALIZERS,
  DELIVERY_PLATFORM_SKILL_EVAL_SCORERS,
} from './skill-eval-delivery-platform-fixtures';
import {
  CLOUD_PLATFORM_SKILL_EVAL_MATERIALIZERS,
  CLOUD_PLATFORM_SKILL_EVAL_SCORERS,
} from './skill-eval-cloud-platform-fixtures';
import {
  LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS,
} from './skill-eval-language-runtime-fixtures';
import {
  BACKEND_STATE_SKILL_EVAL_MATERIALIZERS,
  BACKEND_STATE_SKILL_EVAL_SCORERS,
} from './skill-eval-backend-state-fixtures';
import {
  DATABASE_SKILL_EVAL_MATERIALIZERS,
  DATABASE_SKILL_EVAL_SCORERS,
} from './skill-eval-database-fixtures';
import {
  EDGE_OBSERVABILITY_SKILL_EVAL_MATERIALIZERS,
  EDGE_OBSERVABILITY_SKILL_EVAL_SCORERS,
} from './skill-eval-edge-observability-fixtures';
import {
  AUTH_SECRETS_SECURITY_SKILL_EVAL_MATERIALIZERS,
  AUTH_SECRETS_SECURITY_SKILL_EVAL_SCORERS,
} from './skill-eval-auth-secrets-security-fixtures';
import {
  PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS,
  PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS,
} from './skill-eval-privacy-web-device-fixtures';
import {
  SECURITY_REVIEW_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS,
} from './skill-eval-security-review-runtime-fixtures';
import {
  SUPPLY_CHAIN_INCIDENT_SKILL_EVAL_MATERIALIZERS,
  SUPPLY_CHAIN_INCIDENT_SKILL_EVAL_SCORERS,
} from './skill-eval-supply-chain-incident-fixtures';
import {
  ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS,
  ACCESSIBILITY_SKILL_EVAL_SCORERS,
} from './skill-eval-accessibility-fixtures';
import {
  SAFETY_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  SAFETY_PROTOCOL_SKILL_EVAL_SCORERS,
} from './skill-eval-safety-protocol-fixtures';
import {
  LIFECYCLE_CONCEPT_SKILL_EVAL_MATERIALIZERS,
  LIFECYCLE_CONCEPT_SKILL_EVAL_SCORERS,
} from './skill-eval-lifecycle-concept-fixtures';
import {
  ANDROID_COMPOSE_NATIVE_MATERIALIZERS,
  ANDROID_COMPOSE_NATIVE_SCORERS,
} from './skill-eval-android-compose-native-runtime';
import {
  MEDIA_RUNTIME_CONCEPT_SKILL_EVAL_MATERIALIZERS,
  MEDIA_RUNTIME_CONCEPT_SKILL_EVAL_SCORERS,
} from './skill-eval-media-runtime-concept-fixtures';
import {
  AUDIO_PRODUCTION_SKILL_EVAL_MATERIALIZERS,
  AUDIO_PRODUCTION_SKILL_EVAL_SCORERS,
} from './skill-eval-audio-production-runtime';
import {
  SPEECH_AUDIO_HARNESS_MATERIALIZERS,
  SPEECH_AUDIO_HARNESS_SCORERS,
} from './skill-eval-speech-audio-harness';
import {
  BUN_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  BUN_RUNTIME_SKILL_EVAL_SCORERS,
} from './skill-eval-bun-runtime-fixtures';
import {
  DENO_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  DENO_RUNTIME_SKILL_EVAL_SCORERS,
} from './skill-eval-deno-runtime-fixtures';
import {
  BUSINESS_CASE_SKILL_EVAL_MATERIALIZERS,
  BUSINESS_CASE_SKILL_EVAL_SCORERS,
} from './skill-eval-business-case-fixtures';
import {
  FINOPS_FULL_TASK_SKILL_EVAL_MATERIALIZERS,
  FINOPS_FULL_TASK_SKILL_EVAL_SCORERS,
} from './skill-eval-finops-full-task-fixtures';
import {
  SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS,
  SEALED_EVIDENCE_SKILL_EVAL_SCORERS,
} from './skill-eval-sealed-evidence-fixtures';
import {
  SHELL_CLI_SKILL_EVAL_MATERIALIZERS,
  SHELL_CLI_SKILL_EVAL_SCORERS,
} from './skill-eval-shell-cli-fixtures';
import {
  JVM_RUBY_SKILL_EVAL_MATERIALIZERS,
  JVM_RUBY_SKILL_EVAL_SCORERS,
} from './skill-eval-jvm-ruby-fixtures';
import {
  SWIFT_SKILL_EVAL_MATERIALIZERS,
  SWIFT_SKILL_EVAL_SCORERS,
} from './skill-eval-swift-fixtures';
import { RUST_SKILL_EVAL_MATERIALIZERS, RUST_SKILL_EVAL_SCORERS } from './skill-eval-rust-fixtures';
import {
  AI_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  AI_PROTOCOL_SKILL_EVAL_SCORERS,
} from './skill-eval-ai-protocol-concept-fixtures';
import {
  SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS,
} from './skill-eval-systems-protocol-concept-fixtures';
import {
  INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_MATERIALIZERS,
  INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_SCORERS,
} from './skill-eval-interface-search-graphics-concept-fixtures';
import {
  TESTING_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  TESTING_ENGINEERING_SKILL_EVAL_SCORERS,
} from './skill-eval-testing-engineering-fixtures';
import {
  REPOSITORY_COMMUNICATION_SKILL_EVAL_MATERIALIZERS,
  REPOSITORY_COMMUNICATION_SKILL_EVAL_SCORERS,
} from './skill-eval-repository-communication-fixtures';
import {
  MODEL_DATA_SKILL_EVAL_MATERIALIZERS,
  MODEL_DATA_SKILL_EVAL_SCORERS,
} from './skill-eval-model-data-concept-fixtures';
import {
  VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS,
  VISUAL_DESIGN_SKILL_EVAL_SCORERS,
} from './skill-eval-visual-design-fixtures';
import {
  PERFORMANCE_TESTING_SKILL_EVAL_MATERIALIZERS,
  PERFORMANCE_TESTING_SKILL_EVAL_SCORERS,
} from './skill-eval-performance-testing-fixtures';
import {
  BROWSER_SKILL_EVAL_MATERIALIZERS,
  BROWSER_SKILL_EVAL_SCORERS,
} from './skill-eval-browser-fixtures';
import {
  SVELTE_BROWSER_SKILL_EVAL_MATERIALIZERS,
  SVELTE_BROWSER_SKILL_EVAL_SCORERS,
} from './skill-eval-svelte-browser-fixtures';
import {
  REACT_BROWSER_SKILL_EVAL_MATERIALIZERS,
  REACT_BROWSER_SKILL_EVAL_SCORERS,
} from './skill-eval-react-browser-fixtures';
import {
  VUE_NATIVE_BROWSER_SKILL_EVAL_MATERIALIZERS,
  VUE_NATIVE_BROWSER_SKILL_EVAL_SCORERS,
} from './skill-eval-vue-browser-runtime';
import {
  V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS,
  V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS,
} from './skill-eval-v5-language-host-fixtures';
import {
  V5_KOTLIN_HOST_SKILL_EVAL_MATERIALIZERS,
  V5_KOTLIN_HOST_SKILL_EVAL_SCORERS,
} from './skill-eval-v5-kotlin-host-fixtures';
import {
  V5_PROPERTY_FUZZ_HOST_SKILL_EVAL_MATERIALIZERS,
  V5_PROPERTY_FUZZ_HOST_SKILL_EVAL_SCORERS,
} from './skill-eval-v5-property-fuzz-host-fixtures';
import {
  INTEGRATION_FAULT_SKILL_EVAL_MATERIALIZERS,
  INTEGRATION_FAULT_SKILL_EVAL_SCORERS,
} from './skill-eval-integration-fault-fixtures';
import {
  PUBLIC_RESEARCH_SKILL_EVAL_MATERIALIZERS,
  PUBLIC_RESEARCH_SKILL_EVAL_SCORERS,
} from './skill-eval-public-research-runtime';
import {
  RESEARCH_HISTORY_SKILL_EVAL_MATERIALIZERS,
  RESEARCH_HISTORY_SKILL_EVAL_SCORERS,
} from './skill-eval-research-history-runtime';
import {
  MARKET_RESEARCH_SKILL_EVAL_MATERIALIZERS,
  MARKET_RESEARCH_SKILL_EVAL_SCORERS,
} from './skill-eval-market-research-runtime';
import {
  VIDEO_PRODUCTION_SKILL_EVAL_MATERIALIZERS,
  VIDEO_PRODUCTION_SKILL_EVAL_SCORERS,
} from './skill-eval-video-production-runtime';
import {
  DESKTOP_SKILL_EVAL_MATERIALIZERS,
  DESKTOP_SKILL_EVAL_SCORERS,
} from './skill-eval-desktop-runtime';
import {
  ROBOTICS_CONTROL_MATERIALIZERS,
  ROBOTICS_CONTROL_SCORERS,
} from './skill-eval-robotics-runtime';
import {
  HARDWARE_RUNTIME_MATERIALIZERS,
  HARDWARE_RUNTIME_SCORERS,
} from './skill-eval-hardware-runtime';
import { IMAGEGEN_MATERIALIZERS, IMAGEGEN_SCORERS } from './skill-eval-imagegen-runtime';
import {
  EMBEDDED_RUNTIME_MATERIALIZERS,
  EMBEDDED_RUNTIME_SCORERS,
} from './skill-eval-embedded-runtime';
import {
  NATIVE_INTERFACE_SKILL_EVAL_MATERIALIZERS,
  NATIVE_INTERFACE_SKILL_EVAL_SCORERS,
} from './skill-eval-native-interface-runtime';
import {
  IOS_SWIFTUI_NATIVE_MATERIALIZERS,
  IOS_SWIFTUI_NATIVE_SCORERS,
} from './skill-eval-ios-swiftui-runtime';
import {
  EXTERNAL_ENVIRONMENT_SKILL_EVAL_MATERIALIZERS,
  EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS,
} from './skill-eval-external-environment-fixtures';
import {
  PERFORMANCE_DEBUGGING_SKILL_EVAL_MATERIALIZERS,
  PERFORMANCE_DEBUGGING_SKILL_EVAL_SCORERS,
} from './skill-eval-performance-debugging-fixtures';
import {
  NOVEL_UI_TOOLKIT_SKILL_EVAL_MATERIALIZERS,
  NOVEL_UI_TOOLKIT_SKILL_EVAL_SCORERS,
} from './skill-eval-novel-ui-toolkit-fixtures';
import {
  PERFORMANCE_TESTING_LOAD_SKILL_EVAL_MATERIALIZERS,
  PERFORMANCE_TESTING_LOAD_SKILL_EVAL_SCORERS,
} from './skill-eval-performance-testing-load-fixtures';

const CRLF_SCENARIO = 'deterministic-debugging-full-task-1';
const CACHE_SCENARIO = 'deterministic-debugging-full-task-2';

const crlfMaterializer: SkillEvalFixtureMaterializer = {
  id: 'deterministic-debugging/crlf-empty-value@1',
  matches: (scenario) => scenario.id === CRLF_SCENARIO,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-crlf-parser'));
    writeFixtureFile(
      destination,
      'src/parser.ts',
      `export function parseRecord(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of input.split('\\n')) {
    if (!rawLine) continue;
    const hadCarriageReturn = rawLine.endsWith('\\r');
    const line = hadCarriageReturn ? rawLine.slice(0, -1) : rawLine;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    // BUG: a historical CRLF blank-line guard mistakes an explicit empty value for no record.
    if (hadCarriageReturn && value.length === 0) continue;
    result[key] = value;
  }
  return result;
}
`,
    );
    writeFixtureFile(
      destination,
      'tests/parser.test.ts',
      `import { describe, expect, test } from 'bun:test';
import { parseRecord } from '../src/parser';

describe('parseRecord', () => {
  test('preserves an explicit empty value with LF delimiters', () => {
    expect(parseRecord('name=alpha\\ntags=\\n')).toEqual({ name: 'alpha', tags: '' });
  });

  test('parses non-empty CRLF values', () => {
    expect(parseRecord('name=alpha\\r\\ntags=red\\r\\n')).toEqual({ name: 'alpha', tags: 'red' });
  });

  test('keeps malformed-line behavior unchanged', () => {
    expect(parseRecord('name=alpha\\nnot-a-pair\\nmode=fast\\n')).toEqual({ name: 'alpha', mode: 'fast' });
  });
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# CRLF parser regression fixture

Contract: an explicit key with an empty value is present with value \`""\`; an absent key is absent. Malformed lines without \`=\` are ignored. Both LF and CRLF delimiters are supported.
`,
    );
  },
};

const cacheMaterializer: SkillEvalFixtureMaterializer = {
  id: 'deterministic-debugging/project-permission-cache@1',
  matches: (scenario) => scenario.id === CACHE_SCENARIO,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-project-session-cache'));
    writeFixtureFile(
      destination,
      'src/session.ts',
      `export type Permission = 'read-only' | 'writable';

export interface ProjectSession {
  projectId: string;
  permission: Permission;
}

const sessions = new Map<string, ProjectSession>();
let mostRecentlyOpenedPermission: Permission | null = null;

export function resetSessions(): void {
  sessions.clear();
  mostRecentlyOpenedPermission = null;
}

export function cachedSessionCount(): number {
  return sessions.size;
}

export function openProject(projectId: string, permission: Permission): ProjectSession {
  const existing = sessions.get(projectId);
  if (existing) {
    // BUG: reopening an existing project incorrectly inherits process-global permission state.
    return { ...existing, permission: mostRecentlyOpenedPermission ?? existing.permission };
  }
  const session = { projectId, permission };
  sessions.set(projectId, session);
  mostRecentlyOpenedPermission = permission;
  return { ...session };
}
`,
    );
    writeFixtureFile(
      destination,
      'tests/session.test.ts',
      `import { beforeEach, expect, test } from 'bun:test';
import { cachedSessionCount, openProject, resetSessions } from '../src/session';

beforeEach(resetSessions);

test('a single reopened project keeps its own permission', () => {
  openProject('A', 'read-only');
  expect(openProject('A', 'read-only').permission).toBe('read-only');
  expect(cachedSessionCount()).toBe(1);
});

test('new projects retain their supplied permission', () => {
  expect(openProject('A', 'read-only').permission).toBe('read-only');
  expect(openProject('B', 'writable').permission).toBe('writable');
  expect(cachedSessionCount()).toBe(2);
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Project permission cache regression fixture

Permissions are project-scoped cached state. Reopening one project after another must read that project's cached permission. The cache must remain enabled; restarting or clearing it on every open is not an acceptable fix.
`,
    );
  },
};

const crlfScorer: SkillEvalDeterministicScorer = {
  id: 'deterministic-debugging/crlf-empty-value-scorer@1',
  scenarioIds: [CRLF_SCENARIO],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { parseRecord } from '../src/parser';

test('hidden: arbitrary CRLF empty values remain explicit', () => {
  expect(parseRecord('name=beta\\r\\nnote=\\r\\nmode=safe\\r\\n')).toEqual({ name: 'beta', note: '', mode: 'safe' });
});

test('hidden: absent and explicitly empty keys remain distinct', () => {
  const absent = parseRecord('name=beta\\r\\n');
  const empty = parseRecord('name=beta\\r\\ntags=\\r\\n');
  expect(Object.hasOwn(absent, 'tags')).toBe(false);
  expect(Object.hasOwn(empty, 'tags')).toBe(true);
  expect(empty.tags).toBe('');
});

test('hidden: malformed lines remain ignored', () => {
  expect(parseRecord('bad-line\\r\\nkey=value\\r\\n')).toEqual({ key: 'value' });
});
`,
    );
    const regressionAdded = hasRegressionText(workingDirectory, [
      /\\r\\n/u,
      /empty|absent|hasOwn|tags/u,
    ]);
    return {
      passed: hidden.passed && regressionAdded,
      quality: hidden.passed ? (regressionAdded ? 1 : 0.75) : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden behavior checks: ${hidden.passed ? 'pass' : 'fail'}`,
        `repository regression coverage: ${regressionAdded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const cacheScorer: SkillEvalDeterministicScorer = {
  id: 'deterministic-debugging/project-permission-cache-scorer@1',
  scenarioIds: [CACHE_SCENARIO],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { beforeEach, expect, test } from 'bun:test';
import { cachedSessionCount, openProject, resetSessions } from '../src/session';

beforeEach(resetSessions);

test('hidden: A read-only -> B writable -> A stays read-only', () => {
  openProject('A', 'read-only');
  openProject('B', 'writable');
  expect(openProject('A', 'read-only').permission).toBe('read-only');
  expect(cachedSessionCount()).toBe(2);
});

test('hidden: A writable -> B read-only -> A stays writable', () => {
  openProject('A', 'writable');
  openProject('B', 'read-only');
  expect(openProject('A', 'writable').permission).toBe('writable');
  expect(cachedSessionCount()).toBe(2);
});
`,
    );
    const regressionAdded = hasRegressionText(workingDirectory, [
      /openProject\(['"]A['"]/u,
      /openProject\(['"]B['"]/u,
      /permission/u,
    ]);
    const cachePreserved = /new Map|Map</u.test(
      readFileSync(join(workingDirectory, 'src', 'session.ts'), 'utf8'),
    );
    return {
      passed: hidden.passed && regressionAdded && cachePreserved,
      quality: hidden.passed ? (regressionAdded && cachePreserved ? 1 : 0.75) : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden A→B→A checks: ${hidden.passed ? 'pass' : 'fail'}`,
        `repository multi-project regression coverage: ${regressionAdded ? 'present' : 'missing'}`,
        `cache mechanism preserved: ${cachePreserved ? 'yes' : 'no'}`,
        hidden.evidence,
      ],
    };
  },
};

export const BUILTIN_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  ...CRITIC_SKILL_EVAL_MATERIALIZERS,
  ...C_CPP_SKILL_EVAL_MATERIALIZERS,
  crlfMaterializer,
  cacheMaterializer,
  ...PILOT_SKILL_EVAL_MATERIALIZERS,
  ...TASK_ROUTING_SKILL_EVAL_MATERIALIZERS,
  ...REPOSITORY_ENVIRONMENT_DISCOVERY_SKILL_EVAL_MATERIALIZERS,
  ...PLAN_MODE_SKILL_EVAL_MATERIALIZERS,
  ...WEBHOOK_INTEGRATION_SKILL_EVAL_MATERIALIZERS,
  ...API_CONTRACT_DESIGN_SKILL_EVAL_MATERIALIZERS,
  ...HTTP_REST_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  ...GRAPHQL_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  ...GRPC_PROTOBUF_SKILL_EVAL_MATERIALIZERS,
  ...FRONTEND_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  ...VERIFICATION_SKILL_EVAL_MATERIALIZERS,
  ...SKILL_AUTHORING_EVALUATION_MATERIALIZERS,
  ...DEVELOPER_EXPERIENCE_SKILL_EVAL_MATERIALIZERS,
  ...REPOSITORY_RESEARCH_SKILL_EVAL_MATERIALIZERS,
  ...CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS,
  ...FEATURE_IMPLEMENTATION_SKILL_EVAL_MATERIALIZERS,
  ...VERIFICATION_CHILD_SKILL_EVAL_MATERIALIZERS,
  ...SECURITY_RELIABILITY_VERIFICATION_MATERIALIZERS,
  ...ARCHITECTURE_PLANNING_SKILL_EVAL_MATERIALIZERS,
  ...CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS,
  ...DATA_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  ...DATA_PERFORMANCE_VISUALIZATION_MATERIALIZERS,
  ...EVENT_DISTRIBUTED_SKILL_EVAL_MATERIALIZERS,
  ...AUTHORIZATION_SECURITY_SKILL_EVAL_MATERIALIZERS,
  ...CRYPTO_CLOUD_SECURITY_SKILL_EVAL_MATERIALIZERS,
  ...DELIVERY_PLATFORM_SKILL_EVAL_MATERIALIZERS,
  ...CLOUD_PLATFORM_SKILL_EVAL_MATERIALIZERS,
  ...LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  ...BACKEND_STATE_SKILL_EVAL_MATERIALIZERS,
  ...DATABASE_SKILL_EVAL_MATERIALIZERS,
  ...EDGE_OBSERVABILITY_SKILL_EVAL_MATERIALIZERS,
  ...AUTH_SECRETS_SECURITY_SKILL_EVAL_MATERIALIZERS,
  ...PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS,
  ...SECURITY_REVIEW_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  ...SUPPLY_CHAIN_INCIDENT_SKILL_EVAL_MATERIALIZERS,
  ...ACCESSIBILITY_SKILL_EVAL_MATERIALIZERS,
  ...SAFETY_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  ...LIFECYCLE_CONCEPT_SKILL_EVAL_MATERIALIZERS,
  ...ANDROID_COMPOSE_NATIVE_MATERIALIZERS,
  ...MEDIA_RUNTIME_CONCEPT_SKILL_EVAL_MATERIALIZERS,
  ...AUDIO_PRODUCTION_SKILL_EVAL_MATERIALIZERS,
  ...SPEECH_AUDIO_HARNESS_MATERIALIZERS,
  ...BUN_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  ...DENO_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  ...BUSINESS_CASE_SKILL_EVAL_MATERIALIZERS,
  ...FINOPS_FULL_TASK_SKILL_EVAL_MATERIALIZERS,
  ...SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS,
  ...SHELL_CLI_SKILL_EVAL_MATERIALIZERS,
  ...JVM_RUBY_SKILL_EVAL_MATERIALIZERS,
  ...SWIFT_SKILL_EVAL_MATERIALIZERS,
  ...RUST_SKILL_EVAL_MATERIALIZERS,
  ...AI_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  ...SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  ...INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_MATERIALIZERS,
  ...TESTING_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  ...REPOSITORY_COMMUNICATION_SKILL_EVAL_MATERIALIZERS,
  ...MODEL_DATA_SKILL_EVAL_MATERIALIZERS,
  ...VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS,
  ...PERFORMANCE_TESTING_SKILL_EVAL_MATERIALIZERS,
  ...BROWSER_SKILL_EVAL_MATERIALIZERS,
  ...SVELTE_BROWSER_SKILL_EVAL_MATERIALIZERS,
  ...REACT_BROWSER_SKILL_EVAL_MATERIALIZERS,
  ...VUE_NATIVE_BROWSER_SKILL_EVAL_MATERIALIZERS,
  ...WRITING_STYLE_SKILL_EVAL_MATERIALIZERS,
  ...COMMUNICATION_SKILL_EVAL_MATERIALIZERS,
  ...RESPONSE_STYLE_SKILL_EVAL_MATERIALIZERS,
  // Real evaluators must precede the external-environment gates: matching is first-wins, and the
  // gates intentionally trail so a faithful harness supersedes the gate without deleting history.
  ...V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS,
  ...V5_KOTLIN_HOST_SKILL_EVAL_MATERIALIZERS,
  ...V5_PROPERTY_FUZZ_HOST_SKILL_EVAL_MATERIALIZERS,
  ...PERFORMANCE_DEBUGGING_SKILL_EVAL_MATERIALIZERS,
  ...NOVEL_UI_TOOLKIT_SKILL_EVAL_MATERIALIZERS,
  ...PERFORMANCE_TESTING_LOAD_SKILL_EVAL_MATERIALIZERS,
  ...INTEGRATION_FAULT_SKILL_EVAL_MATERIALIZERS,
  ...PUBLIC_RESEARCH_SKILL_EVAL_MATERIALIZERS,
  ...RESEARCH_HISTORY_SKILL_EVAL_MATERIALIZERS,
  ...MARKET_RESEARCH_SKILL_EVAL_MATERIALIZERS,
  ...VIDEO_PRODUCTION_SKILL_EVAL_MATERIALIZERS,
  ...DESKTOP_SKILL_EVAL_MATERIALIZERS,
  // Xcode 27 iPhone and iPad intended-red/full-green controls passed 2026-10-20.
  // These native materializers still require exact caller-selected booted devices;
  // the controls establish evaluator calibration, not candidate qualification.
  ...IOS_SWIFTUI_NATIVE_MATERIALIZERS,
  ...ROBOTICS_CONTROL_MATERIALIZERS,
  ...HARDWARE_RUNTIME_MATERIALIZERS,
  ...IMAGEGEN_MATERIALIZERS,
  ...EMBEDDED_RUNTIME_MATERIALIZERS,
  ...NATIVE_INTERFACE_SKILL_EVAL_MATERIALIZERS,
  ...EXTERNAL_ENVIRONMENT_SKILL_EVAL_MATERIALIZERS,
];

export const BUILTIN_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  ...CRITIC_SKILL_EVAL_SCORERS,
  ...C_CPP_SKILL_EVAL_SCORERS,
  crlfScorer,
  cacheScorer,
  ...PILOT_SKILL_EVAL_SCORERS,
  ...TASK_ROUTING_SKILL_EVAL_SCORERS,
  ...REPOSITORY_ENVIRONMENT_DISCOVERY_SKILL_EVAL_SCORERS,
  ...PLAN_MODE_SKILL_EVAL_SCORERS,
  ...WEBHOOK_INTEGRATION_SKILL_EVAL_SCORERS,
  ...API_CONTRACT_DESIGN_SKILL_EVAL_SCORERS,
  ...HTTP_REST_ENGINEERING_SKILL_EVAL_SCORERS,
  ...GRAPHQL_ENGINEERING_SKILL_EVAL_SCORERS,
  ...GRPC_PROTOBUF_SKILL_EVAL_SCORERS,
  ...FRONTEND_ENGINEERING_SKILL_EVAL_SCORERS,
  ...VERIFICATION_SKILL_EVAL_SCORERS,
  ...SKILL_AUTHORING_EVALUATION_SCORERS,
  ...DEVELOPER_EXPERIENCE_SKILL_EVAL_SCORERS,
  ...REPOSITORY_RESEARCH_SKILL_EVAL_SCORERS,
  ...CORE_EXECUTION_SKILL_EVAL_SCORERS,
  ...FEATURE_IMPLEMENTATION_SKILL_EVAL_SCORERS,
  ...VERIFICATION_CHILD_SKILL_EVAL_SCORERS,
  ...SECURITY_RELIABILITY_VERIFICATION_SCORERS,
  ...ARCHITECTURE_PLANNING_SKILL_EVAL_SCORERS,
  ...CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS,
  ...DATA_ENGINEERING_SKILL_EVAL_SCORERS,
  ...DATA_PERFORMANCE_VISUALIZATION_SCORERS,
  ...EVENT_DISTRIBUTED_SKILL_EVAL_SCORERS,
  ...AUTHORIZATION_SECURITY_SKILL_EVAL_SCORERS,
  ...CRYPTO_CLOUD_SECURITY_SKILL_EVAL_SCORERS,
  ...DELIVERY_PLATFORM_SKILL_EVAL_SCORERS,
  ...CLOUD_PLATFORM_SKILL_EVAL_SCORERS,
  ...LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS,
  ...BACKEND_STATE_SKILL_EVAL_SCORERS,
  ...DATABASE_SKILL_EVAL_SCORERS,
  ...EDGE_OBSERVABILITY_SKILL_EVAL_SCORERS,
  ...AUTH_SECRETS_SECURITY_SKILL_EVAL_SCORERS,
  ...PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS,
  ...SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS,
  ...SUPPLY_CHAIN_INCIDENT_SKILL_EVAL_SCORERS,
  ...ACCESSIBILITY_SKILL_EVAL_SCORERS,
  ...SAFETY_PROTOCOL_SKILL_EVAL_SCORERS,
  ...LIFECYCLE_CONCEPT_SKILL_EVAL_SCORERS,
  ...ANDROID_COMPOSE_NATIVE_SCORERS,
  ...MEDIA_RUNTIME_CONCEPT_SKILL_EVAL_SCORERS,
  ...SPEECH_AUDIO_HARNESS_SCORERS,
  ...AUDIO_PRODUCTION_SKILL_EVAL_SCORERS,
  ...BUN_RUNTIME_SKILL_EVAL_SCORERS,
  ...DENO_RUNTIME_SKILL_EVAL_SCORERS,
  ...BUSINESS_CASE_SKILL_EVAL_SCORERS,
  ...FINOPS_FULL_TASK_SKILL_EVAL_SCORERS,
  ...SEALED_EVIDENCE_SKILL_EVAL_SCORERS,
  ...SHELL_CLI_SKILL_EVAL_SCORERS,
  ...JVM_RUBY_SKILL_EVAL_SCORERS,
  ...SWIFT_SKILL_EVAL_SCORERS,
  ...RUST_SKILL_EVAL_SCORERS,
  ...AI_PROTOCOL_SKILL_EVAL_SCORERS,
  ...SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS,
  ...INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_SCORERS,
  ...TESTING_ENGINEERING_SKILL_EVAL_SCORERS,
  ...REPOSITORY_COMMUNICATION_SKILL_EVAL_SCORERS,
  ...MODEL_DATA_SKILL_EVAL_SCORERS,
  ...VISUAL_DESIGN_SKILL_EVAL_SCORERS,
  ...PERFORMANCE_TESTING_SKILL_EVAL_SCORERS,
  ...BROWSER_SKILL_EVAL_SCORERS,
  ...SVELTE_BROWSER_SKILL_EVAL_SCORERS,
  ...REACT_BROWSER_SKILL_EVAL_SCORERS,
  ...VUE_NATIVE_BROWSER_SKILL_EVAL_SCORERS,
  ...WRITING_STYLE_SKILL_EVAL_SCORERS,
  ...COMMUNICATION_SKILL_EVAL_SCORERS,
  ...RESPONSE_STYLE_SKILL_EVAL_SCORERS,
  ...V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS,
  ...V5_KOTLIN_HOST_SKILL_EVAL_SCORERS,
  ...V5_PROPERTY_FUZZ_HOST_SKILL_EVAL_SCORERS,
  ...PERFORMANCE_DEBUGGING_SKILL_EVAL_SCORERS,
  ...NOVEL_UI_TOOLKIT_SKILL_EVAL_SCORERS,
  ...PERFORMANCE_TESTING_LOAD_SKILL_EVAL_SCORERS,
  ...INTEGRATION_FAULT_SKILL_EVAL_SCORERS,
  ...PUBLIC_RESEARCH_SKILL_EVAL_SCORERS,
  ...RESEARCH_HISTORY_SKILL_EVAL_SCORERS,
  ...MARKET_RESEARCH_SKILL_EVAL_SCORERS,
  ...VIDEO_PRODUCTION_SKILL_EVAL_SCORERS,
  ...DESKTOP_SKILL_EVAL_SCORERS,
  ...IOS_SWIFTUI_NATIVE_SCORERS,
  ...ROBOTICS_CONTROL_SCORERS,
  ...HARDWARE_RUNTIME_SCORERS,
  ...IMAGEGEN_SCORERS,
  ...EMBEDDED_RUNTIME_SCORERS,
  ...NATIVE_INTERFACE_SKILL_EVAL_SCORERS,
  ...EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS,
];
