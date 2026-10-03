# Workbench UI

Koryphaios is a working surface, not a product landing page. Keep the warm Kintsugi identity; make content and actions carry the hierarchy.

## Layout

- Use aligned rows and separators for lists, settings, activity and metadata. Do not put a card inside another card just to group text.
- Reserve filled surfaces for editable fields, selected states, popovers, and content that genuinely needs its own boundary.
- Prefer the shared spacing and radius tokens. Compact does not mean unreadable: keep text legible, controls reachable, and useful breathing room between distinct groups.
- Avoid hero-sized empty states, oversized icons, gratuitous gradients, and ambient animation. An empty state should offer the next action, not explain the entire product.
- Check narrow windows as well as desktop. Truncate names, not actions; wrap toolbars when needed.

## Copy

- Use sentence-case actions. Avoid tiny bold uppercase controls and status badges for ordinary metadata.
- Remove obvious explanations and duplicate labels. A worker's name and task usually suffice; do not repeatedly announce that it is a sub-agent.
- Keep explanations that prevent mistakes: permissions, destructive actions, credential scope, errors and unfamiliar concepts.

## Details

- Keep a useful summary visible; reveal verbose output in one explicit disclosure.
- Preserve the user's expansion preference. Do not force open completed logs or collapse content while the user is reading it.
- Bound long logs and maintain scroll anchoring when details expand.
- Use `aria-expanded`, a meaningful accessible label, and keyboard-operable controls. Do not rely solely on hover to expose essential actions.
- Prefer a separator or indentation for expanded content over another rounded bubble.

## Verification

Run `bun run --filter frontend check` and relevant component tests. `e2e/ui-cleanup.spec.ts` exercises settings and detail expansion and writes screenshots to Playwright's test-results directory. Inspect those images as well as the assertions; a passing click test is not a visual review.
