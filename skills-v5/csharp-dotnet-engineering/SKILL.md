---
name: csharp-dotnet-engineering
description: Engineer C# and .NET systems with async discipline, dependency lifetimes, nullability, serialization, and runtime compatibility. Use when the request specifically requires c#, csharp, .net, dotnet; prefer a narrower child only when its boundary is established.
---

# Csharp Dotnet Engineering

## Boundary

Confirm the target framework matrix, C# language and nullable settings, hosting model, dependency lifetimes, async flow, and serializer configuration from the actual project files and host. Keep `IDisposable` and `IAsyncDisposable` ownership explicit, propagate `CancellationToken` through operations that can actually cancel, and treat reflection, trimming, AOT, and serialization as deployment contracts when used. A C# or .NET mention alone does not make a generic product, documentation, or API design task a runtime engineering task.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when .NET runtime, C# semantics, DI lifetime, async flow, or deployment mode is material. Conventions that depend on the framework actually in use stay conditional. Quoted, historical, negated, fixture, or example text is not a live trigger.

## Decisions that change the implementation

- Resolve the target framework matrix and C# language version before using APIs, language features, source generators, trimming annotations, or native AOT assumptions. Inspect `global.json`, project files, shared MSBuild props, and the actual runtime rather than inferring support from a file extension.
- Match DI lifetime to the resource lifetime. A singleton must not retain a scoped service. If singleton work needs scoped dependencies, create and dispose a scope at the operation boundary rather than promoting the dependency.
- Treat cancellation as cooperative. Pass an existing token into cancelable downstream work and preserve `OperationCanceledException` as cancellation when it represents that token, rather than translating it into an unrelated failure.
- After an async resource factory succeeds, establish its owner immediately with `await using` or a correctly scoped `try/finally`. Parsing, saving, cancellation, and other exceptions must dispose the acquired resource exactly once; failures before acquisition must not attempt disposal. Keep separately acquired async resources in nested or separate scopes so a later acquisition failure cannot skip earlier cleanup. Do not replace asynchronous cleanup with `.Result` or `.Wait()`.
- Define the commit boundary. Honor cancellation while work is still cancelable, but do not retroactively report cancellation after an irreversible commit completed successfully. Test cancellation before the save, during the save, and immediately after commit.
- Let the container dispose services it creates. Make ownership explicit for services or disposables constructed outside the container.
- Review reflection and serializer metadata against the actual publish mode when trimming or AOT is enabled.
- Treat serializer behavior as an explicit contract: record the options or generated context, naming and null rules, missing versus supplied values, unknown property and enum handling, and the failure type for malformed input. Do not treat a successful default `JsonSerializer` round trip as proof that a rolling deployment or a trimmed/AOT publish is compatible.
- For persisted JSON contracts, distinguish omitted fields from invalid supplied values. Apply documented defaults for old records, validate newly supplied ranges, and preserve the fields an older reader still requires. Process malformed queue entries independently, retaining their raw contents and position while allowing later valid entries to load after restart.
- For a public positional `record`, its primary constructor, deconstruction shape and generated properties are source and binary compatibility contracts. When evolving optional serialized state, preserve existing constructor overloads and call sites; do not silently replace a constructor taking three arguments with one taking two arguments. Use a wire DTO or compatible overload where needed, then separately verify serialization compatibility.

## Failure discriminators

- If data from one request leaks into another, inspect service lifetime and mutable singleton state before changing serializer or cache behavior.
- If shutdown hangs, determine whether work ignores cancellation, blocks on `.Result` or `.Wait`, or retains an undisposed resource.
- If development works but a published artifact fails, compare trimming, AOT, runtime identifier, single file packaging, and reflection or serializer paths.
- If nullable warnings appear after a contract change, determine whether the domain permits null. Do not suppress the warning until the contract is resolved.
- If a serializer accepts an omitted value but rejects a supplied value, distinguish the defaulting path from the validation path before changing annotations or constructors. If malformed queue input is skipped, verify that its raw entry and position remain recoverable and that later valid entries are not blocked.
- If a supplied regression project or build definition is marked immutable, keep its project references and inputs intact. Add executable regressions at the designated test entry point rather than changing the project file to make tests compile.

## Verification at the .NET boundary

- Run build and focused tests for every affected supported target framework, and run the fixture's actual regression program or test project when one is supplied.
- Exercise cancellation before start and during downstream work, and verify expected cleanup or disposal.
- Cover successful completion, parser or dependency errors, cancellation before and during commit, success after commit, and disposal that happens exactly once when these paths exist. A library build alone cannot prove the executable regression contract.
- For DI changes, resolve through the real host or service provider and cover scope disposal and singleton interaction.
- If serialization changed, round trip representative old and new payloads where compatibility matters. Check invalid bounds, unknown additive fields, malformed item retention, later valid entries, and deterministic recovery on a repeated load using the configured serializer, not an unrelated default.
- Compile a consumer using every preexisting public constructor, deconstruction, and property contract against the updated library. Where binary compatibility is claimed, load a previously built consumer as well. A passing library build or a new writer's round trip does not prove that older consumers still compile or can consume new serialized payloads.
- If trimming or AOT is part of deployment, verify the corresponding published artifact rather than relying on the development build.

## Completion evidence

- Target framework and hosting or deployment assumptions affected by the change
- Lifetime, cancellation, disposal, or serialization evidence at the real host boundary
- Published artifact evidence when trimming, AOT, or reflection behavior is material

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
