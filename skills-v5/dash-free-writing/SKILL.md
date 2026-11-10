---
name: dash-free-writing
description: Revise prose to a requested style without dash punctuation or hyphenated wording while preserving meaning and exact technical material. Use when the user asks for no dashes, removal of em or en dashes, avoidance of hyphens, or a dash free rewrite; not for changing code, identifiers, mathematical signs, or quoted evidence.
---

# Writing without dashes

Apply the requested house style to authored prose. This is a style preference, not a claim that dashes are incorrect or unused. The broader documents communication skill owns audience, factual fidelity, and document structure.

## Rewrite the sentence, not the character

Replace an aside with parentheses or a separate sentence. Use a colon for an explanation and a conjunction when it expresses the relationship more clearly. Express a range with “to” or “through”. When removing a dash from a range, keep the endpoint tokens and their representation unchanged, including leading zeros, clock notation, units, and timezone labels. “With words” means use a word separator such as “to” or “through”; it does not mean spell out numeric endpoints unless the user separately asks to restyle them. Rephrase a compound as an ordinary phrase instead of deleting the joining mark and leaving ambiguous words. Preserve negation, uncertainty, conditions, attribution, numbers, units, and scope.

Cover em, en, figure, horizontal, fullwidth, nonbreaking, and ordinary hyphen forms when they function as prose punctuation. Do not replace them with double hyphens, another Unicode dash, or a visually similar minus sign. Choose natural wording rather than a mechanical punctuation substitution.

## Preserve exact material

Keep code, command flags, URLs, email addresses, paths, identifiers, versions, dates in required machine formats, mathematical operators, and exact quotations unchanged. Keep Markdown frontmatter, tables, list markers, and other required syntax valid. Rephrase surrounding prose, not a protected token. When the request is exact transcription or reproduction, preserve the source rather than applying this style to it. A later explicit style instruction can override this preference.

For mixed prose and technical material, identify the protected spans before editing. If a character might be an identifier or significant notation, retain it and disclose the exception rather than guessing. Never apply a blanket character deletion to a repository or document.

## Check the result

Read the revision against the source for meaning and readability. For Markdown or text, `scripts/check-prose.mjs` reports dash candidates without changing files. Pass literal tokens that must remain exact through its `--literal` option. Its conservative syntax exclusions are not a complete Markdown parser or a semantic verifier; inspect both findings and protected regions. A clean scan alone does not prove a faithful rewrite.

Use [the source map](references/sources.md) when refreshing punctuation distinctions or format boundaries.
