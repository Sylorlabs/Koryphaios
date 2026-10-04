# Computer use: architecture, platform constraints, and security acceptance

This document describes the first-party computer-use contract and its security requirements. **An adapter existing in the repository is not evidence that its native operations work on a particular OS.** Capability reporting and errors from the installed adapter are authoritative; unsupported operations must fail closed. The manual matrix below is a release checklist, not a record of completed runtime verification.

Research reviewed 2026-10-02. Native API references are linked below; their version requirements are not interchangeable with the minimum version of a particular Koryphaios helper build.

## Scope and shared architecture

The common contract is `shared/src/computer-use.ts`; effective configuration is `AgentSettings.computerUse`. Desktop adapters live under `backend/src/computer-use/`. The intended execution path is:

1. A provider invokes a structured `computer_*` tool through `ToolRegistry` (including CLI calls through the authenticated Kory MCP bridge).
2. The host obtains the actual session, orchestration role, interaction mode, and **current** settings. Agent-supplied role labels are not authority.
3. The dedicated computer policy checks enablement, supported capability, permission tier, role, and exact application grant. Generic tool permission checks can further restrict access, never broaden it.
4. The host resolves the supplied `appId` and `windowId` against live OS targets. Display labels and window titles are untrusted descriptive content, not identities.
5. If required, a user approval identifies the concrete target and action. Re-resolve target identity and re-evaluate current policy after approval and again when queued work begins. Approval is for that action, not permission to substitute another app or execute future actions.
6. A bounded, cancellable adapter operation executes under a host-wide desktop-operation lock. Native helpers accept structured data, not agent-authored scripts, executable paths, or shell fragments.
7. Observation returns bounded PNG image content to the authorized requesting model. It must not silently become a full-desktop capture, a workspace file, or a base64 string in ordinary logs.

The tool vocabulary now includes `computer_status`, `computer_list_apps`, `computer_observe`, `computer_click`, `computer_double_click`, `computer_move`, `computer_drag`, `computer_type`, `computer_key`, `computer_scroll`, `computer_wait`, and `computer_focus`. These expose a Codex/Anthropic-style action taxonomy at the Kory tool layer; actual platform support is negotiated by the native adapter and unsupported operations fail accurately rather than pretending success. Status reports prerequisites without taking a screenshot. Discovery reveals window titles and application metadata, so it is also permission-controlled. Settings UI discovery is an explicit authenticated user action, not an ambient background scan. The user-facing control routes are `GET /api/v1/computer-use/status`, `GET /api/v1/computer-use/apps`, and `POST /api/v1/computer-use/stop`.

### Permission layers

Computer use is **disabled by default**, with an empty app allowlist. The tier and role defaults ask rather than silently allow, except YOLO defaults to allow without Kory approval prompts. Plan and Critic are configurable through the same matrix. The strictest applicable decision wins: `block` > `ask` > `allow`; YOLO converts applicable asks to allow but never overrides explicit blocks or native OS failures.

| Layer             | Values                                                      | Required behavior                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Master enablement | Enabled / disabled                                          | Disabled denies use regardless of other grants; status may explain why.                                                                                                                                                                  |
| Permission tier   | `plan`, `ask`, `edits`, `guarded`, `yolo`, `custom`         | Every tier uses the separate computer matrix. YOLO and generic auto-run never imply desktop authorization.                                                                                                                               |
| Agent role        | `manager`, `worker`, `critic`                               | Roles are independent of tiers. Worker delegation must use the effective worker context, not silently become manager.                                                                                                                    |
| Application       | Exact resolved `appId` plus per-capability settings         | No matching grant means denied. Missing app capability means blocked. Discover is the explicit app-independent exception.                                                                                                                |
| Hard restrictions | Explicit blocks; unsupported capabilities                   | Plan and Critic are not implicitly read-only; their role/tier/app settings decide. Unavailable native functionality still fails at execution. New pointer/timing actions are exposed while native adapters progressively implement them. |
| OS consent        | TCC, desktop/session access, portal grants, integrity level | Necessary independently of Kory approval. Kory cannot grant or bypass it.                                                                                                                                                                |

Capabilities are `discover`, `observe`, `interact`, `manageWindows`, `clipboardRead`, `clipboardWrite`, `transfer`, and `sensitive`. Clipboard, transfer, and sensitive operations are reserved; there are no dedicated tools implementing them. They must not be presented as working controls. `computer_focus` is a mutation, not read-only observation.

**YOLO semantics:** YOLO means zero Koryphaios approval prompts for actions that are allowed by the current role/app policy. It does not grant OS permissions, implement unsupported actions, or override explicit `block` entries.

**Important limitation:** blocking a reserved capability is not semantic prevention of that activity through a generic GUI. Clicking “Send”, uploading through a browser dialog, or entering a payment form can be sensitive while still looking like ordinary clicks/typing. Copy/paste shortcuts can access the clipboard without a clipboard tool. A browser app grant is not a website, tab, account, or filesystem grant. Where interaction is supported, retain per-action approval for high-risk apps and require human handoff for secrets, authentication, purchases, external sends, destructive operations, installations, and permission changes. Do not describe the reserved settings as a complete sensitive-action detector.

## Native prerequisites and limitations

### Adapter implementation reviewed

The native source reviewed for this change intentionally avoids global keyboard/pointer injection. The expanded action schema does not silently turn unsupported actions into global injection: the executor must gain a target-bound implementation before an action becomes operational. A broad `interact` capability means **at least one** interaction is implemented, not that every interaction tool works.

| Adapter source        | Observation                                                                                                      | Interaction                                                                                    | Explicit boundary                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform-macos.ts`   | macOS 14+ `SCScreenshotManager` with single-window ScreenCaptureKit filter and existing Screen Recording consent | Semantic AXPress at a validated element; AXSelectedText insertion where supported; raise/focus | Requires Accessibility for interaction. No global key or scroll injection; ambiguous AX/window bindings and secure text fields rejected.                  |
| `platform-windows.ts` | Window-scoped `PrintWindow` through static PowerShell/C#                                                         | UIAutomation InvokePattern on a validated descendant; foreground focus                         | Windows PowerShell 5.1, .NET desktop UIAutomation and System.Drawing required. No type/key/scroll injection. No WGC picker is implemented by this helper. |
| `platform-linux.ts`   | XComposite named-window pixmap only; requires an existing compositor backing surface                             | Direct window focus only                                                                       | Local X11, Python 3, XRes 1.2 and XComposite required. No click/type/key/scroll; Wayland and XWayland rejected.                                           |

This table is source review, not runtime certification. For Linux and helper build/launch requirements, consult the adapter's current status and the constraints below; do not infer functionality from tool names.

### macOS

Authoritative native building blocks are [ScreenCaptureKit][apple-capture] for content-filtered observation, Accessibility APIs for target inspection/actions, and appropriate native event APIs for any implemented input.

- Screen capture and Accessibility are **separate** privacy permissions. A screen-recording grant does not imply input permission. `AXIsProcessTrustedWithOptions` tests whether the _current process_ is trusted; displaying its asynchronous prompt does not change a false return value into success. See [Apple's trust-check API][apple-ax].
- The actual helper/application identity must receive the relevant grant under System Settings → Privacy & Security. Development shells, helper executables, packaged apps, and replacement builds may have different authorization behavior. Do not tell users to grant every terminal or reset TCC to make automation work.
- If an adapter invokes Apple Events/System Events, Automation consent is an additional possible requirement; it is not synonymous with Accessibility. Prefer a narrowly scoped native helper over a broad scripting fallback.
- Apple's current [capture sample][apple-capture] requires macOS 15 and Xcode 16 and documents a restart after initially granting capture access. Those are requirements of that sample, **not a claim that all ScreenCaptureKit APIs first appeared in macOS 15**. A source-built helper additionally needs its declared Swift/Xcode command-line toolchain; a shipped compiled helper should not require users to compile it.
- Use a single-window `SCContentFilter(desktopIndependentWindow:)` or another verified window-isolated API, not a desktop screenshot followed by a crop. Disable audio/microphone capture: it is outside this contract.
- Hidden/minimized windows, protected content, modal sheets, secure text fields, fullscreen Spaces, Retina scaling, and multi-display coordinates require explicit testing. Refuse unsupported cases; do not synthesize success from a zero/blank image or a posted event alone.
- An Accessibility grant is powerful host access, not a per-app sandbox. No automatic privilege escalation, TCC modification, or undocumented bypass is acceptable.

### Windows

The current helper uses [PrintWindow][windows-printwindow], not Windows.Graphics.Capture. PrintWindow asks the target application to render into a device context and is synchronous; a non-cooperating/GPU/protected app may return unusable or blank content. There is no picker-consent flow or guaranteed capture indicator in this helper. A returned PNG alone is not proof of a useful observation. UIAutomation [InvokePattern.Invoke][windows-invoke] invokes a semantic control action rather than a pointer click and may also block depending on the target provider. Both require enforced helper timeouts.

As a proposed modern capture alternative, [Windows.Graphics.Capture][windows-capture] supports display or application-window capture; the standard picker path obtains user selection and displays a capture indicator. Check `GraphicsCaptureSession.IsSupported()` at runtime; picker cancellation is denial, not permission to capture the desktop. Desktop interop and packaging models have different setup requirements, so report the actual adapter implementation rather than promising the picker for a helper that uses another capture API.

- Run in an interactive user desktop session. A background service, locked desktop, secure desktop, or disconnected remote session is not equivalent to an unlocked local session.
- An implementation using a compiled native helper needs its declared Windows SDK/runtime at build or installation time. An implementation using PowerShell/.NET must explicitly detect the executable and required assemblies and run fixed helper code, not interpolate titles or user text into code.
- Bind HWND to the live owning process and executable identity and revalidate it. Window handles and process IDs can be recycled; a title or process basename is not a durable security identity. Packaged apps and brokered windows need separate handling.
- [SendInput][windows-sendinput] injects into the input stream and is limited by User Interface Privilege Isolation (UIPI): callers can inject only into equal/lower integrity processes. Its error reporting does not reliably identify UIPI as the cause. An elevated target must fail without relaunching Kory as administrator or changing UAC policy.
- Foreground focus can change; a focus check followed by global input is not atomic target confinement. Existing pressed modifiers can change input semantics. Reject an unsafe state instead of assuming focus or forcibly modifying unrelated user input state.
- DPI awareness, mixed-scale monitors, negative monitor coordinates, keyboard layout/IME, GPU-rendered windows, protected content, and minimized-window capture differ by API and require native tests. Do not fall back from a failed per-window capture to desktop BitBlt/crop.

### Linux X11

X11 requires an active X server, valid `DISPLAY` and authorized connection, and the exact helper dependencies reported by the adapter. Utilities such as `wmctrl`, `xprop`, or `xdotool` are optional implementation choices, not a portable Linux API guarantee. Missing dependencies must produce an unavailable capability, never `sudo`, package installation, `xhost +`, or an unconfined fallback.

- [XTEST][x11-xtest] synthesizes device input with normal event propagation and grab activation. It is not an app-targeted input sandbox; focus and passive/global grabs can redirect effects.
- **A window ID alone does not prove screenshot isolation.** The [X.Org SECURITY specification][x11-security] explicitly notes implementations of `GetImage` can return obscuring-window pixels in undefined regions when the target has no backing store. A command named “capture window” is insufficient evidence; use a proven isolated backing surface or mark observation unsupported. Test with a sensitive decoy window overlapping the allowed app.
- `_NET_WM_PID`, window class, and title are not strong authenticated application identity. A trustworthy same-host process/executable mapping and a defined threat model are required; X11 clients are not generally isolated from one another merely by this allowlist.
- Do not equate an X11 file/workspace sandbox with a desktop sandbox: giving a process the X socket and authorization may grant broad desktop access. A disposable desktop session/VM provides a stronger boundary.

### Linux Wayland

Wayland is **unsupported until an explicit portal-backed adapter is implemented and validated**. The presence of `DISPLAY` for XWayland does not justify treating a Wayland session as fully supported X11 or bypassing compositor consent.

The native extension path is [XDG ScreenCast][portal-screencast] plus [RemoteDesktop][portal-remote] and PipeWire, with a compatible compositor-specific portal backend and session D-Bus. Probe available interfaces/versions, source types, and device types rather than assuming all distributions implement the latest spec.

- ScreenCast's default source type is **monitor**. A future implementation must explicitly request `WINDOW`, reject monitor sources, and verify the returned stream is the intended allowed target. Merely receiving a stream does not establish Kory application identity.
- RemoteDesktop `Start` typically asks the user to choose devices/content. A window capture grant and a remote keyboard/pointer grant are distinct; remote input is not automatically confined to that window.
- Current RemoteDesktop documentation recommends EIS/libei after `ConnectToEIS`; once connected, do not also send the D-Bus `Notify*` input methods.
- Do not persist portal permissions by default (`persist_mode=0`). Restore tokens are single-use and may fail after revocation or target disappearance. Stop must close portal sessions and release stream/device resources.
- Stream logical coordinates differ from pixel coordinates. Current ScreenCast version 6 recommends `pipewire-serial`/`PW_KEY_TARGET_OBJECT` over reusable PipeWire node IDs; older backends need guarded lifecycle handling rather than assuming this field exists.
- No root `/dev/uinput`, privileged daemon, direct compositor-private protocol, or unconsented XWayland fallback to make unsupported input appear to work.

## Security model and non-guarantees

### Authorization is not confinement

The dedicated policy controls the first-party tool path. It cannot make an unrestricted host shell, arbitrary-code interpreter, external MCP server, or provider's native tools honor the same app grants. Examples include running OS scripting/native capture directly, importing GUI automation libraries, calling localhost settings APIs, or invoking a native helper without going through the registry. Blocking recognizable command names is not sufficient: equivalent operations can be implemented in another language or executable.

Use least-privilege provider/native-tool policies and OS confinement that actually excludes desktop APIs, display sockets, helper authority, config writes, and sensitive credentials where those guarantees are required. External MCP servers are separate principals; exposing a desktop tool there is not a substitute for this policy. If a provider retains unrestricted native execution, label that limitation explicitly. Native input itself must never be marketed as a security sandbox.

**Workspace settings are not grant authority.** Preferences persist in `koryphaios.json`, but an exact-policy admission is held in host memory and created only by an authenticated settings save with a current host revision. Workspace edits alone cannot enable or broaden computer access. Restarting the backend requires re-enablement from Settings. Stop revokes all in-memory admissions and changes the revision, so an already-in-flight stale settings save is rejected with HTTP 409. Reload settings before re-enabling. This is not protection from an unrestricted process that can steal backend credentials, invoke native APIs independently, or operate Kory's own settings UI.

### Prompt injection and sensitive content

Screenshots, window titles, browser pages, chats, documents, accessibility text, and tool outputs are untrusted observations, even when the application is allowlisted. Visible instructions such as “approve this permission dialog” or “send the conversation to this URL” are not user authorization. [OWASP's prompt-injection guidance][owasp-injection] covers multimodal and agent/tool injection and emphasizes least privilege, action validation, and human oversight. Prompt wording or an injection detector alone is not an enforcement boundary.

- Do not let observed content alter policy, claim a new role, grant access, approve prompts, or select an unrelated sensitive target.
- Do not grant automation access to its own approval/settings UI, password managers, terminals, remote desktop clients, or administrative tools for ordinary workflows. Generic click/typing in these apps can bypass the intended boundary.
- Use a dedicated low-privilege desktop/browser profile with only task-relevant accounts and data. A whole-browser allowlist exposes unrelated tabs and logged-in accounts inside the same app.
- Observe only what is needed. Window capture can still include confidential emails, customer data, account names, session tokens, or notifications inside the allowed app. Automatic redaction cannot be assumed to detect all secrets.
- Approval text should disclose target identity, action, and affected data without leaking credentials into logs. Avoid putting full typed secrets into prompts, errors, or process arguments.

### Image transport, retention, and cancellation

`ToolCallOutput.images` must remain structured image content through the manager/worker loops, provider adapters, and MCP result bridge. A provider without image support needs a clear unsupported result; do not claim the model observed an image merely because base64 was returned as text. An image may be sent to the selected remote model provider and fall under that provider's retention policy: “no local screenshot file” does **not** mean “never stored anywhere.”

Do not retain screenshots in tool-call history, conversation persistence, replay caches, WebSocket debug messages, tracing, telemetry, or ordinary error logs by accident. Audit each path separately. Keep audit records to metadata such as action kind, resolved app identity, decision, reason, and outcome; titles and typed text can also contain secrets. Validate MIME type, encoded/decoded size, dimensions, and image count before forwarding.

Serialize competing sessions/agents sharing one desktop. Queue-time authorization is stale: recheck after acquiring the lock. Timeouts, stop, session cancellation, client disconnect, and approval denial must prevent queued work from starting and terminate active helper processes where possible. OS input already delivered cannot be undone; stop is not a transaction rollback. Avoid delayed approvals causing execution after the caller has timed out, and never retry non-idempotent actions blindly.

## Setup and verified state

1. Open Agent Settings → Computer Use. Check platform status before enabling.
2. Install the documented native prerequisites yourself. On macOS the development helper currently requires Xcode Command Line Tools and the macOS 14 SDK; its first compilation can take about a minute. A prebuilt signed production helper is not yet packaged.
3. Grant the actual helper the required OS privacy permissions manually; Kory never changes OS permissions for you.
4. Explicitly discover running apps, add the intended identity, and configure observation/interaction for its app grant, active permission preset, and agent role. Every new app starts blocked.
5. Enable and save. Use one-shot approvals for sensitive apps. Use a vision-capable provider for observations; screenshots are transmitted to that provider.
6. Stop revokes active grants. Reload/re-enable after Stop or backend restart.

Verified locally: 141 focused backend/regression tests, 20 focused frontend tests, backend typecheck and frontend check (zero errors/warnings); macOS Swift helper compilation and non-mutating capability status; embedded-source Bun compilation. The current Mac reported discovery/accessibility interaction/focus available, but observation unavailable because Screen Recording consent was absent. The broader frontend run reported 757 passing tests and one unrelated ManagerFeed button-label expectation failure. Actual screenshot/input tests and Windows/Linux native runtime certification remain outstanding. Wayland, managed browser domain isolation, global emergency shortcut/always-visible activity overlay, observation-version-bound coordinates, durable audit UI, and production signed helper packaging are **not implemented** in this increment. Do not treat this as full production cross-platform computer use.

## Manual acceptance matrix

Record OS/build, desktop/session type, helper/dependency versions, provider, test fixture, observed result, and evidence for every executed row. Use sacrificial local fixtures and decoy secrets, never real credentials or payments. All rows below are **not run by this documentation/research task**; unsupported native capabilities should pass refusal tests, not be claimed as positive functional coverage.

| Test                             | Platforms / contexts                                                                  | Expected result                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh configuration and reset    | All; each role/tier                                                                   | Disabled, no app grants, no capture/input. Reset must not share mutable nested defaults across sessions.                                                     |
| Restrictive precedence           | All 6 tiers × all 3 roles                                                             | Explicit app/tier/role block wins; YOLO converts Ask to Allow and generic allowlists cannot override blocks. Missing/duplicate/malformed grants fail closed. |
| Configurable Plan/Critic actions | Plan interaction mode and critic, including custom allow                              | Action behavior follows their configured tier/role/app gates; explicit blocks and unsupported native operations still deny.                                  |
| Trusted identity                 | Renamed windows, duplicate labels, recycled PID/window ID, restarted app              | Target is resolved from OS identity; mismatches abort, never silently retarget.                                                                              |
| Approval race                    | Revoke app, disable feature, change role/tier, close target while approval is pending | Approval does not restore a revoked grant or authorize a replacement target.                                                                                 |
| Settings self-grant              | File tools, patch, shell, malicious checkout, direct settings HTTP requests           | Untrusted agent cannot elevate authority; otherwise record a release-blocking boundary failure.                                                              |
| Native consent denial/revocation | macOS capture/AX; Windows picker; future Wayland portals                              | Action denied with accurate remediation; no privilege or capture fallback.                                                                                   |
| macOS helper identity            | Development and packaged launch; grant revoked; restart                               | Status reflects actual helper trust; no claim that a different app's grant suffices.                                                                         |
| Windows privilege/session        | Standard versus elevated target; locked/UAC desktop; RDP disconnect                   | Unsupported/elevated/secure cases fail safely; never elevate to recover.                                                                                     |
| Linux dependency/session         | X11, Wayland with XWayland, headless; missing binary/display permission               | Accurate unavailable status; no fallback through root, uinput, or xhost.                                                                                     |
| Window-only image isolation      | Allowed app overlapped by disallowed decoy; modal/fullscreen/minimized windows        | No decoy pixels; unsupported capture returns error, not a desktop crop or false success.                                                                     |
| Focus and input interference     | User steals focus, same-app second window, popup, global shortcuts, held modifiers    | No input to a disallowed target; if not guaranteeable, interaction is unavailable and documented.                                                            |
| Coordinate correctness           | Mixed DPI/Retina, negative monitors, resize between observation and action            | Bounds and scaling checked; stale/invalid coordinates rejected.                                                                                              |
| Text and command boundaries      | Unicode/IME, quotes, newlines, shell metacharacters, leading dashes, malicious title  | Data remains data; no script/argument injection or unintended shortcuts.                                                                                     |
| Sensitive equivalents            | Clipboard shortcuts, Send/Purchase, upload dialog, settings page                      | Explicit handoff/approval or unsupported; no assertion that reserved flags detect arbitrary GUI meaning.                                                     |
| Injection                        | Image/title/page asking to alter policy or exfiltrate                                 | Observation does not become authority; subsequent tool policy remains enforced.                                                                              |
| Concurrency and stop             | Two agents/two sessions, queued action, helper hang, pending approval                 | No interleaved input; stop cancels active and queued work; bounded recovery without retrying mutations.                                                      |
| MCP/provider transport           | Every supported manager/worker/critic/provider route                                  | Same policy and actual role; image delivered as image; unsupported vision fails honestly.                                                                    |
| Caller timeout                   | MCP bridge timeout, HTTP abort, provider cancellation while awaiting approval         | No orphan action executes after the caller abandons it; late approval cannot revive it.                                                                      |
| Privacy/retention                | Logs, persisted messages, traces, UI events, temporary files                          | No unintended image/text retention or broadcast; provider transmission is disclosed.                                                                         |
| Broad bypass                     | Native CLI tools, arbitrary shell/code, external MCP                                  | Confinement verified or limitation explicitly recorded; never claim first-party policy constrains unrelated execution.                                       |

Unit tests should separately exhaust permission combinations, schema normalization, unknown roles/tiers, hard restrictions, settings persistence, queue cancellation, and all dispatch paths with fake adapters. Build/typecheck and fake-adapter tests are useful but do not substitute for native focus, capture-isolation, input, and consent tests.

## Authoritative references

[apple-capture]: https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos
[apple-ax]: https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions
[windows-capture]: https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture
[windows-sendinput]: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
[windows-printwindow]: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow
[windows-invoke]: https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.invokepattern.invoke?view=windowsdesktop-9.0
[x11-xtest]: https://www.x.org/releases/current/doc/xextproto/xtest.html
[x11-security]: https://www.x.org/releases/current/doc/xextproto/security.html
[portal-screencast]: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html
[portal-remote]: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html
[owasp-injection]: https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html

Apple's JavaScript-rendered documentation was also inspected through its official documentation JSON endpoints: [capture sample](https://developer.apple.com/tutorials/data/documentation/screencapturekit/capturing-screen-content-in-macos.json) and [AX trust check](https://developer.apple.com/tutorials/data/documentation/applicationservices/1459186-axisprocesstrustedwithoptions.json).
