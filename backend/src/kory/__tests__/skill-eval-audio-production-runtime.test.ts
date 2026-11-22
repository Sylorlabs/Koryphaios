import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIO_PRODUCTION_RUNTIME_SCENARIOS,
  AUDIO_PRODUCTION_SKILL_EVAL_MATERIALIZERS,
  AUDIO_PRODUCTION_SKILL_EVAL_SCORERS,
  audioProductionRuntimeReadiness,
  materializeAudioProductionFixture,
  renderAudioProductionControl,
  runAudioProductionRuntime,
} from '../../eval/skills/skill-eval-audio-production-runtime';

const scenarios = [
  AUDIO_PRODUCTION_RUNTIME_SCENARIOS.interview,
  AUDIO_PRODUCTION_RUNTIME_SCENARIOS.narration,
] as const;

function reports(root: string, id: (typeof scenarios)[number]): void {
  writeFileSync(
    join(root, '.kory-eval', 'result.json'),
    JSON.stringify({
      scenarioId: id,
      boundary: 'audio-production',
      outcome: 'A measured AAC final and repaired delivery for the specified content',
      audience: 'Listeners on phone speakers, headphones, and mono output',
      sourceTreatment: 'Clean and level the provided real speech and media stems',
      dynamics: 'Normalize the integrated loudness while retaining natural voice dynamics',
      speechClarity: 'Preserve both voiced segments and their intelligible high-mid content',
      musicBalance: 'Keep the narration audible while ducking the test music during words',
      monitoring: 'Measure encoded stereo, mono fold-down and small-speaker audio proxies',
      delivery: 'Encode a stereo 48 kHz AAC stream with bounded loudness and true peak',
      negativeDefect: 'Construct a decodable negative that exceeds the measured mastering envelope',
      recovery: 'Correct the negative defect and verify independently decoded final media',
      uncertainty: 'The acoustic proxy cannot certify a human listener experience',
    }),
  );
  writeFileSync(
    join(root, '.kory-eval', 'verification.json'),
    JSON.stringify({
      negativeFinding: 'Final-file loudness or ducking defect confirmed by decoding and measurement.',
      recoveryEvidence: 'The corrected AAC is decoded and independently measured again.',
      subjectiveListening: 'unverified',
    }),
  );
}

describe('audio-production V5 actual encoded media evaluation', () => {
  test('registers both full-task materializers and independent encoded audio scorers', () => {
    expect(AUDIO_PRODUCTION_SKILL_EVAL_MATERIALIZERS).toHaveLength(2);
    expect(AUDIO_PRODUCTION_SKILL_EVAL_SCORERS).toHaveLength(2);
    for (const id of scenarios) {
      expect(
        AUDIO_PRODUCTION_SKILL_EVAL_MATERIALIZERS.some(
          (item) => item.realRuntime && item.matches({ id } as never),
        ),
      ).toBe(true);
      expect(
        AUDIO_PRODUCTION_SKILL_EVAL_SCORERS.some((item) => item.scenarioIds.includes(id)),
      ).toBe(true);
    }
  });

  test('fails closed if the audio toolchain and speech generator are absent', () => {
    const original = process.env.PATH;
    try {
      process.env.PATH = '/definitely/no/audio/executables';
      expect(audioProductionRuntimeReadiness(scenarios[0])).toEqual(
        expect.arrayContaining([expect.stringContaining('ffmpeg missing')]),
      );
      expect(runAudioProductionRuntime('/missing', scenarios[0]).passed).toBe(false);
      expect(() => materializeAudioProductionFixture('/missing', scenarios[0])).toThrow(
        'Audio-production runtime unavailable',
      );
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
  });

  for (const id of scenarios) {
    test.skipIf(audioProductionRuntimeReadiness(id).length > 0)(
      `${id}: real 24-bit stems, encoded positive/negative/recovered QC and integrity`,
      () => {
        const root = mkdtempSync(join(tmpdir(), 'kory-audio-v5-'));
        try {
          materializeAudioProductionFixture(root, id);
          mkdirSync(join(root, '.kory-eval'), { recursive: true });
          reports(root, id);
          const missingFiles = runAudioProductionRuntime(root, id);
          expect(missingFiles.passed).toBe(false);
          expect(missingFiles.checks.find((check) => check.id === 'real-encoded-media-probe')?.passed).toBe(false);

          renderAudioProductionControl(root, id, 'positive');
          renderAudioProductionControl(root, id, 'negative');
          renderAudioProductionControl(root, id, 'recovered');

          const passing = runAudioProductionRuntime(root, id);
          expect(passing.checks.filter((check) => !check.passed)).toEqual([]);
          expect(passing.passed).toBe(true);
          expect(passing.checks.find((check) => check.id === 'real-defective-encoded-negative-rejected')?.passed).toBe(true);
          expect(passing.checks.find((check) => check.id === 'final-decoded-mono-and-small-speaker-proxy')?.passed).toBe(true);

          copyFileSync(join(root, '.kory-eval', 'negative.m4a'), join(root, '.kory-eval', 'final.m4a'));
          const corruptedFinal = runAudioProductionRuntime(root, id);
          expect(corruptedFinal.passed).toBe(false);
          expect(corruptedFinal.checks.some((check) => !check.passed)).toBe(true);

          appendFileSync(join(root, 'sources', 'music.wav'.replace('music', id === scenarios[0] ? 'interview-a' : 'music')), Buffer.from('source changed'));
          const altered = runAudioProductionRuntime(root, id);
          expect(altered.passed).toBe(false);
          expect(altered.checks).toEqual([
            expect.objectContaining({ id: 'immutable-real-audio-source-provenance', passed: false }),
          ]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      120_000,
    );
  }

  test.skipIf(audioProductionRuntimeReadiness(scenarios[0]).length > 0)(
    'recognizes a real encoded mono-collapse negative even when encoded loudness passes',
    () => {
      const id = scenarios[0];
      const root = mkdtempSync(join(tmpdir(), 'kory-audio-mono-negative-'));
      try {
        materializeAudioProductionFixture(root, id);
        mkdirSync(join(root, '.kory-eval'), { recursive: true });
        reports(root, id);
        renderAudioProductionControl(root, id, 'positive');
        renderAudioProductionControl(root, id, 'recovered');

        const render = spawnSync('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', join(root, '.kory-eval', 'final.m4a'),
          '-af', 'pan=stereo|c0=c0|c1=-1*c0',
          '-c:a', 'aac', '-ar', '48000', '-b:a', '192k',
          join(root, '.kory-eval', 'negative.m4a'),
        ], { encoding: 'utf8' });
        expect(render.status, render.stderr).toBe(0);

        const measured = runAudioProductionRuntime(root, id);
        expect(measured.passed).toBe(true);
        const negative = measured.checks.find((check) => check.id === 'real-defective-encoded-negative-rejected');
        expect(negative?.passed).toBe(true);
        expect(negative?.detail).toContain('decoded-mono-and-small-speaker-proxy');
        expect(negative?.detail).not.toContain('post-encode-loudness');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
