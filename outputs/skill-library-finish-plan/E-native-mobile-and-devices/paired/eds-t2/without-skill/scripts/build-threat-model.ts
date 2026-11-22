/**
 * Deterministic builder for `.kory-eval/threat-model.md`.
 *
 * This document is analysis, not verification. Every computable number in it is
 * re-derived from the same models the evidence artifact uses, so the prose can
 * never drift from the reproducible results; the tests in
 * `tests/evidence-artifacts.test.ts` assert that re-running this file
 * reproduces the committed bytes.
 */
import { bootDecision } from '../src/device-sim';
import {
  type AuthoredDeviceConfig,
  type Corpus,
  ANALYSIS_PATH,
  CONFIG_PATH,
  CORPUS_PATH,
  EVIDENCE_PATH,
  SIM_PATH,
  corpusImage,
  deriveBootPolicy,
  fileDigest,
  imageKey,
  readConfig,
  readCorpus,
  writeArtifact,
} from './kory-artifact';
import {
  ATTACKER_MODEL,
  CLAIM_BOUNDARY,
  COMMUNICATIONS,
  LIMITS,
  PERIPHERALS,
  PROVENANCE_AND_KEYS,
  RESISTANCE_CLAIMS,
  SCOPE_BOUNDARIES,
} from './attack-surface';
import {
  INTERFACE_NAMES,
  POSSESSION_STATES,
  POSSESSION_STATE_DEFINITIONS,
  enumerateAuthority,
  probeAttempts,
} from './interface-authority';
import { recordFor, runLifecycle } from './credential-lifecycle';
import { powerCutScenario, resolvedEnvironmentFacts, trustChain } from './boot-and-update';

const table = (headers: string[], rows: string[][]): string => {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [line(headers), `|${headers.map(() => ' --- |').join('')}`, ...rows.map(line)].join('\n');
};

const escapeCell = (text: string): string => text.replace(/\|/gu, '\\|').replace(/\n/gu, ' ');
const orDash = (value: unknown): string =>
  value === undefined || value === null || value === '' ? '—' : escapeCell(String(value));

export function buildAnalysis(corpus: Corpus, config: AuthoredDeviceConfig): string {
  const policy = deriveBootPolicy(corpus, config);
  const current = corpusImage(corpus, 'current');
  const older = corpusImage(corpus, 'older');
  const wrongProduct = corpusImage(corpus, 'wrong-product');
  const unsigned = corpusImage(corpus, 'unsigned');
  const corrupt = corpusImage(corpus, 'corrupt');
  const recovery = corpusImage(corpus, 'recovery');
  const candidate = { ...current, id: 'update-candidate', version: current.version + 1 };
  const recoveryUnauthorized = { ...recovery, id: 'recovery-unauthorized', authorizedRecovery: undefined };

  const attempts = probeAttempts(config);
  const transcript = runLifecycle(current.version);
  const step = (event: string) => recordFor(transcript, event);
  const resolved = resolvedEnvironmentFacts(corpus, config);
  const recentDenials = attempts.filter((attempt) => !attempt.grantedByPolicy);
  const recentGrants = attempts.filter((attempt) => attempt.grantedByPolicy);

  const images = [
    ['current@7 (corpus)', 'board-observed serial boot log', bootDecision(policy, current), 'yes'],
    ['older@5 (corpus)', 'correctly signed downgrade', bootDecision(policy, older), 'no'],
    ['wrong-product@8 (corpus)', 'correctly signed, other product', bootDecision(policy, wrongProduct), 'no'],
    ['unsigned@8 (corpus)', 'unsigned', bootDecision(policy, unsigned), 'no'],
    ['corrupt@8 (corpus)', 'corrupt slot content', bootDecision(policy, corrupt), 'no'],
    ['recovery@3 (corpus)', 'authorized recovery image', bootDecision(policy, recovery), 'yes'],
    ['update-candidate@8 (derived)', 'authenticated update candidate', bootDecision(policy, candidate), 'yes'],
    ['recovery-unauthorized@3 (derived)', 'recovery image with the authorization removed', bootDecision(policy, recoveryUnauthorized), 'no'],
  ] as const;

  const cuts = powerCutScenario(policy, corpus, 'authenticated update', current, candidate, []);

  const sections: string[] = [];

  sections.push(`# Device firmware threat model — ${corpus.board} / ${corpus.product}

This is the analysis document for \`.kory-eval/device-config.json\` and
\`.kory-eval/device-lifecycle-evidence.json\`. It explains the reasoning; it is not
the evidence. Every table below is regenerated from the same models the evidence
artifact uses, and the reproducible results live in the artifacts and the tests.

- Board: \`${corpus.board}\`
- Product: \`${corpus.product}\`
- Production key-hash record: \`${corpus.keyHash}\`
- Deployed application version: \`${current.version}\` (minimum accepted version \`${policy.minimumVersion}\`)
- Evidence labels: **hardware-observed** (read on the board, recorded in the corpus), **documentation** (fixture README, device policy or the authored config), **simulation** (the supplied state machine or this repository's own lifecycle model).
`);

  sections.push(`## What this fixture can and cannot show

${CLAIM_BOUNDARY}

The corpus records \`${Object.entries(corpus.emulator)
    .filter(([, value]) => value === false)
    .map(([key]) => key)
    .join('`, `')}\` as unavailable in the emulator, so no debug-lock, physical-fuse, invasive-extraction or fault-injection resistance is claimed anywhere in these artifacts.
`);

  sections.push(`## 1. Attacker access and consequences

${table(
    ['Capability', 'Available', 'What it means here'],
    ATTACKER_MODEL.capabilities.map((entry) => [
      entry.capability,
      entry.available ? 'yes' : 'no',
      escapeCell(entry.description),
    ]),
  )}

${table(
    ['Consequence', 'Severity', 'Trigger', 'Control'],
    ATTACKER_MODEL.consequences.map((entry) => [
      entry.consequence,
      entry.severity,
      escapeCell(entry.trigger),
      escapeCell(entry.control),
    ]),
  )}
`);

  sections.push(`## 2. Boot chain, provenance and keys

${table(
    ['Stage', 'Mutability', 'Enforces', 'On failure'],
    trustChain(policy, corpus).map((stage) => [
      String(stage.stage),
      String(stage.mutability),
      Array.isArray(stage.enforces)
        ? stage.enforces.join('; ')
        : orDash(stage.authenticates ?? stage.currentImage),
      orDash(stage.failureBehavior),
    ]),
  )}

- **trust anchor**: ${PROVENANCE_AND_KEYS.trustAnchor.property} (${PROVENANCE_AND_KEYS.trustAnchor.evidenceLabel}). ${PROVENANCE_AND_KEYS.trustAnchor.note}
- **per-device credential**: ${PROVENANCE_AND_KEYS.perDeviceCredential.property}; ${PROVENANCE_AND_KEYS.perDeviceCredential.storage}; exportable=${String(PROVENANCE_AND_KEYS.perDeviceCredential.exportable)} (${PROVENANCE_AND_KEYS.perDeviceCredential.evidenceLabel}).
- **artifact provenance boundary**: ${PROVENANCE_AND_KEYS.artifactProvenanceBoundary}
- **algorithm boundary**: ${PROVENANCE_AND_KEYS.algorithmBoundary}
- **rotation**: ${PROVENANCE_AND_KEYS.keysAndCounters.rotation}
- **revocation**: ${PROVENANCE_AND_KEYS.keysAndCounters.revocation}
- **backup**: ${PROVENANCE_AND_KEYS.keysAndCounters.backup}
`);

  sections.push(`## 3. Environment facts that change the answer

${table(
    ['Fact', 'Resolved value', 'Decision and consequence'],
    resolved.facts.map((fact) => [fact.fact, fact.value, escapeCell(`${fact.decision}. ${fact.consequence}`)]),
  )}

The minimum-version ambiguity is the one that changes a decision, so it is
demonstrated rather than asserted:

- resolved policy (\`minimumVersion=${policy.minimumVersion}\`): \`${resolved.minimumVersionDemonstration.resolvedPolicyDecision}\` for \`${imageKey(older)}\`
- counterfactual policy (\`minimumVersion=${older.version}\`): \`${resolved.minimumVersionDemonstration.counterfactualPolicyDecision}\` for \`${imageKey(older)}\`

${resolved.minimumVersionDemonstration.conclusion}
`);

  sections.push(`## 4. Debug interface authority

Authority is enumerated in \`.kory-eval/device-config.json\` as
\`<state>:<privilege>\` tokens, where a \`no-\` prefix records an explicit denial.
The two states are:

${table(
    ['State', 'Meaning'],
    POSSESSION_STATES.map((state) => [state, POSSESSION_STATE_DEFINITIONS[state]]),
  )}

${table(
    ['Interface', 'State', 'Granted', 'Explicitly denied'],
    INTERFACE_NAMES.flatMap((name) =>
      POSSESSION_STATES.map((state) => {
        const tokens = enumerateAuthority(config).filter(
          (token) => token.interface === name && token.state === state,
        );
        return [
          name,
          state,
          tokens.filter((token) => token.kind === 'grant').map((token) => token.privilege).join(', ') || '—',
          tokens.filter((token) => token.kind === 'denial').map((token) => token.privilege).join(', ') || '—',
        ];
      }),
    ),
  )}

${attempts.length} attempts were re-derived from that policy with the supplied
\`interfaceCan()\`: ${recentDenials.length} refused, ${recentGrants.length} granted.
The grants are exactly \`${recentGrants.map((attempt) => `${attempt.interface} ${attempt.state}:${attempt.privilege}`).join('`, `')}\`.
Everything else an attacker tries — unrestricted firmware readout, secret export,
flash erase, rollback-state clear, unauthenticated image install, credential
export — is refused by the enumeration, so there is no privileged path that ends
in key material. The production lock register read on \`${corpus.board}\`
(\`observedProductionLockState=${String(config.observedProductionLockState)}\`,
\`swdReadoutLocked=${String(config.swdReadoutLocked)}\`) is what keeps SWD bounded,
and only the explicitly authenticated recovery path remains.
`);

  sections.push(`## 5. Update and recovery

${table(
    ['Image', 'Basis', 'Decision', 'Executed'],
    images.map((row) => [...row]),
  )}

${table(
    ['Power-cut step', 'Slot booted'],
    cuts.steps.map((entry) => [entry.step, entry.bootedImageKey]),
  )}

Every one of the ${cuts.steps.length} supplied cut steps recovers to an
authenticated slot: \`${cuts.recoveredImages.join('`, `')}\` across the
authenticated-update scenario, and the same holds for the downgrade, wrong-product,
unsigned, corrupt, recovery-as-candidate, restore-from-recovery,
unsigned-while-in-recovery and authorization-removed scenarios recorded in the
evidence artifact. The authorization-removed counterfactual is the recovery
condition that must be demonstrated rather than assumed:

- \`${imageKey(recovery)}\` with its separate authorization → \`${bootDecision(policy, recovery)}\`
- \`${imageKey(recoveryUnauthorized)}\` with the authorization removed → \`${bootDecision(policy, recoveryUnauthorized)}\`

A valid signature alone therefore does not open the recovery path.
`);

  sections.push(`## 6. Per-device credential lifecycle

The lifecycle is executed, not asserted: \`scripts/credential-lifecycle.ts\` runs a
${transcript.length}-step transcript and the evidence artifact quotes it in full.

${table(
    ['#', 'Step', 'Outcome', 'Slot', 'Fleet', 'Authority'],
    transcript.map((entry) => [
      String(entry.order),
      entry.event,
      entry.outcome,
      `${entry.slotState}${entry.credentialId ? ` (${entry.credentialId})` : ''}`,
      entry.fleetState,
      entry.localCredentialAuthority,
    ]),
  )}

The properties the contract asks for, and the step that shows each one:

- **hardware-backed and non-exportable**: \`${step('credential-export-attempt').outcome}\` — the slot answers challenges and never returns key material.
- **explicit rotate semantics**: \`${step('credential-rotate').outcome}\`, after which the rotated-out credential \`${step('stale-credential-use').outcome}\`.
- **explicit revoke semantics**: \`${step('device-revocation').outcome}\`, leaving only stale local authority.
- **protected through update**: \`${step('authenticated-application-update').outcome}\` with the credential still provisioned.
- **protected through recovery**: \`${step('authorized-recovery-entry').outcome}\` with the separate authorization, and without it \`${step('unauthorized-recovery-entry').outcome}\`.
- **factory reset destroys local authority**: slot becomes \`${step('factory-reset').slotState}\`, authority \`${step('factory-reset').localCredentialAuthority}\`, while the immutable device identity survives so revocation still applies.
- **the partial state is not an authorization**: \`${step('post-reset-silent-reauthorization-attempt').outcome}\` — an empty slot plus a fleet record that still lists the device is not authority.
- **fleet revocation survives a reset**: \`${step('reset-after-revocation-with-fleet-authority').outcome}\` even with fleet authority presented, because only RMA authority can reprovision a refused device.
- **decommission is terminal**: \`${step('decommission').outcome}\`, after which later use \`${step('post-decommission-use-attempt').outcome}\` and later recovery \`${step('post-decommission-recovery-attempt').outcome}\`.
`);

  sections.push(`## 7. Peripherals and communications at the device endpoint

${table(
    ['Peripheral', 'Capability', 'Production policy'],
    PERIPHERALS.map((entry) => [entry.peripheral, entry.capability, escapeCell(entry.productionPolicy)]),
  )}

${table(
    ['Channel', 'Purpose', 'Device-side enforcement'],
    COMMUNICATIONS.map((entry) => [entry.channel, entry.purpose, escapeCell(entry.deviceSideEnforcement)]),
  )}

The fleet backend itself belongs to infrastructure-security / cloud-security; this
artifact owns the device endpoint and its trust boundary.
`);

  sections.push(`## 8. Resistance claims that are deliberately false

- invasive extraction: claimed \`${String(RESISTANCE_CLAIMS.invasiveExtractionClaimed)}\`
- fault injection: claimed \`${String(RESISTANCE_CLAIMS.faultInjectionClaimed)}\`

${RESISTANCE_CLAIMS.reason} What would establish them: ${RESISTANCE_CLAIMS.whatWouldEstablishThem}.
`);

  sections.push(`## 9. Safety consequences, limits and reproduction

Safety consequences are listed separately from the privacy, availability, fleet and
credential consequences rather than folded into them: ${ATTACKER_MODEL.consequences
    .filter((entry) => entry.severity === 'safety')
    .map((entry) => `**${entry.consequence}** (${entry.trigger.toLowerCase()})`)
    .join('; ')}. Both are controlled before actuating code runs — by product binding
and the authenticated boot chain, not by anything downstream of the boot gate.

${LIMITS.map((limit) => `- ${limit}`).join('\n')}

Scope boundaries: ${SCOPE_BOUNDARIES.map((entry) => `\n  - ${entry}`).join('')}

Reproduction (deterministic, no clock, no network, no randomness):

\`\`\`text
bun run build:evidence
bun run build:analysis
bun test
\`\`\`

Inputs pinned by content digest:

\`\`\`text
${[
  ['src/device-sim.ts', fileDigest(SIM_PATH)],
  ['evidence/device-corpus.json', fileDigest(CORPUS_PATH)],
  ['.kory-eval/device-config.json', fileDigest(CONFIG_PATH)],
  ['.kory-eval/device-lifecycle-evidence.json', fileDigest(EVIDENCE_PATH)],
]
  .map(([name, digest]) => `${name.padEnd(40)} ${digest}`)
  .join('\n')}
\`\`\`
`);

  return `${sections.join('\n')}`;
}

function main(): void {
  const corpus = readCorpus();
  const config = readConfig();
  writeArtifact(ANALYSIS_PATH, buildAnalysis(corpus, config));
  console.log(`wrote ${ANALYSIS_PATH}`);
}

if (import.meta.main) main();
