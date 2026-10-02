# Source map

Source curation for `csharp-dotnet-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no-skill or blind qualification.

## Adopted primary guidance

- **Dependency injection service lifetimes**: https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection/service-lifetimes
  - Adopted: scoped services belong to a scope, singletons must not capture scoped services, and singleton implementations must account for concurrent use.
  - Conditional: an explicit scope inside singleton or background work is appropriate only when the operation genuinely needs scoped dependencies and owns that scope.
  - Limit: these lifetime rules describe the built-in .NET DI model. Third-party containers can add behavior, but do not erase the underlying lifetime mismatch.
- **Dependency injection guidelines**: https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection/guidelines
  - Adopted: the container disposes `IDisposable` services it creates, and disposal ownership must remain explicit for externally created objects.
  - Conditional: apply container disposal guidance only to objects whose construction is actually owned by the container.
  - Limit: this is not a reason to move arbitrary disposable business objects into DI.
- **Cancellation in managed threads**: https://learn.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads
  - Adopted: cancellation is cooperative, existing tokens should flow through cancelable operations, and cancellation should remain distinguishable from unrelated failure.
  - Conditional: do not add cancellation parameters to work that cannot meaningfully observe cancellation.
  - Limit: token signaling does not force arbitrary work to stop.
- **.NET documentation index**: https://learn.microsoft.com/dotnet/
  - Preserved use: version and API discovery entry point.
  - Limit: the index alone is not evidence for a runtime, DI, trimming, or AOT rule.

For deployment-sensitive behavior, the target framework and publish mode are part of the evidence. Development-host success does not establish trimmed or AOT behavior.
