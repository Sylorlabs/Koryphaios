# Source map

Source curation for `gpu-compute`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no-skill or blind qualification.

## Adopted primary guidance

- **CUDA kernel programming basics**: https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/writing-cuda-kernels.html
  - Adopted: inspect memory-access efficiency and coalescing alongside launch geometry before introducing more complex kernel-local caching or tiling.
  - Conditional: this is CUDA guidance for NVIDIA targets. Use the equivalent primary documentation for Metal or another compute API.
  - Limit: coalescing guidance does not establish that a kernel is memory-bound or that a particular transformation will improve end-to-end latency.
- **CUDA memory basics**: https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/understanding-memory.html
  - Adopted: reason separately about host-device transfer and the device memory hierarchy when explaining where time and bandwidth are spent.
  - Conditional: apply only to the actual CUDA memory path and hardware generation under test.
  - Limit: documentation cannot substitute for profiler evidence from the target workload.
- **CUDA C++ Programming Guide**: https://docs.nvidia.com/cuda/cuda-c-programming-guide/
  - Preserved use: existing CUDA execution, synchronization, precision, occupancy, and toolkit reference entry point.
  - Limit: CUDA-specific limits and tuning do not generalize to Metal, Vulkan compute, DirectCompute, or arbitrary GPUs.

Numerical correctness needs a trusted reference and an explicit tolerance contract. Performance claims need representative hardware and end-to-end measurements, not kernel documentation alone.
