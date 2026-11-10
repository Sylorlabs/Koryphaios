# Source map

Source curation for `python-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no skill or blind qualification.

## Adopted primary guidance

- **asyncio tasks and cancellation**: https://docs.python.org/3/library/asyncio-task.html
  - Adopted: cancellation raises `CancelledError` at an await boundary, cleanup belongs in `try` and `finally`, and cancellation should normally propagate after cleanup so structured-concurrency helpers retain their semantics.
  - Conditional: APIs such as `TaskGroup` depend on the supported interpreter version. Do not prescribe them for older targets that lack them.
  - Limit: asyncio documentation does not make blocking synchronous code cancelable.
- **contextlib**: https://docs.python.org/3/library/contextlib.html
  - Adopted: use synchronous or asynchronous context managers where a resource's acquisition and release can be expressed as one ownership boundary.
  - Conditional: context managers should clarify real resource ownership, not wrap trivial values for style.
  - Limit: context-manager use does not establish that third-party cleanup itself is correct.
- **Python 3 documentation index**: https://docs.python.org/3/
  - Preserved use: language, standard-library, and interpreter-version reference discovery.
  - Limit: the current documentation index must be reconciled with the project's supported Python range.

Clean-environment installation and target-interpreter tests control packaging and dependency claims. One developer virtual environment is not project evidence.
