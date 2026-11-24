import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type HostSpeechEngine = 'say' | 'espeak-ng';

let cached: {
  path: string | undefined;
  checkedAt: number;
  engine: HostSpeechEngine | null;
} | null = null;

/** A launcher reporting success does not establish that speech was generated. */
function producesAudibleSpeech(engine: HostSpeechEngine): boolean {
  const root = mkdtempSync(join(tmpdir(), 'kory-speech-readiness-'));
  try {
    const output = join(root, engine === 'say' ? 'probe.aiff' : 'probe.wav');
    const phrase = 'This is a spoken audio test of the available speech synthesizer.';
    const args =
      engine === 'say' ? ['-r', '154', '-o', output, phrase] : ['-s', '154', '-w', output, phrase];
    const generated = spawnSync(engine, args, {
      env: { ...process.env },
      timeout: 8_000,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (generated.status !== 0) return false;

    // Decode actual samples. Some sandboxed macOS `say` invocations return 0
    // but leave an empty AIFF container; ffprobe/version checks miss this.
    const decoded = spawnSync(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        output,
        '-t',
        '2',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        'f32le',
        '-',
      ],
      {
        env: { ...process.env },
        timeout: 8_000,
        encoding: 'buffer',
        maxBuffer: 100_000,
        windowsHide: true,
      },
    );
    if (decoded.status !== 0 || !Buffer.isBuffer(decoded.stdout)) return false;
    const samples = decoded.stdout;
    if (samples.length < 8_000 || samples.length % 4 !== 0) return false;
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i += 4) {
      const sample = samples.readFloatLE(i);
      if (!Number.isFinite(sample)) return false;
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / (samples.length / 4)) > 0.001;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function availableHostSpeechEngine(): HostSpeechEngine | null {
  const path = process.env.PATH;
  if (cached && cached.path === path && Date.now() - cached.checkedAt < 30_000)
    return cached.engine;

  const engine: HostSpeechEngine | null = producesAudibleSpeech('say')
    ? 'say'
    : producesAudibleSpeech('espeak-ng')
      ? 'espeak-ng'
      : null;
  cached = { path, checkedAt: Date.now(), engine };
  return engine;
}
