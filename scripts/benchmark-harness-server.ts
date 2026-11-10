// Instrument the real server in a disposable, credential-free benchmark child.
// Never add this preload to a product launch.
if (process.env.KORY_BENCHMARK_CHILD !== '1') {
  throw new Error('Run scripts/benchmark-harness.ts instead');
}

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('External HTTP is disabled in the harness benchmark');
    }
    return originalFetch(input, init);
  },
  originalFetch,
);

let previous = performance.now();
setInterval(() => {
  const now = performance.now();
  process.send?.({
    kind: 'sample',
    rss: process.memoryUsage().rss,
    heapUsed: process.memoryUsage().heapUsed,
    timerDelayMs: Math.max(0, now - previous - 250),
  });
  previous = now;
}, 250).unref();

await import('../backend/src/server');
