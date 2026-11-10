# Source map

Source curation for `csharp-dotnet-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no skill or blind qualification. Official documentation anchors API and language behavior; repository tests and published artifacts still provide the evidence for an application's actual contract.

## Adopted primary guidance

- **Dependency injection service lifetimes**: https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection/service-lifetimes
  - Adopted: scoped services belong to a scope, singletons must not capture scoped services, and singleton implementations must account for concurrent use.
  - Conditional: an explicit scope inside singleton or background work is appropriate only when the operation genuinely needs scoped dependencies and owns that scope.
  - Limit: these lifetime rules describe the built in .NET DI model. Third party containers can add behavior, but do not erase the underlying lifetime mismatch.
- **Dependency injection guidelines**: https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection/guidelines
  - Adopted: the container disposes `IDisposable` services it creates, and disposal ownership must remain explicit for externally created objects.
  - Conditional: apply container disposal guidance only to objects whose construction is actually owned by the container.
  - Limit: this is not a reason to move arbitrary disposable business objects into DI.
- **Cancellation in managed threads**: https://learn.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads
  - Adopted: cancellation is cooperative, existing tokens should flow through cancelable operations, and cancellation should remain distinguishable from unrelated failure.
  - Conditional: do not add cancellation parameters to work that cannot meaningfully observe cancellation.
  - Limit: token signaling does not force arbitrary work to stop.
- **Asynchronous dispose pattern**: https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-disposeasync
  - Adopted: `await using` awaits `IAsyncDisposable.DisposeAsync`, and async ownership must be established after successful acquisition; nonsealed implementations need an overridable async cleanup path when they own inheritable resources.
  - Conditional: implement both synchronous and asynchronous disposal only when the owned resource graph and consumer contract require both paths.
  - Limit: documentation of the pattern does not prove that a specific factory, exception path, or host disposes a resource exactly once.
- **System.Text.Json overflow and extension data**: https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/handle-overflow
  - Adopted: unknown JSON properties are discarded by default unless an extension data member or another explicit contract preserves them; the configured serializer determines round trip behavior.
  - Conditional: preserve unknown queue fields only when the compatibility policy requires it and the selected serializer contract can retain them.
  - Limit: extension data support does not define queue ordering, malformed entry retention, restart recovery, or domain validation.
- **System.Text.Json overview**: https://learn.microsoft.com/en-us/dotnet/standard/serialization/system-text-json/overview
  - Adopted: reflection metadata and source generated metadata are distinct serializer paths, and trimming or AOT makes metadata availability part of the deployment contract.
  - Limit: API documentation does not establish that a project's options, source generated context, or publish configuration is correct.
- **C# records**: https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record
  - Adopted: positional records synthesize public properties, a primary constructor, and a deconstruction method; changing positional shape changes those public contracts.
  - Limit: language reference behavior does not by itself establish JSON constructor selection or binary compatibility for a particular assembly.
- **.NET library versioning and breaking changes**: https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/versioning and https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/breaking-changes
  - Adopted: source, behavior, and binary compatibility are separate claims; public signature changes require consumer checks rather than inference from a successful library build.
  - Limit: general library guidance does not replace a compiled old consumer or a real old and new serialized payload corpus.
- **Trimmed self contained deployment**: https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/trim-self-contained
  - Adopted: trimming is a self contained publish contract and reflection heavy paths can fail at runtime when analysis cannot see required metadata.
  - Limit: trim warnings and a publish command do not prove runtime behavior without executing the published artifact.
- **Native AOT deployment**: https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/
  - Adopted: Native AOT is runtime and architecture specific, implies trimming and single file constraints, and rejects or limits dynamic loading and runtime code generation.
  - Limit: the published target and toolchain must be available; a development build cannot stand in for Native AOT evidence.
- **.NET documentation index**: https://learn.microsoft.com/dotnet/
  - Preserved use: version and API discovery entry point.
  - Limit: the index alone is not evidence for a runtime, DI, trimming, or AOT rule.

The DI and cancellation pages were rechecked on 2026-10-17. The async disposal, JSON, record, versioning, trimming, and Native AOT pages were rechecked on 2026-10-17. For deployment sensitive behavior, the target framework, runtime identifier, publish mode, and executed artifact are part of the evidence. Development host success does not establish trimmed or AOT behavior.
