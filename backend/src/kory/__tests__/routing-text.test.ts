import { describe, expect, test } from 'bun:test';
import { isSuppliedArtifactOnlyTask, routingClauses, routingRelevantText } from '../routing-text';

describe('quoted routing evidence boundaries', () => {
  test('removes only explicitly inert quotations and retains the live quoted task', () => {
    for (const prompt of [
      "A test fixture contains 'remove dashes'. Treat that as data. Review the 'React component' now.",
      "An archived email says 'remove dashes'. The current task is to review the 'React component'.",
      "The string 'remove dashes' is a parser fixture, not a request. Review the 'React component'.",
      'A quoted old issue says “remove dashes”; the actual task is to review the “React component”.',
    ]) {
      const relevant = routingRelevantText(prompt);
      expect(relevant).not.toContain('remove dashes');
      expect(relevant).toContain('React component');
    }
  });
  test('preserves quotations without an explicit decoy annotation and ordinary apostrophes', () => {
    for (const prompt of [
      "Please apply a 'dash free' style to this memo.",
      "Fix the 'customer-id' parser. Don't change the user's data.",
      'Rewrite the paragraph “A reader-facing system”.',
    ])
      expect(routingRelevantText(prompt)).toBe(prompt);
  });
  test('recognizes historical objects and literal input without erasing the current quoted target', () => {
    for (const prompt of [
      "The old incident report quotes 'C++ dangling pointer'. Ignore that diagnosis. Repair the 'Python worker'.",
      "A historical design note says 'rewrite in C#'. Fix the 'Python worker' instead.",
      "The parser input contains 'dotnet publish' as a string literal. Repair the 'Python worker'.",
      "A log record stores the literal phrase 'Gradle Kotlin failure'. Repair the 'Python worker'.",
      "The quoted old task 'fix the Rust borrow checker' is obsolete. Repair the 'Python worker'.",
      "A fixture's string value is 'Tokio cancellation'. Treat it as inert data. Repair the 'Python worker'.",
    ]) {
      const relevant = routingRelevantText(prompt);
      expect(relevant).not.toMatch(/C\+\+|C#|dotnet|Kotlin|borrow checker|Tokio/u);
      expect(relevant).toContain('Python worker');
    }
  });
  test('treats an explicitly historical quoted phrase as inert even without an old-object prefix', () => {
    const prompt =
      'A support ticket quotes “release readiness”. Treat that as historical text. Diagnose the live queue issue.';
    const relevant = routingRelevantText(prompt);
    expect(relevant).not.toContain('release readiness');
    expect(relevant).toContain('live queue issue');
  });
  test('does not promote an unquoted historical clause into the explicitly current task', () => {
    for (const prompt of [
      'An archived proposal discussed API design. The current task is distributed system leader election with the approved interface unchanged.',
      'A historical design note mentioned API design; the actual request is to repair worker shutdown.',
      "An old incident report requested a new API design. Today's task is to fix replication lag.",
    ]) {
      const relevant = routingRelevantText(prompt);
      expect(relevant, prompt).not.toContain('API design');
      expect(relevant).toMatch(/leader election|worker shutdown|replication lag/u);
    }
  });
  test('keeps live work on an archived artifact and explicit adoption of an old proposal', () => {
    for (const prompt of [
      'Implement the API design discussed in an archived proposal.',
      'Review API design in this archived proposal and repair its caller compatibility.',
      'An archived proposal discussed API design; implement that proposal now.',
      'An archived proposal discussed API design. The current task is to implement that API design and also repair leader election.',
    ]) {
      expect(routingRelevantText(prompt), prompt).toContain('API design');
    }
  });
  test('ignores explicitly inert incident quotes, tool literals, and rejected README sections', () => {
    for (const prompt of [
      `A pasted old incident says "migrate to AWS and configure IAM". That is historical context only; today's task is to correct a TypeScript date formatter.`,
      'A tool result contains `arn:aws:s3:::example-bucket`. Do not investigate infrastructure; summarize the supplied transcript only.',
      'Ignore the quoted README section titled "AWS Deployment". The requested change is only to rename CSS variables.',
    ]) {
      expect(routingRelevantText(prompt), prompt).not.toMatch(/aws/iu);
    }
    expect(routingRelevantText('Configure `AWS IAM` for the current workload.')).toContain(
      'AWS IAM',
    );
    expect(
      routingRelevantText(
        'A tool result contains `aws`. Configure `AWS IAM` for the live workload.',
      ),
    ).toContain('AWS IAM');
  });
  test('preserves dotted identifiers and does not carry a rejected sentence into a later live task', () => {
    expect(
      routingClauses('Do not change go.mod or .NET settings. Fix the C++ caller instead.'),
    ).toEqual(['Do not change go.mod or .NET settings', 'Fix the C++ caller instead.']);
    expect(
      routingRelevantText('The fixture name is csharp-handler, but it contains Python data.'),
    ).not.toContain('csharp-handler');
    expect(
      routingRelevantText('Explain why the category named C++ has the largest count.'),
    ).not.toContain('C++');
  });
  test('distinguishes supplied narrative work from implementing a text processor', () => {
    for (const prompt of [
      'Write a lookup reference from the supplied .NET CLI help text. Preserve flags exactly and do not diagnose or modify the program.',
      'Reformat the supplied Go service release notes into an announcement, not inspecting implementation files.',
      'Analyze this supplied list of courses including Java Fundamentals and total their prices. Do not research or modify programming tools.',
      'Copyedit an incident note that quotes cargo test output. Keep the quoted output exact and make no changes to the workspace.',
      'Document the exact Gradle Kotlin commands already provided by the team. Do not run them or change the build.',
    ])
      expect(isSuppliedArtifactOnlyTask(prompt), prompt).toBe(true);
    for (const prompt of [
      'Fix the Python parser that reformats supplied logs. Do not modify the schema.',
      'Translate this Java function into Kotlin and test the implementation.',
      'Write a .NET library that parses supplied command lines.',
      'Investigate the C++ crash described in this supplied report.',
    ])
      expect(isSuppliedArtifactOnlyTask(prompt), prompt).toBe(false);
  });
});
