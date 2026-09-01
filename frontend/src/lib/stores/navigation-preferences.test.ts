import { beforeEach, describe, expect, test } from 'vitest';
import {
  loadLastSessionId,
  loadSessionScope,
  saveLastSessionId,
  saveSessionScope,
} from './navigation-preferences';

describe('navigation preferences', () => {
  beforeEach(() => localStorage.clear());

  test('keeps only an opaque session hint and a view scope', () => {
    saveLastSessionId('session-42');
    saveSessionScope('all');

    expect(loadLastSessionId()).toBe('session-42');
    expect(loadSessionScope()).toBe('all');
    expect(localStorage.getItem('koryphaios-navigation-preferences-v1')).not.toContain('/');
  });

  test('clears a stale hint and falls back safely on malformed data', () => {
    saveLastSessionId('session-42');
    saveLastSessionId('');
    expect(loadLastSessionId()).toBe('');

    localStorage.setItem('koryphaios-navigation-preferences-v1', '{bad');
    expect(loadLastSessionId()).toBe('');
    expect(loadSessionScope()).toBe('project');
  });
});
