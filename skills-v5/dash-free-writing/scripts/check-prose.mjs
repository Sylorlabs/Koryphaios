#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Read-only style signal, not a semantic verifier or a complete Markdown parser. */
export function lintProse(text, { literals = [] } = {}) {
  if (
    typeof text !== 'string' ||
    !Array.isArray(literals) ||
    literals.some((v) => typeof v !== 'string' || !v)
  ) {
    throw new TypeError('Expected text and an array of nonempty literal strings');
  }
  const protectedOffsets = new Uint8Array(text.length);
  const protect = (start, end) => protectedOffsets.fill(1, start, end);
  let offset = 0;
  let fence = null;
  const lines = text.split(/(?<=\n)/u);
  const metadataEnd = lines.findIndex(
    (line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/u.test(line),
  );
  const hasMetadata =
    lines[0]?.trimEnd() === '---' &&
    metadataEnd > 0 &&
    lines.slice(1, metadataEnd).some((line) => /^\s*[\w-]+:\s/u.test(line));
  const listIndents = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const plain = line.replace(/\r?\n$/u, '');
    if (hasMetadata && index <= metadataEnd) {
      protect(offset, offset + line.length);
    } else if (fence) {
      protect(offset, offset + line.length);
      const close = plain.match(/^ {0,3}(`{3,}|~{3,})\s*$/u);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else {
      const whitespace = plain.match(/^[ \t]*/u)[0];
      const indent = [...whitespace].reduce(
        (width, char) => (char === '\t' ? width + 4 - (width % 4) : width + 1),
        0,
      );
      if (plain.trim()) {
        while (listIndents.length && indent < listIndents.at(-1)) listIndents.pop();
      }
      const listMarker = plain.match(/^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/u);
      const isList = listMarker && indent < (listIndents.at(-1) ?? 0) + 4;
      if (isList) {
        const contentIndent = indent + listMarker[0].length - whitespace.length;
        listIndents.push(contentIndent);
        protect(offset, offset + listMarker[0].length);
      }
      const indentedCode = !isList && indent >= (listIndents.at(-1) ?? 0) + 4;
      const open = plain.match(/^ {0,3}(`{3,}|~{3,})/u);
      if (open) {
        fence = open[1];
        protect(offset, offset + line.length);
      } else if (
        indentedCode ||
        /^ {0,3}>/u.test(plain) ||
        /^ {0,3}(?:-\s*){3,}$/u.test(plain) ||
        /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(plain)
      ) {
        protect(offset, offset + line.length);
      } else {
        const bullet = plain.match(/^\s*[-+*]\s/u);
        if (bullet) protect(offset, offset + bullet[0].length);
        // Link reference definitions carry exact destinations and titles.
        if (/^ {0,3}\[[^\]]+\]:\s*\S/u.test(plain)) protect(offset, offset + line.length);
      }
    }
    offset += line.length;
  }
  // Delimiter runs must match exactly. A single backtick must not close at
  // the last character of a longer run and hide intervening ordinary prose.
  const ticks = [...text.matchAll(/`+/gu)].filter((match) => !protectedOffsets[match.index]);
  const nextTick = new Map();
  const closingTicks = ticks.map(() => -1);
  for (let i = ticks.length - 1; i >= 0; i--) {
    closingTicks[i] = nextTick.get(ticks[i][0].length) ?? -1;
    nextTick.set(ticks[i][0].length, i);
  }
  for (let i = 0; i < ticks.length; i++) {
    const opening = ticks[i];
    let escapes = 0;
    for (let at = opening.index - 1; at >= 0 && text[at] === '\\'; at--) escapes++;
    const closing = closingTicks[i];
    if (escapes % 2 || closing < 0) continue;
    const end = ticks[closing];
    if (/\n[ \t]*\n/u.test(text.slice(opening.index, end.index))) continue;
    protect(opening.index, end.index + end[0].length);
    i = closing;
  }
  for (const match of text.matchAll(
    /<!--[^]*?-->|<\/?[A-Za-z][^>\n]*>|\$\$[^]*?\$\$|(?<![\w$])\$(?![\s$])[^$\n]*[^\s$]\$(?![\d$])/gu,
  ))
    protect(match.index, match.index + match[0].length);
  for (const match of text.matchAll(/\]\(/gu)) {
    let depth = 1;
    let i = match.index + 2;
    for (; i < text.length && depth; i++) {
      if (text[i] === '\\') {
        i++;
        continue;
      }
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    if (depth === 0) protect(match.index + 1, i);
  }
  for (const match of text.matchAll(
    /https?:\/\/[^\s<>]+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu,
  ))
    protect(match.index, match.index + match[0].length);
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu))
    protect(match.index, match.index + match[0].length);
  for (const literal of literals) {
    let at = text.indexOf(literal);
    while (at !== -1) {
      protect(at, at + literal.length);
      at = text.indexOf(literal, at + literal.length);
    }
  }
  const findings = [];
  let line = 1;
  let column = 1;
  for (let at = 0; at < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(at));
    if (!protectedOffsets[at] && /[\p{Dash}\u00ad]/u.test(char)) {
      // A number's sign is data, not dash punctuation. Ranges still require review.
      const numericSign =
        /[-\u2212]/u.test(char) &&
        /^(?:\d|\.\d)/u.test(text.slice(at + 1, at + 3)) &&
        (at === 0 || /[\s(=,:]/u.test(text[at - 1]));
      if (!numericSign)
        findings.push({
          line,
          column,
          offset: at,
          character: char,
          codePoint: `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        });
    }
    if (char === '\n') {
      line++;
      column = 1;
    } else column++;
    at += char.length;
  }
  return {
    findings,
    protectedCharacters: protectedOffsets.reduce((a, b) => a + b, 0),
    semanticReviewRequired: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const literals = [];
    const files = [];
    let positionalOnly = false;
    for (let i = 0; i < args.length; i++) {
      if (!positionalOnly && args[i] === '--') positionalOnly = true;
      else if (!positionalOnly && args[i] === '--literal') {
        if (!args[i + 1]) throw new Error('--literal requires a nonempty token');
        literals.push(args[++i]);
      } else if (!positionalOnly && args[i].startsWith('-'))
        throw new Error(`Unknown option: ${args[i]}`);
      else files.push(args[i]);
    }
    if (!files.length)
      throw new Error('Usage: node scripts/check-prose.mjs [--literal TOKEN] FILE...');
    const reports = files.map((file) => {
      const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile()) throw new Error(`Expected a regular file: ${file}`);
        if (stat.size > 2_000_000) throw new Error(`Input exceeds 2 MB: ${file}`);
        const bytes = Buffer.alloc(2_000_001);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(descriptor, bytes, length, bytes.length - length, length);
          if (count === 0) break;
          length += count;
        }
        if (length > 2_000_000) throw new Error(`Input exceeds 2 MB: ${file}`);
        return { file, ...lintProse(bytes.subarray(0, length).toString('utf8'), { literals }) };
      } finally {
        closeSync(descriptor);
      }
    });
    await new Promise((resolve, reject) =>
      process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    process.exitCode = reports.some((report) => report.findings.length) ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
