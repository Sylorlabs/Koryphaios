import { describe, expect, it } from 'vitest';
import {
  buildFeedbackReport,
  feedbackCategoryLabel,
  feedbackTitle,
  type FeedbackEnvironment,
} from './feedback-report';

const environment: FeedbackEnvironment = {
  appVersion: '0.5.0',
  frontendVersion: '0.5.0',
  backendVersion: '0.5.1',
  tauriVersion: '2.11.1',
  os: 'macOS',
  osVersion: '15.6',
  browser: 'Safari',
  browserVersion: '18.6',
};

describe('feedback issue reports', () => {
  it('uses the selected category in the issue title', () => {
    expect(feedbackCategoryLabel('performance')).toBe('Performance');
    expect(feedbackTitle('performance', '  The editor stutters while typing  ')).toBe(
      '[Performance] The editor stutters while typing',
    );
  });

  it('inserts a category-specific template and all environment versions', () => {
    const report = buildFeedbackReport(
      'bug',
      'The sidebar disappears after relaunch.',
      environment,
    );

    expect(report).toContain('## Bug report');
    expect(report).toContain('### What happened');
    expect(report).toContain('The sidebar disappears after relaunch.');
    expect(report).toContain('| Koryphaios app | 0.5.0 |');
    expect(report).toContain('| Frontend | 0.5.0 |');
    expect(report).toContain('| Backend | 0.5.1 |');
    expect(report).toContain('| Tauri | 2.11.1 |');
    expect(report).toContain('| Operating system | macOS 15.6 |');
    expect(report).toContain('| Web runtime | Safari 18.6 |');
  });

  it('changes the template headings for non-bug categories', () => {
    expect(
      buildFeedbackReport('documentation', 'The setup guide skips a step.', environment),
    ).toContain('### What is unclear or missing?');
    expect(
      buildFeedbackReport('integration', 'The provider connection fails.', environment),
    ).toContain('### Integration or provider');
  });
});
