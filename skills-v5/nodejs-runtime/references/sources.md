# Node runtime source map

Check documentation for the project's supported Node major. The latest API index is for discovery; API semantics and measured application performance are different kinds of evidence.

- [Streams](https://nodejs.org/api/stream.html): `pipeline` cancellation and teardown, writable `write()` / `drain`, `highWaterMark`, and stream error behavior. Bounded stream buffers do not bound every upstream queue.
- [Process](https://nodejs.org/api/process.html): signals, exit, environment, and process lifecycle. Platform behavior varies; documentation cannot identify an application's leaked handles.
- [Performance hooks](https://nodejs.org/api/perf_hooks.html): `monitorEventLoopDelay` measures observed delay; use a CPU profile to attribute the work causing it.
- [Worker threads](https://nodejs.org/api/worker_threads.html): CPU execution outside the main JavaScript thread; measure transfer, queue, and worker lifecycle cost before claiming improvement.
- [API index](https://nodejs.org/docs/latest/api/): locate APIs, then verify availability and behavior on the supported runtime.

Keep runtime traces, benchmark inputs, and measurements for any performance or resource claim. Docs alone establish API behavior, not workload improvement.
