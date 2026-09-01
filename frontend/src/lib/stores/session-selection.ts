/** Pure selection resolution for session refreshes.
 *
 *  Invariants (previously inlined in fetchSessions and untested):
 *  - A stored last-session id wins when it still exists (boot restore).
 *  - A currently-active id that vanished from the list is cleared — never
 *    replaced by an unrelated conversation.
 *  - An empty selection stays empty: the welcome screen has a usable
 *    composer, and auto-activating sessions[0] hijacked explicit user
 *    selections (e.g. right after choosing a workspace project bubble). */
export function resolveSessionSelection(options: {
  storedSessionId: string;
  currentActiveId: string;
  sessionIds: Iterable<string>;
}): string {
  const ids = new Set(options.sessionIds);
  if (options.storedSessionId && ids.has(options.storedSessionId)) {
    return options.storedSessionId;
  }
  if (options.currentActiveId && !ids.has(options.currentActiveId)) {
    return '';
  }
  return options.currentActiveId;
}
