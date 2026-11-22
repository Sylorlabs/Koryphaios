import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import {
  canonicalizePath, hasHardLinks, hasUnexpectedMode, hasUnexpectedOwner, isContainedBy,
} from '../../runtime/platform';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { exactRecord, strictJson } from '../../../../scripts/reviewer-json';
import { parseNativeTextEvents } from '../../../../scripts/native-text-events';
import type { SkillEvaluationRun } from '../../kory/skill-evaluations';

export const OPENCODE_TEXT_PATCH_QUARANTINE_REASON =
  'opencode-text-patch execution evidence is quarantined: no qualified enforced isolation boundary. ' +
  'The data-visualization task1 run f03e4d7c-2579-4823-bb27-28318139441d emitted repository grep tool events; ' +
  'earlier successes have no isolation receipt, and tool-event-guard-v1 detects actions only after execution.';

export const OPENCODE_STATELESS_QUARANTINE_REASON =
  'opencode-stateless-text-patch evidence is quarantined: the source-inspected no-tools ' +
  'generation contract is not an enforced OS isolation boundary, and the host-observed ' +
  'unsigned response does not attest upstream model identity or isolated execution.';

export const LOCAL_LLAMA_TEXT_PATCH_QUARANTINE_REASON =
  'local-llama-text-patch evidence is quarantined: a host-observed unsigned completion ' +
  'does not independently attest model identity, blind review, or isolated execution provenance.';

export const NATIVE_STATELESS_EXCLUSION_REASON =
  'native-stateless-text-patch execution evidence lacks a matching pinned no-tools completion receipt and archived output binding.';

function nativeReceiptValid(
  run: Pick<SkillEvaluationRun, 'harnessVersion'> & Partial<SkillEvaluationRun>,
): boolean {
  try {
    if (
      run.evaluator !== 'deterministic' ||
      run.protocolVersion !== 3 ||
      run.infrastructureFailure ||
      !run.provider ||
      !run.model ||
      run.provider.includes(':') ||
      run.model.includes(':') ||
      !run.comparisonId ||
      !['with-skill', 'without-skill'].includes(run.variant ?? '') ||
      !run.evaluationContractHash ||
      !/^[a-f0-9]{16,64}$/u.test(run.evaluationContractHash)
    )
      return false;
    // The receipt attests one execution, so the identity it is read from names that
    // execution's own provider and model. Pinning one model here would silently
    // exclude every receipt produced by any other model, which is the opposite of
    // what the receipt proves.
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const identity = new RegExp(
      `^v5-campaign-2026-09-08:native-stateless-text-patch:native-stateless-text-patch:${escape(run.model)}:(.+):${escape(run.provider)}:${escape(run.model)}:${escape(run.provider)}:(.+):v2\\.1\\.309:no-tools-text-patch-v1:text-only-patch:([^:]+):([1-9][0-9]*)ms:([a-f0-9]{16,64})$`,
      'u',
    ).exec(run.harnessVersion);
    if (
      !identity ||
      identity[1] !== identity[2] ||
      identity[5] !== run.evaluationContractHash ||
      !Number.isSafeInteger(Number(identity[4])) ||
      Number(identity[4]) > 2_147_483_647
    )
      return false;
    const one = (prefix: string) => {
      const entries = (run.evidence ?? []).filter((item) => item.startsWith(prefix));
      if (entries.length !== 1) throw new Error('Invalid receipt count');
      return strictJson(entries[0]!.slice(prefix.length)) as Record<string, unknown>;
    };
    const receipt = exactRecord(one('Native stateless host receipt: '), [
      'kind',
      'runtime',
      'cliVersion',
      'requestedModel',
      'boundary',
      'boundaryBasis',
      'osIsolationVerified',
      'upstreamIdentityVerified',
      'upstreamCancellationAcknowledged',
      'requestSerialization',
      'request',
      'response',
      'exitCode',
      'elapsedMs',
    ]);
    const completion = exactRecord(one('Native stateless completed session: '), [
      'sessionId',
      'observedModel',
      'tools',
      'mcpServers',
      'skills',
      'signed',
      'outputSha256',
    ]);
    const request = exactRecord(receipt.request, ['sha256', 'bytes']);
    const response = exactRecord(receipt.response, ['sha256', 'bytes', 'complete']);
    const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
    const positiveBytes = (value: unknown, limit: number) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= limit;
    if (
      receipt.kind !== 'host-observed-unsigned' ||
      receipt.runtime !== 'no-tools-text-patch-v1' ||
      receipt.cliVersion !== '2.1.309' ||
      receipt.requestedModel !== run.model ||
      receipt.boundary !== 'native-no-tools-bare-restricted-explicit-stdin' ||
      receipt.boundaryBasis !== 'measured-version-dependent' ||
      receipt.osIsolationVerified !== false ||
      receipt.upstreamIdentityVerified !== false ||
      receipt.upstreamCancellationAcknowledged !== false ||
      receipt.requestSerialization !== 'host-declared-system-prompt-model-not-upstream-wire' ||
      receipt.exitCode !== 0 ||
      !digest(request.sha256) ||
      !positiveBytes(request.bytes, 24_000) ||
      response.complete !== true ||
      !digest(response.sha256) ||
      !positiveBytes(response.bytes, 4_000_000) ||
      typeof receipt.elapsedMs !== 'number' ||
      !Number.isSafeInteger(receipt.elapsedMs) ||
      receipt.elapsedMs < 0 ||
      receipt.elapsedMs > Number(identity[4]) + 500 ||
      completion.observedModel !== run.model ||
      typeof completion.sessionId !== 'string' ||
      !/^[A-Za-z0-9._-]{1,150}$/u.test(completion.sessionId) ||
      completion.signed !== false ||
      !digest(completion.outputSha256)
    )
      return false;
    for (const field of ['tools', 'mcpServers', 'skills']) {
      if (!Array.isArray(completion[field]) || completion[field].length !== 0) return false;
    }
    const outputs = (run.artifacts ?? []).filter(
      (artifact) =>
        artifact.kind === 'report' && basename(artifact.location) === 'final-output.txt',
    );
    const manifests = (run.artifacts ?? []).filter(
      (artifact) =>
        artifact.kind === 'report' && basename(artifact.location) === 'run-manifest.json',
    );
    const streams = (run.artifacts ?? []).filter(
      (artifact) =>
        artifact.kind === 'report' && basename(artifact.location) === 'native-text-events.jsonl',
    );
    if (
      outputs.length !== 1 ||
      manifests.length !== 1 ||
      streams.length !== 1 ||
      dirname(outputs[0]!.location) !== dirname(manifests[0]!.location) ||
      dirname(streams[0]!.location) !== dirname(manifests[0]!.location)
    )
      return false;
    const archived = (
      artifact: (typeof outputs)[number],
      limit: number,
      protectedStream = false,
    ) => {
      const stat = lstatSync(artifact.location);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || !digest(artifact.sha256))
        throw new Error('Invalid archive');
      // A pathname may become a FIFO or symlink after lstat; do not block or
      // follow it before the existing descriptor identity/protection checks.
      const fd = openSync(
        artifact.location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          opened.size !== stat.size ||
          (protectedStream &&
            (hasUnexpectedMode(opened, 0o600) ||
              hasUnexpectedOwner(opened) ||
              hasHardLinks(opened)))
        )
          throw new Error('Invalid archive identity');
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!count) throw new Error('Incomplete archive');
          offset += count;
        }
        if (
          readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
          createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
        )
          throw new Error('Archive hash mismatch');
        return bytes;
      } finally {
        closeSync(fd);
      }
    };
    const stream = archived(streams[0]!, 4_000_000, true);
    if (
      stream.byteLength !== response.bytes ||
      createHash('sha256').update(stream).digest('hex') !== response.sha256
    )
      return false;
    // Claimed completion fields are not enough: revalidate the actual archived init and result.
    const parsed = parseNativeTextEvents(stream, run.model!);
    const output = archived(outputs[0]!, 4_000_000);
    if (
      parsed.sessionId !== completion.sessionId ||
      !output.equals(Buffer.from(parsed.output, 'utf8')) ||
      createHash('sha256').update(output).digest('hex') !== completion.outputSha256
    )
      return false;
    const manifest = strictJson(archived(manifests[0]!, 8_000_000).toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      manifest.artifactSchemaVersion !== 3 ||
      manifest.pairId !== run.comparisonId ||
      manifest.variant !== run.variant ||
      manifest.harnessVersion !== run.harnessVersion ||
      manifest.evaluationContractHash !== run.evaluationContractHash ||
      manifest.evaluationContractVersion !== run.evaluationContractVersion ||
      manifest.materializerId !== run.materializerId ||
      manifest.deterministicScorerId !== run.deterministicScorerId ||
      !run.materializerId ||
      !run.deterministicScorerId ||
      !manifest.scenario ||
      typeof manifest.scenario !== 'object' ||
      (manifest.scenario as Record<string, unknown>).id !== run.scenarioId ||
      (manifest.scenario as Record<string, unknown>).skill !== run.skill ||
      manifest.infrastructureFailure !== null ||
      !manifest.score ||
      typeof manifest.score !== 'object' ||
      !Array.isArray(manifest.evidence) ||
      !manifest.evidence.every((item) => typeof item === 'string')
    )
      return false;
    const archive = exactRecord(manifest.nativeTextEventArchive, [
      'location', 'sha256', 'bytes', 'workspaceRoot',
    ]);
    if (
      archive.location !== canonicalizePath(streams[0]!.location) ||
      archive.sha256 !== streams[0]!.sha256 ||
      archive.bytes !== stream.byteLength ||
      typeof archive.workspaceRoot !== 'string' ||
      !isAbsolute(archive.workspaceRoot) ||
      resolve(archive.workspaceRoot) !== archive.workspaceRoot ||
      isContainedBy(archive.workspaceRoot, archive.location as string)
    )
      return false;
    const score = manifest.score as Record<string, unknown>;
    for (const field of ['passed', 'quality', 'verification', 'integrityFailure'] as const) {
      if (score[field] !== run[field]) return false;
    }
    for (const prefix of [
      'Native stateless host receipt: ',
      'Native stateless completed session: ',
    ]) {
      const archivedReceipts = manifest.evidence.filter(
        (item): item is string => typeof item === 'string' && item.startsWith(prefix),
      );
      if (archivedReceipts.length !== 1 || !(run.evidence ?? []).includes(archivedReceipts[0]!))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** No runtime suffix alone grants trust; native receipt validation stays derived. */
export function skillEvaluationExecutionExclusionReason(
  run: Pick<SkillEvaluationRun, 'harnessVersion'> & Partial<SkillEvaluationRun>,
): string | null {
  if (/(?:^|:)opencode-text-patch(?::|$)/u.test(run.harnessVersion))
    return OPENCODE_TEXT_PATCH_QUARANTINE_REASON;
  if (/(?:^|:)opencode-stateless-text-patch(?::|$)/u.test(run.harnessVersion))
    return OPENCODE_STATELESS_QUARANTINE_REASON;
  if (/(?:^|:)local-llama-text-patch(?::|$)/u.test(run.harnessVersion))
    return LOCAL_LLAMA_TEXT_PATCH_QUARANTINE_REASON;
  if (
    (/(?:^|:)native-stateless-text-patch(?::|$)/u.test(run.harnessVersion) ||
      (run.evaluator === 'deterministic' && run.provider === 'native-cli')) &&
    !nativeReceiptValid(run)
  ) {
    return NATIVE_STATELESS_EXCLUSION_REASON;
  }
  return null;
}

export interface SkillEvaluationEvidenceExclusion {
  runId: string;
  reason: string;
  /** Case the excluded observation belonged to, when it can be attributed. */
  scenarioId?: string;
}

const pairKey = (run: SkillEvaluationRun) =>
  JSON.stringify([run.skill, run.revisionHash, run.scenarioId ?? run.caseId, run.comparisonId]);

/** A review can only qualify a recorded, eligible execution of both arms. */
function eligibleExecutionPairs(runs: readonly SkillEvaluationRun[]): Set<string> {
  const byPair = new Map<string, SkillEvaluationRun[]>();
  for (const run of runs) {
    if (
      run.evaluator !== 'deterministic' || !run.comparisonId ||
      run.integrityFailure || run.infrastructureFailure ||
      skillEvaluationExecutionExclusionReason(run)
    ) continue;
    const key = pairKey(run);
    byPair.set(key, [...(byPair.get(key) ?? []), run]);
  }
  const eligible = new Set<string>();
  for (const [key, candidates] of byPair) {
    for (const withSkill of candidates.filter((run) => run.variant === 'with-skill')) {
      if (candidates.some((withoutSkill) =>
        withoutSkill.variant === 'without-skill' &&
        withoutSkill.protocolVersion === withSkill.protocolVersion &&
        withoutSkill.caseId === withSkill.caseId &&
        withoutSkill.caseCategory === withSkill.caseCategory &&
        withoutSkill.suiteId === withSkill.suiteId &&
        withoutSkill.provider === withSkill.provider &&
        withoutSkill.model === withSkill.model &&
        withoutSkill.harnessVersion === withSkill.harnessVersion &&
        withoutSkill.evaluationContractVersion === withSkill.evaluationContractVersion &&
        withoutSkill.evaluationContractHash === withSkill.evaluationContractHash &&
        withoutSkill.materializerId === withSkill.materializerId &&
        withoutSkill.deterministicScorerId === withSkill.deterministicScorerId
      )) {
        eligible.add(JSON.stringify([
          key, withSkill.protocolVersion, withSkill.caseId, withSkill.caseCategory,
          withSkill.suiteId, withSkill.evaluationContractVersion,
          withSkill.evaluationContractHash, withSkill.materializerId,
          withSkill.deterministicScorerId,
        ]));
      }
    }
  }
  return eligible;
}

const reviewExecutionKey = (run: SkillEvaluationRun) => JSON.stringify([
  pairKey(run), run.protocolVersion, run.caseId, run.caseCategory,
  run.suiteId, run.evaluationContractVersion, run.evaluationContractHash,
  run.materializerId, run.deterministicScorerId,
]);

/** Derived view only: preserve original observations and their scores verbatim. */
export function selectEligibleSkillEvaluationEvidence(runs: readonly SkillEvaluationRun[]): {
  runs: SkillEvaluationRun[];
  excludedEvidence: SkillEvaluationEvidenceExclusion[];
} {
  const excludedPairs = new Map(
    runs.flatMap((run) => {
      const reason = skillEvaluationExecutionExclusionReason(run);
      return run.evaluator === 'deterministic' && run.comparisonId && reason
        ? [[pairKey(run), reason] as const]
        : [];
    }),
  );
  const executionPairs = eligibleExecutionPairs(runs);
  const eligible: SkillEvaluationRun[] = [];
  const excludedEvidence: SkillEvaluationEvidenceExclusion[] = [];
  for (const run of runs) {
    const reason =
      skillEvaluationExecutionExclusionReason(run) ??
      (run.evaluator !== 'deterministic' && run.comparisonId && excludedPairs.has(pairKey(run))
        ? `Review of excluded execution pair ${run.comparisonId}: ${excludedPairs.get(pairKey(run))}`
        : null) ??
      ((run.protocolVersion === 2 || run.protocolVersion === 3) &&
        (run.evaluator === 'blind-review' || run.evaluator === 'human-blind-review') &&
        (!run.comparisonId || !executionPairs.has(reviewExecutionKey(run)))
        ? 'Blind review has no eligible matched execution pair with a recorded comparisonId.'
        : null);
    if (reason) excludedEvidence.push({ runId: run.id, reason });
    else eligible.push(run);
  }
  return { runs: eligible, excludedEvidence };
}
