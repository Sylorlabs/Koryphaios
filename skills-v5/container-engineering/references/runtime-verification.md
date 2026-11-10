# Runtime verification protocol

Use only the checks relevant to the requested image/runtime contract. Resolve the target OS first. The signal, UID/GID, capability, and tmpfs examples below describe Linux containers, including Linux containers running inside a VM on another host OS.

## Close the build inputs

Record the context root and file inventory or hash, ignore rules, Dockerfile, lockfiles, installation flags, target platforms, build arguments without secret values, and the builder/frontend versions. Exclude local credentials, VCS internals, development dependency trees, and unrelated artifacts from the context. Copy only the required runtime closure from build stages.

Pin every external base stage and remote artifact needed for a reproducibility claim. A digest can identify an index, a child manifest, or a config; label which one it is. Validate downloads against trusted expected checksums and install from enforced locks or controlled package snapshots. Caches are accelerators, not undeclared dependency stores; a cold build must still work. Keep required CA certificates, dynamic loaders, native libraries, timezone data, and project diagnostics. Do not switch libc solely to reduce size without validating the runtime ABI.

Use an explicit builder and output destination. Some Buildx drivers export to a registry or OCI layout without loading the result into the local engine. Inspect the artifact that was actually exported, not an older local tag. A successful build is neither an independent rebuild comparison nor proof of identical bytes. If exact reproducibility is required, rebuild independently from the same immutable inputs and compare the requested artifact digests, accounting explicitly for timestamps and attestations.

## Inspect the exported artifact

Inspect index descriptors and each target's manifest/config, layer digests, effective user, working directory, environment, entrypoint/arguments, stop signal, and health configuration. Preserve raw inspector outputs and the commands that produced them. Distinguish base identity from final artifact identity; an engine image ID is commonly a config digest, not the registry manifest digest.

For secret handling, use a synthetic canary and never publish real credentials in evidence. Check history/config, raw exported layers, and the merged root filesystem. Deleting a credential in a later layer does not erase the earlier bytes. Inspect build logs and exported caches separately when those surfaces are in scope; absence from the runtime image does not clear them. Secret and SSH mounts only control delivery to a step. A consumer can still persist or print the value, including through shell tracing. Validate the inspector with a known leaking control before trusting an empty search result. Do not extract an untrusted image archive onto the host without safe path handling.

## Exercise the process and mounts

Start the exact image under its intended runtime configuration without development bind mounts. Observe effective UID/GID and supplementary groups, mount ownership/modes, and the process tree. An image `USER` can be overridden at launch, and mount contents can hide ownership created during the build. Test writes to each allowed mount and rejection of a representative write outside it with the root filesystem read only. Do not solve a missing mount or ownership error with root, privileged mode, or universal write permissions.

Observe both default arguments and an override containing spaces. A wrapper using `exec "$@"` preserves argument boundaries when it is designed to receive the complete command. A wrapper that manages multiple processes instead needs deliberate forwarding, waiting, and child reaping. Exec form alone does not prove that the program handles PID 1 signals or reaps children.

Record readiness before stopping, the actual configured stop signal and grace period, application receipt, shutdown marker, elapsed time, exit status, forced kill status, and remaining children. A stopped container or exit code alone does not prove graceful termination. Exercise orphan handling only when the application or contract requires it; otherwise record the scope reason. Keep logs before removing the test container. Use uniquely named disposable resources and remove only resources created by this check; retain persistent data and unrelated images, volumes, builders, and Docker contexts.

Test the listening address and port through the intended network path. `EXPOSE` is metadata, not port publication, and binding only to container loopback can prevent reachability. For an existing health mechanism, inspect its executable dependencies and observe healthy, failed, and recovered states within its timing contract. Docker health metadata alone does not provide Kubernetes readiness or restart semantics. Keep controller behavior with `kubernetes-operations`.

## Record bounded evidence

For every required axis, record desired settings separately from an observation containing the command/oracle, exact artifact/platform, status, result or reason, and evidence location. Use `pass`, `fail`, `unavailable`, or `not-configured` when the artifact specifies those values. `not-configured` is appropriate for an absent optional health or project policy gate, never for an unrun required startup or platform check. Null plus an unavailable reason is appropriate for an unobserved fact.

Record execution mode as native, emulated, simulated, or unavailable. Metadata and a simulated dependency selection do not establish executable compatibility. For each required platform, exercise the actual native dependency path against the intended libc/ABI when execution is available. Preserve a failed or partial attempt, bounded cleanup, and successful retry when recovery is requested. An unavailable target prevents a claim that every target passed.

Run project vulnerability/license gates against the exact produced artifact and record tool version, policy, database identity/freshness where relevant, exit status, and finding summary. A package list or signature cannot replace a required scanner. An unavailable gate remains unavailable. Host containment, provenance, signing identity, and supply chain trust require their own specialist evidence; keep them explicitly unproved when they were not exercised.
