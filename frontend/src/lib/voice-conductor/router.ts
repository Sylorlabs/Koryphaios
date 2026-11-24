// Decides, per voice capture, whether speech is dictation for the composer or a
// command for the conductor.
//
// - A capture started with the conductor shortcut is always a command.
// - A dictation capture whose first words are the wake phrase becomes a
//   command; everything else in it stays dictation.
// - While the conductor is waiting for a spoken confirmation, a dictation that
//   is only "yes" / "no" answers it instead of landing in the composer.
//
// Recognisers deliver a capture either as one final transcript (local and API
// transcription) or as several final segments (system speech recognition), so
// the router is fed segment by segment and the command is only released when
// the capture ends: a command split across two segments is still one command.

import { isAffirmative, isNegative, matchWakePhrase, parseConductorUtterance } from './grammar';

export type CaptureMode = 'dictation' | 'conductor';

export interface RouterOptions {
  /** The conductor master switch. Off means every capture is dictation. */
  conductorEnabled: boolean;
  wakePhraseEnabled: boolean;
  wakePhrase: string;
  /** True while a destructive command or fallback chip awaits a "yes". */
  awaitingConfirmation: boolean;
}

export type RouteDecision = { target: 'composer'; text: string } | { target: 'conductor'; text: string };

/** Route one complete dictation transcript. */
export function routeDictation(text: string, options: RouterOptions): RouteDecision {
  const trimmed = text.trim();
  if (!options.conductorEnabled || !trimmed) return { target: 'composer', text: trimmed };
  if (options.awaitingConfirmation && (isAffirmative(trimmed) || isNegative(trimmed)))
    return { target: 'conductor', text: trimmed };
  if (!options.wakePhraseEnabled) return { target: 'composer', text: trimmed };
  const wake = matchWakePhrase(trimmed, options.wakePhrase);
  if (!wake.matched) return { target: 'composer', text: trimmed };
  // "Kory, …" or "Hey Kory …" is addressed to the conductor. A bare "Kory"
  // followed by an ordinary sentence ("Kory is slow today") is only routed when
  // the rest is a command the grammar recognises, so dictating a sentence that
  // happens to start with the name still reaches the composer.
  if (wake.explicit || parseConductorUtterance(wake.rest).type !== 'unknown')
    return { target: 'conductor', text: wake.rest.trim() };
  return { target: 'composer', text: trimmed };
}

export interface DictationRouter {
  readonly mode: CaptureMode;
  /** Feed one final segment. Returns text for the composer, or null when the
   *  segment belongs to a conductor command. */
  push(segment: string): string | null;
  /** End the capture. Returns the conductor command, or null if the capture
   *  was dictation. An empty string means the conductor was addressed but no
   *  command followed. */
  finish(): string | null;
}

export function createDictationRouter(
  initialMode: CaptureMode,
  options: RouterOptions,
  onModeChange?: (mode: CaptureMode) => void,
): DictationRouter {
  let mode: CaptureMode = options.conductorEnabled ? initialMode : 'dictation';
  let decided = mode === 'conductor';
  let finished = false;
  const command: string[] = [];

  return {
    get mode() {
      return mode;
    },
    push(segment: string) {
      const text = segment.trim();
      if (finished || !text) return null;
      if (mode === 'conductor') {
        command.push(text);
        return null;
      }
      if (decided) return text;
      decided = true;
      const route = routeDictation(text, options);
      if (route.target === 'composer') return route.text;
      mode = 'conductor';
      onModeChange?.(mode);
      if (route.text) command.push(route.text);
      return null;
    },
    finish() {
      if (finished) return null;
      finished = true;
      if (mode !== 'conductor') return null;
      return command.join(' ').replace(/\s+/g, ' ').trim();
    },
  };
}
