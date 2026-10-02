# Source map

`web-interface` is the browser-specific child of cross-medium frontend engineering. It owns HTML/CSS/browser navigation and interaction behavior only after web evidence exists. Framework-specific implementation belongs to React, Svelte, Vue, Angular, Next.js, or other qualified children when their runtime is confirmed.

## Maintained interpretation

- Inspect the actual browser product first: routes and URL model, framework and rendering mode, component library and tokens, content and real assets, data-loading boundaries, supported browsers/viewports, existing density and visual language, and the state of the rendered page. Do not infer the stack from the requested appearance.
- Use HTML according to its semantics and browser interaction model. Prefer native elements and behaviors when they satisfy the contract, but preserve repository-required shared controls and design-system primitives. ARIA or custom behavior should not erase working native semantics.
- Treat URL, history, navigation, refresh, deep links, focus restoration, and document structure as product behavior. A visually correct single state is not sufficient if navigation loses context or direct URLs fail.
- Model network uncertainty explicitly: initial loading, partial data, revalidation, stale data where supported, empty results, validation failures, permission errors, request failure, retry, cancellation or replacement, and races between navigation or requests. Keep prior usable content when the product contract supports it instead of blanking the page gratuitously.
- Responsive behavior derives from available space and content/task priority. Media and container queries are tools, not a mandate for universal named device breakpoints. Validate zoom, reflow, long or localized content, narrow and wide windows, and any repository-supported orientation or embedded-browser constraints.
- Respect browser-exposed user preferences such as reduced motion when motion is non-essential. Hover, pointer precision, color scheme, contrast preferences, and other media features are capabilities or preferences to evaluate, not assumptions about a device category.
- Accessibility work follows WCAG and platform semantics where applicable: keyboard operation, meaningful focus order and visibility, programmatic names/roles/states, landmarks and headings, labels and errors, target interaction, zoom/reflow, and status feedback. Route formal conformance claims to accessibility verification.
- Visual direction starts from purpose, audience, brand, content, references, and product identity. Generic centered heroes, interchangeable card grids, ornamental glass or glow, arbitrary gradients, fake telemetry, generic placeholder content, and purposeless motion are review warnings when repeated without evidence. They are not prohibited motifs.
- Verify in the real browser: supported engines when relevant, representative viewports, keyboard and pointer/touch where supported, reduced motion, slow/failed requests, empty/partial/error states, refresh and deep links, console/runtime errors, and visual hierarchy. Captures support visual evidence but do not prove behavior or semantics.

## Community-pattern review

SecondSky's MIT-licensed `frontend-design` skill is valuable for forcing an explicit aesthetic direction and rejecting context-free generated design. Kory preserves the intent while rejecting rigid universal prescriptions such as banning Inter/system fonts, forcing dramatic visual differentiation, fixed 320/768/1024/1440 breakpoints, or assuming a particular animation/performance recipe. Those decisions remain product-, content-, browser-, and evidence-specific.

## Verification record

- WHATWG HTML Living Standard interaction sections: inspected 2026-09-04; the living standard reported an update on 2026-09-04; recheck within 30 days.
- W3C Media Queries Level 5: inspected 2026-09-04; recheck within 90 days.
- W3C WCAG 2.2 Recommendation and current understanding guidance: inspected 2026-09-04; recheck supporting guidance within 90 days and the Recommendation within 365 days.
- Google web.dev Learn Responsive Design: inspected 2026-09-04; recheck within 90 days.
- secondsky/claude-skills `frontend-design` on `main`: inspected 2026-09-04; recheck within 30 days.
