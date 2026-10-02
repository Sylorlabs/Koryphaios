---
name: gpu-compute
description: Engineer GPU compute workloads around memory movement, kernels, synchronization, numerical behavior, occupancy, portability, and profiling. Use when the request specifically requires gpu compute, cuda kernel, metal compute, compute shader; prefer a narrower child only when its boundary is established.
---

# Gpu Compute

## Boundary

Establish target GPU and API, data layout, host-device transfers, kernel launch geometry, synchronization, precision, reductions or atomics, memory hierarchy, and representative workload sizes. Separate numerical correctness from performance and optimize from profiler evidence rather than kernel folklore.

## Hierarchy and routing

- Broader skills: performance-debugging.
- No narrower bundled child is declared.
- Required skills: verification, performance-verification.

CUDA-specific memory and execution guidance applies only to CUDA targets. For Metal or another compute API, use that platform's primary documentation for equivalent limits and synchronization semantics. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Establish the accuracy contract first: exact result, absolute or relative tolerance, deterministic reduction, or statistically acceptable result. Floating-point reassociation can change results even when the kernel is otherwise correct.
- Account for host-device transfer, allocation, launch, synchronization, and readback costs when choosing whether work belongs on the GPU.
- For CUDA, inspect memory transaction efficiency and access coalescing before adding shared memory or more complex tiling. Similar concepts on other APIs require platform-specific evidence.
- Change launch geometry, register pressure, shared memory, and occupancy only against profiler data from the target workload and device class.

## Failure discriminators

- If the GPU result differs from a CPU reference, separate precision and reduction-order drift from an indexing, synchronization, race, or stale-buffer defect.
- If a faster kernel does not improve end-to-end latency, inspect transfer and synchronization time before further kernel tuning.
- If performance regresses only on one device generation, compare memory behavior, occupancy limits, compiler output, and workload shape before generalizing the optimization.
- If failures occur only at certain sizes, inspect launch bounds, tail handling, alignment, reduction assumptions, and buffer capacity.

## Verification at the compute boundary

- Compare against a trusted reference for empty or minimum work, odd or tail sizes, representative sizes, and the largest practical boundary affected.
- Profile end-to-end time and kernel time separately. Record target GPU, driver or OS, API or toolkit version, precision mode, and workload shape.
- Use the platform's race or memory checking tools when synchronization or indexing changed and the tool supports the target.
- Validate performance claims on representative hardware. Emulation, compilation, or a different GPU generation does not establish target performance.
- Keep performance and correctness claims separate when only one has been measured.

## Completion evidence

- Numerical accuracy contract and reference-result evidence
- End-to-end and kernel-level profiler evidence for performance claims
- Representative hardware, workload, precision, and synchronization evidence, with unsupported device checks stated explicitly

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
