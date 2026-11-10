import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import { availableHostSpeechEngine } from './skill-eval-speech-engine';

const TUTORIAL = 'video-production-full-task-1-individual';
const MULTICAM = 'video-production-full-task-2-individual';
type ScenarioId = typeof TUTORIAL | typeof MULTICAM;
type Variant = 'positive' | 'negative' | 'recovered';
type Delivery = 'web' | 'archive';

interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
  speech: 'say' | 'espeak-ng' | null;
  captions: 'drawtext' | 'pango';
}

interface VideoSpec {
  scenarioId: ScenarioId;
  duration: number;
  markers: number[];
  subtitleLines: string[];
  deliveries: Record<
    string,
    { width: number; height: number; fps: number; video: string; audio: string }
  >;
}

export interface VideoProductionCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface VideoProductionRuntimeResult {
  passed: boolean;
  checks: VideoProductionCheck[];
  evidence: string[];
  blockers: string[];
}

const SPECS: Record<ScenarioId, VideoSpec> = {
  [TUTORIAL]: {
    scenarioId: TUTORIAL,
    duration: 6,
    markers: [1, 3.5, 5],
    subtitleLines: ['Open settings', 'Select privacy'],
    deliveries: { web: { width: 1920, height: 1080, fps: 30, video: 'h264', audio: 'aac' } },
  },
  [MULTICAM]: {
    scenarioId: MULTICAM,
    duration: 12,
    markers: [1, 5, 10],
    subtitleLines: ['Camera A', 'Camera B'],
    deliveries: {
      web: { width: 1920, height: 1080, fps: 30, video: 'h264', audio: 'aac' },
      archive: { width: 1920, height: 1080, fps: 25, video: 'h264', audio: 'pcm_s16le' },
    },
  },
};

const VTT: Record<ScenarioId, string> = {
  [TUTORIAL]:
    'WEBVTT\n\n00:00:00.500 --> 00:00:02.750\nOpen settings\n\n' +
    '00:00:03.250 --> 00:00:05.750\nSelect privacy\n',
  [MULTICAM]:
    'WEBVTT\n\n00:00:00.500 --> 00:00:05.750\nCamera A\n\n' +
    '00:00:06.250 --> 00:00:11.750\nCamera B\n',
};

const MAX_MEDIA_BYTES = 160_000_000;
const MAX_OUTPUT_BYTES = 3_000_000;

function invoke(
  executable: string,
  args: string[],
  options: { cwd?: string; binary?: boolean; timeout?: number } = {},
): { stdout: string | Buffer; stderr: string; status: number | null; error?: string } {
  const output = spawnSync(executable, args, {
    cwd: options.cwd,
    // Bun otherwise retains the PATH from process startup for child lookup.
    env: { ...process.env },
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.binary ? 12_000_000 : MAX_OUTPUT_BYTES,
    encoding: options.binary ? 'buffer' : 'utf8',
    windowsHide: true,
    shell: false,
  });
  return {
    stdout: output.stdout ?? (options.binary ? Buffer.alloc(0) : ''),
    stderr: String(output.stderr ?? ''),
    status: output.status,
    error: output.error?.message,
  };
}

function requireRun(
  executable: string,
  args: string[],
  cwd?: string,
  binary = false,
): string | Buffer {
  const execution = invoke(executable, args, { cwd, binary });
  if (execution.status !== 0) {
    throw new Error(
      executable +
        ' failed (status ' +
        execution.status +
        '): ' +
        (execution.error ?? execution.stderr).slice(-700),
    );
  }
  return execution.stdout;
}

function toolchain(): { tools: MediaTools | null; blockers: string[] } {
  const blockers: string[] = [];
  const tools: MediaTools = {
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    speech: null,
    captions: 'drawtext',
  };
  for (const name of [tools.ffmpeg, tools.ffprobe]) {
    const result = invoke(name, ['-version'], { timeout: 8_000 });
    if (result.status !== 0 || !String(result.stdout).includes('version')) {
      blockers.push(
        name + ' executable/version unavailable: ' + (result.error ?? result.stderr).slice(0, 160),
      );
    }
  }
  if (blockers.length) return { tools: null, blockers };

  const filters = String(requireRun(tools.ffmpeg, ['-hide_banner', '-filters']));
  const encoders = String(requireRun(tools.ffmpeg, ['-hide_banner', '-encoders']));
  for (const filter of [
    'drawbox',
    'overlay',
    'colorspace',
    'ebur128',
    'signalstats',
    'loudnorm',
    'limiter',
  ]) {
    if (!new RegExp('\\b' + filter + '\\b').test(filters))
      blockers.push('ffmpeg missing ' + filter + ' filter');
  }
  if (!/\bdrawtext\b/.test(filters)) {
    const pango = invoke('pango-view', ['--version'], { timeout: 8_000 });
    if (pango.status === 0) tools.captions = 'pango';
    else blockers.push('ffmpeg missing drawtext filter and pango-view rasterizer unavailable');
  }
  if (!/\blibx264\b/.test(encoders)) blockers.push('ffmpeg missing libx264 encoder');
  if (!/\bmov_text\b/.test(encoders)) blockers.push('ffmpeg missing mov_text subtitle encoder');
  tools.speech = availableHostSpeechEngine();
  return { tools: blockers.length ? null : tools, blockers };
}

export function videoProductionRuntimeReadiness(scenarioId: ScenarioId): string[] {
  const found = toolchain();
  const blockers = [...found.blockers];
  if (scenarioId === TUTORIAL && found.tools && !found.tools.speech)
    blockers.push('Real narrated speech requires say or espeak-ng (no transcript-only fallback)');
  return blockers;
}

function mediaTools(scenarioId: ScenarioId): MediaTools {
  const { tools, blockers } = toolchain();
  const speechBlocker =
    scenarioId === TUTORIAL && !tools?.speech
      ? ['Missing real speech synthesis (say or espeak-ng)']
      : [];
  const unavailable = [...blockers, ...speechBlocker];
  if (!tools || unavailable.length)
    throw new Error('Video-production runtime unavailable: ' + unavailable.join('; '));
  return tools;
}

function videoPath(root: string, relative: string): string {
  return join(root, relative);
}

function ensureRegular(root: string, relative: string, maxBytes = MAX_MEDIA_BYTES): string {
  const segments = relative.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) throw new Error('Unsafe media path');
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index < segments.length - 1 && !stat.isDirectory())) {
      throw new Error('Media path uses a symlink or non-directory parent: ' + relative);
    }
    if (
      index === segments.length - 1 &&
      (!stat.isFile() || stat.size === 0 || stat.size > maxBytes)
    ) {
      throw new Error('Media file missing, empty, or exceeds budget: ' + relative);
    }
  }
  return current;
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function markerBox(markers: readonly number[]): string {
  const windows = markers
    .map((time) => 'between(t\\,' + time + '\\,' + (time + 0.15) + ')')
    .join('+');
  return (
    'drawbox=x=0:y=0:w=128:h=128:color=black:t=fill,' +
    "drawbox=x=0:y=0:w=128:h=128:color=white:t=fill:enable='" +
    windows +
    "'"
  );
}

function generateVideo(
  tools: MediaTools,
  root: string,
  name: string,
  fps: string,
  frames: number,
  markers: number[],
  color: string,
): void {
  const duration = frames / (fps === '30000/1001' ? 30000 / 1001 : Number(fps));
  requireRun(
    tools.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=960x540:rate=' + fps + ':duration=' + duration,
      '-vf',
      markerBox(markers),
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '27',
      '-pix_fmt',
      'yuv420p',
      '-x264-params',
      'colorprim=' + color + ':transfer=' + color + ':colormatrix=' + color,
      '-color_primaries',
      color,
      '-color_trc',
      color,
      '-colorspace',
      color,
      '-color_range',
      'tv',
      videoPath(root, 'sources/' + name + '.mp4'),
    ],
    root,
  );
}

function generateAudio(tools: MediaTools, root: string, scenarioId: ScenarioId): void {
  const spec = SPECS[scenarioId];
  const shift = scenarioId === MULTICAM ? 0.24 : 0;
  const markerExpression =
    'aevalsrc=0.28*sin(2*PI*1700*t)*(' +
    spec.markers
      .map((marker) => 'between(t\\,' + (marker + shift) + '\\,' + (marker + shift + 0.12) + ')')
      .join('+') +
    '):s=48000:d=' +
    (spec.duration + shift + 0.1);
  requireRun(
    tools.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      markerExpression,
      '-c:a',
      'pcm_s16le',
      videoPath(root, 'sources/markers.wav'),
    ],
    root,
  );
  requireRun(
    tools.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=190:sample_rate=48000:duration=' + spec.duration,
      '-af',
      'volume=0.015',
      '-c:a',
      'pcm_s16le',
      videoPath(root, 'sources/music.wav'),
    ],
    root,
  );
  if (scenarioId !== TUTORIAL) return;
  const speech = tools.speech;
  if (!speech) throw new Error('Speech synthesizer missing');
  for (const [index, phrase] of ['Open settings', 'Select privacy'].entries()) {
    const basename = 'sources/speech-' + (index + 1);
    const original = videoPath(root, basename + (speech === 'say' ? '.aiff' : '.wav'));
    if (speech === 'say') requireRun('say', ['-r', '165', '-o', original, phrase], root);
    else requireRun('espeak-ng', ['-s', '165', '-w', original, phrase], root);
    requireRun(
      tools.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        original,
        '-ar',
        '48000',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        videoPath(root, basename + '-48k.wav'),
      ],
      root,
    );
  }
}

function sourceNames(id: ScenarioId): string[] {
  return id === TUTORIAL
    ? [
        'sources/screen.mp4',
        'sources/pickup.mp4',
        'sources/speech-1-48k.wav',
        'sources/speech-2-48k.wav',
        'sources/markers.wav',
        'sources/music.wav',
      ]
    : ['sources/camera-a.mp4', 'sources/camera-b.mp4', 'sources/markers.wav', 'sources/music.wav'];
}

function fixtureReadme(id: ScenarioId): string {
  const second = id === MULTICAM;
  return [
    '# Real-media V5 video-production evaluation',
    '',
    'Source files in sources/ are encoded audiovisual media (not metadata stubs).',
    'The footage is evaluator-generated representative screen/camera imagery, and the speech in scenario 1 is real synthesized audio; do not claim a human field recording.',
    'Inspect evidence/contract.json, evidence/transcript-draft.vtt, and sources/.',
    'Produce .kory-eval/final-web.mp4, .kory-eval/negative-web.mp4, .kory-eval/recovered-web.mp4.',
    second ? 'Also produce .kory-eval/final-archive.mov, .kory-eval/recovered-archive.mov.' : '',
    'Render from the supplied actual media sources. Preserve animated motion and the bright flash/audio slate markers.',
    second
      ? 'Source A is 25 fps BT.709; source B is 30000/1001 fps SMPTE 170M. Cut at 6 s and normalize the final color to BT.709.'
      : 'Cut the screen source at 3 s, then use the pickup source for 3 s. Show safe, legible captions and correct the draft transcript.',
    second
      ? 'The external audio reference starts 0.24 s late (six 25-fps frames); trim the reference head and check long-take drift.'
      : 'Mix actual speech and the music bed; keep the slate markers aligned with source video and captions.',
    'Embed timed subtitles in each final export AND render visible legible text inside the title-safe region.',
    'Probe the final encoded files (frames, seek points, streams, cadence, sync, captions, loudness, color metadata/scopes).',
    'Create a genuine defective encoded export in negative-web.mp4, then repair and recheck recovered outputs.',
    'Write .kory-eval/result.json before rendering, then revise it with actual decisions and measurements.',
    'The result.json schema requires scenarioId (from contract.json), boundary="video-production", broader="human-experience", neighbor=' +
      (second ? '"accessibility-practice"' : '"audio-production"') +
      ', and these descriptive fields: audience, outcome, platform, aspectRatio, narrativeBeats, shotGrammar, pacing, visualContinuity, motionLanguage, voiceMusicSfx, captions, brandConstraints, ownership, decisionSequence, uncertainty.',
    'Every descriptive field must contain meaningful project-specific text or a sequence of at least two decisions. Do not substitute an arbitrary purpose key for outcome or omit hierarchy/ownership.',
    'Write .kory-eval/verification.json with descriptive negativePath and recovery entries, plus subjectivePlayback="unverified" unless human playback was actually performed (otherwise "human-reviewed"). Record unavailable playback honestly.',
    'Do not assert transcript text or an editor preview as proof of the final encoded video/audio.',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function materializeVideoProductionFixture(root: string, scenarioId: ScenarioId): void {
  const tools = mediaTools(scenarioId);
  mkdirSync(videoPath(root, 'sources'), { recursive: true });
  writeFixtureFile(root, 'package.json', packageJson('kory-eval-video-production'));
  writeFixtureFile(root, 'README.md', fixtureReadme(scenarioId));
  writeFixtureFile(root, 'tests/.gitkeep', '');
  writeFixtureFile(
    root,
    'evidence/contract.json',
    JSON.stringify(SPECS[scenarioId], null, 2) + '\n',
  );
  writeFixtureFile(root, 'evidence/captions.vtt', VTT[scenarioId]);
  writeFixtureFile(
    root,
    'evidence/transcript-draft.vtt',
    scenarioId === TUTORIAL
      ? VTT[scenarioId].replace('Select privacy', 'Select privcy')
      : VTT[scenarioId],
  );
  if (scenarioId === TUTORIAL) {
    generateVideo(tools, root, 'screen', '24', 144, [1], 'bt709');
    generateVideo(tools, root, 'pickup', '30', 180, [0.5, 2], 'bt709');
  } else {
    generateVideo(tools, root, 'camera-a', '25', 300, [1, 5], 'bt709');
    generateVideo(tools, root, 'camera-b', '30000/1001', 360, [4], 'smpte170m');
  }
  generateAudio(tools, root, scenarioId);
  const hashes = Object.fromEntries(
    sourceNames(scenarioId).map((name) => [name, digest(ensureRegular(root, name))]),
  );
  writeFixtureFile(root, 'evidence/source-sha256.json', JSON.stringify(hashes, null, 2) + '\n');
}

function captionTimings(id: ScenarioId): Array<{ line: string; start: number; end: number }> {
  const starts = id === TUTORIAL ? [0.5, 3.25] : [0.5, 6.25];
  const ends = id === TUTORIAL ? [2.75, 5.75] : [5.75, 11.75];
  return SPECS[id].subtitleLines.map((line, index) => ({
    line,
    start: starts[index]!,
    end: ends[index]!,
  }));
}

function subtitleFilter(id: ScenarioId): string {
  return captionTimings(id)
    .map(
      ({ line, start, end }) =>
        "drawtext=text='" +
        line +
        "':fontcolor=white:fontsize=66:box=1:boxcolor=black@0.90:boxborderw=16:" +
        "x=(w-text_w)/2:y=h-180:enable='between(t\\," +
        start +
        '\\,' +
        end +
        ")'",
    )
    .join(',');
}

/** FFmpeg's Homebrew build can lack drawtext. Render real transparent text with Pango. */
function captionImages(tools: MediaTools, root: string, id: ScenarioId): string[] {
  if (tools.captions === 'drawtext') return [];
  return captionTimings(id).map(({ line }, index) => {
    const relative = '.kory-eval/caption-' + index + '.png';
    const output = videoPath(root, relative);
    requireRun(
      'pango-view',
      [
        '-q',
        '-t',
        line,
        '--font=Sans Bold 66',
        '--background=transparent',
        '--foreground=#ffffff',
        '-o',
        output,
      ],
      root,
    );
    ensureRegular(root, relative, 1_000_000);
    return output;
  });
}

function captionVideoGraph(tools: MediaTools, id: ScenarioId, imageStart: number): string {
  const colorLimit = id === MULTICAM ? ',limiter=min=32:max=216:planes=1' : '';
  if (tools.captions === 'drawtext') {
    return '[base]' + subtitleFilter(id) + colorLimit + '[vout]';
  }

  // A real, alpha-composited PNG from Pango is gated by the cue time and placed
  // inside a dark title-safe panel. The panel is transparent outside cue times.
  const timing = captionTimings(id);
  const panel = timing
    .map(
      ({ start, end }) =>
        "drawbox=x=525:y=755:w=870:h=200:color=black@0.90:t=fill:enable='between(t\\," +
        start +
        '\\,' +
        end +
        ")'",
    )
    .join(',');
  let graph = '[base]' + panel + '[caption-panel];';
  for (let index = 0; index < timing.length; index++) {
    const { start, end } = timing[index]!;
    const previous = index === 0 ? 'caption-panel' : 'caption-' + (index - 1);
    const next = 'caption-' + index;
    graph +=
      '[' +
      previous +
      '][' +
      (imageStart + index) +
      ":v]overlay=x=(main_w-overlay_w)/2:y=775:format=auto:enable='between(t\\," +
      start +
      '\\,' +
      end +
      ")'[" +
      next +
      '];';
  }
  return graph + '[caption-' + (timing.length - 1) + ']format=yuv420p' + colorLimit + '[vout]';
}

function exportedPath(id: ScenarioId, root: string, variant: Variant, delivery: Delivery): string {
  if (variant === 'negative') return videoPath(root, '.kory-eval/negative-web.mp4');
  const name = variant === 'positive' ? 'final' : 'recovered';
  return videoPath(
    root,
    '.kory-eval/' + name + '-' + delivery + (delivery === 'web' ? '.mp4' : '.mov'),
  );
}

function renderExport(
  tools: MediaTools,
  id: ScenarioId,
  root: string,
  variant: Variant,
  delivery: Delivery,
): void {
  const fps = SPECS[id].deliveries[delivery]?.fps;
  if (!fps) throw new Error('Unknown delivery target');
  const output = exportedPath(id, root, variant, delivery);
  const videoInputs =
    id === TUTORIAL
      ? ['sources/screen.mp4', 'sources/pickup.mp4']
      : ['sources/camera-a.mp4', 'sources/camera-b.mp4'];
  const audioInputs =
    id === TUTORIAL
      ? [
          'sources/speech-1-48k.wav',
          'sources/speech-2-48k.wav',
          'sources/markers.wav',
          'sources/music.wav',
        ]
      : ['sources/markers.wav', 'sources/music.wav'];
  const inputs = [...videoInputs, ...audioInputs, 'evidence/captions.vtt'];
  for (const source of inputs) ensureRegular(root, source, 60_000_000);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const file of inputs) args.push('-i', videoPath(root, file));
  const images = captionImages(tools, root, id);
  for (const file of images) args.push('-loop', '1', '-framerate', String(fps), '-i', file);
  const video =
    id === TUTORIAL
      ? '[0:v]trim=duration=3,setpts=PTS-STARTPTS,fps=' +
        fps +
        ',scale=1920:1080[a];[1:v]trim=duration=3,setpts=PTS-STARTPTS,fps=' +
        fps +
        ',scale=1920:1080[b];[a][b]concat=n=2:v=1:a=0[base];'
      : '[0:v]trim=duration=6,setpts=PTS-STARTPTS,fps=' +
        fps +
        ',scale=1920:1080[a];[1:v]trim=duration=6,setpts=PTS-STARTPTS,' +
        'colorspace=all=bt709:iall=smpte170m,fps=' +
        fps +
        ',scale=1920:1080[b];[a][b]concat=n=2:v=1:a=0[base];';
  // Keep the actual encoded multicamera picture in the legal BT.709 luma
  // range, with headroom for quantization at the high-contrast edit markers.
  const visual = video + captionVideoGraph(tools, id, inputs.length);
  const audio =
    id === TUTORIAL
      ? '[2:a]atrim=duration=2.4,asetpts=PTS-STARTPTS,adelay=450|450[v1];' +
        '[3:a]atrim=duration=2.4,asetpts=PTS-STARTPTS,adelay=3250|3250[v2];' +
        '[v1][v2][4:a][5:a]amix=inputs=4:duration=longest:normalize=0,' +
        'loudnorm=I=-18:TP=-2:LRA=7,aresample=48000,' +
        'aformat=channel_layouts=stereo[aout]'
      : '[2:a]atrim=start=0.24:duration=12,asetpts=PTS-STARTPTS[reference];' +
        '[reference][3:a]amix=inputs=2:duration=longest:normalize=0,' +
        'loudnorm=I=-18:TP=-2:LRA=7,volume=-7.3dB,aresample=48000,' +
        'aformat=channel_layouts=stereo[aout]';
  const subtitleIndex = inputs.length - 1;
  args.push(
    '-filter_complex',
    visual + ';' + audio,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-map',
    String(subtitleIndex) + ':s:0',
    '-t',
    String(SPECS[id].duration),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    delivery === 'archive' ? '18' : '25',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-x264-params',
    'colorprim=bt709:transfer=bt709:colormatrix=bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-color_range',
    'tv',
    '-c:a',
    delivery === 'archive' ? 'pcm_s16le' : 'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:s',
    'mov_text',
  );
  if (delivery === 'web') args.push('-movflags', '+faststart');
  args.push(output);
  requireRun(tools.ffmpeg, args, root);
}

/**
 * Test oracle: renders an actual positive export, a deliberately unsynced negative
 * encode, and a corrected recovery from the immutable sources. It is not a
 * replacement for the evaluation agent's own edits.
 */
export function renderVideoProductionControl(root: string, id: ScenarioId, variant: Variant): void {
  const tools = mediaTools(id);
  mkdirSync(videoPath(root, '.kory-eval'), { recursive: true });
  if (variant !== 'negative') {
    renderExport(tools, id, root, variant, 'web');
    if (id === MULTICAM) renderExport(tools, id, root, variant, 'archive');
    return;
  }
  const input = ensureRegular(root, '.kory-eval/final-web.mp4');
  const output = exportedPath(id, root, 'negative', 'web');
  // A six-frame initial offset with additional drift is a real audio encode defect.
  requireRun(
    tools.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      input,
      '-filter_complex',
      '[0:a]adelay=240|240,atempo=0.98[a]',
      '-map',
      '0:v:0',
      '-map',
      '[a]',
      '-map',
      '0:s:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-c:s',
      'copy',
      '-t',
      String(SPECS[id].duration),
      output,
    ],
    root,
  );
}

function probe(tools: MediaTools, path: string): Record<string, unknown> {
  return JSON.parse(
    String(
      requireRun(tools.ffprobe, [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,sample_rate,channels,color_primaries,color_transfer,color_space,color_range,start_time',
        '-of',
        'json',
        path,
      ]),
    ),
  ) as Record<string, unknown>;
}

function records(input: unknown): Array<Record<string, unknown>> {
  return Array.isArray(input)
    ? input.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
      )
    : [];
}

function stream(meta: Record<string, unknown>, kind: string): Record<string, unknown> | undefined {
  return records(meta.streams).find((entry) => entry.codec_type === kind);
}

function close(actual: number, target: number, tolerance: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - target) <= tolerance;
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function frameCadence(
  tools: MediaTools,
  path: string,
  fps: number,
  duration: number,
): {
  valid: boolean;
  detail: string;
} {
  const raw = String(
    requireRun(tools.ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_frames',
      '-show_entries',
      'frame=best_effort_timestamp_time',
      '-of',
      'csv=p=0',
      path,
    ]),
  );
  const pts = raw
    .trim()
    .split(/\r?\n/)
    .map((line) => Number(line.split(',')[0]))
    .filter(Number.isFinite);
  const deltas = pts.slice(1).map((time, index) => time - pts[index]!);
  const inconsistent = deltas.filter((delta) => !close(delta, 1 / fps, 0.003));
  // Some FFmpeg versions emit one quantized boundary timestamp at the end of
  // an otherwise constant-rate export. Keep the cadence check strict for
  // actual gaps while accepting that single container-boundary artifact.
  const consistent = inconsistent.length <= 1;
  const expected = Math.round(duration * fps);
  // Actual decoded-frame content detects extensive duplicated stills that PTS alone hides.
  const hashes = String(
    requireRun(tools.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-map',
      '0:v:0',
      '-an',
      '-f',
      'framemd5',
      '-',
    ]),
  )
    .split(/\r?\n/)
    .filter((line) => /^\d+,\s*/.test(line))
    .map((line) => line.trim().split(',').at(-1)?.trim());
  const duplicates = hashes.slice(1).filter((hash, index) => hash === hashes[index]).length;
  const duplicateRatio = hashes.length > 1 ? duplicates / (hashes.length - 1) : 1;
  const valid =
    Math.abs(pts.length - hashes.length) <= 1 &&
    Math.abs(pts.length - expected) <= 2 &&
    consistent &&
    duplicateRatio < 0.33;
  return {
    valid,
    detail:
      'decoded=' +
      pts.length +
      ' expected=' +
      expected +
      ' timestamps=' +
      (consistent ? 'consistent' : 'gaps') +
      ' duplicate-ratio=' +
      duplicateRatio.toFixed(3),
  };
}

function pixel(tools: MediaTools, path: string, seconds: number, x: number, y: number): number {
  const result = requireRun(
    tools.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      seconds.toFixed(3),
      '-i',
      path,
      '-vf',
      'crop=1:1:' + x + ':' + y + ',format=gray',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-',
    ],
    undefined,
    true,
  );
  if (!Buffer.isBuffer(result) || result.length !== 1) throw new Error('Cannot decode seek frame');
  return result[0]!;
}

function frameChecks(tools: MediaTools, id: ScenarioId, path: string): VideoProductionCheck[] {
  const result: VideoProductionCheck[] = [];
  const spec = SPECS[id];
  const checkpoints = [0.2, spec.duration / 2 + 0.2, spec.duration - 0.3];
  const frames = checkpoints.map((time) => pixel(tools, path, time, 480, 240));
  result.push({
    id: 'opening-cut-seek-ending',
    passed: frames.every(Number.isFinite) && new Set(frames).size > 1,
    detail: 'decoded opening/mid/ending luma=' + frames.join(','),
  });
  const flashes = spec.markers.map((time) => ({
    time,
    before: pixel(tools, path, Math.max(0, time - 0.16), 48, 48),
    during: pixel(tools, path, time + 0.05, 48, 48),
  }));
  result.push({
    id: 'visual-markers',
    passed: flashes.every((row) => row.before < 90 && row.during > 185),
    detail: JSON.stringify(flashes),
  });
  if (id === TUTORIAL) {
    // Dark title-safe caption panels should visibly occupy the intended band;
    // this is a pixel check, not an invented human readability judgment.
    const captions = [1.5, 4.5].map((time) => pixel(tools, path, time, 960, 900));
    const lowerMargins = [1.5, 4.5].map((time) => pixel(tools, path, time, 960, 1050));
    result.push({
      id: 'caption-safe-area',
      passed:
        captions.every((x) => x < 45) &&
        lowerMargins.every((x, index) => x > captions[index]! + 25),
      detail: 'caption luma=' + captions.join(',') + ' bottom margins=' + lowerMargins.join(','),
    });
  }
  return result;
}

function audioPulseChecks(tools: MediaTools, id: ScenarioId, path: string): VideoProductionCheck {
  const output = requireRun(
    tools.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-vn',
      '-ac',
      '1',
      '-ar',
      '8000',
      '-f',
      'f32le',
      '-',
    ],
    undefined,
    true,
  );
  if (!Buffer.isBuffer(output)) throw new Error('Expected decoded PCM');
  const sampleCount = Math.floor(output.byteLength / 4);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index++) samples[index] = output.readFloatLE(index * 4);
  const energy = (time: number): number => {
    const start = Math.floor(time * 8000);
    const length = 320;
    if (start < 0 || start + length > samples.length) return 0;
    let sine = 0;
    let cosine = 0;
    for (let index = 0; index < length; index++) {
      const angle = (2 * Math.PI * 1700 * index) / 8000;
      sine += samples[start + index]! * Math.sin(angle);
      cosine += samples[start + index]! * Math.cos(angle);
    }
    return (2 * Math.hypot(sine, cosine)) / length;
  };
  const offsets = SPECS[id].markers.map((marker) => {
    const candidate = Array.from({ length: 26 }, (_, n) => marker - 0.24 + n * 0.02);
    const peaks = candidate.map((time) => ({ time, amplitude: energy(time) }));
    peaks.sort((a, b) => b.amplitude - a.amplitude);
    return {
      target: marker,
      observed: Number(peaks[0]!.time.toFixed(3)),
      amplitude: Number(peaks[0]!.amplitude.toFixed(4)),
    };
  });
  return {
    id: 'decoded-audio-visual-sync',
    passed: offsets.every(
      (row) => Math.abs(row.observed - row.target) < 0.09 && row.amplitude > 0.01,
    ),
    detail: JSON.stringify(offsets),
  };
}

function loudness(tools: MediaTools, path: string): VideoProductionCheck {
  const result = invoke(tools.ffmpeg, [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ]);
  if (result.status !== 0) throw new Error(result.error ?? result.stderr.slice(-500));
  const lines = result.stderr;
  const integrated = [...lines.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)].at(-1);
  const peak = [...lines.matchAll(/\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g)].at(-1);
  const lufs = Number(integrated?.[1]);
  const dbtp = Number(peak?.[1]);
  return {
    id: 'encoded-loudness-and-true-peak',
    passed: Boolean(integrated && peak) && close(lufs, -18, 3) && dbtp <= -1 && dbtp > -70,
    detail: 'EBU R128 integrated=' + lufs + ' LUFS true-peak=' + dbtp + ' dBTP',
  };
}

function captionChecks(tools: MediaTools, id: ScenarioId, path: string): VideoProductionCheck {
  const result = invoke(tools.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    path,
    '-map',
    '0:s:0',
    '-f',
    'webvtt',
    '-',
  ]);
  if (result.status !== 0)
    return { id: 'encoded-caption-track', passed: false, detail: result.stderr.slice(-260) };
  const text = String(result.stdout);
  const linesCorrect = SPECS[id].subtitleLines.every((line) => text.includes(line));
  const badDraft = id === TUTORIAL && /privcy/i.test(text);
  const intervals = [
    ...text.matchAll(
      /(?:(\d\d):)?(\d\d):(\d\d)\.(\d\d\d)\s*-->\s*(?:(\d\d):)?(\d\d):(\d\d)\.(\d\d\d)/g,
    ),
  ];
  const start = intervals.map(
    (match) =>
      Number(match[1] ?? 0) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]) +
      Number(match[4]) / 1000,
  );
  const expected = id === TUTORIAL ? [0.5, 3.25] : [0.5, 6.25];
  const timed =
    start.length === expected.length &&
    start.every((time, index) => close(time, expected[index]!, 0.12));
  return {
    id: 'encoded-caption-track',
    passed: linesCorrect && !badDraft && timed,
    detail:
      'decoded cues=' + JSON.stringify(start) + ' corrected=' + linesCorrect + ' timing=' + timed,
  };
}

function colorScope(tools: MediaTools, path: string): VideoProductionCheck {
  const samples = [2, 8].map((second) => {
    const result = requireRun(tools.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(second),
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      'signalstats,metadata=print:file=-',
      '-f',
      'null',
      '-',
    ]);
    const output = String(result);
    const ymin = Number(output.match(/lavfi\.signalstats\.YMIN=(\d+)/)?.[1]);
    const ymax = Number(output.match(/lavfi\.signalstats\.YMAX=(\d+)/)?.[1]);
    return { second, ymin, ymax };
  });
  return {
    id: 'decoded-color-scopes',
    passed: samples.every((s) => s.ymin >= 14 && s.ymin <= 95 && s.ymax >= 160 && s.ymax <= 239),
    detail: JSON.stringify(samples),
  };
}

function probeDelivery(
  tools: MediaTools,
  id: ScenarioId,
  path: string,
  delivery: Delivery,
): VideoProductionCheck[] {
  const target = SPECS[id].deliveries[delivery];
  if (!target) throw new Error('Unsupported target delivery ' + delivery);
  const info = probe(tools, path);
  const video = stream(info, 'video');
  const audio = stream(info, 'audio');
  const subtitles = stream(info, 'subtitle');
  const format = info.format as Record<string, unknown> | undefined;
  const rate = String(video?.r_frame_rate ?? '').split('/');
  const fps = Number(rate[0]) / Number(rate[1] ?? 1);
  const duration = number(format?.duration);
  const meta = {
    video: video?.codec_name,
    width: video?.width,
    height: video?.height,
    fps,
    audio: audio?.codec_name,
    channels: audio?.channels,
    sampleRate: audio?.sample_rate,
    subtitle: subtitles?.codec_name,
    duration,
  };
  const checks: VideoProductionCheck[] = [
    {
      id: 'encoded-container-streams-' + delivery,
      passed:
        meta.video === target.video &&
        Number(meta.width) === target.width &&
        Number(meta.height) === target.height &&
        close(meta.fps, target.fps, 0.04) &&
        meta.audio === target.audio &&
        Number(meta.channels) === 2 &&
        Number(meta.sampleRate) === 48000 &&
        subtitles?.codec_name === 'mov_text' &&
        close(duration, SPECS[id].duration, 0.18),
      detail: JSON.stringify(meta),
    },
    {
      id: 'final-color-metadata-' + delivery,
      passed:
        video?.color_primaries === 'bt709' &&
        video?.color_transfer === 'bt709' &&
        video?.color_space === 'bt709' &&
        ['tv', 'unknown', undefined].includes(video?.color_range as string | undefined),
      detail:
        'primaries=' +
        video?.color_primaries +
        ' transfer=' +
        video?.color_transfer +
        ' matrix=' +
        video?.color_space +
        ' range=' +
        video?.color_range,
    },
  ];
  const cadence = frameCadence(tools, path, target.fps, SPECS[id].duration);
  checks.push({
    id: 'decoded-frame-cadence-' + delivery,
    passed: cadence.valid,
    detail: cadence.detail,
  });
  checks.push(
    ...frameChecks(tools, id, path).map((check) => ({ ...check, id: check.id + '-' + delivery })),
  );
  checks.push({
    ...audioPulseChecks(tools, id, path),
    id: 'decoded-audio-visual-sync-' + delivery,
  });
  checks.push({ ...loudness(tools, path), id: 'encoded-loudness-and-true-peak-' + delivery });
  checks.push({ ...captionChecks(tools, id, path), id: 'encoded-caption-track-' + delivery });
  if (id === MULTICAM)
    checks.push({ ...colorScope(tools, path), id: 'decoded-color-scopes-' + delivery });
  return checks;
}

function validateSourceManifest(root: string, id: ScenarioId): boolean {
  const saved = readJsonArtifact<Record<string, string>>(root, 'evidence/source-sha256.json');
  const spec = readJsonArtifact<VideoSpec>(root, 'evidence/contract.json');
  if (!saved || !spec || JSON.stringify(spec) !== JSON.stringify(SPECS[id])) return false;
  if (Object.keys(saved).length !== sourceNames(id).length) return false;
  if (readFileSync(ensureRegular(root, 'evidence/captions.vtt', 30_000), 'utf8') !== VTT[id])
    return false;
  for (const source of sourceNames(id)) {
    if (saved[source] !== digest(ensureRegular(root, source))) return false;
  }
  return true;
}

function resultContract(root: string, id: ScenarioId): VideoProductionCheck[] {
  const report = readJsonArtifact<Record<string, unknown>>(root, '.kory-eval/result.json');
  const verification = readJsonArtifact<Record<string, unknown>>(
    root,
    '.kory-eval/verification.json',
  );
  const required = [
    'audience',
    'outcome',
    'platform',
    'aspectRatio',
    'narrativeBeats',
    'shotGrammar',
    'pacing',
    'visualContinuity',
    'motionLanguage',
    'voiceMusicSfx',
    'captions',
    'brandConstraints',
    'ownership',
    'decisionSequence',
    'uncertainty',
  ];
  const described = Boolean(
    report &&
    report.scenarioId === id &&
    report.boundary === 'video-production' &&
    report.broader === 'human-experience' &&
    report.neighbor === (id === TUTORIAL ? 'audio-production' : 'accessibility-practice') &&
    required.every((key) => {
      const value = report[key];
      return typeof value === 'string'
        ? value.trim().length > 6
        : Array.isArray(value)
          ? value.length >= 2
          : false;
    }),
  );
  const review = Boolean(
    verification &&
    typeof verification.negativePath === 'string' &&
    verification.negativePath.length > 15 &&
    typeof verification.recovery === 'string' &&
    verification.recovery.length > 15 &&
    (verification.subjectivePlayback === 'unverified' ||
      verification.subjectivePlayback === 'human-reviewed'),
  );
  return [
    {
      id: 'production-decision-and-hierarchy',
      passed: described,
      detail: described
        ? 'structured production contract present'
        : 'incomplete decision/hierarchy report',
    },
    {
      id: 'negative-recovery-and-uncertainty-labels',
      passed: review,
      detail: review
        ? 'report labels limits and controls'
        : 'missing verification report or review status',
    },
  ];
}

/**
 * The scorer reruns every technical probe on the actual candidate bytes. A
 * claimed transcript, screenshot, or JSON measurement is never accepted as
 * a substitute for the decoded final, failed, and repaired media.
 */
export function runVideoProductionRuntime(
  root: string,
  id: ScenarioId,
): VideoProductionRuntimeResult {
  const blockers = videoProductionRuntimeReadiness(id);
  if (blockers.length) return { passed: false, checks: [], blockers, evidence: blockers };
  const tools = mediaTools(id);
  const checks: VideoProductionCheck[] = [];
  try {
    const intact = validateSourceManifest(root, id);
    checks.push({
      id: 'encoded-source-provenance-and-contract',
      passed: intact,
      detail: intact
        ? 'actual source media hashes match the fixture manifest'
        : 'fixture source altered or missing',
    });
    if (!intact)
      return { passed: false, checks, blockers: [], evidence: checks.map((c) => c.detail) };
    checks.push(...resultContract(root, id));
    const deliveries: Delivery[] = id === TUTORIAL ? ['web'] : ['web', 'archive'];
    for (const delivery of deliveries) {
      for (const variant of ['positive', 'recovered'] as const) {
        const relative =
          '.kory-eval/' +
          (variant === 'positive' ? 'final' : 'recovered') +
          '-' +
          delivery +
          (delivery === 'web' ? '.mp4' : '.mov');
        const file = ensureRegular(root, relative);
        checks.push(
          ...probeDelivery(tools, id, file, delivery).map((c) => ({
            ...c,
            id: variant + '-' + c.id,
          })),
        );
      }
    }
    const broken = ensureRegular(root, '.kory-eval/negative-web.mp4');
    const negative = probeDelivery(tools, id, broken, 'web');
    const specificallyBroken = negative.some(
      (check) => check.id === 'decoded-audio-visual-sync-web' && !check.passed,
    );
    const otherNegativeFailures = negative.filter(
      (check) => check.id !== 'decoded-audio-visual-sync-web' && !check.passed,
    );
    checks.push({
      id: 'actual-negative-render-rejected',
      passed: specificallyBroken,
      detail: negative
        .filter((c) => !c.passed)
        .map((c) => c.id + ': ' + c.detail)
        .join('; ')
        .slice(0, 700),
    });
    checks.push({
      id: 'negative-control-still-otherwise-decodable',
      passed: otherNegativeFailures.length === 0,
      detail: otherNegativeFailures.length
        ? otherNegativeFailures
            .map((check) => check.id + ': ' + check.detail)
            .join('; ')
            .slice(0, 700)
        : 'negative control passes every encoded-media check except defective synchronization',
    });
  } catch (error) {
    checks.push({
      id: 'runtime-probe-failure',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    passed: checks.length > 0 && checks.every((check) => check.passed),
    checks,
    blockers: [],
    evidence: checks.map((c) => c.id + ': ' + (c.passed ? 'pass' : 'fail') + ' — ' + c.detail),
  };
}

function score(id: ScenarioId, root: string): SkillEvalDeterministicScore {
  const result = runVideoProductionRuntime(root, id);
  const passed = result.checks.filter((check) => check.passed).length;
  return {
    passed: result.passed,
    quality: result.checks.length ? passed / result.checks.length : 0,
    verification: result.checks.length ? passed / result.checks.length : 0,
    integrityFailure: result.checks.some(
      (check) => check.id === 'encoded-source-provenance-and-contract' && !check.passed,
    ),
    evidence: result.evidence,
  };
}

export const VIDEO_PRODUCTION_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'video-production/tutorial-real-media-v5@2',
    realRuntime: true,
    get readinessBlockers() {
      return videoProductionRuntimeReadiness(TUTORIAL);
    },
    matches: (scenario) => scenario.id === TUTORIAL,
    materialize: (destination) => materializeVideoProductionFixture(destination, TUTORIAL),
  },
  {
    id: 'video-production/multicam-real-media-v5@2',
    realRuntime: true,
    get readinessBlockers() {
      return videoProductionRuntimeReadiness(MULTICAM);
    },
    matches: (scenario) => scenario.id === MULTICAM,
    materialize: (destination) => materializeVideoProductionFixture(destination, MULTICAM),
  },
];

export const VIDEO_PRODUCTION_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'video-production/tutorial-encoded-probe-scorer-v5@1',
    scenarioIds: [TUTORIAL],
    score: ({ workingDirectory }) => score(TUTORIAL, workingDirectory),
  },
  {
    id: 'video-production/multicam-encoded-probe-scorer-v5@1',
    scenarioIds: [MULTICAM],
    score: ({ workingDirectory }) => score(MULTICAM, workingDirectory),
  },
];

export const VIDEO_PRODUCTION_RUNTIME_SCENARIOS = {
  tutorial: TUTORIAL,
  multicam: MULTICAM,
} as const;
