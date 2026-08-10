/** Monotonic latest-request identities scoped by data source. A response is
 * allowed to mutate UI state only while its key and identity are still current. */
export class KeyedRequestGate<Key extends string> {
  readonly #requestIds = new Map<Key, number>();
  #nextRequestId = 0;

  begin(key: Key): number {
    // IDs stay monotonic across reset boundaries. Reusing `1` after a project
    // transition would let an older global-source response impersonate the
    // first request in the new workspace.
    const requestId = ++this.#nextRequestId;
    this.#requestIds.set(key, requestId);
    return requestId;
  }

  isCurrent(key: Key, requestId: number): boolean {
    return this.#requestIds.get(key) === requestId;
  }

  reset(): void {
    this.#requestIds.clear();
  }
}
