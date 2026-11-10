export type FeedbackCategory =
  'bug' | 'idea' | 'question' | 'performance' | 'ux' | 'documentation' | 'integration' | 'other';

export interface FeedbackEnvironment {
  appVersion: string | null;
  frontendVersion: string | null;
  backendVersion: string | null;
  tauriVersion: string | null;
  os: string;
  osVersion: string | null;
  browser: string | null;
  browserVersion: string | null;
}

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: 'Bug',
  idea: 'Idea',
  question: 'Question',
  performance: 'Performance',
  ux: 'UX / UI',
  documentation: 'Documentation',
  integration: 'Integration',
  other: 'Other',
};

const CATEGORY_HEADINGS: Record<FeedbackCategory, string> = {
  bug: 'Bug report',
  idea: 'Feature idea',
  question: 'Question',
  performance: 'Performance feedback',
  ux: 'UX / UI feedback',
  documentation: 'Documentation feedback',
  integration: 'Integration feedback',
  other: 'Feedback',
};

export function feedbackCategoryLabel(category: FeedbackCategory): string {
  return CATEGORY_LABELS[category];
}

export function feedbackTitle(category: FeedbackCategory, message: string): string {
  return `[${feedbackCategoryLabel(category)}] ${message.trim().slice(0, 80)}`;
}

function version(value: string | null): string {
  return value ?? 'Not available';
}

export function feedbackEnvironmentMarkdown(environment: FeedbackEnvironment): string {
  const os = [environment.os, environment.osVersion].filter(Boolean).join(' ');
  const browser = environment.browser
    ? [environment.browser, environment.browserVersion].filter(Boolean).join(' ')
    : 'Not available';

  return [
    '## Environment',
    '',
    '| Component | Version |',
    '| --- | --- |',
    `| Koryphaios app | ${version(environment.appVersion)} |`,
    `| Frontend | ${version(environment.frontendVersion)} |`,
    `| Backend | ${version(environment.backendVersion)} |`,
    `| Tauri | ${version(environment.tauriVersion)} |`,
    `| Operating system | ${os || 'Not available'} |`,
    `| Web runtime | ${browser} |`,
  ].join('\n');
}

export function buildFeedbackReport(
  category: FeedbackCategory,
  message: string,
  environment: FeedbackEnvironment,
): string {
  const trimmed = message.trim();
  const heading = CATEGORY_HEADINGS[category];
  const sections: Record<FeedbackCategory, string> = {
    bug: [
      `## ${heading}`,
      '',
      '### What happened',
      trimmed,
      '',
      '### Steps to reproduce',
      '<!-- What steps reliably reproduce this? -->',
      '- ',
      '',
      '### Expected behavior',
      '<!-- What did you expect to happen? -->',
      '',
      '### Additional context',
      '<!-- Add logs or screenshots only after checking that they contain no secrets or private data. -->',
    ].join('\n'),
    idea: [
      `## ${heading}`,
      '',
      '### What would you like to see?',
      trimmed,
      '',
      '### Why would this be useful?',
      '<!-- Describe the problem or workflow this would improve. -->',
    ].join('\n'),
    question: [
      `## ${heading}`,
      '',
      '### Question',
      trimmed,
      '',
      '### Context',
      '<!-- Include the relevant workflow or configuration, without private project details or secrets. -->',
    ].join('\n'),
    performance: [
      `## ${heading}`,
      '',
      '### What feels slow or resource-intensive?',
      trimmed,
      '',
      '### When does it happen?',
      '<!-- Include approximate timing, frequency, and the affected workflow. -->',
      '',
      '### Expected behavior',
      '<!-- What performance would you expect instead? -->',
    ].join('\n'),
    ux: [
      `## ${heading}`,
      '',
      '### What could be improved?',
      trimmed,
      '',
      '### User impact',
      '<!-- Explain what is confusing, difficult, or inaccessible. -->',
    ].join('\n'),
    documentation: [
      `## ${heading}`,
      '',
      '### What is unclear or missing?',
      trimmed,
      '',
      '### Suggested improvement',
      '<!-- Describe the wording, example, or guide that would help. -->',
    ].join('\n'),
    integration: [
      `## ${heading}`,
      '',
      '### Integration or provider',
      trimmed,
      '',
      '### What happened?',
      '<!-- Include the relevant integration workflow and non-sensitive error details. -->',
      '',
      '### Expected behavior',
      '<!-- What should the integration do? -->',
    ].join('\n'),
    other: [
      `## ${heading}`,
      '',
      trimmed,
      '',
      '### Additional context',
      '<!-- Add any context that helps us understand this feedback. -->',
    ].join('\n'),
  };

  return [sections[category], '', feedbackEnvironmentMarkdown(environment)].join('\n');
}
