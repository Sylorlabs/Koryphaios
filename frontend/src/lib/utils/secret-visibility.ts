/**
 * Secret reveal state is transient UI state. Crossing either Settings drawer
 * boundary must re-mask every value, including unsaved drafts that remain in
 * their inputs for the user's return.
 */
export function shouldRemaskSecrets(open: boolean, wasOpen: boolean): boolean {
  return open !== wasOpen;
}
