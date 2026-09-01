/**
 * Structured, evidence-backed work notes.
 *
 * A work note is more than an agent-authored summary: Koryphaios attaches
 * host-owned run provenance and keeps decisions, changed files, commands, test
 * evidence, risks, and follow-ups in a predictable Markdown contract. That
 * makes the note useful to humans, searchable by agents, and reviewable later.
 */

export type WorkNoteStatus = 'completed' | 'partial' | 'blocked' | 'decision';

export interface WorkNoteTestEvidence {
  name: string;
  outcome: 'pass' | 'fail' | 'not-run';
  evidence?: string;
}

export interface WorkNoteInput {
  title: string;
  summary: string;
  status: WorkNoteStatus;
  objective?: string;
  decisions?: string[];
  changedFiles?: string[];
  commands?: string[];
  tests?: WorkNoteTestEvidence[];
  evidence?: string[];
  risks?: string[];
  followUps?: string[];
  relatedNotes?: string[];
  includeInContext?: boolean;
}

export interface WorkNoteProvenance {
  sessionId: string;
  createdAt?: Date;
  provider?: string;
  model?: string;
  reasoningLevel?: string;
  agentId?: string;
  goalId?: string;
  goalItemId?: string;
}

export interface BuiltWorkNote {
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
  includeInContext: boolean;
}

const MAX_SCALAR_LENGTH = 8_000;
const MAX_LIST_ITEMS = 200;

function cleanScalar(value: unknown, maxLength = MAX_SCALAR_LENGTH): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function cleanList(values: readonly unknown[] | undefined): string[] {
  if (!values) return [];
  return values
    .slice(0, MAX_LIST_ITEMS)
    .map((value) => cleanScalar(value))
    .filter(Boolean);
}

function inlineCode(value: string): string {
  const longestFence = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(longestFence + 1);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
}

function bulletSection(
  title: string,
  values: string[],
  format = (value: string) => value,
): string[] {
  if (values.length === 0) return [];
  return [`## ${title}`, '', ...values.map((value) => `- ${format(value)}`), ''];
}

function safeRelatedTitle(value: string): string {
  return value.replace(/\[|\]/g, '').trim();
}

export function buildWorkNote(input: WorkNoteInput, provenance: WorkNoteProvenance): BuiltWorkNote {
  const createdAt = provenance.createdAt ?? new Date();
  const title = cleanScalar(input.title, 240);
  const summary = cleanScalar(input.summary);
  if (!title) throw new Error('Work note title is required');
  if (!summary) throw new Error('Work note summary is required');
  if (!provenance.sessionId.trim()) throw new Error('Work note session provenance is required');

  const decisions = cleanList(input.decisions);
  const changedFiles = cleanList(input.changedFiles);
  const commands = cleanList(input.commands);
  const evidence = cleanList(input.evidence);
  const risks = cleanList(input.risks);
  const followUps = cleanList(input.followUps);
  const relatedNotes = cleanList(input.relatedNotes).map(safeRelatedTitle).filter(Boolean);
  const tests = (input.tests ?? [])
    .slice(0, MAX_LIST_ITEMS)
    .map((test) => ({
      name: cleanScalar(test.name, 1_000),
      outcome: test.outcome,
      evidence: cleanScalar(test.evidence),
    }))
    .filter((test) => test.name);

  const provenanceRows = [
    ['Session', inlineCode(provenance.sessionId)],
    ['Recorded', inlineCode(createdAt.toISOString())],
    provenance.provider ? ['Provider', inlineCode(cleanScalar(provenance.provider, 240))] : null,
    provenance.model ? ['Model', inlineCode(cleanScalar(provenance.model, 240))] : null,
    provenance.reasoningLevel
      ? ['Reasoning', inlineCode(cleanScalar(provenance.reasoningLevel, 120))]
      : null,
    provenance.agentId ? ['Agent', inlineCode(cleanScalar(provenance.agentId, 240))] : null,
    provenance.goalId ? ['Goal', inlineCode(cleanScalar(provenance.goalId, 240))] : null,
    provenance.goalItemId
      ? ['Goal item', inlineCode(cleanScalar(provenance.goalItemId, 240))]
      : null,
  ].filter((row): row is string[] => Boolean(row));

  const lines = [
    `# ${title}`,
    '',
    `> **${input.status.toUpperCase()}** · Evidence-backed Koryphaios work note`,
    '',
    '## Outcome',
    '',
    summary,
    '',
  ];

  const objective = cleanScalar(input.objective);
  if (objective) lines.push('## Objective', '', objective, '');

  lines.push(
    '## Provenance',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...provenanceRows.map(([label, value]) => `| ${label} | ${value} |`),
    '',
    ...bulletSection('Decisions', decisions),
    ...bulletSection('Changed files', changedFiles, inlineCode),
    ...bulletSection('Commands', commands, inlineCode),
  );

  if (tests.length > 0) {
    lines.push(
      '## Verification',
      '',
      ...tests.map((test) => {
        const marker =
          test.outcome === 'pass' ? 'PASS' : test.outcome === 'fail' ? 'FAIL' : 'NOT RUN';
        return `- **${marker}** — ${test.name}${test.evidence ? ` — ${test.evidence}` : ''}`;
      }),
      '',
    );
  }

  lines.push(
    ...bulletSection('Evidence', evidence),
    ...bulletSection('Risks', risks),
    ...bulletSection('Follow-ups', followUps),
    ...bulletSection('Related notes', relatedNotes, (value) => `[[${value}]]`),
  );

  const year = String(createdAt.getUTCFullYear());
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  return {
    title,
    content: lines.join('\n').trimEnd() + '\n',
    folderPath: `/Work Notes/${year}/${month}`,
    tags: ['agent-work-note', 'evidence', `status-${input.status}`],
    includeInContext: Boolean(input.includeInContext),
  };
}
