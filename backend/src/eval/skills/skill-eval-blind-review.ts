import { createHash } from 'node:crypto';
import type {
  SkillEvalPublicContractSnapshot,
  SkillEvalPublicFixturePath,
} from './skill-eval-execution';
import type { V5FullTaskFixture } from '../../kory/skill-packages';
import type { SkillEvaluationRun } from '../../kory/skill-evaluations';
import { selectEligibleSkillEvaluationEvidence } from './skill-eval-eligibility';

/** Shared by assignment selection and import revalidation. */
export function completePairForScenario(
  runs: readonly SkillEvaluationRun[],
  scenarioId: string,
  contractHash: string,
): { withSkill: SkillEvaluationRun; withoutSkill: SkillEvaluationRun } | null {
  const eligible = selectEligibleSkillEvaluationEvidence(runs).runs.filter(
    (run) =>
      run.protocolVersion === 3 &&
      run.evaluator === 'deterministic' &&
      run.caseCategory === 'full-task' &&
      run.scenarioId === scenarioId &&
      run.evaluationContractHash === contractHash &&
      !run.integrityFailure &&
      !run.infrastructureFailure &&
      // An aborted arm produced no artifact: the executor rejected the provider's
      // output or the clock ran out. A reviewer asked to judge it can only report
      // that nothing was there, which is a harness result recorded as a skill failure.
      run.executionAborted !== true &&
      Boolean(run.comparisonId),
  );
  const byPair = new Map<string, SkillEvaluationRun[]>();
  for (const run of eligible) {
    byPair.set(run.comparisonId!, [...(byPair.get(run.comparisonId!) ?? []), run]);
  }
  const pairs = [...byPair.entries()]
    .flatMap(([comparisonId, pairRuns]) => {
      const withSkill = pairRuns.find((run) => run.variant === 'with-skill');
      const withoutSkill = pairRuns.find((run) => run.variant === 'without-skill');
      if (!withSkill || !withoutSkill) return [];
      if (
        withSkill.skill !== withoutSkill.skill ||
        withSkill.revisionHash !== withoutSkill.revisionHash ||
        withSkill.caseId !== withoutSkill.caseId ||
        withSkill.caseCategory !== withoutSkill.caseCategory ||
        withSkill.suiteId !== withoutSkill.suiteId ||
        withSkill.protocolVersion !== withoutSkill.protocolVersion ||
        withSkill.provider !== withoutSkill.provider ||
        withSkill.model !== withoutSkill.model ||
        withSkill.harnessVersion !== withoutSkill.harnessVersion ||
        withSkill.evaluationContractVersion !== withoutSkill.evaluationContractVersion ||
        withSkill.evaluationContractHash !== withoutSkill.evaluationContractHash ||
        withSkill.materializerId !== withoutSkill.materializerId ||
        withSkill.deterministicScorerId !== withoutSkill.deterministicScorerId
      ) {
        return [];
      }
      return [{ comparisonId, withSkill, withoutSkill }];
    })
    .sort((left, right) => {
      const leftTime = [left.withSkill.recordedAt, left.withoutSkill.recordedAt].sort().at(-1)!;
      const rightTime = [right.withSkill.recordedAt, right.withoutSkill.recordedAt].sort().at(-1)!;
      return rightTime.localeCompare(leftTime) || right.comparisonId.localeCompare(left.comparisonId);
    });
  return pairs[0] ?? null;
}

export interface BlindReviewPublicContract {
  taskPrompt: SkillEvalPublicContractSnapshot['taskPrompt'];
  fixtureFiles: Record<
    SkillEvalPublicFixturePath,
    SkillEvalPublicContractSnapshot['fixtureFiles'][SkillEvalPublicFixturePath]
  >;
}

function unavailablePublicContract(reason: string): BlindReviewPublicContract {
  return {
    taskPrompt: {
      available: false,
      sha256: null,
      byteLength: 0,
      text: null,
      reason,
    },
    fixtureFiles: {
      'README.md': { available: false, sha256: null, byteLength: 0, text: null, reason },
      'contract.json': { available: false, sha256: null, byteLength: 0, text: null, reason },
    },
  };
}

/**
 * Verify archived public-contract bytes against the pre-execution snapshot.
 * Current fixture files are deliberately not accepted as a fallback: callers
 * pass only bytes archived with the historical run.
 */
export function verifyBlindReviewPublicContractSnapshot(input: {
  snapshot?: SkillEvalPublicContractSnapshot;
  taskPromptBytes?: Uint8Array;
  fixtureFileBytes?: Partial<Record<SkillEvalPublicFixturePath, Uint8Array>>;
}): BlindReviewPublicContract {
  if (!input.snapshot) return unavailablePublicContract('not-archived');

  const verify = (
    label: string,
    expected: SkillEvalPublicContractSnapshot['taskPrompt'],
    bytes: Uint8Array | undefined,
  ): SkillEvalPublicContractSnapshot['taskPrompt'] => {
    if (!expected.available) return expected;
    if (!bytes || typeof expected.sha256 !== 'string' || typeof expected.text !== 'string') {
      throw new Error(`Archived public contract is missing ${label}`);
    }
    const actual = Buffer.from(bytes);
    const sha256 = createHash('sha256').update(actual).digest('hex');
    if (
      sha256 !== expected.sha256 ||
      actual.byteLength !== expected.byteLength ||
      actual.toString('utf8') !== expected.text ||
      !Buffer.from(expected.text, 'utf8').equals(actual)
    ) {
      throw new Error(`Archived public contract hash mismatch for ${label}`);
    }
    return expected;
  };

  return {
    taskPrompt: verify('task prompt', input.snapshot.taskPrompt, input.taskPromptBytes),
    fixtureFiles: {
      'README.md': verify(
        'README.md',
        input.snapshot.fixtureFiles['README.md'],
        input.fixtureFileBytes?.['README.md'],
      ),
      'contract.json': verify(
        'contract.json',
        input.snapshot.fixtureFiles['contract.json'],
        input.fixtureFileBytes?.['contract.json'],
      ),
    },
  };
}

export interface BlindReviewArtifact {
  finalOutput: string;
  executionEvidence: string[];
  publicContract?: BlindReviewPublicContract;
  changes: Array<{
    path: string;
    change: string;
    beforeSha256: string | null;
    afterSha256: string | null;
    beforeText?: string;
    afterText?: string;
  }>;
}

export interface BlindPairExecutionEvidence {
  matchedPair: true;
  sameScenario: true;
  sameProviderModel: true;
  sameHarness: true;
  sameEvaluationContract: true;
  sameMaterializer: true;
  sameDeterministicScorer: true;
  randomizedArmIdentity: true;
  evidenceOwner: 'evaluation-harness';
}

export interface BlindJudgeRubricResult {
  artifactA: { evidence: string[] };
  artifactB: { evidence: string[] };
  rationale: string[];
}

export function blindJudgeQuoteIsStructural(tail: string): boolean {
  const normalized = tail.replace(/^(\s*)\\+(?=[,\]}:])/u, '$1').trimStart();
  if (!normalized) return true;
  const first = normalized[0]!;
  if (first === ':' || first === ']' || first === '}') return true;
  if (first !== ',') return false;
  const afterComma = normalized.slice(1).trimStart();
  if (!afterComma) return true;
  return /^(?:["\[{]|-?\d|true\b|false\b|null\b)/u.test(afterComma);
}

const ABSENCE_CRITICISM =
  /\b(?:lack(?:s|ing)?(?:\s+of)?|missing|absent|without|no(?:\s+explicit)?|(?:does?|did)\s+not\s+(?:produce|provide|include|establish|show|document|address|narrate|explain|state|identify|follow|respect|honou?r|stay\s+within)|fails?\s+to\s+(?:produce|provide|include|establish|show|document|address|narrate|explain|state|identify|follow|respect|honou?r|stay\s+within)|neither(?:\s+(?:artifact|agent|candidate|output)s?)?\s+(?:produces?|provides?|includes?|establishes?|shows?|documents?|addresses?|narrates?|explains?|identifies?|follows?|respects?))\b/iu;
const ABSENCE_CRITICISM_AT_END = new RegExp(`${ABSENCE_CRITICISM.source}\\s*$`, 'iu');

/**
 * These are requirements owned by the evaluation harness rather than by an
 * anonymous candidate. Keep the list specific: a real defect in a hierarchy,
 * route, schema, or Linux implementation must remain review evidence.
 */
const EVALUATOR_OWNED_META_REQUIREMENT =
  /\b(?:hierarch(?:y|ical)(?:\s*[/,&-]\s*(?:specialist|skill))?\s+(?:boundary|selection|rationale|narration|evidence|scope)|specialist\s+(?:selection|rationale|narration|evidence)|skill\s*(?:[/_-]\s*no[ -]?skill|\s*[-/]?\s*vs\.?\s*[-/]?\s*no[ -]?skill|\s+versus\s+no[ -]?skill)?\s+(?:selection|routing|rationale|narration|names?|evidence)|skill\s*[-/]\s*guidance\s+(?:scope|boundary|selection|rationale)|routing\s+(?:selection|rationale|narration|evidence)|paired\s*[-/]?\s*(?:(?:same\s+model\s+)?(?:skill(?:\s*[/ -]\s*no[ -]?skill)?|evaluation|runs?|execution|evidence|provenance|comparison))(?:\s+(?:evidence|provenance|comparison|artifacts?|runs?))*|pairing\s+(?:evidence|provenance|comparison|rationale)|skill\s*[-/]?\s*(?:vs|versus)\s*[-/]?\s*no[ -]?skill)\b/iu;
const EVALUATOR_OWNED_META_REQUIREMENT_GLOBAL =
  /\b(?:hierarch(?:y|ical)(?:\s*[/,&-]\s*(?:specialist|skill))?\s+(?:boundary|selection|rationale|narration|evidence|scope)|specialist\s+(?:selection|rationale|narration|evidence)|skill\s*(?:[/_-]\s*no[ -]?skill|\s*[-/]?\s*vs\.?\s*[-/]?\s*no[ -]?skill|\s+versus\s+no[ -]?skill)?\s+(?:selection|routing|rationale|narration|names?|evidence)|skill\s*[-/]\s*guidance\s+(?:scope|boundary|selection|rationale)|routing\s+(?:selection|rationale|narration|evidence)|paired\s*[-/]?\s*(?:(?:same\s+model\s+)?(?:skill(?:\s*[/ -]\s*no[ -]?skill)?|evaluation|runs?|execution|evidence|provenance|comparison))(?:\s+(?:evidence|provenance|comparison|artifacts?|runs?))*|pairing\s+(?:evidence|provenance|comparison|rationale)|skill\s*[-/]?\s*(?:vs|versus)\s*[-/]?\s*no[ -]?skill)\b/giu;

const EVALUATOR_OWNED_META_EVIDENCE =
  /\b(?:hierarch(?:y|ical)(?:\s*[/,&-]\s*(?:specialist|skill))?\s+(?:selection|rationale|narration|evidence)|specialist\s+(?:selection|rationale|narration|evidence)|skill\s*(?:[/_-]\s*no[ -]?skill|\s*[-/]?\s*vs\.?\s*[-/]?\s*no[ -]?skill|\s+versus\s+no[ -]?skill)?\s+(?:selection|routing|rationale|narration|names?|evidence)|skill\s*[-/]\s*guidance\s+(?:scope|boundary|selection|rationale)|routing\s+(?:selection|rationale|narration|evidence)|paired\s*[-/]?\s*(?:(?:same\s+model\s+)?(?:skill(?:\s*[/ -]\s*no[ -]?skill)?|evaluation|runs?|execution|evidence|provenance|comparison))(?:\s+(?:evidence|provenance|comparison|artifacts?|runs?))*|pairing\s+(?:evidence|provenance|comparison|rationale)|skill\s*[-/]?\s*(?:vs|versus)\s*[-/]?\s*no[ -]?skill)\b/iu;

const EXPLICIT_NO_META_PENALTY =
  /\b(?:no penalty(?:\s+(?:is\s+)?assigned)?|not penalized|does not penalize|do not penalize|not to penalize)\b/iu;
const META_NON_CRITICISM =
  /\b(?:no need to|does not lack|do not lack|not missing|not absent|is not missing|is not absent)\b/iu;
const META_SCOPE_PRESERVATION =
  /\b(?:no\b[^.!?;]{0,60}\b(?:violation|breach|defect|error|issues?|problems?|concerns?|crossed)|(?:is|are|was|were)\s+(?:not\s+(?:crossed|violated|breached)|respected|honou?red))\b/iu;

const META_SCAFFOLD =
  /\b(?:a|an|and|are|as|assigned|be|because|both|by|candidate|does|did|do|document(?:ed|s)?|establish(?:ed|es)?|evaluat(?:e|ed|es|or)|evidence|explicit|fail(?:ed|s)?|for|from|have|has|in|include(?:d|s)?|is|it|lack(?:s|ing)?|lower(?:ing|s)?|missing|name(?:d|s)?|neither|no|not|of|omission|or|output|paired|penalty|provided|rationale|review(?:er)?|scope|selection|should|show(?:n|s)?|skill|specialist|suppl(?:ied|y|ies)?|the|this|to|was|were|without|within|boundary|guidance|hierarchy|narrat(?:e|ed|es|ion)|address(?:ed|es)?|explain(?:ed|s)?|identify|follow|respect(?:ed)?|honou?r|stay|requirement(?:s)?|run(?:s)?|execution|comparison|provenance|quality|score|confidence|artifact(?:s)?|agent(?:s)?|clear|satisf(?:y|ies|ied)|harness|owned|evaluator-owned|records?|needed)\b/giu;

const CONCRETE_ARTIFACT_EVIDENCE =
  /\b(?:actual|authorization|boot|bug|check(?:s|ed)?|cold[- ]start|command|concrete|contract|cycle|defect|deviation|diversity|endpoint|fallback|field|failure|feedback[- ]loop|file|guardrail|invalid|json|kernel|launch|linux|long[- ]tail|malformed|metric(?:s)?|negative|observ(?:ation|ed)|origin|parity|path|permission|privilege|recovery|reboot|replica|request|result|rollback|route|schema|service|stale|systemd|test(?:s|ed)?|train[- ]serving|unsupported|verification|verified|upstream|validation|runtime|scope\s+gap|evidence\s+gap)\b/iu;

const PURE_META_CONSEQUENCE =
  /^(?:lower(?:ing|s)?\s+(?:quality|confidence|the\s+score)|which\s+(?:lowers?|weakens?)\s+(?:quality|confidence|the\s+score)|(?:therefore|thus)\s+(?:lower(?:s|ing)?|weakens?)\s+(?:quality|confidence|the\s+score))\.?$/iu;

function hasMetaRequirement(statement: string): boolean {
  return EVALUATOR_OWNED_META_REQUIREMENT.test(statement);
}

function hasMetaEvidence(statement: string): boolean {
  return EVALUATOR_OWNED_META_EVIDENCE.test(statement);
}

function isMetaOmission(statement: string): boolean {
  for (const match of statement.matchAll(EVALUATOR_OWNED_META_REQUIREMENT_GLOBAL)) {
    const before = statement.slice(0, match.index);
    const after = statement.slice(match.index + match[0].length);

    // If the omitted object is followed by a concrete artifact noun, the
    // reviewer is criticizing that noun rather than requesting meta evidence.
    if (CONCRETE_ARTIFACT_EVIDENCE.test(after)) continue;

    // "No hierarchy boundary violation" and "no boundary was crossed"
    // describe preserved scope, not a demand for evaluator-owned narration.
    if (
      /^\s+(?:(?:(?:is|are|was|were)\s+)?(?:violations?|breaches?|defects?|errors?|issues?|problems?|concerns?|crossed|violated|breached))\b/iu.test(
        after,
      )
    ) {
      continue;
    }

    if (
      ABSENCE_CRITICISM_AT_END.test(before) &&
      /^\s*(?:$|[.!?;,) :]|(?:from|in|by|and|or|so|because|which|therefore)\b)/iu.test(after)
    ) {
      return true;
    }

    if (
      /^\s+(?:(?:is|are|was|were|remains?)\s+)?(?:missing|absent|omitted|supplied|not\s+(?:provided|supplied|included|established|shown|documented|addressed|narrated|explained|identified))\b(?=\s*(?:$|[.!?;,) :]|(?:from|in|by|and|or|so|because|which|therefore)\b))/iu.test(
        after,
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasAmbiguousMetaOmission(statement: string): boolean {
  for (const match of statement.matchAll(EVALUATOR_OWNED_META_REQUIREMENT_GLOBAL)) {
    const before = statement.slice(0, match.index);
    const after = statement.slice(match.index + match[0].length);
    if (
      ABSENCE_CRITICISM_AT_END.test(before) &&
      CONCRETE_ARTIFACT_EVIDENCE.test(after) &&
      !META_SCOPE_PRESERVATION.test(statement)
    ) {
      return true;
    }
  }
  return false;
}

function isMetaOnlyClause(statement: string): boolean {
  if (CONCRETE_ARTIFACT_EVIDENCE.test(statement)) return false;
  if (PURE_META_CONSEQUENCE.test(statement.trim())) return true;

  const remainder = statement
    .replace(EVALUATOR_OWNED_META_REQUIREMENT_GLOBAL, ' ')
    .replace(ABSENCE_CRITICISM, ' ')
    .replace(EXPLICIT_NO_META_PENALTY, ' ')
    .replace(META_SCAFFOLD, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return remainder.length === 0;
}

function splitParenthesizedClauses(statement: string): string[] {
  const clauses: string[] = [];
  let plainStart = 0;
  let depth = 0;
  let parentheticalStart = -1;
  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index];
    if (char === '(' && depth === 0) {
      if (index > plainStart) clauses.push(statement.slice(plainStart, index));
      parentheticalStart = index;
      depth = 1;
    } else if (char === '(' && depth > 0) {
      depth += 1;
    } else if (char === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0 && parentheticalStart >= 0) {
        clauses.push(statement.slice(parentheticalStart, index + 1));
        plainStart = index + 1;
        parentheticalStart = -1;
      }
    }
  }
  if (plainStart < statement.length) clauses.push(statement.slice(plainStart));
  return clauses.filter((clause) => clause.trim());
}

function splitReviewerClauses(statement: string): string[] {
  let clauses = splitParenthesizedClauses(statement);
  const boundaries = [
    /[.!?;]\s+/u,
    /\n+/u,
    /\s+(?:but|while|whereas|although|yet)\s+/iu,
    /,\s+(?=(?:and\s+|or\s+)?(?:no\b|missing\b|without\b|lacks?\b|fails?\b|does?\s+not\b|hierarch|specialist\b|skill(?:[- ]guidance)?\b|paired\b|pairing\b|routing\b|cold[- ]start\b|long[- ]tail\b|train[- ]serving\b|recovery\b|verification\b|linux\b|schema\b|unsupported\b))/iu,
    /\s+(?:and|or)\s+(?=(?:no\b|missing\b|without\b|lacks?\b|fails?\b|does?\s+not\b|hierarch|specialist\b|skill(?:[- ]guidance)?\b|paired\b|pairing\b|routing\b))/iu,
  ];
  for (const boundary of boundaries) {
    clauses = clauses.flatMap((clause) =>
      /^\([^()]*\)$/u.test(clause.trim()) ? [clause] : clause.split(boundary),
    );
  }
  return clauses.map((clause) => clause.trim()).filter(Boolean);
}

function sanitizeParentheticalList(clause: string): {
  value: string;
  removedMeta: boolean;
  ambiguous: boolean;
} {
  if (!/^\([^()]*\)$/u.test(clause.trim())) {
    return { value: clause, removedMeta: false, ambiguous: false };
  }
  const inner = clause.trim().slice(1, -1);
  const items = inner
    .split(/\s*,\s*|\s+(?:and|or)\s+/iu)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length < 2) return { value: clause, removedMeta: false, ambiguous: false };

  let removedMeta = false;
  const kept: string[] = [];
  for (const item of items) {
    if (!hasMetaRequirement(item) && !hasMetaEvidence(item)) {
      kept.push(item);
      continue;
    }
    if (CONCRETE_ARTIFACT_EVIDENCE.test(item)) {
      return { value: clause, removedMeta: false, ambiguous: true };
    }
    removedMeta = true;
  }
  if (!removedMeta) return { value: clause, removedMeta: false, ambiguous: false };
  return {
    value: kept.length ? `(${kept.join(', ')})` : '',
    removedMeta: true,
    ambiguous: false,
  };
}

interface SanitizedStatement {
  value: string | null;
  invalid: boolean;
}

function sanitizeReviewerStatement(statement: string): SanitizedStatement {
  const clauses = splitReviewerClauses(statement);
  const kept: string[] = [];
  let removedStrictMeta = false;
  let removedNeutralMeta = false;
  let sawExplicitNeutral = false;

  for (const rawClause of clauses) {
    const parenthetical = sanitizeParentheticalList(rawClause);
    if (parenthetical.ambiguous) return { value: statement, invalid: true };
    const clause = parenthetical.value.trim();
    if (!clause) {
      removedNeutralMeta ||= parenthetical.removedMeta;
      continue;
    }

    const omission = isMetaOmission(clause);
    const metaEvidence = hasMetaEvidence(clause);
    const neutral = EXPLICIT_NO_META_PENALTY.test(clause);
    sawExplicitNeutral ||= neutral;
    const concrete = CONCRETE_ARTIFACT_EVIDENCE.test(clause);

    const broadPureOmission =
      !neutral &&
      !concrete &&
      hasMetaRequirement(clause) &&
      ABSENCE_CRITICISM.test(clause) &&
      !META_NON_CRITICISM.test(clause) &&
      !META_SCOPE_PRESERVATION.test(clause);
    if (hasAmbiguousMetaOmission(clause)) return { value: statement, invalid: true };
    if (META_SCOPE_PRESERVATION.test(clause) && hasMetaRequirement(clause) && !concrete) {
      removedNeutralMeta = true;
      continue;
    }
    if (!omission && !metaEvidence && !broadPureOmission) {
      kept.push(
        kept.length === 0 && /^\([^()]*\)$/u.test(clause) ? clause.slice(1, -1).trim() : clause,
      );
      continue;
    }

    if (!omission && metaEvidence && concrete) {
      // A phrase such as "routing selection lacks fallback" or "paired
      // evaluation lacks cold-start metrics" names a real artifact defect;
      // the evaluator-owned term is only context for that defect.
      kept.push(
        kept.length === 0 && /^\([^()]*\)$/u.test(clause) ? clause.slice(1, -1).trim() : clause,
      );
      continue;
    }

    if (!omission && metaEvidence && !concrete && !broadPureOmission) {
      // Positive evaluator-owned narration is also excluded from preference
      // comparisons, but it is not a fail-closed omission violation.
      removedNeutralMeta = true;
      continue;
    }

    if (META_NON_CRITICISM.test(clause) && metaEvidence && !concrete) {
      removedNeutralMeta = true;
      continue;
    }

    if (broadPureOmission) {
      // Keep the pure-meta fail-closed behavior even when the reviewer adds a
      // trailing consequence such as "lowering quality".
      removedStrictMeta = true;
      continue;
    }

    if (neutral && !concrete) {
      removedNeutralMeta = true;
      continue;
    }

    if (isMetaOnlyClause(clause)) {
      if (omission && !neutral) removedStrictMeta = true;
      else removedNeutralMeta = true;
      continue;
    }

    // A clause containing both an evaluator-owned omission and unrelated
    // content has no safe edit boundary. Fail closed instead of guessing what
    // the reviewer meant to preserve.
    return { value: statement, invalid: true };
  }

  if (!kept.length) {
    if (removedStrictMeta && !sawExplicitNeutral) return { value: statement, invalid: true };
    return { value: null, invalid: false };
  }
  return { value: kept.join('; '), invalid: false };
}

/**
 * Remove only unambiguous evaluator-owned meta clauses before the caller
 * persists the parsed result. This intentionally mutates the supplied result:
 * parseJudgeResult keeps its existing `find...` return contract and persists
 * the same object after this guard returns null.
 */
export function sanitizeBlindJudgeRubricResult(
  result: BlindJudgeRubricResult,
): BlindJudgeRubricResult {
  const fields: Array<'artifactA' | 'artifactB' | 'rationale'> = [
    'artifactA',
    'artifactB',
    'rationale',
  ];
  const sanitizedFields: Record<'artifactA' | 'artifactB' | 'rationale', string[]> = {
    artifactA: [],
    artifactB: [],
    rationale: [],
  };
  for (const field of fields) {
    const statements = field === 'rationale' ? result.rationale : result[field].evidence;
    const sanitized: string[] = [];
    for (const statement of statements) {
      const outcome = sanitizeReviewerStatement(statement);
      if (outcome.invalid) return result;
      if (outcome.value) sanitized.push(outcome.value);
    }
    sanitizedFields[field] = sanitized;
  }
  result.artifactA.evidence = sanitizedFields.artifactA;
  result.artifactB.evidence = sanitizedFields.artifactB;
  result.rationale = sanitizedFields.rationale;
  return result;
}

/** Reject blind adjudications that penalize evaluator-owned meta evidence. */
export function findBlindJudgeRubricViolation(result: BlindJudgeRubricResult): string | null {
  const original = {
    artifactA: [...result.artifactA.evidence],
    artifactB: [...result.artifactB.evidence],
    rationale: [...result.rationale],
  };
  const sanitized = sanitizeBlindJudgeRubricResult(result);
  const unchanged =
    sanitized.artifactA.evidence.length === original.artifactA.length &&
    sanitized.artifactB.evidence.length === original.artifactB.length &&
    sanitized.rationale.length === original.rationale.length &&
    sanitized.artifactA.evidence.every(
      (statement, index) => statement === original.artifactA[index],
    ) &&
    sanitized.artifactB.evidence.every(
      (statement, index) => statement === original.artifactB[index],
    ) &&
    sanitized.rationale.every((statement, index) => statement === original.rationale[index]);
  if (!unchanged) return null;

  return (
    [...original.artifactA, ...original.artifactB, ...original.rationale].find(
      (statement) => sanitizeReviewerStatement(statement).invalid,
    ) ?? null
  );
}

/**
 * Check a narrowly falsifiable reviewer claim against the actual file snapshot.
 * Reviewers sometimes turn a literal URL into a Markdown link while quoting it,
 * then mistakenly conclude that the Markdown syntax occurs in the candidate.
 * Absence from a visible JSON snapshot is conclusive only when that snapshot is
 * available; do not infer anything about files omitted from the evidence bundle.
 */
export function findBlindJudgeArtifactMismatch(
  result: BlindJudgeRubricResult,
  artifactA: BlindReviewArtifact,
  artifactB: BlindReviewArtifact,
): string | null {
  const arms = [
    { label: 'A', score: result.artifactA, artifact: artifactA },
    { label: 'B', score: result.artifactB, artifact: artifactB },
  ];
  for (const arm of arms) {
    const markdownUrlClaim = arm.score.evidence.find(
      (statement) =>
        /markdown[- ](?:formatted|linked)|markdown link/iu.test(statement) &&
        /\b(?:url|origin|cors|reportfetch)\b/iu.test(statement) &&
        /\b(?:contains?|represented|stores?|configured|values?|malformed|incorrect)\b/iu.test(
          statement,
        ) &&
        !/\b(?:no|not|without|avoids?|never)\b.{0,35}markdown/iu.test(statement),
    );
    if (!markdownUrlClaim) continue;
    const accusedField = /\bcors\s*\.\s*origins\b|\bcors\s+origins?\b/iu.test(markdownUrlClaim)
      ? 'cors.origins'
      : /\breportfetch\s*\.\s*allowedorigin\b|\breport\s+fetch\s+(?:allowed\s+)?origin\b/iu.test(
            markdownUrlClaim,
          )
        ? 'reportFetch.allowedOrigin'
        : null;
    const snapshots = arm.artifact.changes.filter(
      (change) => change.path.endsWith('.json') && typeof change.afterText === 'string',
    );
    if (!snapshots.length) continue;
    const hasMarkdownUrl = snapshots.some((change) => {
      try {
        const parsed = JSON.parse(change.afterText!) as unknown;
        const object =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        const cors =
          object?.cors && typeof object.cors === 'object' && !Array.isArray(object.cors)
            ? (object.cors as Record<string, unknown>)
            : null;
        const reportFetch =
          object?.reportFetch &&
          typeof object.reportFetch === 'object' &&
          !Array.isArray(object.reportFetch)
            ? (object.reportFetch as Record<string, unknown>)
            : null;
        const values: unknown[] =
          accusedField === 'cors.origins'
            ? [cors?.origins]
            : accusedField === 'reportFetch.allowedOrigin'
              ? [reportFetch?.allowedOrigin]
              : [parsed];
        while (values.length) {
          const value = values.pop();
          if (typeof value === 'string' && /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/iu.test(value)) {
            return true;
          }
          if (Array.isArray(value)) values.push(...value);
          else if (value && typeof value === 'object') values.push(...Object.values(value));
        }
      } catch {
        // A truncated/unparseable snapshot is not sufficient to disprove a claim.
        return true;
      }
      return false;
    });
    if (!hasMarkdownUrl) {
      return `Artifact ${arm.label} was accused of a Markdown-formatted URL, but its visible JSON file snapshots contain only literal values: ${markdownUrlClaim}`;
    }
  }
  return null;
}

export function buildBlindReviewJudgePrompt(input: {
  task: V5FullTaskFixture;
  artifactA: BlindReviewArtifact;
  artifactB: BlindReviewArtifact;
  pairEvidence: BlindPairExecutionEvidence;
}): string {
  return [
    'You are an independent blind semantic evaluator.',
    'Two anonymous agents attempted the same task. You are not told which agent received any extra guidance, and you must not infer or speculate about that hidden condition.',
    'Judge each artifact independently against the task contract. Do not reward matching wording, verbosity, or references to a skill. Focus on behavioral correctness, scope discipline, evidence quality, preservation of required facts, negative paths, recovery behavior, and whether completion claims are actually supported.',
    'The artifact bundle may include harness captured execution evidence and before and after file snapshots. Treat that as observed evidence, not as an agent claim.',
    'PUBLIC CANDIDATE CONTRACT SNAPSHOT is the exact task prompt and allowlisted README.md/contract.json bytes visible to the candidate before execution. Hashes are verified by the harness. If an entry says UNAVAILABLE, do not reconstruct it from the current repository or treat current files as historical proof.',
    'executionEvidence is supplied by the host after the agent attempt, including deterministic scorer observations. An agent can truthfully report that it could not run a check even when the host subsequently runs that check successfully. Those observations have different owners and times; that difference alone is not an integrity failure.',
    'Attribute a completion claim to its actual source. Penalize an agent for fabricated or overstated verification only when its finalOutput or authored file content makes that unsupported claim. Do not attribute a host scorer statement to the agent, require the agent to predict later host results, or treat an honest statement of limited access as contradicting later host verification.',
    'Host evidence is not infallible. If a scorer result conflicts with concrete artifact behavior, identify the disputed check and evidence as a possible verifier defect. Keep instrument uncertainty separate from an agent integrity finding; a score label alone does not prove the task succeeded.',
    'Treat afterText JSON strings as literal source bytes. Before claiming a URL or origin is malformed or Markdown-formatted, inspect and quote the exact JSON value. Do not transform plain URL strings into Markdown hyperlinks and then mistake that display formatting for the original value.',
    'The PAIR EXECUTION EVIDENCE section is evaluator owned evidence. It certifies that Artifact A and Artifact B are the two randomized arms of one matched same model comparison for this exact scenario and evaluation contract.',
    'When REQUIRED EVIDENCE or REQUIRED ARTIFACTS asks for paired skill and no skill run artifacts, paired evaluation evidence, or an equivalent pair label, the anonymous A and B bundle plus PAIR EXECUTION EVIDENCE satisfies the existence and provenance of that pair. Do not require either agent output to claim, create, or narrate evaluator owned pair evidence.',
    'The REQUIRED ARTIFACTS entries below are evaluation evidence labels for the overall harness. They are not literal filenames the agent was instructed to create unless the task itself says so. Judge whether the bundle substantively supplies the required evidence; do not require those exact label strings to appear.',
    'Routing and hierarchy selection are evaluated independently by the harness. Do not require the agent to narrate which skill was selected or provide meta level specialist selection rationale when the artifact itself respects the requested scope and neighboring responsibility boundaries.',
    'Never lower passed, quality, verification, or integrity because an artifact omits hierarchy narration, specialist selection rationale, skill names, or evaluator owned paired A/B evidence. If a draft criticism relies on one of those omissions, remove that criticism and score only the concrete task behavior and evidence.',
    'If a REQUIRED EVIDENCE or REQUIRED ARTIFACTS label describes routing, hierarchy selection, specialist selection, or paired skill versus no skill provenance, treat that meta level requirement as evaluator owned. The harness evidence in this prompt is authoritative for those concerns.',
    'When choosing preference A, B, or tie, compare concrete task behavior and evidence only. Evaluator-owned hierarchy or specialist narration, skill-guidance scope, filenames, and paired-run provenance must not affect the preference comparison.',
    'Treat genuinely missing task evidence as missing. Do not assume unshown commands or tests passed.',
    'Return JSON only, with this exact shape:',
    '{"artifactA":{"passed":true,"quality":0.0,"verification":0.0,"integrityFailure":false,"evidence":["..."]},"artifactB":{"passed":true,"quality":0.0,"verification":0.0,"integrityFailure":false,"evidence":["..."]},"preference":"A","rationale":["..."]}',
    '',
    'TASK',
    input.artifactA.publicContract?.taskPrompt.available &&
    typeof input.artifactA.publicContract.taskPrompt.text === 'string'
      ? input.artifactA.publicContract.taskPrompt.text
      : '[UNAVAILABLE: no verified pre-execution task-prompt snapshot was archived for this run]',
    '',
    'FALSIFIABLE CHECKS',
    JSON.stringify(input.task.falsifiableChecks, null, 2),
    '',
    'REQUIRED EVIDENCE',
    JSON.stringify(input.task.requiredEvidence, null, 2),
    '',
    'REQUIRED ARTIFACTS',
    JSON.stringify(input.task.requiredArtifacts, null, 2),
    '',
    'PUBLIC CANDIDATE CONTRACT SNAPSHOT',
    JSON.stringify(
      input.artifactA.publicContract ?? unavailablePublicContract('not-archived'),
      null,
      2,
    ),
    '',
    'PAIR EXECUTION EVIDENCE',
    JSON.stringify(input.pairEvidence, null, 2),
    '',
    'ARTIFACT A',
    JSON.stringify(input.artifactA, null, 2),
    '',
    'ARTIFACT B',
    JSON.stringify(input.artifactB, null, 2),
  ].join('\n');
}

export interface BlindReviewQueueCandidate {
  skill: string;
  scenarioId: string;
  comparisonId: string;
  /** Newest execution time of the pair's two arms. */
  pairRecordedAt: string;
}

export interface BlindReviewAdjudication {
  skill: string;
  scenarioId: string;
  comparisonId?: string;
  recordedAt: string;
}

/**
 * Which assignments a campaign may stage, given what has already been adjudicated.
 *
 * A pair that was replaced after it was judged is a different observation, so it
 * needs its own adjudication: the evidence of a pair is the artifact plus the
 * execution that produced it, and a replaced pair has new artifacts. A pair that
 * has already been judged at its current identity is never re-reviewed, which is
 * what stops review shopping on a fixed artifact.
 *
 * `maxPerSkill` bounds what this invocation stages, not the skill's lifetime
 * review count. Counting history here froze any skill that already held two
 * passing reviews, because two passes on one case consumed the budget of a
 * different case that had never been judged at all.
 */
export function selectBlindReviewQueue(
  candidates: readonly BlindReviewQueueCandidate[],
  adjudications: readonly BlindReviewAdjudication[],
  maxPerSkill: number,
): BlindReviewQueueCandidate[] {
  const newestByCase = new Map<string, BlindReviewAdjudication>();
  const judgedPairs = new Set<string>();
  for (const adjudication of adjudications) {
    if (!adjudication.comparisonId) continue;
    judgedPairs.add(`${adjudication.skill}\0${adjudication.scenarioId}\0${adjudication.comparisonId}`);
    const key = `${adjudication.skill}\0${adjudication.scenarioId}`;
    const current = newestByCase.get(key);
    if (!current || adjudication.recordedAt > current.recordedAt) newestByCase.set(key, adjudication);
  }
  const needsAdjudication = candidates.filter((candidate) => {
    if (!judgedPairs.has(`${candidate.skill}\0${candidate.scenarioId}\0${candidate.comparisonId}`)) {
      return true;
    }
    return false;
  });
  if (!Number.isFinite(maxPerSkill)) return needsAdjudication;
  const stagedBySkill = new Map<string, number>();
  const queue: BlindReviewQueueCandidate[] = [];
  for (const candidate of needsAdjudication) {
    const staged = stagedBySkill.get(candidate.skill) ?? 0;
    if (staged >= maxPerSkill) continue;
    stagedBySkill.set(candidate.skill, staged + 1);
    queue.push(candidate);
  }
  return queue;
}
