export class AsyncMutex {
  private promise: Promise<void> | null = null;
  async acquire(): Promise<() => void> {
    let resolve: () => void;
    const nextPromise = new Promise<void>(res => { resolve = res; });
    const previousPromise = this.promise;
    this.promise = nextPromise;
    if (previousPromise) await previousPromise;
    return resolve!;
  }
}

export const gitMutex = new AsyncMutex();
