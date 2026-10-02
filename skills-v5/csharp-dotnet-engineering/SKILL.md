---
name: csharp-dotnet-engineering
description: Engineer C# and .NET systems with async discipline, dependency lifetimes, nullability, serialization, and runtime compatibility. Use when the request specifically requires c#, csharp, .net, dotnet; prefer a narrower child only when its boundary is established.
---

# Csharp Dotnet Engineering

## Boundary

Confirm target frameworks, nullable context, hosting model, dependency lifetimes, async flow, and serializer configuration. Keep `IDisposable` and `IAsyncDisposable` ownership explicit, propagate `CancellationToken` through operations that can actually cancel, and treat reflection, trimming, AOT, and serialization as deployment contracts when used.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when .NET runtime, C# semantics, DI lifetime, async flow, or deployment mode is material. Framework-specific conventions are conditional on the framework actually in use. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Resolve the target framework matrix before using APIs, language features, source generators, trimming annotations, or native AOT assumptions.
- Match DI lifetime to the resource lifetime. A singleton must not retain a scoped service. If singleton work needs scoped dependencies, create and dispose a scope at the operation boundary rather than promoting the dependency.
- Treat cancellation as cooperative. Pass an existing token into cancelable downstream work and preserve `OperationCanceledException` as cancellation when it represents that token, rather than translating it into an unrelated failure.
- Let the container dispose services it creates. Make ownership explicit for services or disposables constructed outside the container.
- Review reflection and serializer metadata against the actual publish mode when trimming or AOT is enabled.

## Failure discriminators

- If data from one request leaks into another, inspect service lifetime and mutable singleton state before changing serializer or cache behavior.
- If shutdown hangs, determine whether work ignores cancellation, blocks on `.Result` or `.Wait`, or retains an undisposed resource.
- If development works but a published artifact fails, compare trimming, AOT, runtime identifier, single-file, and reflection or serializer paths.
- If nullable warnings appear after a contract change, determine whether the domain permits null. Do not suppress the warning until the contract is resolved.

## Verification at the .NET boundary

- Run build and focused tests for every affected supported target framework.
- Exercise cancellation before start and during downstream work, and verify expected cleanup or disposal.
- For DI changes, resolve through the real host or service provider and cover scope disposal and singleton interaction.
- If serialization changed, round trip representative old and new payloads where compatibility matters.
- If trimming or AOT is part of deployment, verify the corresponding published artifact rather than relying on the development build.

## Completion evidence

- Target framework and hosting or deployment assumptions affected by the change
- Lifetime, cancellation, disposal, or serialization evidence at the real host boundary
- Published-artifact evidence when trimming, AOT, or reflection behavior is material

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
