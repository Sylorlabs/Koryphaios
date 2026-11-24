import { describe, expect, it, vi } from 'vitest';
import { createDictationRouter, routeDictation, type RouterOptions } from './router';

const ON: RouterOptions = {
  conductorEnabled: true,
  wakePhraseEnabled: true,
  wakePhrase: 'Kory',
  awaitingConfirmation: false,
};

describe('routeDictation', () => {
  it.each([
    ['Kory, stop worker two', 'conductor', 'stop worker two'],
    ['Hey Kory what are the agents doing', 'conductor', 'what are the agents doing'],
    ['Hey Kory, refactor the parser', 'conductor', 'refactor the parser'],
    ['Kory status', 'conductor', 'status'],
    ['Corey, open notes', 'conductor', 'open notes'],
    ['Kory is slow today', 'composer', 'Kory is slow today'],
    ['Please refactor the parser', 'composer', 'Please refactor the parser'],
    ['stop worker two', 'composer', 'stop worker two'],
    ['Ask Kory to stop', 'composer', 'Ask Kory to stop'],
  ])('%s → %s', (text, target, routed) => {
    expect(routeDictation(text, ON)).toEqual({ target, text: routed });
  });

  it('keeps everything in the composer when the wake phrase is off', () => {
    expect(routeDictation('Kory, stop', { ...ON, wakePhraseEnabled: false })).toEqual({
      target: 'composer',
      text: 'Kory, stop',
    });
  });

  it('keeps everything in the composer when the conductor is off', () => {
    expect(
      routeDictation('Kory, stop', { ...ON, conductorEnabled: false, awaitingConfirmation: true }),
    ).toEqual({ target: 'composer', text: 'Kory, stop' });
  });

  it('honours a custom wake phrase and ignores the default one', () => {
    const options = { ...ON, wakePhrase: 'Maestro' };
    expect(routeDictation('Maestro, status', options).target).toBe('conductor');
    expect(routeDictation('Kory, status', options).target).toBe('composer');
  });

  it('routes a bare yes/no to the conductor only while a confirmation is pending', () => {
    expect(routeDictation('yes', ON).target).toBe('composer');
    expect(routeDictation('yes', { ...ON, awaitingConfirmation: true })).toEqual({
      target: 'conductor',
      text: 'yes',
    });
    expect(routeDictation('No.', { ...ON, awaitingConfirmation: true }).target).toBe('conductor');
    expect(
      routeDictation('yes I think we should ship it', { ...ON, awaitingConfirmation: true }).target,
    ).toBe('composer');
    // Even with the wake phrase disabled, a pending question can be answered.
    expect(
      routeDictation('yes', { ...ON, wakePhraseEnabled: false, awaitingConfirmation: true }).target,
    ).toBe('conductor');
  });
});

describe('createDictationRouter', () => {
  it('passes plain dictation through segment by segment', () => {
    const router = createDictationRouter('dictation', ON);
    expect(router.push('Write a parser')).toBe('Write a parser');
    expect(router.push('for the config file')).toBe('for the config file');
    expect(router.finish()).toBeNull();
    expect(router.mode).toBe('dictation');
  });

  it('switches to the conductor on a wake phrase and buffers the whole command', () => {
    const onMode = vi.fn();
    const router = createDictationRouter('dictation', ON, onMode);
    expect(router.push('Hey Kory, tell the manager')).toBeNull();
    expect(router.push('to run the tests')).toBeNull();
    expect(onMode).toHaveBeenCalledWith('conductor');
    expect(router.finish()).toBe('tell the manager to run the tests');
  });

  it('only checks the wake phrase on the first segment', () => {
    const router = createDictationRouter('dictation', ON);
    expect(router.push('The release is ready.')).toBe('The release is ready.');
    expect(router.push('Kory, stop')).toBe('Kory, stop');
    expect(router.finish()).toBeNull();
  });

  it('treats every segment of a conductor-shortcut capture as the command', () => {
    const router = createDictationRouter('conductor', ON);
    expect(router.push('stop')).toBeNull();
    expect(router.push('worker two')).toBeNull();
    expect(router.finish()).toBe('stop worker two');
  });

  it('a conductor capture does not need the wake phrase, even when it is disabled', () => {
    const router = createDictationRouter('conductor', { ...ON, wakePhraseEnabled: false });
    router.push('status');
    expect(router.finish()).toBe('status');
  });

  it('downgrades a conductor capture to dictation when the conductor is off', () => {
    const router = createDictationRouter('conductor', { ...ON, conductorEnabled: false });
    expect(router.mode).toBe('dictation');
    expect(router.push('status')).toBe('status');
    expect(router.finish()).toBeNull();
  });

  it('reports an addressed-but-empty command as an empty string, and finishes once', () => {
    const router = createDictationRouter('dictation', ON);
    expect(router.push('Hey Kory')).toBeNull();
    expect(router.finish()).toBe('');
    expect(router.finish()).toBeNull();
    expect(router.push('late segment')).toBeNull();
  });
});
