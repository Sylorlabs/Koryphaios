/**
 * Remove quoted text only when the request explicitly marks that text as
 * historical, pasted, or otherwise non-task context. Ordinary quoted
 * identifiers remain visible to classification and skill matching.
 */
export function routingRelevantText(value: string): string {
  const quotation =
    /"[^"\n]{1,1000}"|(?<![\p{L}\p{N}])'[^'\n]{1,1000}'(?![\p{L}\p{N}])|“[^”\n]{1,1000}”|‘[^’\n]{1,1000}’|`[^`\n]{1,1000}`/gu;
  const quotes = [...value.matchAll(quotation)];
  const explicitQuoteRejection =
    /\b(?:ignore (?:that|the) quote|quote is not the task|quoted text is not the task)\b/i.test(
      value,
    );
  const withoutDecoyQuotes = value.replace(quotation, (quoted, offset: number) => {
    // Scope a decoy annotation to its own sentence/clause, not every quoted
    // identifier in the request. Later live requests must remain routable.
    const prefix =
      value
        .slice(0, offset)
        .split(/[.!?;\n]/u)
        .at(-1) ?? '';
    const currentClause =
      prefix.split(/\b(?:actual|current|new) (?:task|request)\b/iu).at(-1) ?? prefix;
    const decoyPrefix =
      /\b(?:historical context only|ignore (?:the )?quoted (?:readme|section|note|example)|quoted (?:example|old issue|old memo|issue|comment|instruction|directive)|(?:old|historical|archived) (?:issue|ticket|comment|note|memo|email)|pasted (?:article|issue|comment)|(?:test|parser) fixture (?:contains|says)|(?:inert|example) (?:text|string))\b/iu.test(
        currentClause,
      );
    const historicalObject =
      /\b(?:old|historical|archived|legacy|obsolete|rejected)\s+(?:(?:incident|design|engineering|implementation|support|project|release|quoted)\s+){0,3}(?:incident|issue|ticket|comment|note|memo|email|report|readme|plan|proposal|task|instruction|diagnosis|title|checklist)\b/iu.test(
        currentClause,
      );
    const dataObject =
      /\b(?:fixture(?:['’]s)?|(?:test[- ]data|parser|unit[- ]test)\s+(?:field|input|string)|(?:log|alert)\s+(?:line|record|message)|tool\s+(?:result|output)|sample\s+(?:text|string|input)|literal\s+(?:phrase|string|text))\b[^\n.!?]{0,180}$/iu.test(
        currentClause,
      );
    const storedLiteral =
      /\b(?:stores?|contains?|includes?)\s+(?:the\s+)?(?:literal\s+)?(?:text|string|phrase|value|label)\s*$/iu.test(
        currentClause,
      );
    const annotatedHistoricalQuote =
      /^\s*(?:is\s+(?:historical(?:\s+only)?|obsolete|inert)|[.;]?\s*(?:ignore\s+(?:that|the|those)\s+(?:historical|obsolete|abandoned)|treat\s+(?:that|this|it)\s+as\s+(?:history|historical(?:\s+(?:text|context))?|inert\s+data)))/iu.test(
        value.slice(offset + quoted.length, offset + quoted.length + 180),
      );
    const suffix = value.slice(offset + quoted.length, offset + quoted.length + 180);
    const decoySuffix =
      /^\s*(?:is (?:a |an )?(?:(?:test|parser) )?fixture,? not a request|[.;]?\s*(?:treat (?:that|this|it) as (?:data|historical(?:\s+(?:text|context))?)|ignore (?:that|the) quote|(?:that|this) is not the (?:current )?task))/iu.test(
        suffix,
      );
    return decoyPrefix ||
      historicalObject ||
      dataObject ||
      storedLiteral ||
      decoySuffix ||
      annotatedHistoricalQuote ||
      (quotes.length === 1 && explicitQuoteRejection)
      ? ' '
      : quoted;
  });
  // Quotation marks are not required for an explicitly historical statement.
  // Discard only the historical clause immediately before a declared current
  // task; requests to inspect or implement an old proposal retain their subject.
  const withoutHistoricalClauses = withoutDecoyQuotes.replace(
    /(^|[.!?;\n]\s*)(?:(?:a|an|the)\s+)?(?:old|historical|archived|obsolete|rejected)\s+(?:(?:incident|design|engineering|implementation|support|project|release)\s+){0,3}(?:issue|ticket|comment|note|memo|email|report|readme|plan|proposal|task|instruction|diagnosis|title|checklist)\s+(?:discussed|mentioned|requested|said|says|mentions|asked\s+for)\b[^.!?;\n]{0,1000}(?=[.!?;\n]\s*(?:(?:the\s+)?(?:actual|current|new)\s+(?:task|request)|today['’]s\s+(?:task|request))\s+is\b)/giu,
    '$1 ',
  );
  // An explicit exclusive current-task statement supersedes earlier quoted,
  // incident, or release-note context. Keep later instructions in full.
  const exclusiveScope =
    /\b(?:the\s+)?(?:(?:active|actual|current)\s+(?:task|request)|task\s+here|request\s+here)\s+is\s+(?:solely|only)\b/iu.exec(
      withoutHistoricalClauses,
    );
  const currentTaskText = exclusiveScope
    ? withoutHistoricalClauses.slice(exclusiveScope.index)
    : withoutHistoricalClauses;
  // Names of data fields/categories are not requests to operate the technology
  // named by that value. Retain the surrounding analysis or implementation task.
  return currentTaskText
    .replace(
      /\b(?:fixture(?:['’]s)?\s+(?:name|label)|(?:data|test[- ]data)\s+field)\s+(?:is|named|called)\s+[^,;.!?\n]{1,100}(?=[,;.!?\n]|$)/giu,
      'fixture label ',
    )
    .replace(
      /\b(?:category|series|column|course)\s+(?:named|labelled|labeled|called)\s+([\p{L}\p{N}+#_.-]+)(?=\s+(?:has|is|was|contains|in|from)\b)/giu,
      'data category ',
    );
}

/** Keep sentence scope while preserving dotted identifiers such as go.mod and .NET. */
export function routingClauses(value: string): string[] {
  return value
    .split(/(?:[.!?;]\s+(?=\S)|\n+|\s*[—–]\s*|\b(?:but|however)\b)/giu)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/** A supplied-artifact transformation is not permission to operate its subject. */
export function isSuppliedArtifactOnlyTask(value: string): boolean {
  const text = routingRelevantText(value);
  const transform =
    /\b(?:copyedit|copy edit|reformat|rewrite|translate|summariz[es]|summari[sz]e|extract|document|write|total|analy[sz]e)\b/iu.test(
      text,
    );
  const suppliedArtifact =
    /\b(?:supplied|provided|pasted|quoted|existing)\b[\s\S]{0,180}\b(?:notes?|announcement|article|email|reply|help\s+text|commands?|manifest|report|log|list|chart|table|paragraph|guide|output|document)\b/iu.test(
      text,
    ) ||
    /\b(?:commands?|facts?|text|data|output)\b[^.!?\n]{0,80}\b(?:already\s+provided|already\s+supplied)\b/iu.test(
      text,
    );
  const closedScope =
    /\b(?:no\s+(?:(?:software|code|build|runtime|service|programming|toolchain)[,/\s]+)*(?:changes?|work|analysis|investigation)|do\s+not\s+(?:diagnose\s+or\s+)?(?:modify|change|inspect|execute|run|research|investigate)|not\s+inspecting\s+implementation|make\s+no\s+(?:changes|software\s+changes)|without\s+(?:running|inspecting|inferring|changing)|only\s+(?:wording|formatting|the\s+supplied)|using\s+only|use\s+only|only\s+wording\s+and\s+formatting)\b/iu.test(
      text,
    );
  // A request to implement a parser that transforms text is still software work.
  const liveCodeChange =
    /\b(?:fix|repair|implement|debug|test|profile|refactor|upgrade)\b[^.!?\n]{0,100}\b(?:code|function|class|service|component|parser|serializer|runtime|library|package|handler|compiler|build|executor)\b/iu.test(
      text,
    );
  return transform && suppliedArtifact && closedScope && !liveCodeChange;
}
