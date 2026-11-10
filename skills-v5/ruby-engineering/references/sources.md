# Source map

Source curation for `ruby-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no skill or blind qualification.

## Adopted primary guidance

- **Ruby 3.4 exception syntax and semantics**: https://ruby-doc.org/3.4.1/syntax/exceptions_rdoc.html
  - Adopted: bare `rescue` handles `StandardError`, `ensure` runs for cleanup, and `retry` restarts the protected body and therefore needs a bounded policy.
  - Conditional: the cited page is Ruby 3.4.1. Check the project's supported Ruby version when behavior can differ.
  - Limit: exception syntax does not define framework transaction rollback or job retry policy.
- **Ruby Thread::Queue**: https://ruby-doc.org/3.4.1/Thread/Queue.html
  - Adopted: use a synchronization-aware queue when multiple threads exchange producer-consumer work rather than relying on unsynchronized collection mutation.
  - Conditional: this applies when Ruby threads are the actual concurrency primitive.
  - Limit: using `Queue` does not prove thread shutdown, fairness, or application-level ordering.
- **Ruby Thread**: https://ruby-doc.org/3.4.1/Thread.html
  - Adopted: spawned threads need lifecycle ownership because process exit and thread termination can leave work incomplete when callers do not join or otherwise coordinate completion.
  - Conditional: process managers and frameworks can impose additional lifecycle rules.
  - Limit: thread documentation does not establish safety of shared mutable application objects.
- **Ruby documentation index**: https://www.ruby-lang.org/en/documentation/
  - Preserved use: locate the language and standard-library documentation matching the supported Ruby version.

Rails and ActiveSupport behavior must be sourced from the framework version in use. Core Ruby documentation does not make framework helpers portable library contracts.
