# Source map

Information architecture here means the organization and labeling of a domain so people can find, understand, and orient themselves within it. It is not synonymous with a navigation bar, a database schema, or a visual layout.

## Maintained interpretation

- Start from the real domain: concepts, content, tasks, relationships, terminology, audiences, permissions, lifecycle, scale, and evidence of the words people use.
- Use hierarchy only when a primary parent-child relationship is truthful. Use facets, cross-links, search, filters, contextual entry points, or multiple routes when one tree would distort the domain.
- Labels should be specific, distinguishable, understandable without hidden context, and informed by user language. Internal team ownership and storage structure are weak default organizing principles.
- Preserve orientation: people should be able to tell where they are, recognize a destination, recover from a wrong route, and reach important content through appropriate alternative paths.
- Evaluate findability with representative tasks and realistic terminology. Tree tests or equivalent task evidence can test hierarchy strength; do not substitute stakeholder preference for observed findability.
- Adopt WCAG criteria at their actual scope and level when structure becomes a web interface: 2.4.5 Multiple Ways and 2.4.6 Headings and Labels are AA; 2.4.8 Location is AAA; 3.2.3 Consistent Navigation is AA, not part of Guideline 2.4. Adapt to the declared conformance target and exceptions; reject treating every orientation recommendation as an AA requirement. Deeper conformance work belongs to accessibility specialists.

## Community pattern review

The MIT-licensed Rampstack `information-architecture` skill has useful workflow patterns around inventories, taxonomy, navigation, labels, and findability. It also includes numerical heuristics for navigation size and taxonomy breadth. Those values are not carried into Kory as universal rules because appropriate breadth and depth depend on the domain, medium, content volume, user expertise, and evidence from findability testing.

GOV.UK also publishes numerical child-topic guidance for its own topic taxonomy. Kory retains the transferable principles of bounded domain scope, distinguishable labels, user language, maintainability, and testing without imposing GOV.UK's specific counts on other taxonomies.

## Verification record

- W3C WAI Page Structure Tutorial: official W3C guidance verified 2026-09-04; recheck within 120 days.
- WCAG 2.2, Guideline 2.4 Navigable and 3.2.3 Consistent Navigation: https://www.w3.org/TR/WCAG22/#navigable. Relevant success criteria inspected 2026-09-06; recheck within 180 days or after a new Recommendation.
- GOV.UK Taxonomy principles: official publication verified 2026-09-04; recheck within 120 days.
- Rampstack `information-architecture`: GitHub `main` at `e5bc67519991` inspected 2026-10-03; repository license is MIT. Recheck within 30 days.
