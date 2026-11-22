import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const DOCUMENT_API = 'authorization-security-full-task-1';
const GRAPHQL = 'authorization-security-full-task-2';

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

function hasBoolean(value: unknown, key: string, expected: boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => hasBoolean(item, key, expected));
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record[key] === expected) return true;
  return Object.values(record).some((item) => hasBoolean(item, key, expected));
}

const DOCUMENT_POLICY_EVALUATOR = `export interface PolicyRule {
  role: string;
  relation: string;
  action: string;
  tenantMatch: boolean;
  allow: boolean;
  allowedFields?: string[];
}

export interface DocumentPolicySpec {
  rules: PolicyRule[];
  defaultDeny: boolean;
  enforcementBoundary: string;
  exportWorker: {
    effectiveSubject: string;
    broadServiceIdentityAuthorizes: boolean;
    delegationBounded: boolean;
  };
  revocation: {
    suspensionImmediate: boolean;
    memberRemovalImmediateForHighRisk: boolean;
    maxStaleSeconds: number;
    failClosedWhenPolicyUnavailable: boolean;
  };
  deniedNonEffects: string[];
  audit: { protectedDataExcluded: boolean; securityRelevantDenials: boolean };
}

export interface DecisionInput {
  role: string;
  relation: string;
  action: string;
  tenantMatch: boolean;
}

export function decide(spec: DocumentPolicySpec, input: DecisionInput): boolean {
  const rule = spec.rules.find((candidate) =>
    candidate.role === input.role &&
    candidate.relation === input.relation &&
    candidate.action === input.action &&
    candidate.tenantMatch === input.tenantMatch,
  );
  return rule?.allow ?? !spec.defaultDeny;
}

export function fieldAllowed(spec: DocumentPolicySpec, input: DecisionInput, field: string): boolean {
  const rule = spec.rules.find((candidate) =>
    candidate.role === input.role &&
    candidate.relation === input.relation &&
    candidate.action === input.action &&
    candidate.tenantMatch === input.tenantMatch,
  );
  if (!rule?.allow) return false;
  return rule.allowedFields ? rule.allowedFields.includes(field) : true;
}
`;

const DOCUMENT_REQUIREMENTS = `${JSON.stringify(
  {
    tenants: ['Acme', 'Bravo'],
    roles: ['member', 'editor', 'tenant-admin', 'suspended'],
    relations: ['owner', 'editor', 'viewer', 'none'],
    actions: ['read', 'edit', 'delete', 'share', 'member-manage', 'export'],
    productRules: [
      'cross-tenant access is denied even when role names match',
      'suspended subjects are denied all protected actions',
      'member may read same-tenant documents with owner/editor/viewer relation',
      'editor may edit same-tenant documents with owner/editor relation',
      'only an owner may delete/share a document unless tenant-admin policy explicitly grants it',
      'tenant-admin may manage same-tenant membership',
      'edit overposting must not change id, tenantId, ownerId, or createdAt',
      'export authorization is evaluated as the originating user/constrained delegation',
    ],
    editAllowedFields: ['title', 'body', 'tags'],
    forbiddenOverpostFields: ['id', 'tenantId', 'ownerId', 'createdAt'],
  },
  null,
  2,
)}\n`;

const documentApiMaterializer: SkillEvalFixtureMaterializer = {
  id: 'authorization-security/document-api-policy-design@1',
  matches: (scenario) => scenario.id === DOCUMENT_API,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'package.json',
      packageJson('kory-eval-authorization-document-api'),
    );
    writeFixtureFile(destination, 'src/policy-evaluator.ts', DOCUMENT_POLICY_EVALUATOR);
    writeFixtureFile(destination, 'evidence/product-requirements.json', DOCUMENT_REQUIREMENTS);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# Multi-tenant document authorization design fixture

This is an authorization-design task, not the finished security-verification execution. Preserve \`src/policy-evaluator.ts\` and \`evidence/product-requirements.json\`; express the proposed policy as executable design data in \`.kory-eval/authorization-document-api.json\` using the \`DocumentPolicySpec\` shape exported by the evaluator.

The matrix must be explicit enough to decide the supplied role/relation/action/tenant cases, including same-role cross-tenant and suspended cases. Use \`defaultDeny: true\`. Put enforcement at a trusted service/data layer. For allowed \`edit\` rules, enumerate allowed mutable fields so overposting cannot change \`id\`, \`tenantId\`, \`ownerId\`, or \`createdAt\`.

The export worker must authorize as the originating user or a constrained delegation, not its broad service credential. Suspension and high-risk member removal are immediate; any lower-risk token/cache staleness must be bounded and fail closed if trustworthy policy state is unavailable. Denials must have no durable mutation, message, file, or export side effect and must be auditable without protected payload leakage.

Include \`evidenceBoundary\` stating that this is synthetic design evidence and that finished control execution belongs to \`security-verification\`.
`,
    );
  },
};

const documentApiScorer: SkillEvalDeterministicScorer = {
  id: 'authorization-security/document-api-policy-design-scorer@2',
  scenarioIds: [DOCUMENT_API],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { decide, fieldAllowed, type DocumentPolicySpec } from '../src/policy-evaluator';

const spec = JSON.parse(readFileSync('.kory-eval/authorization-document-api.json', 'utf8')) as DocumentPolicySpec;
const d = (role:string, relation:string, action:string, tenantMatch:boolean) => ({ role, relation, action, tenantMatch });
const mentionsEffect = (values:string[], effect:string) =>
  values.some((value) => value.toLowerCase().split(/[^a-z]+/u).includes(effect));

test('hidden: default/suspended/cross-tenant paths fail closed', () => {
  expect(spec.defaultDeny).toBe(true);
  expect(decide(spec, d('unknown', 'none', 'read', true))).toBe(false);
  expect(decide(spec, d('member', 'viewer', 'read', false))).toBe(false);
  expect(decide(spec, d('editor', 'editor', 'edit', false))).toBe(false);
  for (const action of ['read','edit','delete','share','member-manage','export']) {
    expect(decide(spec, d('suspended', 'owner', action, true))).toBe(false);
  }
});

test('hidden: same-tenant object and field rules are explicit', () => {
  expect(decide(spec, d('member', 'viewer', 'read', true))).toBe(true);
  expect(decide(spec, d('editor', 'editor', 'edit', true))).toBe(true);
  expect(decide(spec, d('member', 'viewer', 'delete', true))).toBe(false);
  expect(decide(spec, d('tenant-admin', 'none', 'member-manage', true))).toBe(true);
  expect(fieldAllowed(spec, d('editor', 'editor', 'edit', true), 'title')).toBe(true);
  expect(fieldAllowed(spec, d('editor', 'editor', 'edit', true), 'body')).toBe(true);
  for (const field of ['id','tenantId','ownerId','createdAt']) {
    expect(fieldAllowed(spec, d('editor', 'editor', 'edit', true), field)).toBe(false);
  }
});

test('hidden: worker delegation, revocation, denied non-effects, and audit contract are bounded', () => {
  expect(spec.enforcementBoundary.toLowerCase()).toMatch(/service|data/);
  expect(spec.exportWorker.effectiveSubject.toLowerCase()).toMatch(/originat|user|delegat/);
  expect(spec.exportWorker.broadServiceIdentityAuthorizes).toBe(false);
  expect(spec.exportWorker.delegationBounded).toBe(true);
  expect(spec.revocation.suspensionImmediate).toBe(true);
  expect(spec.revocation.memberRemovalImmediateForHighRisk).toBe(true);
  expect(spec.revocation.maxStaleSeconds).toBeGreaterThanOrEqual(0);
  expect(spec.revocation.maxStaleSeconds).toBeLessThanOrEqual(300);
  expect(spec.revocation.failClosedWhenPolicyUnavailable).toBe(true);
  for (const effect of ['mutation','message','file','export']) expect(mentionsEffect(spec.deniedNonEffects, effect)).toBe(true);
  expect(spec.audit.protectedDataExcluded).toBe(true);
  expect(spec.audit.securityRelevantDenials).toBe(true);
});
`,
    );
    const evaluatorPreserved =
      readFileSync(join(workingDirectory, 'src/policy-evaluator.ts'), 'utf8') ===
      DOCUMENT_POLICY_EVALUATOR;
    const requirementsPreserved =
      readFileSync(join(workingDirectory, 'evidence/product-requirements.json'), 'utf8') ===
      DOCUMENT_REQUIREMENTS;
    const report = artifactText(workingDirectory, '.kory-eval/authorization-document-api.json');
    const bounded =
      Boolean(report.artifact) &&
      /security-verification/u.test(report.text) &&
      /synthetic|design/u.test(report.text) &&
      !/route visibility.*(?:enforce|authority)/u.test(report.text);
    const passed = hidden.passed && evaluatorPreserved && requirementsPreserved && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && evaluatorPreserved ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !evaluatorPreserved || !requirementsPreserved,
      evidence: [
        `executable authorization matrix: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed evaluator/product requirements preserved: ${evaluatorPreserved && requirementsPreserved ? 'yes' : 'no'}`,
        `design-vs-verification evidence boundary: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const GRAPHQL_POLICY_EVALUATOR = `export interface GraphqlRule {
  role: string;
  resource: string;
  operation: string;
  field: string;
  orgMatch: boolean;
  allow: boolean;
  supportGrant?: 'active' | 'expired' | 'revoked' | 'none';
}

export interface GraphqlPolicySpec {
  rules: GraphqlRule[];
  defaultDeny: boolean;
  enforcementPaths: Record<string, string>;
  backendServiceIdentityAsSubject: boolean;
  originatingCallerPreserved: boolean;
  support: {
    timeBounded: boolean;
    revocationImmediateForNewDecisions: boolean;
    prohibitedResources: string[];
  };
  overpostDeniedFields: string[];
  deniedNonEffects: string[];
  graphqlMechanicsOwnedBy: string;
  evidenceBoundary: string;
}

export function decide(
  spec: GraphqlPolicySpec,
  input: Omit<GraphqlRule, 'allow'>,
): boolean {
  const rule = spec.rules.find((candidate) =>
    candidate.role === input.role &&
    candidate.resource === input.resource &&
    candidate.operation === input.operation &&
    candidate.field === input.field &&
    candidate.orgMatch === input.orgMatch &&
    (candidate.supportGrant ?? 'none') === (input.supportGrant ?? 'none'),
  );
  return rule?.allow ?? !spec.defaultDeny;
}
`;

const GRAPHQL_REQUIREMENTS = `${JSON.stringify(
  {
    resources: ['Project', 'Member', 'BillingAccount', 'ApiToken', 'AuditEvent'],
    paths: ['query', 'nested-resolver', 'alias', 'batch-loader', 'mutation'],
    roles: ['viewer', 'contributor', 'maintainer', 'owner', 'organization-support'],
    sensitive: ['BillingAccount.paymentMethod', 'ApiToken.secret', 'AuditEvent.payload'],
    supportGrant: ['active', 'expired', 'revoked'],
    policyFacts: [
      'cross-organization access is denied',
      'support delegation is time-bounded and revocable',
      'support cannot create API tokens or read billing/token secrets',
      'backend service identity is never the effective subject for user-originated operations',
      'all GraphQL access paths call the same trusted policy',
    ],
  },
  null,
  2,
)}\n`;

const graphqlMaterializer: SkillEvalFixtureMaterializer = {
  id: 'authorization-security/graphql-policy-review@1',
  matches: (scenario) => scenario.id === GRAPHQL,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-authorization-graphql'));
    writeFixtureFile(destination, 'src/graphql-policy-evaluator.ts', GRAPHQL_POLICY_EVALUATOR);
    writeFixtureFile(destination, 'evidence/graphql-requirements.json', GRAPHQL_REQUIREMENTS);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# GraphQL authorization policy design fixture

Preserve the supplied evaluator and requirements. Write an executable policy design to \`.kory-eval/authorization-graphql.json\` using \`GraphqlPolicySpec\`. This skill owns authorization policy/enforcement; keep schema/resolver mechanics explicitly assigned to \`graphql-engineering\`.

Use \`defaultDeny: true\`. Object, operation, and field rules must survive alternate GraphQL shapes because query, nested resolver, alias, batch-loader, and mutation paths all converge on the same trusted policy. Cross-organization access fails closed. The backend service credential must never replace the originating caller as the effective subject.

Organization support access exists only under an active time-bounded grant, is revoked for new decisions immediately, and cannot access billing/token secrets or create API tokens. Include horizontal, vertical, cross-org, nested, token-creation, bulk-loader, and overposting denial cases with no mutation/message/token/audit-leak side effects. Mark the evidence as synthetic design evidence, not finished security-verification proof.
`,
    );
  },
};

const graphqlScorer: SkillEvalDeterministicScorer = {
  id: 'authorization-security/graphql-policy-review-scorer@2',
  scenarioIds: [GRAPHQL],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { decide, type GraphqlPolicySpec } from '../src/graphql-policy-evaluator';

const spec = JSON.parse(readFileSync('.kory-eval/authorization-graphql.json','utf8')) as GraphqlPolicySpec;
const d = (role:string, resource:string, operation:string, field:string, orgMatch:boolean, supportGrant:'active'|'expired'|'revoked'|'none'='none') => ({ role,resource,operation,field,orgMatch,supportGrant });
const mentionsEffect = (values:string[], effect:string) =>
  values.some((value) => value.toLowerCase().split(/[^a-z]+/u).includes(effect));

test('hidden: same trusted policy covers direct and indirect GraphQL paths', () => {
  expect(spec.defaultDeny).toBe(true);
  for (const path of ['query','nested-resolver','alias','batch-loader','mutation']) {
    expect(spec.enforcementPaths[path]?.toLowerCase()).toMatch(/trusted|policy|service|data/);
  }
  expect(decide(spec, d('viewer','Project','read','name',true))).toBe(true);
  expect(decide(spec, d('viewer','Project','read','name',false))).toBe(false);
  expect(decide(spec, d('contributor','ApiToken','create','*',true))).toBe(false);
});

test('hidden: sensitive fields and support delegation fail closed', () => {
  expect(decide(spec, d('organization-support','Project','read','name',true,'active'))).toBe(true);
  for (const grant of ['expired','revoked'] as const) {
    expect(decide(spec, d('organization-support','Project','read','name',true,grant))).toBe(false);
  }
  expect(decide(spec, d('organization-support','BillingAccount','read','paymentMethod',true,'active'))).toBe(false);
  expect(decide(spec, d('organization-support','ApiToken','read','secret',true,'active'))).toBe(false);
  expect(decide(spec, d('organization-support','ApiToken','create','*',true,'active'))).toBe(false);
  expect(spec.support.timeBounded).toBe(true);
  expect(spec.support.revocationImmediateForNewDecisions).toBe(true);
});

test('hidden: caller identity, overposting, and denial non-effects are explicit', () => {
  expect(spec.backendServiceIdentityAsSubject).toBe(false);
  expect(spec.originatingCallerPreserved).toBe(true);
  for (const field of ['organizationId','ownerId','billingAccountId','role']) expect(spec.overpostDeniedFields).toContain(field);
  for (const effect of ['mutation','message','token']) expect(mentionsEffect(spec.deniedNonEffects, effect)).toBe(true);
  expect(spec.graphqlMechanicsOwnedBy).toBe('graphql-engineering');
  expect(spec.evidenceBoundary.toLowerCase()).toMatch(/synthetic|design/);
});
`,
    );
    const evaluatorPreserved =
      readFileSync(join(workingDirectory, 'src/graphql-policy-evaluator.ts'), 'utf8') ===
      GRAPHQL_POLICY_EVALUATOR;
    const requirementsPreserved =
      readFileSync(join(workingDirectory, 'evidence/graphql-requirements.json'), 'utf8') ===
      GRAPHQL_REQUIREMENTS;
    const report = artifactText(workingDirectory, '.kory-eval/authorization-graphql.json');
    const bounded =
      Boolean(report.artifact) &&
      /graphql-engineering/u.test(report.text) &&
      /synthetic|design/u.test(report.text) &&
      hasBoolean(report.artifact, 'backendServiceIdentityAsSubject', false);
    const passed = hidden.passed && evaluatorPreserved && requirementsPreserved && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && evaluatorPreserved ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !evaluatorPreserved || !requirementsPreserved,
      evidence: [
        `object/field/operation + indirect-path policy: ${hidden.passed ? 'pass' : 'fail'}`,
        `fixed evaluator/requirements preserved: ${evaluatorPreserved && requirementsPreserved ? 'yes' : 'no'}`,
        `GraphQL mechanics/security-verification boundary: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const AUTHORIZATION_SECURITY_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [documentApiMaterializer, graphqlMaterializer];

export const AUTHORIZATION_SECURITY_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  documentApiScorer,
  graphqlScorer,
];
