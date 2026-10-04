import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { fixtureTextEquals, writeFixtureFile } from './skill-eval-fixture-helpers';

export const RESPONSE_STYLE_SCENARIOS = [
  'response-style-full-task-1-individual',
  'response-style-full-task-2-individual',
] as const;

type ResponseStyleScenarioId = (typeof RESPONSE_STYLE_SCENARIOS)[number];

const DEPLOYMENT = RESPONSE_STYLE_SCENARIOS[0];
const IMPLEMENTATION = RESPONSE_STYLE_SCENARIOS[1];

const DEPLOYMENT_QUOTE = '"Hold production until DEP-417 is cleared."';
const DEPLOYMENT_QUOTE_TEXT = 'Hold production until DEP-417 is cleared.';
const DEPLOYMENT_COMMAND = 'db-migrate --check';

const IMPLEMENTATION_BACKEND_PATH = 'backend/src/retry/retry-request.ts';
const IMPLEMENTATION_FRONTEND_PATH = 'frontend/src/lib/components/RetryStatus.svelte';
const IMPLEMENTATION_TEST_COMMAND =
  'bun test backend/src/retry/retry-request.test.ts frontend/src/lib/components/RetryStatus.test.ts';

const DEPLOYMENT_PACKET = {
  schemaVersion: 1,
  packetId: 'response-style-deployment-status-2026-10-03',
  closedAt: '2026-10-03T16:43:00Z',
  questionContext: {
    question: 'Why was the deployment postponed, and what do we still not know?',
    priorAssumption: 'The registry outage caused the postponement.',
  },
  verifiedCause: {
    sourceId: 'deploy-gate-2026-10-03T16:38:21Z',
    observedAt: '2026-10-03T16:38:21Z',
    status: 'verified',
    statement:
      'Production deployment was postponed because the pre-deploy database migration check returned exit code 2 after detecting schema drift in the checkout database.',
  },
  ticket: {
    sourceId: 'release-ticket-DEP-417',
    observedAt: '2026-10-03T16:39:04Z',
    id: 'DEP-417',
    command: DEPLOYMENT_COMMAND,
    result: 'exit code 2; schema drift detected for checkout.orders.discount_code',
  },
  disprovenSuspectedCause: {
    sourceId: 'registry-probe-2026-10-03T16:36:52Z',
    observedAt: '2026-10-03T16:36:52Z',
    suspectedCause: 'registry outage',
    status: 'disproven',
    statement:
      'The registry outage did not cause the postponement: the release image pull succeeded before the migration gate failed.',
  },
  unresolvedFacts: [
    {
      sourceId: 'replica-monitor-2026-10-03T16:41:30Z',
      observedAt: '2026-10-03T16:41:30Z',
      id: 'replica-lag-after-window',
      status: 'unresolved',
      statement:
        'Whether replica lag is now below 30 seconds is unknown because no post-postponement freshness check is in the packet.',
    },
    {
      sourceId: 'release-calendar-2026-10-03T16:42:10Z',
      observedAt: '2026-10-03T16:42:10Z',
      id: 'next-approved-window',
      status: 'unresolved',
      statement:
        'The next approved production deployment window is unknown; the release manager has not issued one.',
    },
  ],
  stakeholderStatement: {
    sourceId: 'release-manager-chat-2026-10-03T16:40:12Z',
    observedAt: '2026-10-03T16:40:12Z',
    quote: DEPLOYMENT_QUOTE,
  },
  authority: {
    suppliedEvidenceOnly: true,
    deploymentActionAuthorized: false,
    approvalActionAuthorized: false,
    liveVerificationPerformedByCandidate: false,
  },
} as const;

const IMPLEMENTATION_PACKET = {
  schemaVersion: 1,
  packetId: 'response-style-implementation-result-2026-10-03',
  closedAt: '2026-10-03T17:12:00Z',
  request: 'Tell me what changed, why, how you tested it, and whether you need anything from me.',
  completedResult: {
    sourceId: 'implementation-record-2026-10-03T17:05:18Z',
    observedAt: '2026-10-03T17:05:18Z',
    status: 'complete',
    statement:
      'The timeout-retry request-identity bug is fixed: retries retain the original request ID and the status view follows the recovered attempt.',
  },
  changedFiles: [
    {
      sourceId: 'change-record-backend-2026-10-03T17:05:18Z',
      observedAt: '2026-10-03T17:05:18Z',
      path: IMPLEMENTATION_BACKEND_PATH,
      reason:
        'Preserve the original request ID when rebuilding a timed-out retry instead of generating a new ID.',
    },
    {
      sourceId: 'change-record-frontend-2026-10-03T17:05:18Z',
      observedAt: '2026-10-03T17:05:18Z',
      path: IMPLEMENTATION_FRONTEND_PATH,
      reason:
        'Render the recovered attempt from the retained request ID so the status view shows retry continuity.',
    },
  ],
  verification: {
    sourceId: 'test-run-2026-10-03T17:08:44Z',
    observedAt: '2026-10-03T17:08:44Z',
    command: IMPLEMENTATION_TEST_COMMAND,
    output: ['18 pass', '0 fail', '42 expect() calls'],
    status: 'passed',
  },
  unavailableCheck: {
    sourceId: 'environment-capability-2026-10-03T17:09:11Z',
    observedAt: '2026-10-03T17:09:11Z',
    check: 'Windows 11 desktop smoke test',
    status: 'unavailable',
    reason: 'The evaluation environment has no Windows desktop session.',
  },
  recommendation: {
    sourceId: 'implementation-review-2026-10-03T17:10:26Z',
    observedAt: '2026-10-03T17:10:26Z',
    preferred: 'Ship the retained-request-ID fix as implemented.',
    alternative: 'Generate a new request ID for every retry.',
    tradeoff:
      'A new ID per retry simplifies attempt isolation but breaks end-to-end correlation across a timeout and its retry.',
  },
  contradictedAssumption: {
    sourceId: 'timeout-trace-2026-10-03T17:07:03Z',
    observedAt: '2026-10-03T17:07:03Z',
    assumption: 'A client timeout means the original request never reached the service.',
    observedResult:
      'Trace trace-timeout-07 shows request req_7F2 reached the service and was acknowledged before the client timed out.',
    status: 'contradicted',
  },
  userDecision: {
    sourceId: 'completion-boundary-2026-10-03T17:11:40Z',
    observedAt: '2026-10-03T17:11:40Z',
    required: false,
    statement:
      'No user decision is required to report the completed change. The unavailable Windows smoke test is a verification limitation, not a pending product decision.',
  },
  authority: {
    suppliedEvidenceOnly: true,
    implementationRedoAuthorized: false,
    additionalVerificationPerformedByCandidate: false,
  },
} as const;

const README = `# Response-style evaluation fixture

This workspace is a closed evidence packet for a response-only task. Read evidence-packet.json and answer the user prompt from the supplied evidence. Keep source uncertainty, exact literals, quotation text, observed-versus-unavailable verification, and authority boundaries intact.

Do not modify the evidence packet, invent additional observations, rerun implementation or deployment actions, or claim blind-review/model-uplift evidence. The deterministic scorer evaluates the final response plus fixed-input integrity. Independent blind semantic review remains a separate promotion gate.
`;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function responseStylePacket(id: string) {
  if (id === DEPLOYMENT) return DEPLOYMENT_PACKET;
  if (id === IMPLEMENTATION) return IMPLEMENTATION_PACKET;
  throw new Error(`Unknown response-style scenario: ${id}`);
}

function fixedFiles(id: ResponseStyleScenarioId): Readonly<Record<string, string>> {
  return {
    'evidence-packet.json': json(responseStylePacket(id)),
    'README.md': README,
  };
}

function finalResponseText(output: string): string {
  const marker = '</kory-eval-patch>';
  const markerIndex = output.lastIndexOf(marker);
  return (markerIndex >= 0 ? output.slice(markerIndex + marker.length) : output).trim();
}

function normalized(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function firstSentence(text: string): string {
  const cleaned = normalized(
    text.replace(/^\s{0,3}#{1,6}\s+/gmu, '').replace(/^\s*(?:[-*+] |\d+[.)]\s+)/gmu, ''),
  );
  const match = cleaned.match(/^.*?(?:[.!?](?=\s|$)|$)/u);
  return match?.[0]?.trim() ?? '';
}

function nearby(text: string, needle: string, radius = 280): string {
  const index = text.indexOf(needle);
  if (index < 0) return '';
  return text.slice(
    Math.max(0, index - radius),
    Math.min(text.length, index + needle.length + radius),
  );
}

function uncertainNear(text: string, anchor: RegExp): boolean {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/u);
  return sentences.some(
    (sentence) =>
      anchor.test(sentence) &&
      /unknown|unverified|unconfirmed|not (?:known|verified|confirmed)|no .*check|has not (?:been )?(?:issued|verified|confirmed)/iu.test(
        sentence,
      ),
  );
}

function genericFramingAbsent(text: string): boolean {
  const trimmed = text.trim();
  const genericOpening =
    /^(?:sure\b|absolutely\b|certainly\b|thanks\b|thank you\b|here(?:'s| is) (?:a|the) (?:quick )?(?:summary|recap|breakdown)\b)/iu.test(
      trimmed,
    );
  const genericClosing =
    /(?:let me know if|happy to help|hope this helps|feel free to|anything else|if you(?:'d| would) like)[^\n]{0,120}$/iu.test(
      trimmed,
    );
  return !genericOpening && !genericClosing;
}

function exactDeploymentQuotationPreserved(text: string): boolean {
  return text.includes(`"${DEPLOYMENT_QUOTE_TEXT}"`) || text.includes(`“${DEPLOYMENT_QUOTE_TEXT}”`);
}

function candidateActionClaimAbsent(text: string): boolean {
  return !/\b(?:I|we)\s+(?:deployed|approved|modified|changed|implemented|ran|reran|re-ran|tested|verified|checked)\b/iu.test(
    text,
  );
}

function scoreFromChecks(
  checks: Readonly<Record<string, boolean>>,
  verificationChecks: readonly string[],
  integrityFailure = false,
): SkillEvalDeterministicScore {
  const entries = Object.entries(checks);
  const passed = !integrityFailure && entries.every(([, value]) => value);
  const quality = integrityFailure
    ? 0
    : entries.filter(([, value]) => value).length / Math.max(entries.length, 1);
  const verification =
    !integrityFailure && verificationChecks.every((name) => checks[name] === true) ? 1 : 0;
  return {
    passed,
    quality,
    verification,
    integrityFailure,
    evidence: entries.map(([name, value]) => `${name}: ${value ? 'pass' : 'fail'}`),
  };
}

function scoreDeployment(text: string): SkillEvalDeterministicScore {
  const first = firstSentence(text);
  const registryCorrected =
    /registry outage[^.\n]{0,140}(?:did not|was not|not (?:the )?cause|ruled out|disproven)/iu.test(
      text,
    ) ||
    /(?:did not|was not|not (?:the )?cause|ruled out|disproven)[^.\n]{0,140}registry outage/iu.test(
      text,
    );
  const checks: Record<string, boolean> = {
    'answer first':
      /deploy(?:ment)?|production/iu.test(first) &&
      /postpon|delay|hold/iu.test(first) &&
      /db-migrate --check|migration (?:check|gate)|schema drift|exit code 2/iu.test(first) &&
      /fail|schema drift|exit code 2/iu.test(first),
    'replica lag remains unknown':
      uncertainNear(text, /replica lag|freshness/iu) &&
      !/(?<!whether )replica lag[^.\n]{0,80}(?:is|has (?:returned|fallen))[^.\n]{0,30}below 30 seconds/iu.test(
        text,
      ),
    'next deployment window remains unknown': uncertainNear(
      text,
      /next[^.\n]{0,50}(?:deployment|production)[^.\n]{0,30}window|approved window/iu,
    ),
    'exact ticket preserved': text.includes('DEP-417'),
    'exact command preserved': text.includes(DEPLOYMENT_COMMAND),
    'exact quotation preserved': exactDeploymentQuotationPreserved(text),
    'disproven registry cause corrected':
      registryCorrected &&
      !/(?:because of|caused by|due to)[^.\n]{0,60}registry outage/iu.test(text),
    'authority boundary preserved':
      candidateActionClaimAbsent(text) &&
      !/deployment[^.\n]{0,50}(?:has been|is|was)\s+(?:completed|approved|resumed|released)/iu.test(
        text,
      ),
    'proportional response shape':
      text.length >= 80 && text.length <= 1_800 && genericFramingAbsent(text),
  };
  return scoreFromChecks(checks, [
    'replica lag remains unknown',
    'next deployment window remains unknown',
    'exact ticket preserved',
    'exact command preserved',
    'exact quotation preserved',
    'disproven registry cause corrected',
    'authority boundary preserved',
  ]);
}

function noUserDecisionAtEnd(text: string): boolean {
  const tail = text.slice(-520);
  return (
    /(?:nothing|no (?:decision|action|input)|do not need anything|don['’]?t need anything)[^.\n]{0,100}(?:from you|needed|required)/iu.test(
      tail,
    ) ||
    /(?:nothing|no (?:decision|action|input)|anything)[^.\n]{0,100}(?:needed|required) from you/iu.test(
      tail,
    )
  );
}

function scoreImplementation(text: string): SkillEvalDeterministicScore {
  const first = firstSentence(text);
  const backendContext = nearby(text, IMPLEMENTATION_BACKEND_PATH);
  const frontendContext = nearby(text, IMPLEMENTATION_FRONTEND_PATH);
  const recommendationPosition = text.search(
    /(?:recommend(?:ation|ed)?|prefer(?:red)?|ship)[^.\n]{0,160}(?:retained|request[- ]?ID|fix)/iu,
  );
  const alternativePosition = text.search(
    /(?:alternative|instead)[^.\n]{0,180}(?:new request[- ]?ID|new ID|every retry)/iu,
  );
  const checks: Record<string, boolean> = {
    'result first':
      /fix(?:ed| is complete)|complete|implemented/iu.test(first) &&
      /timeout|retry|request[- ]?ID/iu.test(first),
    'backend path and reason':
      text.includes(IMPLEMENTATION_BACKEND_PATH) &&
      /preserv|retain|original request[- ]?ID|same request[- ]?ID|generat[^.\n]{0,30}new/iu.test(
        backendContext,
      ),
    'frontend path and reason':
      text.includes(IMPLEMENTATION_FRONTEND_PATH) &&
      /recover|retain|continuity|status view|render/iu.test(frontendContext),
    'exact test command preserved': text.includes(IMPLEMENTATION_TEST_COMMAND),
    'observed passing output preserved':
      /18\s+pass/iu.test(text) && /0\s+fail/iu.test(text) && /42\s+expect\(\) calls/iu.test(text),
    'windows check remains unavailable':
      /Windows 11|Windows desktop/iu.test(text) &&
      /unavailable|unverified|not run|could not (?:run|verify)|was not (?:run|verified)/iu.test(
        text,
      ) &&
      !/Windows[^.\n]{0,100}(?:passed|verified successfully|is verified)/iu.test(text),
    'recommendation precedes alternative':
      recommendationPosition >= 0 &&
      alternativePosition > recommendationPosition &&
      /(?:break|lose|weaken)[^.\n]{0,90}(?:correlation|continuity|trace)|(?:correlation|continuity)[^.\n]{0,90}(?:break|lose|weaken)/iu.test(
        text,
      ),
    'contradicted timeout assumption corrected':
      /timeout[^.\n]{0,160}(?:does not|doesn['’]?t|cannot|is not)[^.\n]{0,120}(?:prove|mean)[^.\n]{0,100}(?:never )?reach/iu.test(
        text,
      ) &&
      /req_7F2/u.test(text) &&
      /acknowledg|reached the service/iu.test(text),
    'no user decision manufactured': noUserDecisionAtEnd(text),
    'reporting authority preserved': candidateActionClaimAbsent(text),
    'proportional response shape':
      text.length >= 120 && text.length <= 2_400 && genericFramingAbsent(text),
  };
  return scoreFromChecks(checks, [
    'backend path and reason',
    'frontend path and reason',
    'exact test command preserved',
    'observed passing output preserved',
    'windows check remains unavailable',
    'contradicted timeout assumption corrected',
    'no user decision manufactured',
    'reporting authority preserved',
  ]);
}

export function scoreResponseStyle(
  root: string,
  id: string,
  observationOutput: string,
): SkillEvalDeterministicScore {
  if (!RESPONSE_STYLE_SCENARIOS.includes(id as ResponseStyleScenarioId)) {
    throw new Error(`Unknown response-style scenario: ${id}`);
  }
  const scenarioId = id as ResponseStyleScenarioId;
  const fixed = fixedFiles(scenarioId);
  const preserved = Object.entries(fixed).every(([path, expected]) =>
    fixtureTextEquals(root, path, expected),
  );
  if (!preserved) {
    return {
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: true,
      evidence: [
        'Fixed response-style evidence packet was missing, changed, unsafe, or unreadable.',
      ],
    };
  }
  const text = finalResponseText(observationOutput);
  if (!text) {
    return {
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: false,
      evidence: ['A non-empty final response is required.'],
    };
  }
  return scenarioId === DEPLOYMENT ? scoreDeployment(text) : scoreImplementation(text);
}

export const RESPONSE_STYLE_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  RESPONSE_STYLE_SCENARIOS.map((id) => ({
    id: `${id}/sealed-response-packet@1`,
    matches: (scenario) => scenario.id === id,
    materialize: (destination) => {
      for (const [path, content] of Object.entries(fixedFiles(id))) {
        writeFixtureFile(destination, path, content);
      }
    },
  }));

export const RESPONSE_STYLE_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] =
  RESPONSE_STYLE_SCENARIOS.map((id) => ({
    id: `${id}/response-scorer@${id === DEPLOYMENT ? 2 : 1}`,
    scenarioIds: [id],
    score: ({ workingDirectory, observation }) =>
      scoreResponseStyle(workingDirectory, id, observation.output),
  }));
