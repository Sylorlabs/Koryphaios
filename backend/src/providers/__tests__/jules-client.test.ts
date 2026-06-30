import { describe, expect, test } from 'bun:test';
import { matchJulesSource, parseGitHubRemote } from '../jules-client';

describe('parseGitHubRemote', () => {
  test('parses HTTPS remotes', () => {
    expect(parseGitHubRemote('https://github.com/Sylorlabs/Koryphaios.git')).toEqual({
      owner: 'Sylorlabs',
      repo: 'Koryphaios',
    });
  });

  test('parses SSH remotes', () => {
    expect(parseGitHubRemote('git@github.com:bobalover/boba.git')).toEqual({
      owner: 'bobalover',
      repo: 'boba',
    });
  });
});

describe('matchJulesSource', () => {
  test('matches githubRepo metadata', () => {
    const sources = [
      {
        name: 'sources/github/bobalover/boba',
        githubRepo: { owner: 'bobalover', repo: 'boba' },
      },
    ];
    expect(matchJulesSource(sources, 'bobalover', 'boba')?.name).toBe(
      'sources/github/bobalover/boba',
    );
  });
});