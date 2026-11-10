# Source map

Source curation for `php-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no skill or blind qualification.

## Adopted primary guidance

- **PHP type declarations**: https://www.php.net/manual/en/language.types.declarations.php
  - Adopted: `strict_types` is controlled by the calling file for scalar coercion, so caller context is part of a diagnosis at the scalar type boundary.
  - Conditional: this matters for scalar coercion and calling files that opt into strict typing. It is not a generic explanation for every type error.
  - Limit: framework validation and validation of external input remain separate contracts.
- **PHP exceptions**: https://www.php.net/manual/en/control-structures.finally.php
  - Adopted: on normal return and exception unwinding, control flow in `finally` can replace an earlier result or exception. Rechecked 2026-11-07; this is not an unconditional guarantee about cleanup at termination.
  - Conditional: inspect `finally` only when the changed path uses it or cleanup behavior is material.
  - Limit: exception semantics do not define transaction rollback unless the framework or persistence layer does.
- **PHP: exit**: https://www.php.net/manual/en/function.exit.php
  - Opened 2026-11-07; refresh within 60 days. The manual explicitly states that `exit()` does not execute `finally` blocks.
  - Adopt this termination boundary; adapt cleanup checks to return, exception, and exit paths actually used. Reject the claim that `finally` always runs or that every process termination preserves cleanup.
- **PHP manual index**: https://www.php.net/manual/en/
  - Preserved use: current language, runtime, extension, and standard library reference discovery.
  - Limit: the index alone is not evidence for version specific extension or worker behavior.

Isolation in a persistent worker must be verified in the actual worker model. PHP behavior within a single request alone does not prove state isolation across jobs.
