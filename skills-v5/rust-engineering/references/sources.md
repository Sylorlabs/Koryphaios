# Source map

Source curation for `rust-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no-skill or blind qualification.

## Adopted primary guidance

- **Rustonomicon Send and Sync**: https://doc.rust-lang.org/nomicon/send-and-sync.html
  - Adopted: treat `Send` and `Sync`, especially unsafe implementations, as correctness promises about reachable state rather than compiler escape hatches.
  - Conditional: consult this boundary when cross-thread movement or sharing is actually part of the type's contract.
  - Limit: the Rustonomicon documents unsafe reasoning but does not prove a particular implementation is sound.
- **Rustonomicon safe and unsafe meaning**: https://doc.rust-lang.org/stable/nomicon/safe-unsafe-meaning.html
  - Adopted: state the invariant maintained by each unsafe boundary, including FFI operations whose validity Rust cannot check.
  - Conditional: introduce or retain unsafe only when a concrete invariant cannot be expressed through the existing safe abstraction.
  - Limit: enclosing code in an unsafe block does not make an invalid operation valid.
- **Cargo features reference**: https://doc.rust-lang.org/cargo/reference/features.html
  - Adopted: treat feature configuration as part of the supported crate build surface and verify meaningful combinations touched by a change.
  - Conditional: test combinations consumers can actually select; exhaustive powerset testing is not implied.
  - Limit: Cargo feature mechanics do not define the crate's semantic compatibility policy.
- **The Rust Programming Language**: https://doc.rust-lang.org/book/
  - Preserved use: ownership, borrowing, traits, concurrency, and public language guidance.

Miri, sanitizers, or concurrency-model tools are conditional evidence. A clean run covers the explored paths and modeled checks, not all possible unsafe or concurrent executions.
