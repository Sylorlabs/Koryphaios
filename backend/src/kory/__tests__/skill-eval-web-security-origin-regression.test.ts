import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasCookieMutationInventory,
  PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS,
  PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-privacy-web-device-fixtures';

const roots: string[] = [];
const paymentOrigin = 'https://payments.example.test';

const cookieMutation = {
  source: 'Cookie-authenticated dashboard action initiated by a browser form',
  transform:
    'Fetch POST attaches the session cookie; X-CSRF-Token carries a session-bound synchronizer token that the server validates against the authenticated session',
  sink: 'POST state-changing dashboard handler persists the account update',
  control: 'Reject missing, expired, invalid, or mismatched CSRF tokens on the server',
};

function dashboardSpec() {
  return {
    sourceSinkInventory: [
      { source: 'Untrusted rich-text comment', transform: 'Sanitize HTML', sink: 'Rich-text HTML renderer', control: 'Remove script and event-handler attributes' },
      { source: 'Return-navigation query parameter', transform: 'Validate relative path', sink: 'Return navigation URL', control: 'Reject absolute and protocol-relative destinations' },
      cookieMutation,
      { source: 'Payment iframe', transform: 'Restrict frame-src to the payment origin', sink: 'Iframe browsing context', control: 'Deny arbitrary frame ancestors' },
      { source: 'Payment postMessage event', transform: 'Validate origin, source, schema, and transaction context', sink: 'Payment status update', control: 'Reject untrusted or mismatched event' },
    ],
    richText: {
      legacyDangerousSinkRemovedOrSanitized: true,
      ordinaryTextEscaped: true,
      htmlSanitizer: true,
      attributeContextSafe: true,
      navigationUrlValidated: true,
      sanitizerPolicy: 'Allow text formatting tags only, without event attributes',
      allowedUrlSchemes: ['https'],
      eventHandlerAttributesAllowed: false,
    },
    csp: {
      nonceBased: true,
      unsafeInline: false,
      unsafeEval: false,
      reportOnlyRollout: true,
      frameSrc: [paymentOrigin],
      connectSrc: ["'self'"],
      primaryXssFix: false,
      directives: ["default-src 'none'", "script-src 'nonce-<per-response>'", "style-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"],
      noncePropagation: 'Attach a fresh response nonce to trusted script tags',
      reportEndpoint: '/csp-report',
      enforcementVerification: ['Reject inline scripts lacking the nonce', 'Reject hostile embedding after Report-Only validation'],
    },
    csrf: { serverValidatedToken: true, originComplement: true, fetchMetadataComplement: true, sameSiteComplement: true, tokenTransport: 'header', sessionBound: true, allCookieMutationsCovered: true, rejectMissingOrInvalid: true },
    postMessage: {
      expectedOrigin: paymentOrigin,
      validateSchema: true,
      validateSource: true,
      outgoingTargetOrigin: paymentOrigin,
      expectedSourceContext: 'The embedded payment iframe window',
      schemaFields: ['event', 'transactionId', 'status'],
      contextCorrelation: true,
    },
    returnNavigation: { sameOriginOrRelativeOnly: true, externalAllowlist: [] },
    cookie: { secure: true, httpOnly: true, sameSite: 'Lax', domain: null, path: '/' },
    tenantAuthorizationOwnedBy: 'authorization-security',
  };
}

function analyticsSpec() {
  return {
    cors: { origins: ['https://app.example.com'], methods: ['GET', 'POST'], headers: ['Content-Type', 'X-CSRF-Token'], credentials: true, reflectOrigin: false, wildcard: false },
    reportFetch: { allowedOrigin: 'https://reports.example.net', hashIsDirectUrl: false, allowPathIdsOnly: true },
    credentials: { architecture: 'bff-http-only-cookie', localStorageAccessToken: false, csrfServerValidated: true },
    framing: { frameAncestors: ["'self'"] },
    rendering: { safeText: true, explicitSanitization: false },
    csp: { reporting: true, primaryXssFix: false },
    oauthOwnedBy: 'oauth-oidc',
    authorizationOwnedBy: 'authorization-security',
  };
}

type ScenarioId = 'web-security-full-task-1' | 'web-security-full-task-2';

async function fixture(scenarioId: ScenarioId) {
  const root = mkdtempSync(join(tmpdir(), 'kory-web-security-regression-'));
  roots.push(root);
  const materializer = PRIVACY_WEB_DEVICE_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches({ id: scenarioId } as never));
  const scorer = PRIVACY_WEB_DEVICE_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(scenarioId));
  expect(materializer).toBeDefined();
  expect(scorer).toBeDefined();
  if (scenarioId === 'web-security-full-task-1') {
    expect(materializer?.id).toBe('web-security/dashboard-browser-boundaries@4');
    expect(scorer?.id).toBe('web-security/dashboard-browser-boundaries-scorer@8');
  }
  await materializer!.materialize(root, { id: scenarioId } as never);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  return { root, scorer: scorer! };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('web-security origin and cookie mutation scoring', () => {
  test('materialization preserves the exact-origin and same-row mutation instructions', async () => {
    const { root } = await fixture('web-security-full-task-1');
    const instructions = readFileSync(join(root, 'README.md'), 'utf8');
    expect(instructions).toContain('immutable evaluator-provided contract');
    expect(instructions).toContain('server-side CSRF validation');
    expect(instructions).toContain('copy the literal');
    expect(instructions).toContain('Do not emit Markdown links');
  });

  test('accepts raw exact origins and a server-validated cookie mutation trace', async () => {
    const { root, scorer } = await fixture('web-security-full-task-1');
    const spec = dashboardSpec();
    expect(hasCookieMutationInventory(spec.sourceSinkInventory)).toBe(true);
    writeFileSync(join(root, '.kory-eval', 'dashboard-web.json'), JSON.stringify(spec));
    const score = await scorer.score({ workingDirectory: root } as never);
    expect(score.passed, score.evidence.join('\n')).toBe(true);
    expect(score.integrityFailure).toBe(false);
    expect(score.evidence).toContain('postMessage.expectedOrigin: exact');
    expect(score.evidence).toContain('postMessage.outgoingTargetOrigin: exact');
  });

  test('rejects Markdown-wrapped, lookalike, or trailing-slash origins', async () => {
    for (const field of ['expectedOrigin', 'outgoingTargetOrigin'] as const) {
      for (const value of [`[${paymentOrigin}](${paymentOrigin})`, `${paymentOrigin}.evil.example`, `${paymentOrigin}/`]) {
      const { root, scorer } = await fixture('web-security-full-task-1');
      const spec = dashboardSpec();
      spec.postMessage[field] = value;
      writeFileSync(join(root, '.kory-eval', 'dashboard-web.json'), JSON.stringify(spec));
      const score = await scorer.score({ workingDirectory: root } as never);
      expect(score.passed).toBe(false);
      expect(score.integrityFailure).toBe(false);
      expect(score.evidence).toContain(
        value.startsWith('[')
          ? `postMessage.${field}: Markdown-wrapped origin (invalid)`
          : `postMessage.${field}: mismatch or missing`,
      );
      }
    }
  });

  test('rejects missing same-row mutation evidence and client-only CSRF claims', async () => {
    const { root, scorer } = await fixture('web-security-full-task-1');
    const spec = dashboardSpec();
    spec.sourceSinkInventory = spec.sourceSinkInventory.filter((row) => row !== cookieMutation);
    writeFileSync(join(root, '.kory-eval', 'dashboard-web.json'), JSON.stringify(spec));
    const score = await scorer.score({ workingDirectory: root } as never);
    expect(score.passed).toBe(false);
    expect(score.evidence).toContain('cookie-authenticated mutation source/sink: missing');
    expect(hasCookieMutationInventory([{ source: 'Cookie-authenticated action', transform: 'Client checks CSRF locally', sink: 'POST state-changing handler', control: 'Reject missing token in the browser; no server validation' }])).toBe(false);
  });

  test('analytics origins remain raw exact strings', async () => {
    const good = await fixture('web-security-full-task-2');
    writeFileSync(join(good.root, '.kory-eval', 'analytics-web.json'), JSON.stringify(analyticsSpec()));
    expect((await good.scorer.score({ workingDirectory: good.root } as never)).passed).toBe(true);

    const bad = await fixture('web-security-full-task-2');
    const spec = analyticsSpec();
    spec.cors.origins = ['[https://app.example.com](https://app.example.com)'];
    writeFileSync(join(bad.root, '.kory-eval', 'analytics-web.json'), JSON.stringify(spec));
    const score = await bad.scorer.score({ workingDirectory: bad.root } as never);
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(false);
  });

  test('reports evaluator-corpus mutation as an integrity failure', async () => {
    const { root, scorer } = await fixture('web-security-full-task-1');
    writeFileSync(join(root, '.kory-eval', 'dashboard-web.json'), JSON.stringify(dashboardSpec()));
    writeFileSync(join(root, 'evidence', 'web-corpus.json'), '{"dashboard":{}}');
    const score = await scorer.score({ workingDirectory: root } as never);
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(true);
    expect(score.evidence).toContain('fixed evaluator/corpus preserved: no');
  });
});
