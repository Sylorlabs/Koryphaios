import { describe, expect, it } from 'bun:test';
import { projectDisplayName } from './project-path';

describe('projectDisplayName', () => {
  it.each([
    ['/home/micah/Desktop/Sylorlabs/Koryphaios', 'Koryphaios'],
    ['/home/micah/Desktop/Sylorlabs/Koryphaios/', 'Koryphaios'],
    ['C:\\Users\\micah\\Koryphaios', 'Koryphaios'],
    ['relative-project', 'relative-project'],
  ])('shows only the final folder name for %s', (path, expected) => {
    expect(projectDisplayName(path)).toBe(expected);
  });

  it('returns an empty label when a session has no working directory', () => {
    expect(projectDisplayName(undefined)).toBe('');
    expect(projectDisplayName(null)).toBe('');
  });
});
