---
name: application-security
description: Secure application input, output, sessions, and sensitive state across trust boundaries. Use when designing input validation, safe sinks, session controls, or application hardening; use authorization-security for permission policy and web-security for browser origin controls.
---

# Application Security

Trace attacker-controlled data and privilege through the real runtime. For every entry point, identify the first trusted interpretation, sensitive sinks, the invariant enforced before each sink, and fail-closed behavior. Earlier validation is not proof if later decoding, canonicalization, deserialization, or interpolation changes meaning.

## Secure design workflow

1. **Map sources, assets, and sinks.** Include APIs/network, files/archives, IPC/deep links, imports/clipboard, config/environment, stored values later reinterpreted, queues/plugins, and third-party responses. Mark secrets, user data, privileged operations, filesystem/process/network access, and durable state.
2. **Trace interpretation end to end.** Follow values through decode/normalize/parse/transform/store/reuse into queries, templates, command arguments, paths, URL fetchers, deserializers/interpreters, logs, and privileged APIs.
3. **Parse narrowly and canonically.** Prefer typed/schema parsing with explicit size/count/range/enumeration limits when the application actually defines those constraints; reject forms that violate that real contract. Canonicalize where identity matters, then enforce policy on the canonical value. Keep semantic validation separate from sink escaping: do not reject otherwise-valid data merely because punctuation would be dangerous in a different sink, and do not invent a new semantic allowlist just to make a sink feel safer.
4. **Use sink-safe APIs.** Parameterize queries; avoid shell interpolation; encode for the actual rendering context; constrain outbound schemes/hosts/resolved destinations; enforce normalized archive/path containment plus resource limits. For subprocesses, use structured argv to an identified executable, then inspect its option and operand semantics: avoiding a shell does not prevent argument injection. Separate data from options with documented mechanisms such as `--` where supported. Derive permitted effects from the actual application and tool contract. Explicitly authorized option passthrough can remain valid within its trust and resource boundary; unknown option semantics are an unresolved risk, not proof of safe opaque data. Do not invent business validation or reject valid punctuation merely to satisfy a fixture.
5. **Bound resource abuse.** Cap body/file/archive size, nesting/decompression, object counts, recursion, time, memory, redirects, and response size. Multiple decoding passes and parser differentials are security-relevant.
6. **Protect session and sensitive state.** Define create/renew/invalidate/expire/revoke semantics, reauthentication for sensitive actions, and safe token/secret storage. Keep secrets out of logs, crash reports, URLs, analytics, and user-facing errors. Treat secrecy as a data-classification property rather than a single field-name regex: access credentials, refresh credentials, bearer/API tokens, authorization material, cookies/session identifiers, recovery material, and application-specific aliases remain sensitive after relabeling, flattening, serialization, or conversion to free-form diagnostic text. Prefer structured allowlisted diagnostics that never receive secret values; where unstructured third-party/error text must be retained, redact the secret-bearing value and common equivalent representations before persistence or display, then strip unsafe control content and bound the result. Verify redaction with multiple credential classes and aliases rather than one sample key.
7. **Keep denial without effects.** Invalid input must not partially mutate state or fall through to privileged defaults. Revalidate persisted commands and authority at restoration and execution; reject or quarantine corrupt state explicitly according to its contract instead of silently treating it as valid empty state. Return bounded safe errors without unsafe reflection.

For filesystem authority, compare the canonical target against the canonical allowed root using path components, including absolute inputs and symlink resolution. An absolute path is never its own authorization. For a new target, resolve existing ancestors and constrain creation without following an escaping link; do not invent nonexistent absolute roots for tests.

## Evidence and review handoff

Produce the source-to-sink/trust map, sink invariants, resource limits, session contract, and negative cases. `security-review` owns broader finding synthesis; `security-verification` independently proves finished controls.

Retain executable regressions for the repaired trust crossings, including a permitted control, a rejected input and recovery after partial work. Assert that denial creates no privileged effect, secrets and terminal controls stay out of persisted diagnostics, and failed staging or persistence leaves a recoverable state. Include cleanup and restoration observations in the handoff; implementation changes alone do not provide that evidence.

## Boundaries

- `authorization-security`: subject/resource/action/field/tenant policy. `secure-authentication`: authenticator/login/recovery/reauth assurance. `web-security`: browser-origin/XSS/CSRF/CSP/CORS/framing/cookie/postMessage rules. `language-runtime-security`: untrusted-code runtimes/sandboxes. `security-review`: finding quality/severity. `security-verification`: final runtime proof.

Use [the maintained source map](references/sources.md) for ASVS 5.0.0 requirements, current WSTG test taxonomy, SSDF secure-development principles, and OWASP source/sink guidance.
