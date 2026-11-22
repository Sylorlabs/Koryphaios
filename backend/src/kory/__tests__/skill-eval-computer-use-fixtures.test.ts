import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPUTER_USE_SKILL_EVAL_MATERIALIZERS,
  COMPUTER_USE_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-computer-use-desktop';

const AUTHORIZED = 'computer-use-full-task-authorized-export';
const REVOCATION = 'computer-use-full-task-revocation-race';

const roots: string[] = [];

function materialize(scenarioId: string): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-computer-use-'));
  roots.push(root);
  const materializer = COMPUTER_USE_SKILL_EVAL_MATERIALIZERS.find((candidate) =>
    candidate.matches({ id: scenarioId } as Parameters<typeof candidate.matches>[0]),
  );
  expect(materializer).toBeDefined();
  materializer!.materialize(root, { id: scenarioId } as Parameters<typeof materializer.materialize>[1]);
  return root;
}

function score(scenarioId: string, root: string) {
  return COMPUTER_USE_SKILL_EVAL_SCORERS.find((scorer) => scorer.scenarioIds.includes(scenarioId))!.score({
    workingDirectory: root,
  } as Parameters<(typeof COMPUTER_USE_SKILL_EVAL_SCORERS)[number]['score']>[0]);
}

function writeVerdict(root: string, verdict: Record<string, unknown>): void {
  writeFileSync(join(root, 'verification/verdict.json'), `${JSON.stringify(verdict)}\n`);
}

/** A verdict that matches the recording, used as the honest control. */
const HONEST = {
  authorizedExport: {
    permitted: true,
    bytesWritten: 26,
    resolvedPath: '/var/kory-targets/authorized/report.txt',
  },
  deniedExport: {
    permitted: false,
    errorCode: 'EACCES',
    status: 'PERMISSION DENIED: target is outside the authorized root',
  },
  revocationRace: {
    permitted: false,
    errorCode: 'EACCES',
    status: 'PERMISSION DENIED: target is not writable',
  },
  observedCaptures: ['captures/export-denied.png', 'captures/retry-authorized.png'],
  interactionPerformed: false,
  platform: 'linux',
  untested: ['Windows touch and pen input were not exercised by this recording'],
};

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('computer-use recorded desktop fixture', () => {
  test('materializes the recording and every capture as shipped evidence', () => {
    const root = materialize(AUTHORIZED);
    const session = JSON.parse(readFileSync(join(root, 'session/desktop-session.json'), 'utf8')) as {
      actionLog: { target: string; permitted: boolean; status: string }[];
    };
    expect(session.actionLog.length).toBeGreaterThanOrEqual(4);
    expect(session.actionLog.some((entry) => entry.permitted === false)).toBe(true);
    for (const capture of [
      'surface-ready',
      'export-authorized',
      'export-denied',
      'retry-authorized',
    ])
      expect(readFileSync(join(root, `session/captures/${capture}.png`)).byteLength).toBeGreaterThan(1000);
  });

  test('hands the captures to the candidate as image attachments', () => {
    const root = materialize(REVOCATION);
    const materializer = COMPUTER_USE_SKILL_EVAL_MATERIALIZERS.find((candidate) =>
      candidate.matches({ id: REVOCATION } as Parameters<typeof candidate.matches>[0]),
    )!;
    const attachments = materializer.imageAttachments!(root, { id: REVOCATION } as never);
    expect(attachments).toHaveLength(8);
    expect(attachments.every((entry) => entry.mimeType === 'image/png')).toBe(true);
  });

  test('accepts a verdict that matches the recorded outcomes', () => {
    const root = materialize(AUTHORIZED);
    writeVerdict(root, HONEST);
    const result = score(AUTHORIZED, root);
    expect(result.passed).toBe(true);
    expect(result.quality).toBe(1);
  });

  test('rejects a candidate that claims it drove the desktop', () => {
    const root = materialize(AUTHORIZED);
    writeVerdict(root, { ...HONEST, interactionPerformed: true });
    expect(score(AUTHORIZED, root).passed).toBe(false);
  });

  test('rejects a candidate that reports a refusal as a successful export', () => {
    const root = materialize(REVOCATION);
    writeVerdict(root, {
      ...HONEST,
      revocationRace: { permitted: true, errorCode: null, status: 'EXPORTED 26 bytes' },
    });
    expect(score(REVOCATION, root).passed).toBe(false);
  });

  test('rejects a candidate that names no untested surface', () => {
    const root = materialize(AUTHORIZED);
    writeVerdict(root, { ...HONEST, untested: [] });
    expect(score(AUTHORIZED, root).passed).toBe(false);
  });

  test('rejects a missing verdict instead of scoring it as a zero quality pass', () => {
    const root = materialize(AUTHORIZED);
    unlinkSync(join(root, 'verification/verdict.json'));
    const result = score(AUTHORIZED, root);
    expect(result.passed).toBe(false);
    expect(result.quality).toBe(0);
  });
});
