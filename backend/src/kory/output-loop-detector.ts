export const OUTPUT_LOOP_REPETITION_THRESHOLD = 10;
export const MAX_OUTPUT_LOOP_UNIT_CHARS = 4096;

export interface OutputLoopDetection {
  repetitions: number;
  /** Character length only: generated text is never copied into logs. */
  unitLength: number;
}

export class OutputLoopStop extends Error {
  constructor() {
    super('Stopped due to looping.');
    this.name = 'OutputLoopStop';
  }
}

/** Incrementally detects an exact token or phrase repeated ten times. */
export class OutputLoopDetector {
  private tail = '';
  private detection: OutputLoopDetection | null = null;

  push(chunk: string): { accepted: number; detection: OutputLoopDetection | null } {
    if (this.detection) return { accepted: 0, detection: this.detection };
    for (let index = 0; index < chunk.length; index++) {
      this.tail = (this.tail + chunk[index]!).slice(
        -MAX_OUTPUT_LOOP_UNIT_CHARS * OUTPUT_LOOP_REPETITION_THRESHOLD,
      );
      const detection = this.detectTail();
      if (detection) {
        this.detection = detection;
        return { accepted: index + 1, detection };
      }
    }
    return { accepted: chunk.length, detection: null };
  }

  finish(): OutputLoopDetection | null {
    return this.detection;
  }

  private detectTail(): OutputLoopDetection | null {
    const tokens = [...this.tail.matchAll(/\S+/gu)];
    const maximum = Math.floor(tokens.length / OUTPUT_LOOP_REPETITION_THRESHOLD);
    for (let size = 1; size <= maximum; size++) {
      const start = tokens.length - size * OUTPUT_LOOP_REPETITION_THRESHOLD;
      const expected = tokens.slice(start, start + size).map(([value]) => value).join('\u0000');
      let repeated = true;
      for (let block = 1; block < OUTPUT_LOOP_REPETITION_THRESHOLD; block++) {
        const actual = tokens
          .slice(start + block * size, start + (block + 1) * size)
          .map(([value]) => value)
          .join('\u0000');
        if (actual !== expected) {
          repeated = false;
          break;
        }
      }
      if (repeated) {
        const first = tokens[start]!.index;
        const next = tokens[start + size]?.index ?? this.tail.length;
        return { unitLength: next - first, repetitions: OUTPUT_LOOP_REPETITION_THRESHOLD };
      }
    }
    return null;
  }
}

export function detectOutputLoop(text: string): OutputLoopDetection | null {
  const detector = new OutputLoopDetector();
  return detector.push(text).detection ?? detector.finish();
}
