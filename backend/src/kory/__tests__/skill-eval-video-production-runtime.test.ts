import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  materializeVideoProductionFixture,
  renderVideoProductionControl,
  runVideoProductionRuntime,
  VIDEO_PRODUCTION_RUNTIME_SCENARIOS,
  VIDEO_PRODUCTION_SKILL_EVAL_MATERIALIZERS,
  VIDEO_PRODUCTION_SKILL_EVAL_SCORERS,
  videoProductionRuntimeReadiness,
} from '../../eval/skills/skill-eval-video-production-runtime';

const { tutorial, multicam } = VIDEO_PRODUCTION_RUNTIME_SCENARIOS;
const scenarios = [tutorial, multicam] as const;
const readiness = Object.fromEntries(
  scenarios.map((id) => [id, videoProductionRuntimeReadiness(id)]),
);

function probe(path: string): { streams: Array<Record<string, unknown>> } {
  const completed = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,codec_type,r_frame_rate,color_primaries,color_transfer,color_space',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(completed.status).toBe(0);
  return JSON.parse(completed.stdout) as { streams: Array<Record<string, unknown>> };
}

function writeDecisionAndReview(root: string, scenarioId: (typeof scenarios)[number]): void {
  const id = scenarioId;
  const report = {
    scenarioId: id,
    boundary: 'video-production',
    broader: 'human-experience',
    neighbor: id === tutorial ? 'audio-production' : 'accessibility-practice',
    audience: 'Viewers requiring clear and understandable instructions',
    outcome: 'A reproducible encoded movie with checked delivery targets',
    platform: 'Desktop and mobile web playback',
    aspectRatio: '16:9 landscape at 1920 by 1080',
    narrativeBeats: ['Establish context and introduce subject', 'Demonstrate and recap the action'],
    shotGrammar: ['Stable wide master', 'Purposeful insert at the edit boundary'],
    pacing: 'Cut after three seconds for the tutorial or six for the multicamera edit',
    visualContinuity: 'Honor source flash slates and color-match the camera angles',
    motionLanguage: 'Keep source motion with deliberate cadence conversion only',
    voiceMusicSfx: 'Balance synthesized narration or the synchronized reference with quiet music',
    captions: 'Correct the misspelling and export both timed and burned-in captions',
    brandConstraints: 'High contrast and adequate padding for all displayed text',
    ownership: 'Video editor owns picture, mixed audio delivery, and encoded QC',
    decisionSequence: [
      'Validate media and framing',
      'Edit, mix, subtitle, render, probe and repair',
    ],
    uncertainty: 'Subjective playback review is not claimed without a human reviewing it',
  };
  const verification = {
    negativePath: 'Encoded negative control shifts the decoded audio by six frames and adds drift.',
    recovery: 'Re-encode the corrected audio mix and independently probe the recovered delivery.',
    subjectivePlayback: 'unverified',
  };
  writeFileSync(join(root, '.kory-eval', 'result.json'), JSON.stringify(report));
  writeFileSync(join(root, '.kory-eval', 'verification.json'), JSON.stringify(verification));
}

describe('video-production V5 real-media harness', () => {
  test('has scenario-specific fixture and scorer registrations ready for parent integration', () => {
    expect(VIDEO_PRODUCTION_SKILL_EVAL_MATERIALIZERS).toHaveLength(2);
    expect(VIDEO_PRODUCTION_SKILL_EVAL_SCORERS).toHaveLength(2);
    for (const id of scenarios) {
      expect(
        VIDEO_PRODUCTION_SKILL_EVAL_MATERIALIZERS.some(
          (item) => item.realRuntime && item.matches({ id } as never),
        ),
      ).toBe(true);
      expect(
        VIDEO_PRODUCTION_SKILL_EVAL_SCORERS.some((item) => item.scenarioIds.includes(id)),
      ).toBe(true);
    }
  });

  test('fails closed without ffmpeg and ffprobe even when reports claim success', () => {
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = '/a/nonexistent/video-test-toolchain';
      const blocked = videoProductionRuntimeReadiness(tutorial);
      expect(blocked).toEqual(
        expect.arrayContaining([
          expect.stringContaining('ffmpeg executable/version unavailable'),
          expect.stringContaining('ffprobe executable/version unavailable'),
        ]),
      );
      const result = runVideoProductionRuntime('/nonexistent-fixture', tutorial);
      expect(result.passed).toBe(false);
      expect(result.blockers.length).toBeGreaterThanOrEqual(2);
      expect(result.checks).toHaveLength(0);
      expect(() => materializeVideoProductionFixture('/nonexistent-fixture', tutorial)).toThrow(
        'Video-production runtime unavailable',
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  for (const id of scenarios) {
    test.skipIf(readiness[id]!.length > 0)(
      `${id}: real sources, successful exports, defective sync, recovery and integrity failures`,
      () => {
        const root = mkdtempSync(join(tmpdir(), 'kory-video-production-v5-'));
        try {
          materializeVideoProductionFixture(root, id);
          const sources =
            id === tutorial
              ? ['screen.mp4', 'pickup.mp4', 'speech-1-48k.wav', 'speech-2-48k.wav']
              : ['camera-a.mp4', 'camera-b.mp4'];
          for (const name of sources)
            expect(readFileSync(join(root, 'sources', name)).length).toBeGreaterThan(500);
          const first = probe(
            join(root, 'sources', id === tutorial ? 'screen.mp4' : 'camera-a.mp4'),
          );
          const second = probe(
            join(root, 'sources', id === tutorial ? 'pickup.mp4' : 'camera-b.mp4'),
          );
          expect(first.streams.find((s) => s.codec_type === 'video')?.r_frame_rate).toBe(
            id === tutorial ? '24/1' : '25/1',
          );
          expect(second.streams.find((s) => s.codec_type === 'video')?.r_frame_rate).toBe(
            id === tutorial ? '30/1' : '30000/1001',
          );
          if (id === multicam) {
            expect(second.streams.find((s) => s.codec_type === 'video')?.color_primaries).toBe(
              'smpte170m',
            );
          } else {
            expect(readFileSync(join(root, 'evidence', 'transcript-draft.vtt'), 'utf8')).toContain(
              'privcy',
            );
            expect(readFileSync(join(root, 'evidence', 'captions.vtt'), 'utf8')).toContain(
              'privacy',
            );
          }
          mkdirSync(join(root, '.kory-eval'), { recursive: true });
          writeDecisionAndReview(root, id);
          const absentMedia = runVideoProductionRuntime(root, id);
          expect(absentMedia.passed).toBe(false);
          expect(absentMedia.checks.some((check) => check.id === 'runtime-probe-failure')).toBe(
            true,
          );

          renderVideoProductionControl(root, id, 'positive');
          renderVideoProductionControl(root, id, 'negative');
          renderVideoProductionControl(root, id, 'recovered');
          const result = runVideoProductionRuntime(root, id);
          const failed = result.checks.filter((check) => !check.passed);
          expect(failed).toEqual([]);
          expect(result.passed).toBe(true);
          expect(
            result.checks.some(
              (check) => check.id === 'actual-negative-render-rejected' && check.passed,
            ),
          ).toBe(true);
          expect(
            result.checks.some(
              (check) => check.id === 'negative-control-still-otherwise-decodable' && check.passed,
            ),
          ).toBe(true);
          expect(
            result.checks.some(
              (check) => check.id === 'positive-decoded-audio-visual-sync-web' && check.passed,
            ),
          ).toBe(true);
          expect(
            result.checks.some(
              (check) => check.id === 'recovered-encoded-caption-track-web' && check.passed,
            ),
          ).toBe(true);
          expect(
            result.checks.some(
              (check) => check.id === 'positive-encoded-loudness-and-true-peak-web' && check.passed,
            ),
          ).toBe(true);
          expect(
            result.checks.some(
              (check) => check.id === 'positive-decoded-frame-cadence-web' && check.passed,
            ),
          ).toBe(true);
          if (id === multicam) {
            expect(
              result.checks.some(
                (check) => check.id === 'positive-decoded-color-scopes-archive' && check.passed,
              ),
            ).toBe(true);
            expect(existsSync(join(root, '.kory-eval', 'recovered-archive.mov'))).toBe(true);
          }

          // A real defective export cannot be laundered into a passing final by JSON claims.
          if (id === tutorial) {
            // A playable MP4 with valid stream headers but completely silent audio
            // is not a meaningful out-of-sync negative control.
            const silentNegative = join(root, '.kory-eval', 'silent-negative-web.mp4');
            const silentEncode = spawnSync(
              'ffmpeg',
              [
                '-hide_banner',
                '-loglevel',
                'error',
                '-y',
                '-i',
                join(root, '.kory-eval', 'final-web.mp4'),
                '-f',
                'lavfi',
                '-i',
                'anullsrc=r=48000:cl=stereo',
                '-map',
                '0:v:0',
                '-map',
                '1:a:0',
                '-map',
                '0:s:0',
                '-c:v',
                'copy',
                '-c:a',
                'aac',
                '-c:s',
                'copy',
                '-t',
                '6',
                silentNegative,
              ],
              { encoding: 'utf8', timeout: 60_000 },
            );
            expect(silentEncode.status).toBe(0);
            copyFileSync(silentNegative, join(root, '.kory-eval', 'negative-web.mp4'));
            const silentControl = runVideoProductionRuntime(root, id);
            expect(silentControl.passed).toBe(false);
            expect(
              silentControl.checks.find(
                (check) => check.id === 'negative-control-still-otherwise-decodable',
              )?.passed,
            ).toBe(false);

            renderVideoProductionControl(root, id, 'negative');
            copyFileSync(
              join(root, '.kory-eval', 'negative-web.mp4'),
              join(root, '.kory-eval', 'final-web.mp4'),
            );
            const brokenFinal = runVideoProductionRuntime(root, id);
            expect(brokenFinal.passed).toBe(false);
            expect(
              brokenFinal.checks.find(
                (check) => check.id === 'positive-decoded-audio-visual-sync-web',
              )?.passed,
            ).toBe(false);
          }

          // A byte change to a supplied media source invalidates the supposedly immutable fixture.
          appendFileSync(join(root, 'sources', sources[0]!), Buffer.from('tampered'));
          const tampered = runVideoProductionRuntime(root, id);
          expect(tampered.passed).toBe(false);
          expect(tampered.checks).toEqual([
            expect.objectContaining({
              id: 'encoded-source-provenance-and-contract',
              passed: false,
            }),
          ]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      300_000,
    );
  }
});
